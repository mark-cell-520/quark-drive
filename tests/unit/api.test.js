'use strict';
/**
 * api.test.js — QuarkApi unit tests against a stubbed HttpClient.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { QuarkApi, isAuthPayload, isDirEntry, toDate } = require('../../core/quark/api.js');
const { AuthError } = require('../../core/quark/http.js');
const { Device } = require('../../core/device.js');

function makeApi(handler, jarCookies) {
  const calls = [];
  const http = {
    calls,
    cookieJar: { header: () => '' },
    async requestJson(method, url, opts = {}) {
      calls.push({ method, url, opts });
      return handler(method, url, opts);
    },
    async request(method, url, opts = {}) {
      calls.push({ method, url, opts });
      return handler(method, url, opts);
    },
  };
  const api = new QuarkApi({ http, device: new Device({ machineId: 'm1', deviceName: 'PC1' }), sleep: async () => {} });
  return { api, calls };
}

const LIST_OK = {
  code: 0, status: 200, message: 'ok',
  data: {
    total: 2,
    list: [
      { fid: 'f1', file_name: 'docs', size: 0, dir: true, file_type: 0, updated_at: 1700000000 },
      { fid: 'f2', file_name: 'a.txt', size: 123, dir: false, file_type: 4, updated_at: 1700000001 },
    ],
  },
};

test('listDir sends paging/sort params and returns entries', async () => {
  const { api, calls } = makeApi(async () => LIST_OK);
  const out = await api.listDir('0', { page: 1, size: 50 });
  assert.equal(out.entries.length, 2);
  assert.equal(out.total, 2);
  const q = calls[0].opts.query;
  assert.equal(calls[0].url, 'https://drive-pc.quark.cn/1/clouddrive/file/sort');
  assert.equal(q.pdir_fid, '0');
  assert.equal(q._page, '1');
  assert.equal(q._size, '50');
  assert.equal(q._sort, 'file_type:asc,updated_at:desc');
  assert.equal(q.ut, 'm1');
  assert.equal(q.mi, 'PC1');
});

test('listDirAll follows pagination until total is reached', async () => {
  let page = 0;
  const { api } = makeApi(async (_m, _u, opts) => {
    page = Number(opts.query._page);
    return {
      code: 0, status: 200,
      data: { total: 3, list: page === 1 ? [{ fid: 'a' }, { fid: 'b' }] : [{ fid: 'c' }] },
    };
  });
  const entries = await api.listDirAll('root');
  assert.deepEqual(entries.map((e) => e.fid), ['a', 'b', 'c']);
});

test('listDir surfaces business errors', async () => {
  const { api } = makeApi(async () => ({ code: 31001, message: '请重新登录' }));
  await assert.rejects(api.listDir('0'), (e) => e instanceof AuthError && e.code === '31001');
  const { api: api2 } = makeApi(async () => ({ code: 900, message: 'bad' }));
  await assert.rejects(api2.listDir('0'), /file\/sort: code=900/);
});

test('getDownloadUrl returns the sync url', async () => {
  const { api, calls } = makeApi(async () => ({
    code: 0, status: 200, data: [{ fid: 'f2', download_url: 'https://cdn.example.com/x?sig=1', size: 123 }],
  }));
  const out = await api.getDownloadUrl('f2');
  assert.equal(out.url, 'https://cdn.example.com/x?sig=1');
  assert.equal(out.size, 123);
  assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.parse(calls[0].opts.body).fids[0], 'f2');
});

test('getDownloadUrl polls the task on the async form', async () => {
  let n = 0;
  const { api } = makeApi(async (_m, url) => {
    if (url.includes('/1/clouddrive/task')) {
      n++;
      return { code: 0, status: 200, data: n < 2 ? { status: 1 } : { status: 2, download_url: 'https://cdn/final' } };
    }
    return { code: 0, status: 200, data: { task_id: 't1', task_sync: false } };
  });
  const out = await api.getDownloadUrl('f2');
  assert.equal(out.url, 'https://cdn/final');
  assert.ok(n >= 2);
});

test('getDownloadUrl retries with the desktop identity on 23018', async () => {
  let attempts = 0;
  const { api, calls } = makeApi(async () => {
    attempts++;
    if (attempts === 1) throw new Error('download failed: code=23018 (download file size limit)');
    return { code: 0, status: 200, data: [{ download_url: 'https://cdn/big' }] };
  });
  const out = await api.getDownloadUrl('f2');
  assert.equal(out.url, 'https://cdn/big');
  assert.equal(attempts, 2);
  assert.match(calls[1].url, /sys=win32&ve=2\.5\.56/);
  assert.match(calls[1].opts.headers['User-Agent'], /quark-cloud-drive/);
});

test('mkdir returns the new fid', async () => {
  const { api, calls } = makeApi(async () => ({ code: 0, status: 200, data: { fid: 'newdir' } }));
  const fid = await api.mkdir('0', 'my folder');
  assert.equal(fid, 'newdir');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.pdir_fid, '0');
  assert.equal(body.file_name, 'my folder');
  assert.equal(body.dir_path, '');
  assert.equal(body.dir_init_lock, false);
});

test('rename/move/remove send the documented bodies', async () => {
  const { api, calls } = makeApi(async () => ({ code: 0, status: 200, data: { fid: 'x' } }));
  await api.rename('f1', 'newname.txt');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { fid: 'f1', file_name: 'newname.txt' });
  await api.move(['f1', 'f2'], 'dst');
  assert.deepEqual(JSON.parse(calls[1].opts.body), {
    action_type: 1, exclude_fids: [], filelist: ['f1', 'f2'], to_pdir_fid: 'dst',
  });
  await api.remove(['f1']);
  assert.deepEqual(JSON.parse(calls[2].opts.body), {
    action_type: 1, exclude_fids: [], filelist: ['f1'],
  });
});

test('member and userInfo extract data', async () => {
  const { api } = makeApi(async (_m, url) => {
    if (url.includes('/member')) return { code: 0, status: 200, data: { use_capacity: 5, total_capacity: 100 } };
    return { code: 0, status: 200, data: { nickname: 'me' } };
  });
  assert.deepEqual(await api.member(), { use_capacity: 5, total_capacity: 100 });
  assert.deepEqual(await api.userInfo(), { nickname: 'me' });
});

test('resolvePath walks directories and throws ENOENT', async () => {
  const tree = {
    '0': [{ fid: 'd1', file_name: 'docs', dir: true, file_type: 0 }],
    d1: [{ fid: 'f9', file_name: 'file.txt', dir: false, file_type: 4, size: 9 }],
  };
  const { api } = makeApi(async () => ({ code: 0, status: 200, data: { total: 1, list: tree['0'] } }));
  // first call lists root
  let out = await api.resolvePath('/docs');
  assert.equal(out.fid, 'd1');
  assert.equal(out.isDir, true);
  // nested walk: handler dispatches on pdir_fid
  const api2 = new QuarkApi({
    http: {
      async requestJson(_m, _u, opts) {
        const fid = opts.query.pdir_fid;
        return { code: 0, status: 200, data: { total: 1, list: tree[fid] || [] } };
      },
    },
    device: new Device({ machineId: 'm1', deviceName: 'PC1' }),
  });
  out = await api2.resolvePath('/docs/file.txt');
  assert.equal(out.fid, 'f9');
  assert.equal(out.isDir, false);
  const { api: api3 } = makeApi(async () => ({ code: 0, status: 200, data: { total: 1, list: tree['0'] } }));
  await assert.rejects(api3.resolvePath('/nope'), (e) => e.code === 'ENOENT');
});

test('isDirEntry and toDate helpers', () => {
  assert.equal(isDirEntry({ dir: true }), true);
  assert.equal(isDirEntry({ dir: 1 }), true);
  assert.equal(isDirEntry({ file_type: 0 }), true);
  assert.equal(isDirEntry({ file_type: 4, size: 10 }), false);
  assert.equal(isDirEntry(null), false);
  assert.equal(toDate(1700000000).getTime(), 1700000000000);
  assert.equal(toDate(1700000000000).getTime(), 1700000000000);
  assert.equal(toDate(null).getTime(), 0);
});

test('isAuthPayload recognises every documented auth signal', () => {
  assert.ok(isAuthPayload({ code: 31001 }));
  assert.ok(isAuthPayload({ code: 31004 }));
  assert.ok(isAuthPayload({ code: 'NO_AUTH' }));
  assert.ok(isAuthPayload({ code: 'AUTH_ERROR:50051' }));
  assert.ok(isAuthPayload({ success: false, code: 'AUTH_ERROR' }));
  assert.ok(isAuthPayload({ message: '请重新登录' }));
  assert.equal(isAuthPayload({ code: 0, message: 'ok' }), null);
  assert.equal(isAuthPayload(null), null);
});

test('HTML/401 auth errors from the transport propagate unchanged', async () => {
  const { api } = makeApi(async () => { throw new AuthError({ code: 'EXCEPTION_BODY', message: 'html' }); });
  await assert.rejects(api.listDir('0'), AuthError);
});
