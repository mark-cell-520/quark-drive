'use strict';
/**
 * api.js — Quark cloud-drive operations (drive-pc.quark.cn).
 *
 * Every method goes through HttpClient (cookie jar + auth detection) and
 * re-checks business-level auth codes (31001/31004, NO_AUTH, AUTH_ERROR*),
 * raising AuthError so callers can trigger a re-login.
 */
const { AuthError } = require('./http.js');

const DRIVE = 'https://drive-pc.quark.cn';
const PAN = 'https://pan.quark.cn';
const APP_VER = '2.5.56';

/** Business codes that mean "session invalid — re-scan required". */
const AUTH_CODES = new Set(['NO_AUTH', 'AUTH_ERROR', 'AUTH_ERROR:50051', 'AUTH_ERROR:50052', '31001', '31004']);

function isAuthPayload(out) {
  if (!out || typeof out !== 'object') return null;
  const code = out.code;
  if (typeof code === 'number' && (code === 31001 || code === 31004)) {
    return { code: String(code), message: out.message || '请重新登录' };
  }
  if (typeof code === 'string' && (AUTH_CODES.has(code) || code.startsWith('AUTH_ERROR'))) {
    return { code, message: out.message || code };
  }
  if (out.success === false && typeof code === 'string' && (AUTH_CODES.has(code) || code.startsWith('AUTH_ERROR'))) {
    return { code, message: out.message || code };
  }
  if (typeof out.message === 'string' && /重新登录|not login/i.test(out.message)) {
    return { code: String(code), message: out.message };
  }
  return null;
}

function asInt(v) {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}

/** Quark timestamps are seconds (sometimes ms for newer fields). */
function toDate(ts) {
  const n = asInt(ts);
  if (n == null) return new Date(0);
  const ms = n < 1e12 ? n * 1000 : n;
  // Absurd/negative values must not produce an Invalid Date (would 500 listings)
  if (!Number.isFinite(ms) || ms < -8.64e15 || ms > 8.64e15) return new Date(0);
  const d = new Date(ms);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

class QuarkApi {
  /**
   * @param {{
   *   http: import('./http.js').HttpClient,
   *   device: import('../device.js').Device,
   *   logger?: {debug: Function, warn: Function},
   *   sleep?: (ms: number) => Promise<void>,
   * }} deps
   */
  constructor(deps) {
    this.http = deps.http;
    this.device = deps.device;
    this.logger = deps.logger || { debug() {}, warn() {} };
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Common query params appended to drive/pan endpoints. */
  _params(extra) {
    return Object.assign({
      pr: 'ucpro',
      fr: 'pc',
      sys: 'win32',
      ut: this.device.ut,
      mi: this.device.mi,
    }, extra || {});
  }

  /** Verify a drive response, raising AuthError / Error as appropriate. */
  _check(out, what) {
    const auth = isAuthPayload(out);
    if (auth) throw new AuthError({ code: auth.code, message: auth.message });
    if (!out || typeof out !== 'object') throw new Error(what + ': empty response');
    const code = asInt(out.code);
    if (code !== null && code !== 0 && code !== 200) {
      throw new Error(what + ': code=' + out.code + ' message=' + (out.message || ''));
    }
    return out;
  }

  /** Member/capacity info. */
  async member() {
    const out = await this.http.requestJson('GET', DRIVE + '/1/clouddrive/member', {
      query: this._params({ fetch_subscribe: 'true', fetch_identity: 'true', _ch: 'home' }),
    });
    this._check(out, 'member');
    return (out.data && typeof out.data === 'object') ? out.data : {};
  }

  /** Account nickname/avatar. */
  async userInfo() {
    let out = await this.http.requestJson('GET', PAN + '/desktop/account/userinfo', {
      query: this._params(),
    });
    this._check(out, 'userinfo');
    let data = out.data;
    if (!data || typeof data !== 'object') {
      out = await this.http.requestJson('GET', PAN + '/account/info', {
        query: this._params({ platform: 'pc' }),
      });
      this._check(out, 'account/info');
      data = out.data || {};
    }
    return data;
  }

  /**
   * List one directory page.
   * @returns {Promise<{entries: Array<object>, total: number}>}
   *   entries keep the raw fields: fid, file_name, size, dir, file_type,
   *   updated_at, created_at, ...
   */
  async listDir(pdirFid, opts = {}) {
    const fid = pdirFid || '0';
    const page = opts.page || 1;
    const size = opts.size || 100;
    const out = await this.http.requestJson('GET', DRIVE + '/1/clouddrive/file/sort', {
      query: this._params({
        pdir_fid: fid,
        _page: String(page),
        _size: String(size),
        _fetch_total: '1',
        _fetch_sub_dirs: '0',
        _sort: 'file_type:asc,updated_at:desc',
      }),
    });
    this._check(out, 'file/sort');
    const data = out.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    const total = asInt(data.total);
    return { entries: list, total: total == null ? list.length : total };
  }

  /** List every entry of a directory (follows pagination). */
  async listDirAll(pdirFid, opts = {}) {
    const size = opts.size || 100;
    const first = await this.listDir(pdirFid, { page: 1, size });
    const entries = first.entries.slice();
    let page = 2;
    while (entries.length < first.total && page <= 200) {
      const next = await this.listDir(pdirFid, { page, size });
      if (!next.entries.length) break;
      entries.push(...next.entries);
      page++;
    }
    return entries;
  }

  /**
   * Resolve a CDN download URL for a file fid.
   * Handles the async task form and the 23018 desktop-UA fallback.
   * @returns {Promise<{url: string, size: number}>}
   */
  async getDownloadUrl(fid) {
    const body = JSON.stringify({ fids: [fid] });
    let out;
    try {
      out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/download', {
        query: this._params(),
        body,
      });
    } catch (e) {
      const msg = String(e && e.message || e);
      const isSizeLimit = /23018/.test(msg) || /download file size limit/i.test(msg);
      if (!isSizeLimit) throw e;
      // Desktop client identity unlocks large-file links.
      this.logger.debug('download: retrying with desktop client identity (23018)');
      out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/download?sys=win32&ve=' + APP_VER + '&ut=&guid=', {
        body,
        headers: { 'User-Agent': this.device.userAgent() },
      });
    }
    this._check(out, 'file/download');
    const data = out.data;
    if (Array.isArray(data) && data.length > 0 && data[0] && data[0].download_url) {
      return { url: String(data[0].download_url).trim(), size: asInt(data[0].size) || 0 };
    }
    if (data && typeof data === 'object' && typeof data.task_id === 'string' && data.task_id) {
      // async: task_resp may already carry the url
      const tr = data.task_resp && data.task_resp.data;
      if (Array.isArray(tr) && tr[0] && tr[0].download_url) {
        return { url: String(tr[0].download_url).trim(), size: asInt(tr[0].size) || 0 };
      }
      return this._waitDownloadTask(data.task_id);
    }
    throw new Error('file/download: no url in response');
  }

  async _waitDownloadTask(taskId, opts = {}) {
    const intervalMs = opts.intervalMs || 2000;
    const timeoutMs = opts.timeoutMs || 120000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.sleep(intervalMs);
      const out = await this.http.requestJson('GET', DRIVE + '/1/clouddrive/task', {
        query: this._params({ task_id: taskId, retry_index: '0' }),
      });
      this._check(out, 'task');
      const d = out.data;
      if (!d || typeof d !== 'object') continue;
      const status = asInt(d.status);
      if (status === 3) throw new Error('download task failed (status=3)');
      if (status === 2) {
        if (d.download_url) return { url: String(d.download_url).trim(), size: asInt(d.size) || 0 };
        const arr = Array.isArray(d.data) ? d.data : null;
        if (arr && arr[0] && arr[0].download_url) {
          return { url: String(arr[0].download_url).trim(), size: asInt(arr[0].size) || 0 };
        }
        throw new Error('download task finished without url');
      }
      if (Date.now() > deadline) throw new Error('download task timeout');
    }
  }

  /** Create a directory. @returns {Promise<string>} new fid */
  async mkdir(pdirFid, name) {
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file', {
      query: this._params(),
      body: JSON.stringify({
        pdir_fid: pdirFid || '0',
        file_name: name,
        dir_path: '',
        dir_init_lock: false,
      }),
    });
    this._check(out, 'mkdir');
    const fid = out.data && out.data.fid;
    if (!fid) throw new Error('mkdir: no fid in response');
    return String(fid);
  }

  /** Rename a file/dir. */
  async rename(fid, newName) {
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/rename', {
      query: this._params(),
      body: JSON.stringify({ fid, file_name: newName }),
    });
    this._check(out, 'rename');
    return out.data || {};
  }

  /** Move fids into another directory. */
  async move(fids, toPdirFid) {
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/move', {
      query: this._params(),
      body: JSON.stringify({
        action_type: 1,
        exclude_fids: [],
        filelist: fids,
        to_pdir_fid: toPdirFid || '0',
      }),
    });
    this._check(out, 'move');
    return out.data || {};
  }

  /** Delete fids. */
  async remove(fids) {
    const out = await this.http.requestJson('POST', DRIVE + '/1/clouddrive/file/delete', {
      query: this._params(),
      body: JSON.stringify({
        action_type: 1,
        exclude_fids: [],
        filelist: fids,
      }),
    });
    this._check(out, 'delete');
    return out.data || {};
  }

  /**
   * Walk a POSIX path from the root and return the final node.
   * @returns {Promise<{fid: string, isDir: boolean, entry: object}>}
   */
  async resolvePath(posixPath) {
    const parts = String(posixPath || '').split('/').filter(Boolean);
    let cur = '0';
    let entry = { fid: '0', file_name: '/', dir: true, file_type: 0 };
    for (const name of parts) {
      const entries = await this.listDirAll(cur);
      const found = entries.find((e) => e && e.file_name === name);
      if (!found) {
        const err = new Error('ENOENT: ' + posixPath);
        err.code = 'ENOENT';
        throw err;
      }
      entry = found;
      cur = String(found.fid);
    }
    return { fid: cur, isDir: isDirEntry(entry), entry };
  }
}

/** A list entry is a directory when dir==1 (or true) or file_type==0 (matches the desktop client). */
function isDirEntry(entry) {
  if (!entry) return false;
  if (entry.dir === true) return true;
  if (asInt(entry.dir) === 1) return true;
  return asInt(entry.file_type) === 0;
}

module.exports = { QuarkApi, isAuthPayload, isDirEntry, toDate, DRIVE, PAN, AUTH_CODES };
