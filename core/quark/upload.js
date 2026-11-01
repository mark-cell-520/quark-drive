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
    return {
      taskId: String(data.task_id || ''),
      bucket: String(data.bucket || ''),
      objKey: String(data.obj_key || ''),
      uploadId: String(data.upload_id || ''),
      uploadUrl: String(data.upload_url || ''),
      authInfo: data.auth_info,
      callback: data.callback,
      partSize,
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

  /** PUT one part. Returns the ETag. */
  async _putPart(pre, partNumber, chunk, mimeType, sha1) {
    const date = rfc1123(new Date());
    let authMeta = 'PUT\n\n' + mimeType + '\n' + date + '\n';
    const headers = {
      'Content-Type': mimeType,
      'x-oss-date': date,
      'x-oss-user-agent': OSS_USER_AGENT,
    };
    if (partNumber >= 2 && sha1) {
      const ctxB64 = sha1.exportStateB64();
      authMeta += 'X-Oss-Hash-Ctx:' + ctxB64 + '\n';
      headers['X-Oss-Hash-Ctx'] = ctxB64;
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
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/update/hash', {
      query: this._params(),
      body: JSON.stringify({ md5: md5hex, sha1: sha1hex, task_id: pre.taskId }),
    });
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
    let callbackB64 = '';
    try {
      if (typeof pre.callback === 'string') callbackB64 = b64(Buffer.from(pre.callback, 'utf8'));
      else if (pre.callback && typeof pre.callback === 'object') callbackB64 = b64(Buffer.from(JSON.stringify(pre.callback), 'utf8'));
      else callbackB64 = b64(Buffer.from(String(pre.callback || ''), 'utf8'));
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

    const md5 = crypto.createHash('md5');
    const sha1 = new this._Sha1Ctx();
    const etags = [];
    let loaded = 0;

    const parts = this._iterParts(opts, pre.partSize);

    let partNumber = 0;
    for await (const partBuf of parts) {
      partNumber++;
      // NOTE: the hash state must lag one part behind the PUT — OSS expects
      // X-Oss-Hash-Ctx of part N to cover parts 1..N-1. So we feed the hash
      // only after the current part has been accepted.
      const etag = await this._putPart(pre, partNumber, partBuf, mimeType, sha1);
      md5.update(partBuf);
      sha1.update(partBuf);
      etags.push(etag);
      loaded += partBuf.length;
      if (opts.onProgress) {
        try { opts.onProgress(loaded, opts.size); } catch (_e) { /* ignore */ }
      }
      this.logger.debug('upload part ' + partNumber + ' done (' + partBuf.length + ' bytes)');
    }
    if (partNumber === 0) {
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
    let acc = Buffer.alloc(0);
    for await (const chunk of opts.stream) {
      if (!chunk || chunk.length === 0) continue;
      acc = acc.length ? Buffer.concat([acc, chunk]) : Buffer.from(chunk);
      while (acc.length >= partSize) {
        const part = acc.subarray(0, partSize);
        acc = acc.subarray(partSize);
        yield part;
      }
    }
    if (acc.length > 0) yield acc;
  }
}

module.exports = { Uploader, UploadError, DEFAULT_PART_SIZE };
