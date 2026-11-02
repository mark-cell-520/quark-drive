'use strict';
/**
 * http.test.js — unit tests for the cookie jar and HTTP client.
 * Uses an injected fake fetch so no network is touched.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { HttpClient, CookieJar, AuthError, parseSetCookie } = require('../../core/quark/http.js');

/** Build a minimal fetch-like Response. */
function res(status, { headers = {}, body = '' } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: {
      get: (k) => h.get(String(k).toLowerCase()) ?? null,
      getSetCookie: () => (h.has('set-cookie') ? [h.get('set-cookie')] : []),
    },
    arrayBuffer: async () => Buffer.from(body),
    text: async () => body,
  };
}

test('parseSetCookie extracts name/value and ignores attributes', () => {
  assert.deepEqual(parseSetCookie('__puus=abc123; Path=/; HttpOnly'), { name: '__puus', value: 'abc123' });
  assert.deepEqual(parseSetCookie('a=b; Secure'), { name: 'a', value: 'b' });
  assert.equal(parseSetCookie('novalue'), null);
  assert.equal(parseSetCookie('=noname'), null);
});

test('CookieJar ingest/header/delete semantics', () => {
  const jar = new CookieJar({ __pus: '1' });
  jar.ingest(['__puus=xyz; Path=/', 'tfstk=tt; Path=/']);
  assert.equal(jar.header(), '__pus=1; __puus=xyz; tfstk=tt');
  assert.equal(jar.size, 3);
  jar.ingest(['__pus=; Path=/']); // empty value = delete
  assert.equal(jar.header(), '__puus=xyz; tfstk=tt');
  assert.equal(jar.looksAuthenticated(), true);
  const empty = new CookieJar();
  assert.equal(empty.looksAuthenticated(), false);
  assert.equal(empty.header(), '');
  const round = CookieJar.fromJSON(jar.toJSON());
  assert.equal(round.header(), jar.header());
});

test('request sends UA, referer, origin and cookie headers; parses JSON', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return res(200, { headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
  };
  const http = new HttpClient({
    fetchImpl: fakeFetch,
    userAgent: 'TestUA/1.0',
    cookieJar: new CookieJar({ __puus: 's1' }),
  });
  const out = await http.requestJson('GET', 'https://drive-pc.quark.cn/1/clouddrive/member', {
    query: { fetch_subscribe: 'true', _ch: 'home' },
  });
  assert.deepEqual(out, { ok: true });
  assert.match(seen[0].url, /fetch_subscribe=true/);
  assert.equal(seen[0].init.headers['User-Agent'], 'TestUA/1.0');
  assert.equal(seen[0].init.headers.Referer, 'https://pan.quark.cn/');
  assert.equal(seen[0].init.headers.Cookie, '__puus=s1');
});

test('request ingests Set-Cookie from responses (session rotation)', async () => {
  const fakeFetch = async () => res(200, {
    headers: { 'content-type': 'application/json', 'set-cookie': '__puus=newval; Path=/; HttpOnly' },
    body: '{}',
  });
  const http = new HttpClient({ fetchImpl: fakeFetch });
  await http.request('GET', 'https://pan.quark.cn/x');
  assert.equal(http.cookieJar.header(), '__puus=newval');
});

test('manual redirect following keeps ingesting cookies, max 10 hops', async () => {
  let hops = 0;
  const fakeFetch = async (url) => {
    hops++;
    if (hops < 3) {
      return res(302, { headers: { location: 'https://pan.quark.cn/next' + hops, 'set-cookie': 'c' + hops + '=v' + hops } });
    }
    return res(200, { headers: { 'content-type': 'application/json' }, body: '{"done":1}' });
  };
  const http = new HttpClient({ fetchImpl: fakeFetch });
  const out = await http.requestJson('GET', 'https://pan.quark.cn/start');
  assert.deepEqual(out, { done: 1 });
  assert.equal(hops, 3);
  assert.equal(http.cookieJar.header(), 'c1=v1; c2=v2');
});

test('redirect loop is capped at maxRedirects', async () => {
  let hops = 0;
  const fakeFetch = async () => {
    hops++;
    return res(302, { headers: { location: 'https://pan.quark.cn/loop' } });
  };
  const http = new HttpClient({ fetchImpl: fakeFetch, maxRedirects: 3 });
  const out = await http.request('GET', 'https://pan.quark.cn/loop');
  assert.equal(out.status, 302);
  assert.equal(hops, 4); // initial + 3 redirects
});

test('401/403 responses raise AuthError', async () => {
  const http = new HttpClient({ fetchImpl: async () => res(401, { body: 'nope' }) });
  await assert.rejects(http.requestJson('GET', 'https://drive-pc.quark.cn/x'), AuthError);
});

test('HTML body raises AuthError EXCEPTION_BODY (WAF/login page)', async () => {
  const http = new HttpClient({
    fetchImpl: async () => res(200, { headers: { 'content-type': 'text/html' }, body: '<html>login</html>' }),
  });
  await assert.rejects(http.requestJson('GET', 'https://drive-pc.quark.cn/x'), (e) => {
    assert.ok(e instanceof AuthError);
    assert.equal(e.code, 'EXCEPTION_BODY');
    return true;
  });
});

test('invalid JSON on a 200 raises a plain Error', async () => {
  const http = new HttpClient({
    fetchImpl: async () => res(200, { headers: { 'content-type': 'application/json' }, body: 'not json' }),
  });
  await assert.rejects(http.requestJson('GET', 'https://drive-pc.quark.cn/x'), /invalid JSON/);
});

test('raw mode returns the response for streaming downloads', async () => {
  const http = new HttpClient({
    fetchImpl: async () => res(200, { headers: { 'content-type': 'application/octet-stream' }, body: 'binarydata' }),
  });
  const out = await http.request('GET', 'https://cdn.example.com/f', { raw: true });
  assert.equal(out.status, 200);
  assert.equal(out.body, null);
  assert.ok(out.response);
});

test('N-5: raw download body has an idle watchdog (headers-only timeout is not enough)', async () => {
  const { Readable } = require('node:stream');
  // a body that never produces a byte: only a body-level timeout can save us
  const stalling = new Readable({ read() { /* never pushes */ } });
  const http = new HttpClient({
    fetchImpl: async () => new Response(Readable.toWeb(stalling), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
  });
  const t0 = Date.now();
  const out = await http.request('GET', 'https://cdn.example.com/f', { raw: true, timeoutMs: 150 });
  // headers resolve promptly...
  assert.equal(out.status, 200);
  assert.ok(Date.now() - t0 < 100, 'headers must not wait for the body');
  // ...but the body must eventually error instead of hanging forever
  await assert.rejects(
    (async () => { for await (const _c of Readable.fromWeb(out.response.body)) { /* drain */ } })(),
    /stalled|abort/i,
  );
});

test('N-5: raw body watchdog rearms on data and clears on completion', async () => {
  const { Readable } = require('node:stream');
  let pushed = false;
  const body = new Readable({
    read() {
      if (pushed) return;
      pushed = true;
      this.push(Buffer.from('chunk'));
      setTimeout(() => this.push(null), 50);
    },
  });
  const http = new HttpClient({
    fetchImpl: async () => new Response(Readable.toWeb(body), { status: 200, headers: {} }),
  });
  const out = await http.request('GET', 'https://cdn.example.com/f', { raw: true, timeoutMs: 300 });
  let bytes = 0;
  for await (const c of Readable.fromWeb(out.response.body)) bytes += c.length;
  assert.equal(bytes, 5);
});

test('query params: undefined/null values are skipped', async () => {
  const seen = [];
  const http = new HttpClient({
    fetchImpl: async (url) => { seen.push(url); return res(200, { headers: { 'content-type': 'application/json' }, body: '{}' }); },
  });
  await http.requestJson('GET', 'https://x.test/a', { query: { keep: '1', drop: undefined, skip: null } });
  assert.match(seen[0], /keep=1/);
  assert.doesNotMatch(seen[0], /drop/);
  assert.doesNotMatch(seen[0], /skip/);
});

test('cross-host redirects are followed but cookies are dropped (no session leak)', async () => {
  const seenHosts = [];
  const fakeFetch = async (url, init) => {
    const u = new URL(url);
    seenHosts.push({ host: u.host, cookie: init.headers.Cookie || null });
    if (u.host === 'drive-pc.quark.cn') {
      return res(302, { headers: { location: 'https://cdn.aliyuncs.com/file?sig=1' } });
    }
    return res(200, { headers: { 'content-type': 'application/octet-stream' }, body: 'FILEDATA' });
  };
  const http = new HttpClient({
    fetchImpl: fakeFetch,
    cookieJar: new CookieJar({ __puus: 'secret-session' }),
  });
  const out = await http.request('GET', 'https://drive-pc.quark.cn/1/clouddrive/file/download', { raw: true });
  assert.equal(seenHosts.length, 2);
  assert.equal(seenHosts[0].host, 'drive-pc.quark.cn');
  assert.equal(seenHosts[0].cookie, '__puus=secret-session');
  assert.equal(seenHosts[1].host, 'cdn.aliyuncs.com');
  assert.equal(seenHosts[1].cookie, null, 'cookie must not leak to the CDN host');
  assert.equal(out.status, 200);
});

test('same-host redirects keep sending cookies', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(init.headers.Cookie || null);
    if (seen.length === 1) return res(302, { headers: { location: 'https://pan.quark.cn/next' } });
    return res(200, { headers: { 'content-type': 'application/json' }, body: '{}' });
  };
  const http = new HttpClient({ fetchImpl: fakeFetch, cookieJar: new CookieJar({ a: '1' }) });
  await http.request('GET', 'https://pan.quark.cn/start');
  assert.deepEqual(seen, ['a=1', 'a=1']);
});

test('H-1: the session cookie is NEVER sent to a non-Quark host (fail-closed allowlist)', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, cookie: init.headers.Cookie || null });
    return res(200, { headers: { 'content-type': 'application/json' }, body: '{}' });
  };
  const http = new HttpClient({
    fetchImpl: fakeFetch,
    cookieJar: new CookieJar({ __puus: 'secret-session', __pus: 'x' }),
  });
  // even without noCookie — a caller that forgets the flag must not leak
  await http.requestJson('GET', 'https://evil.example.com/collect');
  assert.equal(seen[0].cookie, null, 'no cookie to a foreign host, no matter what the caller passes');
  // ...but Quark API hosts still get it
  await http.requestJson('GET', 'https://drive-pc.quark.cn/1/clouddrive/member');
  assert.equal(seen[1].cookie, '__puus=secret-session; __pus=x');
  await http.requestJson('GET', 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin');
  assert.equal(seen[2].cookie, '__puus=secret-session; __pus=x');
});
