'use strict';
/**
 * quark-fs.js — maps a POSIX namespace onto the Quark cloud drive.
 *
 * Responsibilities:
 *  - path <-> fid resolution with a short-TTL directory cache
 *  - concurrent identical listings are de-duplicated (in-flight map)
 *  - read (streamed via CDN url), write (OSS upload), mkdir, unlink, rename, move
 *  - every mutation invalidates the affected directory caches
 */
const { Readable } = require('node:stream');
const { isDirEntry, toDate } = require('../quark/api.js');

const ROOT_FID = '0';
/** Max cached directory listings (bounded memory for long-running mounts). */
const DIR_CACHE_MAX = 512;

function normalizePath(p) {
  let s = String(p == null ? '/' : p);
  // collapse duplicate slashes, drop trailing slash (except root)
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function splitPath(p) {
  return normalizePath(p).split('/').filter(Boolean);
}

function parentOf(p) {
  const parts = splitPath(p);
  parts.pop();
  return '/' + parts.join('/');
}

function baseName(p) {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Reject names that could escape the namespace or confuse path handling. */
function assertValidName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' ||
      /[\/\\]/.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
    throw httpError(409, 'invalid name');
  }
}

class QuarkFs {
  /**
   * @param {{
   *   api: import('../quark/api.js').QuarkApi,
   *   uploader: import('../quark/upload.js').Uploader,
   *   http: import('../quark/http.js').HttpClient,
   *   cacheTtlMs?: number,
   *   logger?: {debug: Function, warn: Function},
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.api = deps.api;
    this.uploader = deps.uploader;
    this.http = deps.http;
    this.cacheTtlMs = deps.cacheTtlMs == null ? 30000 : deps.cacheTtlMs;
    this.logger = deps.logger || { debug() {}, warn() {} };
    this.now = deps.now || (() => Date.now());
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {Map<string, {ts: number, entries: object[]}>} */
    this.dirCache = new Map();
    /** @type {Map<string, Promise<object[]>>} */
    this.inflight = new Map();
    /** per-path write serialization (concurrent PUTs must not race) */
    this._writeLocks = new Map();
  }

  /** List a directory by fid with TTL cache + in-flight de-duplication. */
  async listFid(fid, opts = {}) {
    if (!opts.fresh) {
      const hit = this.dirCache.get(fid);
      if (hit && this.now() - hit.ts < this.cacheTtlMs) return hit.entries;
      const pending = this.inflight.get(fid);
      if (pending) return pending;
    }
    const p = (async () => {
      const entries = await this.api.listDirAll(fid);
      this._cacheSet(fid, { ts: this.now(), entries });
      return entries;
    })();
    this.inflight.set(fid, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(fid);
    }
  }

  /** Cache a listing, evicting expired-then-oldest entries beyond the cap. */
  _cacheSet(fid, value) {
    // refresh insertion order (LRU-ish)
    this.dirCache.delete(fid);
    this.dirCache.set(fid, value);
    if (this.dirCache.size <= DIR_CACHE_MAX) return;
    const now = this.now();
    for (const [k, v] of this.dirCache) {
      if (this.dirCache.size <= DIR_CACHE_MAX) break;
      if (now - v.ts >= this.cacheTtlMs) this.dirCache.delete(k); // expired first
    }
    while (this.dirCache.size > DIR_CACHE_MAX) {
      const oldest = this.dirCache.keys().next().value;
      this.dirCache.delete(oldest);
    }
  }

  invalidate(fid) {
    this.dirCache.delete(fid);
  }

  /** Resolve a POSIX path to { fid, entry } (entry null for the root). */
  async resolve(path) {
    const parts = splitPath(path);
    let fid = ROOT_FID;
    let entry = null;
    for (const name of parts) {
      const entries = await this.listFid(fid);
      const found = entries.find((e) => e && e.file_name === name);
      if (!found) return null;
      entry = found;
      fid = String(found.fid);
    }
    return { fid, entry };
  }

  /**
   * Stat a path.
   * @returns {Promise<{path: string, fid: string, name: string, isDir: boolean,
   *   size: number, mtime: Date, ctime: Date, etag: string}|null>}
   */
  async stat(path) {
    const p = normalizePath(path);
    if (p === '/') {
      return {
        path: '/', fid: ROOT_FID, name: '/', isDir: true,
        size: 0, mtime: new Date(0), ctime: new Date(0), etag: '"root"',
      };
    }
    const res = await this.resolve(p);
    if (!res || !res.entry) return null;
    return this._entryToStat(p, res.entry);
  }

  _entryToStat(path, entry) {
    const size = Number(entry.size) || 0;
    return {
      path: normalizePath(path),
      fid: String(entry.fid),
      name: String(entry.file_name || ''),
      isDir: isDirEntry(entry),
      size,
      mtime: toDate(entry.updated_at),
      ctime: toDate(entry.created_at),
      etag: '"' + String(entry.fid) + '-' + size + '-' + (entry.updated_at || 0) + '"',
    };
  }

  /** List a directory's children as stat objects. */
  async list(path) {
    const p = normalizePath(path);
    const res = await this.resolve(p);
    if (!res) return null;
    if (res.entry && !isDirEntry(res.entry)) return null; // not a directory
    const entries = await this.listFid(res.fid);
    const base = p === '/' ? '' : p;
    return entries
      .filter((e) => e && typeof e.file_name === 'string')
      .map((e) => this._entryToStat(base + '/' + e.file_name, e));
  }

  /**
   * Open a file for reading.
   * @returns {Promise<{stream: Readable, size: number, mime: string, name: string,
   *   partial: boolean, status: number}|null>}
   */
  async createReadStream(path, range, opts = {}) {
    const st = await this.stat(path);
    if (!st || st.isDir) return null;
    const { url } = await this.api.getDownloadUrl(st.fid);
    const headers = {};
    if (range) headers.Range = 'bytes=' + range.start + '-' + range.end;
    // The download URL is pre-signed: never send the session cookie to the CDN
    // host (noCookie), and let the caller abort us when the client disconnects.
    const res = await this.http.request('GET', url, {
      raw: true,
      headers,
      noCookie: true,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs == null ? 30 * 60 * 1000 : opts.timeoutMs,
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error('download failed: http ' + res.status);
    }
    const mime = res.headers.get ? (res.headers.get('content-type') || '') : '';
    const name = st.name;
    // Trust the upstream's own length when it tells us.
    let size = st.size;
    const upstreamLen = res.headers.get ? Number(res.headers.get('content-length')) : NaN;
    if (Number.isFinite(upstreamLen) && upstreamLen >= 0) size = upstreamLen;
    return {
      stream: Readable.fromWeb(res.response.body),
      size,
      mime: mime.split(';')[0] || 'application/octet-stream',
      name,
      partial: res.status === 206,
      status: res.status,
    };
  }

  /**
   * Create or overwrite a file from a stream (or buffer).
   *
   * Overwrite order matters: we upload FIRST and delete the previous version
   * afterwards. Deleting first would open a data-loss window if the upload
   * then fails. Writes to the same path are serialized so concurrent PUTs
   * cannot create duplicates or lose each other's cleanup.
   * @returns {Promise<{fid: string|null}>}
   */
  async writeFile(path, stream, size, opts = {}) {
    const p = normalizePath(path);
    if (p === '/') throw httpError(405, 'cannot write the root');
    const name = baseName(p);
    assertValidName(name);

    const prev = this._writeLocks.get(p) || Promise.resolve();
    const run = prev.then(() => this._writeFileLocked(p, name, stream, size, opts));
    // keep the chain alive but never let a failure poison later writes
    this._writeLocks.set(p, run.catch(() => {}));
    try {
      return await run;
    } finally {
      if (this._writeLocks.get(p) === run.catch(() => {})) this._writeLocks.delete(p);
    }
  }

  async _writeFileLocked(p, name, stream, size, opts) {
    const parent = parentOf(p);
    const parentRes = await this.resolve(parent);
    if (!parentRes || (parentRes.entry && !isDirEntry(parentRes.entry))) {
      throw httpError(409, 'parent directory does not exist');
    }
    const parentFid = parentRes.fid;

    const existing = (await this.listFid(parentFid)).find((e) => e && e.file_name === name);
    if (existing && isDirEntry(existing)) throw httpError(409, 'a directory with that name exists');

    const uploadOpts = {
      parentFid,
      fileName: name,
      mimeType: opts.mimeType || undefined,
      size,
    };
    if (opts.buffer) uploadOpts.buffer = opts.buffer;
    else uploadOpts.stream = stream;

    let out;
    try {
      out = await this.uploader.upload(uploadOpts);
    } catch (e) {
      // Upload failed: the previous version is still intact. Invalidate so the
      // next listing is fresh, then surface the error.
      this.invalidate(parentFid);
      throw e;
    }

    // Remove the previous version only after the new content is safely stored.
    if (existing) {
      const oldFid = String(existing.fid);
      if (!out.fid || out.fid !== oldFid) {
        // Re-list fresh: a concurrent writer may already have replaced it.
        const stillThere = (await this.listFid(parentFid, { fresh: true }))
          .find((e) => e && String(e.fid) === oldFid && e.file_name === name);
        if (stillThere) {
          try {
            await this.api.remove([oldFid]);
          } catch (e) {
            this.logger.warn('post-upload cleanup of ' + oldFid + ' failed: ' + e.message);
          }
        }
      }
    }
    this.invalidate(parentFid);
    return { fid: out.fid };
  }

  async mkdir(path) {
    const p = normalizePath(path);
    if (p === '/') throw httpError(405, 'already exists');
    const parent = parentOf(p);
    const name = baseName(p);
    assertValidName(name);
    const parentRes = await this.resolve(parent);
    if (!parentRes || (parentRes.entry && !isDirEntry(parentRes.entry))) {
      throw httpError(409, 'parent directory does not exist');
    }
    const existing = (await this.listFid(parentRes.fid)).find((e) => e && e.file_name === name);
    if (existing) throw httpError(405, 'already exists');
    const fid = await this.api.mkdir(parentRes.fid, name);
    this.invalidate(parentRes.fid);
    return { fid };
  }

  async unlink(path) {
    const p = normalizePath(path);
    const res = await this.resolve(p);
    if (!res || !res.entry) throw httpError(404, 'not found');
    await this.api.remove([res.fid]);
    this.invalidate(ROOT_FID);
    this.invalidate(await this._parentFidOf(p));
    return {};
  }

  async rename(path, newName) {
    const p = normalizePath(path);
    assertValidName(newName);
    const res = await this.resolve(p);
    if (!res || !res.entry) throw httpError(404, 'not found');
    await this.api.rename(res.fid, newName);
    this.invalidate(await this._parentFidOf(p));
    return {};
  }

  async move(path, destPath, opts = {}) {
    const src = normalizePath(path);
    const dst = normalizePath(destPath);
    if (src === dst) throw httpError(403, 'source and destination are identical');
    if (src !== '/' && dst.startsWith(src + '/')) {
      throw httpError(403, 'cannot move a directory into its own subtree');
    }
    const srcRes = await this.resolve(src);
    if (!srcRes || !srcRes.entry) throw httpError(404, 'source not found');
    // Destination may be a directory (move into it) or a new path (rename).
    const dstRes = await this.resolve(dst);
    if (dstRes && dstRes.entry && !isDirEntry(dstRes.entry)) {
      // Replacing an existing file. Done without a data-loss window:
      // move to a temporary name, delete the old file, then rename.
      if (!opts.overwrite) throw httpError(409, 'destination exists');
      const parentRes = await this.resolve(parentOf(dst));
      if (!parentRes) throw httpError(409, 'destination parent not found');
      const finalName = baseName(dst);
      assertValidName(finalName);
      const tmpName = '.quarkdrive-tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      await this.api.move([srcRes.fid], parentRes.fid);
      await this.api.rename(srcRes.fid, tmpName);
      let renamed = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
        try {
          await this.api.remove([String(dstRes.entry.fid)]);
          await this.api.rename(srcRes.fid, finalName);
          renamed = true;
        } catch (e) {
          lastErr = e;
          await this.sleep(250 * (attempt + 1));
        }
      }
      if (!renamed) {
        // best effort: leave the source under its temp name rather than lose it
        this.logger.warn('replace move failed, file kept as ' + tmpName + ': ' + (lastErr && lastErr.message));
        this.invalidate(parentRes.fid);
        throw httpError(500, 'replace failed');
      }
      this.invalidate(parentRes.fid);
      this.invalidate(await this._parentFidOf(src));
      return {};
    }
    if (dstRes && (!dstRes.entry || isDirEntry(dstRes.entry))) {
      // plain move into an existing directory
      await this.api.move([srcRes.fid], dstRes.fid);
      this.invalidate(dstRes.fid);
      this.invalidate(await this._parentFidOf(src));
      return {};
    }
    // target does not exist: move into the parent first, then rename. If the
    // rename fails the file is merely left with its old name in the right
    // directory — never silently misplaced.
    const parentRes = await this.resolve(parentOf(dst));
    if (!parentRes) throw httpError(409, 'destination parent not found');
    assertValidName(baseName(dst));
    await this.api.move([srcRes.fid], parentRes.fid);
    try {
      await this.api.rename(srcRes.fid, baseName(dst));
    } catch (e) {
      this.logger.warn('move: rename after move failed for ' + srcRes.fid + ': ' + e.message);
    }
    this.invalidate(parentRes.fid);
    this.invalidate(await this._parentFidOf(src));
    return {};
  }

  async _parentFidOf(path) {
    const res = await this.resolve(parentOf(path));
    return res ? res.fid : ROOT_FID;
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

module.exports = { QuarkFs, normalizePath, splitPath, parentOf, baseName, httpError, ROOT_FID };
