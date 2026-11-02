'use strict';
/**
 * audit-findings.test.js — regression tests for the independent security
 * audit findings (F-1 … F-18). Each test maps to docs/AUDIT.md.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWebDavServer } = require('../../core/webdav/server.js');
const { QuarkFs, normalizePath } = require('../../core/webdav/quark-fs.js');
const { QuarkApi, toDate } = require('../../core/quark/api.js');
const { CookieJar, HttpClient } = require('../../core/quark/http.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../helpers/fake-quark.js');

// ------------------------------------------------------------------ F-1: MOVE

test('F-1: MOVE onto itself is rejected and destroys nothing', async () => {
  const quark = new FakeQuark();
  const removed = [];
  const api = Object.create(quark);
  api.remove = async (fids) => { removed.push(fids); return {}; };
  const qfs = new QuarkFs({ api, uploader: new FakeUploader(quark), http: new FakeDownloadHttp(quark), logger: { debug() {}, warn() {} } });
  await assert.rejects(qfs.move('/docs/a.txt', '/docs/a.txt'), (e) => e.httpStatus === 403);
  assert.deepEqual(removed, [], 'self-MOVE must not delete anything');
});

test('F-1: a failed MOVE never deletes the destination', async () => {
  const quark = new FakeQuark();
  const removed = [];
  const api = Object.create(quark);
  api.remove = async (fids) => { removed.push(fids); return {}; };
  api.move = async () => { throw new Error('quark api down'); };
  const qfs = new QuarkFs({ api, uploader: new FakeUploader(quark), http: {}, logger: { debug() {}, warn() {} }, sleep: async () => {} });
  // replace flow: the very first API call fails -> nothing is deleted
  await assert.rejects(qfs.move('/docs/a.txt', '/sp ace.txt', { overwrite: true }), /quark api down/);
  assert.deepEqual(removed, [], 'destination must survive a failed move');
});

test('F-1: MOVE replacing an existing file keeps the source safe on failure', async () => {
  const quark = new FakeQuark();
  const removed = [];
  const api = Object.create(quark);
  api.remove = async (fids) => { removed.push(fids); return {}; };
  // fail at the very first step (move into the parent) — before any delete
  api.move = async () => { throw new Error('move exploded'); };
  const qfs = new QuarkFs({ api, uploader: new FakeUploader(quark), http: {}, logger: { debug() {}, warn() {} }, sleep: async () => {} });
  await assert.rejects(qfs.move('/docs/a.txt', '/sp ace.txt', { overwrite: true }), /move exploded/);
  assert.deepEqual(removed, [], 'old destination not deleted when the replace failed');
});

// ------------------------------------------------------------------ F-2: CDN cookies

test('F-2: downloads never send the session cookie to the CDN host', async () => {
  const quark = new FakeQuark();
  const seen = [];
  const httpDouble = {
    cookieJar: new CookieJar({ __puus: 'secret-session', __pus: 'x' }),
    async request(method, url, opts) {
      seen.push({ url, noCookie: opts.noCookie, headers: opts.headers || {} });
      return {
        status: 200,
        headers: { get: (k) => ({ 'content-type': 'text/plain', 'content-length': '11' }[String(k).toLowerCase()] || null) },
        response: { body: ReadableToWeb(Buffer.from('hello world')) },
        body: null,
      };
    },
  };
  const qfs = new QuarkFs({ api: quark, uploader: new FakeUploader(quark), http: httpDouble });
  const opened = await qfs.createReadStream('/docs/a.txt');
  assert.ok(opened);
  assert.equal(seen[0].noCookie, true, 'download requests must set noCookie');
  // consume so the stream does not leak
  opened.stream.resume();
});

function ReadableToWeb(buf) {
  const { Readable } = require('node:stream');
  return Readable.toWeb(Readable.from([buf]));
}

// ------------------------------------------------------------------ F-3: auth

test('F-3: requests without the secret URL prefix are 401', async () => {
  const quark = new FakeQuark();
  const qfs = new QuarkFs({ api: quark, uploader: new FakeUploader(quark), http: new FakeDownloadHttp(quark) });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/', { method: 'PROPFIND', headers: { Depth: '0' } });
    assert.equal(res.status, 401);
    // with the token it works
    const ok = await fetch('http://127.0.0.1:' + port + server.urlPrefix + '/', { method: 'PROPFIND', headers: { Depth: '0' } });
    assert.equal(ok.status, 207);
  } finally {
    await server.closeAsync();
  }
});

test('F-3: a foreign Host header is rejected (DNS-rebinding guard)', async () => {
  const net = require('node:net');
  const quark = new FakeQuark();
  const qfs = new QuarkFs({ api: quark, uploader: new FakeUploader(quark), http: new FakeDownloadHttp(quark) });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  try {
    // raw socket so the Host header is exactly what we send
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('PROPFIND ' + server.urlPrefix + '/ HTTP/1.1\r\nHost: evil.example.com\r\nDepth: 0\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => { data += d.toString(); });
      sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)[1])));
      sock.on('error', reject);
    });
    assert.equal(status, 421);
    // and the same request with a proper Host works
    const ok = await fetch('http://127.0.0.1:' + port + server.urlPrefix + '/', { method: 'PROPFIND', headers: { Depth: '0' } });
    assert.equal(ok.status, 207);
  } finally {
    await server.closeAsync();
  }
});

// ------------------------------------------------------------------ F-4: names

test('F-4: PUT rejects control characters, dots and backslashes in names', async () => {
  const { fs } = makeFs();
  // QuarkFs receives decoded paths (the HTTP layer decodes %xx first)
  for (const bad of ['a\x01b', '..', '.', 'a\\b', 'a\x7fb']) {
    await assert.rejects(
      fs.writeFile('/' + bad, null, 1, { buffer: Buffer.from('x') }),
      (e) => e.httpStatus === 409,
      'name ' + JSON.stringify(bad) + ' must be rejected',
    );
  }
  // the root itself is a different error
  await assert.rejects(fs.writeFile('/', null, 1, { buffer: Buffer.from('x') }), (e) => e.httpStatus === 405);
});

test('F-4: MOVE rejects a destination name with control characters', async () => {
  const { fs } = makeFs();
  await assert.rejects(fs.move('/a.txt', '/b\x0cc'), (e) => e.httpStatus === 409);
  await assert.rejects(fs.move('/a.txt', '/..'), (e) => e.httpStatus === 409);
});

test('N-7: PUT/MKCOL reject Windows-illegal and reserved names', async () => {
  const { fs, api: api0 } = makeFs();
  const bad = [
    'CON', 'con.txt', 'PRN', 'aux.js', 'NUL', 'COM1', 'lpt9.dat',   // reserved devices
    'trailing.', 'trailing ', ' lead',                              // mangled by Win32
    'a?b', 'a*b', 'a:b', 'a"b', 'a<b', 'a>b', 'a|b',                // illegal chars
  ];
  for (const name of bad) {
    await assert.rejects(
      fs.writeFile('/' + name, null, 1, { buffer: Buffer.from('x') }),
      (e) => e.httpStatus === 409,
      'PUT name ' + JSON.stringify(name) + ' must be rejected',
    );
    await assert.rejects(
      fs.mkdir('/' + name),
      (e) => e.httpStatus === 409,
      'MKCOL name ' + JSON.stringify(name) + ' must be rejected',
    );
  }
  // ordinary names (including dots inside, unicode, spaces inside) still pass
  const before = api0.calls.mkdir.length;
  await fs.mkdir('/normal dir.txt');
  assert.equal(api0.calls.mkdir.length, before + 1, 'a legal name must reach the API');
  assert.deepEqual(api0.calls.mkdir[before], ['0', 'normal dir.txt']);
});

test('F-4: PROPFIND XML stays well-formed for hostile existing names', async () => {
  // a name with an XML-invalid control char already in the drive must not
  // produce malformed XML (escapeXml strips invalid chars)
  const { multistatus } = require('../../core/webdav/xml.js');
  const xml = multistatus([{ href: '/x', name: 'bad\x01name<&>', size: 1 }]);
  assert.doesNotMatch(xml, /\x01/);
  assert.match(xml, /&lt;&amp;&gt;/);
  // balanced tags
  assert.equal((xml.match(/<D:response>/g) || []).length, (xml.match(/<\/D:response>/g) || []).length);
});

// ------------------------------------------------------------------ F-5: subtree

test('F-5: moving a directory into its own subtree is rejected', async () => {
  const { fs } = makeFs();
  await assert.rejects(fs.move('/docs', '/docs/sub'), (e) => e.httpStatus === 403);
  await assert.rejects(fs.move('/docs', '/docs'), (e) => e.httpStatus === 403);
});

// ------------------------------------------------------------------ F-6: dates

test('F-6: absurd timestamps clamp to epoch instead of Invalid Date', () => {
  const d1 = toDate(1e20);
  assert.equal(isNaN(d1.getTime()), false);
  assert.equal(d1.getTime(), 0);
  assert.equal(isNaN(toDate(-1e20).getTime()), false);
  assert.equal(isNaN(toDate('not-a-number').getTime()), false);
  assert.equal(toDate(1700000000).getTime(), 1700000000000);
  // and the XML layer survives it
  const { multistatus } = require('../../core/webdav/xml.js');
  const xml = multistatus([{ href: '/x', name: 'f', size: 1, mtime: toDate(1e20), ctime: toDate(-5) }]);
  assert.match(xml, /<D:getlastmodified>/);
});

// ------------------------------------------------------------------ F-11: cookie scoping

test('F-11: cookies from non-Quark hosts never enter the session jar', async () => {
  const jar = new CookieJar({ __puus: 'keep' });
  jar.ingestFrom(['evil=1; Path=/'], 'cdn.aliyuncs.com');
  jar.ingestFrom(['tracker=1'], 'evil.example.com');
  assert.equal(jar.header(), '__puus=keep');
  jar.ingestFrom(['__puus=rotated; Path=/'], 'drive-pc.quark.cn');
  assert.equal(jar.header(), '__puus=rotated');
  jar.ingestFrom(['x=1'], 'pan.quark.cn');
  assert.match(jar.header(), /x=1/);
});

test('F-11: cross-host redirects keep cookies out of the request', async () => {
  const seen = [];
  const http = new HttpClient({
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      seen.push({ host: u.host, cookie: init.headers.Cookie || null });
      if (u.host === 'drive-pc.quark.cn') {
        return {
          status: 302,
          headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://cdn.example.com/f' : null), getSetCookie: () => [] },
          arrayBuffer: async () => Buffer.alloc(0),
        };
      }
      return {
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null), getSetCookie: () => ['cdncookie=leak; Path=/'] },
        arrayBuffer: async () => Buffer.from('{}'),
      };
    },
    cookieJar: new CookieJar({ __puus: 's1' }),
  });
  await http.request('GET', 'https://drive-pc.quark.cn/1/clouddrive/file/download');
  assert.equal(seen[1].host, 'cdn.example.com');
  assert.equal(seen[1].cookie, null, 'no cookie to the CDN host');
  assert.equal(http.cookieJar.header(), '__puus=s1', 'CDN-set cookies are ignored');
});

// ------------------------------------------------------------------ F-14: secret registration

test('F-14: buildStack registers the session cookie header for redaction', () => {
  const { buildStack } = require('../../core/index.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-f14-'));
  // pre-seed a session
  fs.writeFileSync(path.join(base, 'session.json'), JSON.stringify({ cookies: { __puus: 'topsecretcookie', __pus: 'p' } }), { mode: 0o600 });
  const stack = buildStack({ baseDir: base, quiet: true });
  stack.logger.info('cookie header is ' + stack.http.cookieJar.header());
  const log = fs.readFileSync(path.join(base, 'logs', 'quark-drive.log'), 'utf8');
  assert.doesNotMatch(log, /topsecretcookie/);
  assert.match(log, /<redacted>/);
});

// ------------------------------------------------------------------ F-9: vendor pinning (static)

test('F-9: fetch-vendor.mjs pins SHA256 for every artifact and fails closed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'fetch-vendor.mjs'), 'utf8');
  const arts = [...src.matchAll(/file:\s*'([^']+)'[\s\S]*?sha256:\s*'([0-9a-f]{64})'/g)];
  assert.ok(arts.length >= 2, 'both artifacts must carry a pinned sha256');
  assert.match(src, /no pinned sha256/);
  assert.match(src, /SHA256 mismatch/);
  // the installer comment must not claim unverified downloads
  assert.doesNotMatch(src, /sha256: null/);
});

// ------------------------------------------------------ round 3 (C series)

/** Minimal fetch-like Response (same shape as http.test.js's res()). */
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

// ---------------------------------------------------------------- C-1: SSRF guard

test('C-1: plaintext http request URLs are refused (TLS downgrade)', async () => {
  const seen = [];
  const http = new HttpClient({
    fetchImpl: async (url) => { seen.push(url); return res(200, { headers: { 'content-type': 'application/json' }, body: '{}' }); },
  });
  await assert.rejects(http.requestJson('GET', 'http://drive-pc.quark.cn/x'), /https required/);
  assert.equal(seen.length, 0, 'no request may leave the process');
});

test('C-1: IP-literal and internal hosts are refused (loopback/metadata SSRF)', async () => {
  const http = new HttpClient({ fetchImpl: async () => res(200, { body: '{}' }) });
  for (const u of [
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'https://10.0.0.5/x',
    'https://localhost/x',
    'https://svc.internal/x',
    // FQDN-root-dot spellings resolve to the same internal targets
    'https://127.0.0.1./x',
    'https://localhost./x',
  ]) {
    await assert.rejects(http.requestJson('GET', u), /refusing to fetch/, u);
  }
});

test('C-1: a redirect to an internal host or plaintext is refused', async () => {
  const http = new HttpClient({
    fetchImpl: async () => res(302, { headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
  });
  await assert.rejects(http.request('GET', 'https://drive-pc.quark.cn/1/clouddrive/file/download', { raw: true }), /refusing to fetch/);
});

test('C-1: ordinary public https destinations are still allowed', async () => {
  const seen = [];
  const http = new HttpClient({
    fetchImpl: async (url) => { seen.push(url); return res(200, { headers: { 'content-type': 'application/json' }, body: '{"ok":1}' }); },
  });
  await http.requestJson('GET', 'https://drive-pc.quark.cn/1/clouddrive/member');
  await http.requestJson('GET', 'https://dn-quark-cdn.example.com/f');
  assert.equal(seen.length, 2);
});

// ---------------------------------------------------------------- C-2: body cap

test('C-2: an oversized buffered response is aborted, not materialised', async () => {
  const big = Buffer.alloc(4096, 0x61);
  const http = new HttpClient({
    fetchImpl: async () => new Response(new Blob([big]).stream(), {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': '10' },
    }),
    maxBodyBytes: 1024,
  });
  await assert.rejects(http.requestJson('GET', 'https://drive-pc.quark.cn/x'), /exceeds 1024 bytes/);
});

test('C-2: normal-sized responses are unaffected by the cap', async () => {
  const http = new HttpClient({
    fetchImpl: async () => res(200, { headers: { 'content-type': 'application/json' }, body: '{"code":0,"data":{"a":1}}' }),
    maxBodyBytes: 1024,
  });
  const out = await http.requestJson('GET', 'https://drive-pc.quark.cn/x');
  assert.deepEqual(out, { code: 0, data: { a: 1 } });
});

// ---------------------------------------------------------------- C-3: CSPRNG request_id

test('C-3: the login request_id nonce is CSPRNG-sourced (no Math.random)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'quark', 'auth.js'), 'utf8');
  // strip comments so prose mentioning the old PRNG cannot false-positive
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /Math\.random/, 'request_id must not come from the non-crypto PRNG');
  assert.match(code, /crypto\.randomInt/, 'request_id must use crypto.randomInt');
});

// ---------------------------------------------------------------- C-4: cookie redaction

test('C-4: rotated cookie values AND individual pairs are redacted from logs', () => {
  const { buildStack } = require('../../core/index.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-c4-'));
  fs.writeFileSync(path.join(base, 'session.json'),
    JSON.stringify({ cookies: { __puus: 'oldsecretvalue111', __pus: 'oldpusvalue222' } }), { mode: 0o600 });
  const stack = buildStack({ baseDir: base, quiet: true });
  // the jar rotates during API calls (Set-Cookie) — a fresh value appears
  stack.http.cookieJar.ingest(['__puus=newrotatedsecret333; Path=/']);
  stack.logger.info('pair leak __puus=newrotatedsecret333 and __pus=oldpusvalue222');
  stack.logger.warn('header leak ' + stack.http.cookieJar.header());
  const log = fs.readFileSync(path.join(base, 'logs', 'quark-drive.log'), 'utf8');
  assert.doesNotMatch(log, /newrotatedsecret333/, 'rotated value must be redacted');
  assert.doesNotMatch(log, /oldpusvalue222/, 'individual pair must be redacted');
  assert.doesNotMatch(log, /oldsecretvalue111/, 'old value must stay redacted');
  assert.match(log, /<redacted>/);
});

// ------------------------------------------------------ M-1: build-time vendor gate

test('M-1: the build gates on vendor integrity and fails closed on a tampered binary', () => {
  const { spawnSync } = require('node:child_process');
  const gate = path.join(__dirname, '..', '..', 'scripts', 'verify-vendor.js');
  const src = fs.readFileSync(gate, 'utf8');
  assert.match(src, /fetch-vendor\.mjs/, 'pins must be read from the fetcher (single source of truth)');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.predist, 'node scripts/verify-vendor.js', 'npm run dist must gate on vendor integrity');
  assert.equal(pkg.build.beforePack, 'scripts/verify-vendor.js', 'electron-builder must gate on vendor integrity');
  // functional: a substituted binary in a vendor dir must fail the gate
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-vendor-'));
  fs.writeFileSync(path.join(vdir, 'rclone.exe'), 'not the real binary');
  const bad = spawnSync(process.execPath, [gate, vdir], { encoding: 'utf8' });
  assert.equal(bad.status, 1, 'a tampered rclone.exe must fail the gate');
  assert.match(bad.stderr, /FAIL\s+rclone\.exe/);
  // ...and the real vendored binaries (when present) must pass
  if (fs.existsSync(path.join(__dirname, '..', '..', 'vendor', 'rclone.exe'))) {
    const good = spawnSync(process.execPath, [gate], { encoding: 'utf8' });
    assert.equal(good.status, 0, 'the real vendor binaries must pass the gate');
  }
});

// ------------------------------------------------------------------ helpers

function makeFs() {  const tree = {
    '0': [
      { fid: 'd1', file_name: 'docs', dir: 1, file_type: 0, size: 0, updated_at: 100, created_at: 90 },
      { fid: 'f1', file_name: 'a.txt', dir: 0, file_type: 4, size: 11, updated_at: 200, created_at: 90 },
      { fid: 'f2', file_name: 'sp ace.txt', dir: 0, file_type: 4, size: 5, updated_at: 150, created_at: 90 },
    ],
    d1: [
      { fid: 'f9', file_name: 'b.txt', dir: 0, file_type: 4, size: 5, updated_at: 150, created_at: 90 },
    ],
  };
  const api = {
    calls: { list: 0, remove: [], rename: [], move: [], mkdir: [] },
    async listDirAll(fid) {
      this.calls.list++;
      return (tree[fid] || []).map((e) => ({ ...e }));
    },
    async getDownloadUrl(fid) { return { url: 'http://127.0.0.1:1/fake/' + fid, size: 5 }; },
    async mkdir(p, name) { this.calls.mkdir.push([p, name]); return 'gen'; },
    async rename(fid, name) { this.calls.rename.push([fid, name]); },
    async move(fids, to) { this.calls.move.push([fids, to]); },
    async remove(fids) { this.calls.remove.push(fids); },
    async member() { return {}; },
  };
  const fsLayer = new QuarkFs({
    api,
    uploader: { async upload() { return { fid: 'newfid', rapid: false }; } },
    http: {},
    logger: { debug() {}, warn() {} },
    sleep: async () => {},
  });
  return { fs: fsLayer, api };
}
