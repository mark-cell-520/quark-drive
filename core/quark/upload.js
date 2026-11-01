'use strict';
/**
 * upload.js — Quark file upload via the OSS multipart protocol.
 *
 * Flow (mirrors the official desktop client):
 *   1. POST /1/clouddrive/file/upload/pre      -> task/bucket/obj_key/upload_id/auth_info/callback/part_size
 *   2. PUT  each part to https://<bucket>.<upload_url>/<obj_key>?partNumber=N&uploadId=...
 *      (Authorization from POST /1/clouddrive/file/upload/auth; part >= 2 also
 *      sends X-Oss-Hash-Ctx — the incremental SHA-1 internal state)
 *   3. POST /1/clouddrive/file/update/hash     -> md5+sha1 (server may answer
 *      data.finish=true = 秒传, the file already exists server-side)
 *   4. POST CompleteMultipartUpload (commit)   -> 200
 *   5. POST /1/clouddrive/file/upload/finish   -> done
 *
 * OSS requests deliberately carry NO session cookie (noCookie) — the signed
 * URL is the credential; sending cookies to the CDN host would leak them.
 */
const crypto = require('node:crypto');
const { AuthError } = require('./http.js');

const DRIVE = 'https://drive-pc.quark.cn';
const OSS_USER_AGENT = 'aliyun-sdk-js/1.0.0 Chrome 145.0.0.0 on Windows 10 64-bit';
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
/** Parts are buffered in memory before each PUT, so cap the server's choice. */
const MIN_PART_SIZE = 1024 * 1024;        // 1 MiB
const MAX_PART_SIZE = 64 * 1024 * 1024;   // 64 MiB

function clampPartSize(n) {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PART_SIZE;
  return Math.min(Math.max(Math.trunc(n), MIN_PART_SIZE), MAX_PART_SIZE);
}

/**
 * How many part PUTs may be in flight at once. The server's part_thread is
 * honoured (the official client uploads parts in parallel), capped at 4 and
 * further bounded so in-flight part buffers stay under ~64 MiB regardless of
 * the (server-chosen, up to 64 MiB) part size.
 */
function uploadConcurrency(pre, maxInFlightBytes = 64 * 1024 * 1024) {
  const byMemory = Math.max(1, Math.floor(maxInFlightBytes / pre.partSize));
  const wanted = pre.partThread || 3;
  return Math.max(1, Math.min(wanted, 4, byMemory));
}

function rfc1123(date) {
  // "Mon, 02 Jan 2006 15:04:05 GMT"
  return date.toUTCString();
}

function b64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
}

class UploadError extends Error {
  constructor(stage, message) {
    super('upload ' + stage + ': ' + message);
    this.name = 'UploadError';
    this.stage = stage;
  }
}

class Uploader {
  /**
   * @param {{
   *   http: import('./http.js').HttpClient,
   *   device: import('../device.js').Device,
   *   logger?: {debug: Function, warn: Function},
   *   sha1?: {Sha1Ctx: Function},
   * }} deps
   */
  constructor(deps) {
    this.http = deps.http;
    this.device = deps.device;
    this.logger = deps.logger || { debug() {}, warn() {} };
    // lazy require so tests can inject
    this._Sha1Ctx = deps.sha1 ? deps.sha1 : require('./sha1ctx.js').Sha1Ctx;
  }

  _params(extra) {
    return Object.assign({
      pr: 'ucpro', fr: 'pc', sys: 'win32', ut: this.device.ut, mi: this.device.mi,
    }, extra || {});
  }

  /** Step 1. */
  async pre(fileName, mimeType, size, pdirFid) {
    const now = Date.now();
    const body = JSON.stringify({
      ccp_hash_update: true,
      parallel_upload: true,
      dir_name: '',
      file_name: fileName,
      format_type: mimeType,
      l_created_at: now,
      l_updated_at: now,
      pdir_fid: pdirFid || '0',
      size,
    });
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/upload/pre', {
      query: this._params(),
      body,
    });
    const code = out && out.code;
    if (!out || (code !== 0 && code !== 200)) {
      throw new UploadError('pre', 'code=' + code + ' message=' + (out && out.message));
    }
    const data = out.data || {};
    const partSize = clampPartSize((data.metadata && Number(data.metadata.part_size)) || DEFAULT_PART_SIZE);
    // The server advertises how many parts may be uploaded in parallel
    // (the official client uploads parts concurrently — hence
    // parallel_upload above). We honour it within a memory bound.
    const partThread = Number(data.metadata && data.metadata.part_thread);
    return {
      taskId: String(data.task_id || ''),
      bucket: String(data.bucket || ''),
      objKey: String(data.obj_key || ''),
      uploadId: String(data.upload_id || ''),
      uploadUrl: String(data.upload_url || ''),
      authInfo: data.auth_info,
      callback: data.callback,
      partSize,
      partThread: Number.isFinite(partThread) && partThread > 0 ? Math.trunc(partThread) : null,
    };
  }

  /** Ask the drive API to sign an OSS request. */
  async _authKey(authMeta, pre) {
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/upload/auth', {
      query: this._params(),
      body: JSON.stringify({ auth_info: pre.authInfo, auth_meta: authMeta, task_id: pre.taskId }),
    });
    const key = out && out.data && out.data.auth_key;
    if (!key) throw new UploadError('auth', 'no auth_key in response');
    return String(key);
  }

  _ossPartUrl(pre, partNumber) {
    const base = pre.uploadUrl.replace(/^https?:\/\//, '');
    return 'https://' + pre.bucket + '.' + base + '/' + pre.objKey +
      '?partNumber=' + partNumber + '&uploadId=' + encodeURIComponent(pre.uploadId);
  }

  /** PUT one part. `hashCtxB64` is the precomputed X-Oss-Hash-Ctx (state
   *  covering parts 1..N-1) or null for part 1. Returns the ETag. */
  async _putPart(pre, partNumber, chunk, mimeType, hashCtxB64) {
    const date = rfc1123(new Date());
    let authMeta = 'PUT\n\n' + mimeType + '\n' + date + '\n';
    const headers = {
      'Content-Type': mimeType,
      'x-oss-date': date,
      'x-oss-user-agent': OSS_USER_AGENT,
    };
    if (partNumber >= 2 && hashCtxB64) {
      authMeta += 'X-Oss-Hash-Ctx:' + hashCtxB64 + '\n';
      headers['X-Oss-Hash-Ctx'] = hashCtxB64;
    }
    authMeta += 'x-oss-date:' + date + '\n' +
      'x-oss-user-agent:' + OSS_USER_AGENT + '\n' +
      '/' + pre.bucket + '/' + pre.objKey + '?partNumber=' + partNumber + '&uploadId=' + pre.uploadId;

    const authKey = await this._authKey(authMeta, pre);
    headers.Authorization = authKey;

    const res = await this.http.request('PUT', this._ossPartUrl(pre, partNumber), {
      body: chunk,
      headers,
      noCookie: true,
      timeoutMs: 30 * 60 * 1000,
    });
    if (res.status === 409) {
      // PartAlreadyExist — recover the ETag from the XML error body.
      const m = /<PartEtag>([^<]+)<\/PartEtag>/.exec(res.body.toString('utf8'));
      if (m) return m[1].trim().replace(/^"|"$/g, '');
    }
    if (res.status !== 200) {
      throw new UploadError('part ' + partNumber, 'http ' + res.status + ' ' + res.body.toString('utf8').slice(0, 200));
    }
    const etag = res.headers.get ? res.headers.get('etag') : null;
    if (!etag) throw new UploadError('part ' + partNumber, 'no ETag in response');
    return etag.replace(/^"|"$/g, '');
  }

  /** Step 3: submit full-file hashes; server answers 秒传 via data.finish. */
  async updateHash(md5hex, sha1hex, pre) {
    let out;
    try {
      out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/update/hash', {
        query: this._params(),
        body: JSON.stringify({ md5: md5hex, sha1: sha1hex, task_id: pre.taskId }),
      });
    } catch (e) {
      // A dead session must surface (re-login); a transport blip must not:
      // all parts are already uploaded, so degrade to a normal commit
      // instead of failing the whole upload.
      if (e instanceof AuthError) throw e;
      this.logger.warn('update/hash failed (' + e.message + ') — degrading to a normal commit');
      return { finish: false };
    }
    const code = out && out.code;
    if (!out || (code !== 0 && code !== 200)) {
      // Non-fatal: degrade to a normal commit.
      this.logger.warn('update/hash failed: ' + (out && out.message));
      return { finish: false };
    }
    return { finish: !!(out.data && out.data.finish) };
  }

  /** Step 4: commit the multipart upload. */
  async commit(pre, etags) {
    const xml = '<CompleteMultipartUpload>' +
      etags.map((e, i) => '<Part><PartNumber>' + (i + 1) + '</PartNumber><ETag>' + e + '</ETag></Part>').join('') +
      '</CompleteMultipartUpload>';
    const md5b64 = b64(crypto.createHash('md5').update(xml).digest());
    // Callback normalization: a string is treated as the callback JSON text,
    // an object is serialized; anything else (number/boolean/null) is not a
    // valid callback payload and is dropped rather than base64'd blindly
    // (base64("0") would be signed and sent as a bogus x-oss-callback).
    let callbackB64 = '';
    try {
      if (typeof pre.callback === 'string' && pre.callback !== '') {
        callbackB64 = b64(Buffer.from(pre.callback, 'utf8'));
      } else if (pre.callback && typeof pre.callback === 'object') {
        callbackB64 = b64(Buffer.from(JSON.stringify(pre.callback), 'utf8'));
      }
    } catch (_e) { callbackB64 = ''; }

    const date = rfc1123(new Date());
    const authMeta = 'POST\n' + md5b64 + '\napplication/xml\n' + date + '\n' +
      'x-oss-callback:' + callbackB64 + '\n' +
      'x-oss-date:' + date + '\n' +
      'x-oss-user-agent:' + OSS_USER_AGENT + '\n' +
      '/' + pre.bucket + '/' + pre.objKey + '?uploadId=' + pre.uploadId;

    const authKey = await this._authKey(authMeta, pre);
    const base = pre.uploadUrl.replace(/^https?:\/\//, '');
    const url = 'https://' + pre.bucket + '.' + base + '/' + pre.objKey + '?uploadId=' + encodeURIComponent(pre.uploadId);
    const res = await this.http.request('POST', url, {
      body: xml,
      headers: {
        'Content-Type': 'application/xml',
        'Content-MD5': md5b64,
        'x-oss-callback': callbackB64,
        'x-oss-date': date,
        'x-oss-user-agent': OSS_USER_AGENT,
        Authorization: authKey,
      },
      noCookie: true,
      timeoutMs: 5 * 60 * 1000,
    });
    if (res.status !== 200) {
      throw new UploadError('commit', 'http ' + res.status + ' ' + res.body.toString('utf8').slice(0, 300));
    }
    return true;
  }

  /** Step 5. */
  async finish(pre) {
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/upload/finish', {
      query: this._params(),
      body: JSON.stringify({ obj_key: pre.objKey, task_id: pre.taskId }),
    });
    const code = out && out.code;
    if (!out || (code !== 0 && code !== 200)) {
      throw new UploadError('finish', 'code=' + code + ' message=' + (out && out.message));
    }
    return out.data || {};
  }

  /**
   * Upload a stream (async iterable of Buffers) or a Buffer.
   *
   * Parts are uploaded concurrently (the official client does the same —
   * the pre response even carries part_thread). The SHA-1 chain is advanced
   * while parts are PRODUCED, so each part's X-Oss-Hash-Ctx (state covering
   * parts 1..N-1) is precomputed before its PUT — the protocol semantics are
   * identical to the sequential flow, only the network waits overlap.
   *
   * @param {{
   *   parentFid: string,
   *   fileName: string,
   *   mimeType?: string,
   *   size: number,
   *   stream?: AsyncIterable<Buffer>,
   *   buffer?: Buffer,
   *   onProgress?: (loaded: number, total: number) => void,
   * }} opts
   * @returns {Promise<{fid: string|null, rapid: boolean, taskId: string}>}
   */
  async upload(opts) {
    const mimeType = opts.mimeType || 'application/octet-stream';
    const pre = await this.pre(opts.fileName, mimeType, opts.size, opts.parentFid);
    if (!pre.taskId || !pre.bucket || !pre.objKey || !pre.uploadId || !pre.uploadUrl) {
      throw new UploadError('pre', 'incomplete pre response');
    }

    const self = this;
    const md5 = crypto.createHash('md5');
    const sha1 = new this._Sha1Ctx();
    /** 0-based index -> etag (filled as parts complete, order preserved) */
    const etags = [];
    let loaded = 0;
    let partCount = 0;

    // Produce parts while advancing the hash chain. The generator runs ahead
    // of the network: its awaits are stream reads + CPU hashing.
    async function* produce() {
      for await (const buf of self._iterParts(opts, pre.partSize)) {
        partCount++;
        // snapshot the state BEFORE this part (covers parts 1..N-1)
        const hashCtxB64 = partCount >= 2 ? sha1.exportStateB64() : null;
        md5.update(buf);
        sha1.update(buf);
        yield { partNumber: partCount, buf, hashCtxB64 };
      }
    }

    const iterator = produce()[Symbol.asyncIterator]();
    const errors = [];
    const uploadOne = async () => {
      try {
        for (;;) {
          const { done, value } = await iterator.next();
          if (done) return;
          const { partNumber, buf, hashCtxB64 } = value;
          const etag = await self._putPart(pre, partNumber, buf, mimeType, hashCtxB64);
          etags[partNumber - 1] = etag;
          loaded += buf.length;
          if (opts.onProgress) {
            try { opts.onProgress(loaded, opts.size); } catch (_e) { /* ignore */ }
          }
          self.logger.debug('upload part ' + partNumber + ' done (' + buf.length + ' bytes)');
        }
      } catch (e) {
        errors.push(e);
      }
    };

    const workers = [];
    for (let w = 0; w < uploadConcurrency(pre); w++) workers.push(uploadOne());
    await Promise.all(workers);
    if (errors.length) throw errors[0];

    if (partCount === 0) {
      // Empty file: OSS still needs one (empty) part + commit.
      const etag = await this._putPart(pre, 1, Buffer.alloc(0), mimeType, null);
      etags.push(etag);
    }

    const hashRes = await this.updateHash(md5.digest('hex'), sha1.digest(), pre);
    if (hashRes.finish) {
      // 秒传: file already exists server-side; skip commit.
      const data = await this.finish(pre);
      return { fid: data && data.fid ? String(data.fid) : null, rapid: true, taskId: pre.taskId };
    }
    await this.commit(pre, etags);
    const data = await this.finish(pre);
    return { fid: data && data.fid ? String(data.fid) : null, rapid: false, taskId: pre.taskId };
  }

  /** Split the input into partSize chunks. */
  async *_iterParts(opts, partSize) {
    if (opts.buffer) {
      const buf = opts.buffer;
      for (let off = 0; off < buf.length; off += partSize) {
        yield buf.subarray(off, Math.min(off + partSize, buf.length));
      }
      return;
    }
    if (!opts.stream) throw new UploadError('input', 'no stream or buffer provided');
    // Preallocated fill-and-flush accumulator: re-concatenating the pending
    // buffer on every chunk is quadratic (a 64 MiB part ingests at ~3 MB/s
    // that way); copying into a fixed buffer is linear. Each flushed part is
    // a fresh allocation because the consumer holds it across the PUT await.
    let acc = Buffer.allocUnsafe(partSize);
    let accLen = 0;
    for await (const raw of opts.stream) {
      if (!raw || raw.length === 0) continue;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(partSize - accLen, chunk.length - off);
        chunk.copy(acc, accLen, off, off + take);
        accLen += take;
        off += take;
        if (accLen === partSize) {
          yield acc;
          acc = Buffer.allocUnsafe(partSize);
          accLen = 0;
        }
      }
    }
    if (accLen > 0) yield acc.subarray(0, accLen);
  }
}

module.exports = { Uploader, UploadError, DEFAULT_PART_SIZE, uploadConcurrency };
