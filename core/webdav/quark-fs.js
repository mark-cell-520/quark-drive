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
/** Max cached pre-signed download URLs (fid -> {url, ts}). */
const URL_CACHE_MAX = 256;
/** Pre-signed CDN URLs live for many minutes; 5 min is a safe reuse window. */
const URL_CACHE_TTL_MS = 5 * 60 * 1000;

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

/**
 * Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) in any
 * extension form ("CON", "con.txt", "aux.js"), case-insensitive. Such names
 * resolve to kernel devices through the mount, making the file unreachable.
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Reject names that could escape the namespace or confuse path handling. */
function assertValidName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' ||
      /[\/\\]/.test(name) || /[\x00-\x1f\x7f]/.test(name) ||
      // Win32-illegal characters (a name containing these cannot be created
      // through Explorer and breaks the cloud<->mount name mapping)
      /[?*:"<>|]/.test(name) ||
      WIN_RESERVED.test(name) ||
      // leading space / trailing dot or space are silently mangled by Win32
      /^ /.test(name) || /[. ]$/.test(name)) {
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
    /** @type {Map<string, {url: string, ts: number}>} pre-signed URL cache */
    this._urlCache = new Map();
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
    // name index: first occurrence wins (matches the previous find() semantics)
    const byName = new Map();
    for (const e of value.entries) {
      if (e && typeof e.file_name === 'string' && !byName.has(e.file_name)) {
        byName.set(e.file_name, e);
      }
    }
    value.byName = byName;
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
      // an intermediate component that is a file makes the rest of the path
      // nonexistent — stop here instead of listing with a file's fid (which
      // would surface upstream business errors as 500s)
      if (entry && !isDirEntry(entry)) return null;
      const found = await this._lookupChild(fid, name);
      if (!found) return null;
      entry = found;
      fid = String(found.fid);
    }
    return { fid, entry };
  }

  /** Look up one child by name using the cached name index when possible. */
  async _lookupChild(fid, name) {
    const entries = await this.listFid(fid);
    const hit = this.dirCache.get(fid);
    if (hit && hit.entries === entries && hit.byName) return hit.byName.get(name) || null;
    return entries.find((e) => e && e.file_name === name) || null;
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

  /**
   * List a directory's children as stat objects.
   *
   * The stat array is cached alongside the raw entries (keyed by fid, tagged
   * with the base path it was built for) so repeated PROPFIND depth-1 on the
   * same directory — the Explorer-browsing hot path — does not rebuild
   * thousands of stat objects each time. Callers MUST treat the returned
   * array as read-only.
   */
  async list(path) {
    const p = normalizePath(path);
    const res = await this.resolve(p);
    if (!res) return null;
    if (res.entry && !isDirEntry(res.entry)) return null; // not a directory
    const fid = res.fid;
    const hit = this.dirCache.get(fid);
    if (hit && this.now() - hit.ts < this.cacheTtlMs && hit.stats && hit.statsBase === p) {
      return hit.stats;
    }
    const entries = await this.listFid(fid);
    const base = p === '/' ? '' : p;
    const stats = entries
      .filter((e) => e && typeof e.file_name === 'string')
      .map((e) => this._entryToStat(base + '/' + e.file_name, e));
    const entry = this.dirCache.get(fid);
    if (entry && entry.entries === entries) {
      entry.stats = stats;
      entry.statsBase = p;
    }
    return stats;
  }

  /**
   * Open a file for reading.
   * @returns {Promise<{stream: Readable, size: number, mime: string, name: string,
   *   partial: boolean, status: number}|null>}
   */
  async createReadStream(path, range, opts = {}) {
    const st = await this.stat(path);
    if (!st || st.isDir) return null;

    // Pre-signed CDN URLs are reused briefly: repeated opens of the same file
    // (Explorer preview, rclone read-ahead re-opens) then cost no API round
    // trip. A 403/404 from the CDN evicts the entry and retries once.
    const open = async () => {
      const { url } = await this._downloadUrl(st.fid);
      const headers = {};
      if (range) headers.Range = 'bytes=' + range.start + '-' + range.end;
      // The download URL is pre-signed: never send the session cookie to the
      // CDN host (noCookie), and let the caller abort us when the client
      // disconnects.
      return this.http.request('GET', url, {
        raw: true,
        headers,
        noCookie: true,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs == null ? 30 * 60 * 1000 : opts.timeoutMs,
      });
    };

    let res = await open();
    if ((res.status === 403 || res.status === 404) && this._urlCache.delete(st.fid)) {
      res = await open(); // stale pre-signed URL — one retry with a fresh one
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new Error('download failed: http ' + res.status);
    }
    const mime = res.headers.get ? (res.headers.get('content-type') || '') : '';
    const name = st.name;
    // Trust the upstream's own length when it tells us. NOTE: headers.get()
    // returns null when absent and Number(null) === 0 — check for null first
    // or a chunked (length-less) response would truncate the file to 0 bytes.
    let size = st.size;
    const lenHeader = res.headers.get ? res.headers.get('content-length') : null;
    const upstreamLen = lenHeader == null ? NaN : Number(lenHeader);
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

  /** Cached pre-signed download URL for a fid (short TTL, bounded size). */
  async _downloadUrl(fid) {
    const hit = this._urlCache.get(fid);
    if (hit && this.now() - hit.ts < URL_CACHE_TTL_MS) return hit;
    const { url, size } = await this.api.getDownloadUrl(fid);
    this._urlCache.set(fid, { url, size: size || 0, ts: this.now() });
    if (this._urlCache.size > URL_CACHE_MAX) {
      const oldest = this._urlCache.keys().next().value;
      this._urlCache.delete(oldest);
    }
    return { url, size: size || 0 };
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
    // keep the chain alive but never let a failure poison later writes.
    // The SAME guarded promise must be stored and compared — run.catch()
    // allocates a new promise on every call, so comparing against a fresh
    // one would never match and the map entry would leak forever.
    const guarded = run.catch(() => {});
    this._writeLocks.set(p, guarded);
    try {
      return await run;
    } finally {
      if (this._writeLocks.get(p) === guarded) this._writeLocks.delete(p);
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
    // Only the DIRECT parent is stale (the entry moved out of it); the root
    // listing is unaffected unless the parent IS the root.
    const parentFid = await this._parentFidOf(p);
    this.invalidate(parentFid);
    if (parentFid === ROOT_FID) this.invalidate(ROOT_FID);
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
      // move to the destination parent, rename to a temporary name, delete
      // the old file, then rename to the final name. Every step is inside
      // the retry loop with a FRESH temp name each attempt (a leftover
      // .quarkdrive-tmp-* from an earlier failure must not collide), and
      // the failure path reports where the file actually landed.
      if (!opts.overwrite) throw httpError(409, 'destination exists');
      const parentRes = await this.resolve(parentOf(dst));
      if (!parentRes) throw httpError(409, 'destination parent not found');
      const finalName = baseName(dst);
      assertValidName(finalName);
      const srcFid = String(srcRes.fid);
      const oldFid = String(dstRes.entry.fid);
      let renamed = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
        const tmpName = '.quarkdrive-tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        try {
          await this.api.move([srcFid], parentRes.fid);
          await this.api.rename(srcFid, tmpName);
          await this.api.remove([oldFid]);
          await this.api.rename(srcFid, finalName);
          renamed = true;
        } catch (e) {
          lastErr = e;
          await this.sleep(250 * (attempt + 1));
        }
      }
      if (!renamed) {
        // Never claim a state we did not verify: look up where the file
        // really is so the log matches reality for recovery.
        const landedAs = await this._nameOfInDir(parentRes.fid, srcFid);
        this.logger.warn('replace move failed: file ' + srcFid + ' is in the destination directory as ' +
          JSON.stringify(landedAs) + ' (' + (lastErr && lastErr.message) + ')');
        this.invalidate(parentRes.fid);
        this.invalidate(await this._parentFidOf(src));
        // Rethrow the ORIGINAL failure (not a generic wrapper): callers and
        // tests match on it, and the WebDAV layer maps plain errors to a
        // generic client-facing message (F-15).
        throw lastErr || httpError(500, 'replace failed');
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
    // rename fails we roll the name back and report failure — silently
    // leaving the file under its old name would make the client 404 on a
    // destination it was told had succeeded.
    const parentRes = await this.resolve(parentOf(dst));
    if (!parentRes) throw httpError(409, 'destination parent not found');
    assertValidName(baseName(dst));
    await this.api.move([srcRes.fid], parentRes.fid);
    try {
      await this.api.rename(srcRes.fid, baseName(dst));
    } catch (e) {
      this.logger.warn('move: rename after move failed for ' + srcRes.fid + ': ' + e.message);
      try {
        await this.api.rename(srcRes.fid, baseName(src)); // roll the name back
      } catch (e2) {
        this.logger.warn('move: rollback rename also failed for ' + srcRes.fid + ': ' + e2.message);
      }
      this.invalidate(parentRes.fid);
      this.invalidate(await this._parentFidOf(src));
      throw httpError(500, 'move failed after transfer');
    }
    this.invalidate(parentRes.fid);
    this.invalidate(await this._parentFidOf(src));
    return {};
  }

  async _parentFidOf(path) {
    const res = await this.resolve(parentOf(path));
    return res ? res.fid : ROOT_FID;
  }

  /** Fresh lookup of an entry's current name inside a directory (by fid). */
  async _nameOfInDir(dirFid, targetFid) {
    try {
      const entries = await this.listFid(dirFid, { fresh: true });
      const found = entries.find((e) => String(e.fid) === String(targetFid));
      return found ? found.file_name : null;
    } catch (_e) {
      return null;
    }
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

module.exports = { QuarkFs, normalizePath, splitPath, parentOf, baseName, httpError, ROOT_FID };
