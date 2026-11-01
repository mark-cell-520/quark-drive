'use strict';
/**
 * auth.test.js — QR login flow unit tests with a stubbed HttpClient.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { QrLogin, redactQrUrl } = require('../../core/quark/auth.js');
const { CookieJar } = require('../../core/quark/http.js');
const { Device } = require('../../core/device.js');

function makeDevice() {
  return new Device({ machineId: 'machine-uuid-123', deviceName: 'QuarkDrive-TESTPC' });
}

/** Fake HttpClient that serves canned responses per URL substring. */
function fakeHttp(routes, jar) {
  const calls = [];
  return {
    calls,
    cookieJar: jar || new CookieJar(),
    async requestJson(method, url, opts = {}) {
      calls.push({ method, url, opts });
      for (const r of routes) {
        if (url.includes(r.match)) return typeof r.response === 'function' ? r.response() : r.response;
      }
      throw new Error('unexpected URL: ' + url);
    },
    async request(method, url, opts = {}) {
      calls.push({ method, url, opts });
      for (const r of routes) {
        if (url.includes(r.match)) return typeof r.response === 'function' ? r.response() : r.response;
      }
      throw new Error('unexpected URL: ' + url);
    },
  };
}

const OK_TOKEN = { status: 2000000, data: { members: { token: 'tok-abc' } } };

test('start() fetches a token and builds the scan URL with all params', async () => {
  const http = fakeHttp([{ match: 'getTokenForQrcodeLogin', response: OK_TOKEN }]);
  const login = new QrLogin({ http, device: makeDevice() });
  const out = await login.start();
  assert.equal(out.token, 'tok-abc');
  const u = new URL(out.qrUrl);
  assert.equal(u.origin + u.pathname, 'https://su.quark.cn/4_eMHBJ');
  assert.equal(u.searchParams.get('token'), 'tok-abc');
  assert.equal(u.searchParams.get('client_id'), '386');
  assert.equal(u.searchParams.get('sch'), 'pckk@information_ch');
  assert.equal(u.searchParams.get('sve'), '3.24.0');
  assert.equal(u.searchParams.get('ssb'), 'weblogin');
  assert.match(u.searchParams.get('uc_biz_str'), /OPT:SAREA@0/);
  assert.ok(out.expiresAt > Date.now());
});

test('start() sends device params (ut/mi) and required protocol params', async () => {
  const http = fakeHttp([{ match: 'getTokenForQrcodeLogin', response: OK_TOKEN }]);
  await new QrLogin({ http, device: makeDevice() }).start();
  const q = http.calls[0].opts.query;
  assert.equal(q.ut, 'machine-uuid-123');
  assert.equal(q.mi, 'QuarkDrive-TESTPC');
  assert.equal(q.pr, 'ucpro');
  assert.equal(q.fr, 'pc');
  assert.equal(q.sys, 'win32');
  assert.equal(q.client_id, '386');
  assert.equal(q.v, '1.2');
  assert.ok(q.request_id);
});

test('start() throws when the token endpoint fails', async () => {
  const http = fakeHttp([{ match: 'getTokenForQrcodeLogin', response: { status: 500, message: 'boom' } }]);
  await assert.rejects(new QrLogin({ http, device: makeDevice() }).start(), /getTokenForQrcodeLogin failed/);
});

test('poll() maps waiting / confirmed / expired statuses', async () => {
  const http = fakeHttp([
    { match: 'getTokenForQrcodeLogin', response: OK_TOKEN },
    { match: 'getServiceTicketByQrcodeToken', response: () => ({ status: 50004001, message: 'empty' }) },
  ]);
  const login = new QrLogin({ http, device: makeDevice() });
  await login.start();
  assert.deepEqual(await login.poll(), { status: 'waiting', rawStatus: 50004001, message: 'empty' });

  http.calls.length = 0;
  // swap route
  http.requestJson = async () => ({ status: 2000000, data: { members: { service_ticket: 'st-1' } } });
  assert.deepEqual(await login.poll(), { status: 'confirmed', ticket: 'st-1', rawStatus: 2000000 });

  http.requestJson = async () => ({ status: 50004002, message: 'expired' });
  assert.equal((await login.poll()).status, 'expired');
});

test('poll() throws before start()', async () => {
  const login = new QrLogin({ http: fakeHttp([]), device: makeDevice() });
  await assert.rejects(login.poll(), /call start\(\) first/);
});

test('complete() exchanges the ticket and requires a session cookie', async () => {
  const jar = new CookieJar();
  const http = fakeHttp([
    {
      match: 'desktop/account/login',
      response: { status: 200, headers: new Map(), body: Buffer.from('{"success":true}'), url: '' },
    },
  ], jar);
  jar.ingest(['__puus=session-1; Path=/; HttpOnly']);
  const login = new QrLogin({ http, device: makeDevice() });
  const out = await login.complete('st-xyz');
  assert.deepEqual(out.cookies, { __puus: 'session-1' });
  const call = http.calls[0];
  assert.equal(call.opts.query.st, 'st-xyz');
  assert.equal(call.opts.query.ut, 'machine-uuid-123');
  assert.equal(call.opts.query.mi, 'QuarkDrive-TESTPC');
});

test('complete() rejects when no session cookie was set', async () => {
  const http = fakeHttp([
    { match: 'desktop/account/login', response: { status: 200, headers: new Map(), body: Buffer.from(''), url: '' } },
  ], new CookieJar());
  await assert.rejects(new QrLogin({ http, device: makeDevice() }).complete('st'), /no session cookie/);
});

test('run() waits for the scan, refreshes on expiry, then completes', async () => {
  const jar = new CookieJar({ __puus: 'sess-final' });
  let polls = 0;
  const http = {
    cookieJar: jar,
    calls: [],
    async requestJson(method, url) {
      if (url.includes('getTokenForQrcodeLogin')) return OK_TOKEN;
      if (url.includes('getServiceTicketByQrcodeToken')) {
        polls++;
        if (polls === 1) return { status: 50004001, message: 'empty' }; // waiting
        if (polls === 2) return { status: 50004002, message: 'expired' }; // expired -> refresh
        return { status: 2000000, data: { members: { service_ticket: 'st-final' } } };
      }
      throw new Error('unexpected ' + url);
    },
    async request(method, url) {
      return { status: 200, headers: new Map(), body: Buffer.from('{}'), url };
    },
  };
  const statuses = [];
  const login = new QrLogin({ http, device: makeDevice() });
  const out = await login.run({
    onStatus: (s) => statuses.push(s),
    onQr: () => {},
    intervalMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(out.cookies, { __puus: 'sess-final' });
  assert.ok(statuses.includes('waiting for scan'));
  assert.ok(statuses.includes('qr expired, refreshing'));
  assert.ok(statuses.includes('scan confirmed'));
});

test('run() respects an abort signal', async () => {
  const http = {
    cookieJar: new CookieJar(),
    async requestJson(method, url) {
      if (url.includes('getTokenForQrcodeLogin')) return OK_TOKEN;
      return { status: 50004001 };
    },
    async request() { throw new Error('should not reach'); },
  };
  const login = new QrLogin({ http, device: makeDevice() });
  await assert.rejects(login.run({ intervalMs: 1, sleep: async () => {}, signal: { aborted: true } }), /aborted/);
});

test('redactQrUrl strips the live token', () => {
  const url = 'https://su.quark.cn/4_eMHBJ?token=SECRET&client_id=386';
  const red = redactQrUrl(url);
  assert.doesNotMatch(red, /SECRET/);
  assert.match(red, /token=%3Credacted%3E/);
  assert.equal(redactQrUrl('not a url'), '<scan-url>');
});

test('N-3: start/poll/complete forward the abort signal to HTTP', async () => {
  const http = fakeHttp([
    { match: 'getTokenForQrcodeLogin', response: OK_TOKEN },
    { match: 'getServiceTicketByQrcodeToken', response: { status: 50004001 } },
    { match: 'desktop/account/login', response: { status: 200, headers: new Map(), body: Buffer.from('') } },
  ]);
  http.cookieJar.ingest(['__puus=s; Path=/']);
  const ac = new AbortController();
  const login = new QrLogin({ http, device: makeDevice() });
  await login.start({ signal: ac.signal });
  assert.equal(http.calls[0].opts.signal, ac.signal, 'start must forward the signal');
  await login.poll({ signal: ac.signal });
  assert.equal(http.calls[1].opts.signal, ac.signal, 'poll must forward the signal');
  await login.complete('st', { signal: ac.signal });
  assert.equal(http.calls[2].opts.signal, ac.signal, 'complete must forward the signal');
});

test('N-3: an abort during an in-flight poll rejects the flow immediately', async () => {
  const ac = new AbortController();
  const http = {
    cookieJar: new CookieJar(),
    async requestJson(method, url, opts) {
      if (url.includes('getTokenForQrcodeLogin')) return OK_TOKEN;
      // poll hangs until the signal fires — exactly what HttpClient does
      // with a real fetch when the caller aborts
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    async request() { throw new Error('should not reach'); },
  };
  const login = new QrLogin({ http, device: makeDevice() });
  const p = login.run({ intervalMs: 1, sleep: async () => {}, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /aborted/);
});
