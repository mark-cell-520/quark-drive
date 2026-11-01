'use strict';
/**
 * soak.test.js — stability / soak tests.
 *
 * The mounted drive is a long-running service: it must survive concurrency
 * storms, client disconnects, malformed requests and keep-alive reuse
 * without hangs, leaks or crashes. Everything here runs against the real
 * HTTP server with the in-memory fake backend.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const { Readable } = require('node:stream');

const { createWebDavServer } = require('../../core/webdav/server.js');
const { QuarkFs } = require('../../core/webdav/quark-fs.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../helpers/fake-quark.js');

function makeStack(fileCount = 200, opts = {}) {
  const quark = new FakeQuark();
  for (let i = 0; i < fileCount; i++) {
    const fid = 's' + i;
    quark.entries.set(fid, {
      fid, file_name: 'f' + String(i).padStart(4, '0') + '.dat', pdir_fid: '0',
      dir: 0, file_type: 4, size: 512, updated_at: 1700000000, created_at: 1699999000,
    });
    quark.contents.set(fid, Buffer.alloc(512, i & 0xff));
  }
  const qfs = new QuarkFs({
    api: quark,
    uploader: opts.uploader || new FakeUploader(quark),
    http: opts.http || new FakeDownloadHttp(quark),
    logger: { debug() {}, warn() {}, error() {} },
  });
  const server = createWebDavServer({
    fs: qfs, host: '127.0.0.1', port: 0,
    logger: { debug() {}, warn() {}, error() {} },
  });
  return { quark, qfs, server };
}

/** Send a raw request over a fresh socket; resolve with whatever comes back. */
function rawRequest(port, text, waitMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
    let data = '';
    sock.on('data', (d) => { data += d.toString(); });
    sock.on('end', () => resolve(data));
    sock.on('error', (e) => (data ? resolve(data) : reject(e)));
    setTimeout(() => { sock.destroy(); resolve(data); }, waitMs);
  });
}

test('concurrent PROPFIND storm on one directory: all 207, identical bodies', async () => {
  const { server } = makeStack();
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;
  try {
    const N = 100;
    const responses = await Promise.all(Array.from({ length: N }, async () => {
      const res = await fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
      return { status: res.status, body: await res.text() };
    }));
    for (const r of responses) {
      assert.equal(r.status, 207);
      assert.equal(r.body, responses[0].body, 'every listing must be identical');
    }
    assert.ok(responses[0].body.length > 50000, 'the listing carries all entries');
  } finally {
    await server.closeAsync();
  }
});

test('mixed concurrent workload (GET/PUT/PROPFIND/MKCOL/MOVE/DELETE) stays consistent', async () => {
  const { server, qfs } = makeStack(50);
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  try {
    const jobs = [];
    // 30 reads
    for (let i = 0; i < 30; i++) {
      jobs.push(fetch(base + '/f' + String(i).padStart(4, '0') + '.dat', { agent }).then((r) => r.arrayBuffer()).then(() => 'ok'));
    }
    // 20 writes (distinct paths)
    for (let i = 0; i < 20; i++) {
      jobs.push(fetch(base + '/w' + i + '.bin', { method: 'PUT', agent, body: Buffer.alloc(1024, i) }).then((r) => r.status));
    }
    // 10 writes to the SAME path (serialization must keep them consistent)
    for (let i = 0; i < 10; i++) {
      jobs.push(fetch(base + '/same.bin', { method: 'PUT', agent, body: Buffer.alloc(2048, i) }).then((r) => r.status));
    }
    // listings
    for (let i = 0; i < 10; i++) {
      jobs.push(fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '1' }, agent }).then((r) => r.status));
    }
    // mkdir + move + delete
    jobs.push(fetch(base + '/dir-a', { method: 'MKCOL', agent }).then((r) => r.status));
    jobs.push(fetch(base + '/f0001.dat', {
      method: 'MOVE', agent,
      headers: { Destination: base + '/dir-a/moved.dat' },
    }).then((r) => r.status));
    jobs.push(fetch(base + '/f0002.dat', { method: 'DELETE', agent }).then((r) => r.status));

    const results = await Promise.all(jobs);
    for (const r of results) {
      if (typeof r === 'number') assert.ok(r >= 200 && r < 300, 'unexpected status ' + r);
      else assert.equal(r, 'ok');
    }
    // the namespace is consistent afterwards
    const names = (await qfs.list('/')).map((s) => s.name);
    assert.ok(names.includes('dir-a'));
    assert.ok(names.includes('same.bin'));
    assert.ok(!names.includes('f0002.dat'), 'deleted file is gone');
    const moved = await qfs.list('/dir-a');
    assert.ok(moved.some((s) => s.name === 'moved.dat'), 'moved file is in the target dir');
    // the same-path writes left exactly one entry with a valid size
    const same = (await qfs.list('/')).filter((s) => s.name === 'same.bin');
    assert.equal(same.length, 1);
    assert.ok([0, 2048].includes(same[0].size) || same[0].size === 2048);
  } finally {
    agent.destroy();
    await server.closeAsync();
  }
});

test('client disconnect mid-download aborts the upstream fetch (no socket leak)', async () => {
  // a CDN double whose body trickles in, so the disconnect happens mid-stream
  const stats = { requests: 0, aborted: 0 };
  const slowHttp = {
    async request(method, url, opts = {}) {
      stats.requests++;
      if (opts.signal) {
        if (opts.signal.aborted) stats.aborted++;
        else opts.signal.addEventListener('abort', () => { stats.aborted++; }, { once: true });
      }
      let i = 0;
      let timer = null;
      const body = new Readable({
        read() {
          if (timer) return;
          timer = setInterval(() => {
            if (opts.signal && opts.signal.aborted) { clearInterval(timer); this.destroy(); return; }
            if (i++ < 50) this.push(Buffer.alloc(1024, i));
            else { clearInterval(timer); this.push(null); }
          }, 5);
        },
        destroy() { if (timer) clearInterval(timer); },
      });
      return {
        status: 200,
        headers: { get: (k) => ({ 'content-type': 'application/octet-stream', 'content-length': '51200' }[String(k).toLowerCase()] || null) },
        response: { body: Readable.toWeb(body) },
        body: null,
      };
    },
  };
  const { server } = makeStack(5, { http: slowHttp });
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;
  try {
    const ac = new AbortController();
    const res = await fetch(base + '/f0000.dat', { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // take the first chunk, then walk away
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(stats.aborted >= 1, 'the upstream fetch must be aborted on client disconnect');
    // the server is still fully functional
    const ok = await fetch(base + '/f0001.dat');
    assert.equal(ok.status, 200);
    await ok.arrayBuffer();
    const prop = await fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '0' } });
    assert.equal(prop.status, 207);
  } finally {
    await server.closeAsync();
  }
});

test('malformed requests are answered safely and the server survives', async () => {
  const { server } = makeStack(10);
  const port = await server.listenAsync(0);
  const token = server.urlPrefix;
  const H = 'Host: 127.0.0.1\r\nConnection: close\r\n';
  try {
    const cases = [
      ['no host header', 'PROPFIND ' + token + '/ HTTP/1.1\r\nDepth: 0\r\nConnection: close\r\n\r\n', /421|400/],
      ['foreign host', 'PROPFIND ' + token + '/ HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\nDepth: 0\r\n\r\n', /421/],
      ['unknown method', 'BREW ' + token + '/ HTTP/1.1\r\n' + H + '\r\n', /400|405/], // Node rejects unknown methods itself
      ['bad token', 'PROPFIND /wrong-token/ HTTP/1.1\r\n' + H + 'Depth: 0\r\n\r\n', /401/],
      ['bad percent-encoding', 'GET ' + token + '/%ZZ HTTP/1.1\r\n' + H + '\r\n', /404|400/],
      ['nonsense range', 'GET ' + token + '/f0000.dat HTTP/1.1\r\n' + H + 'Range: bytes=abc\r\n\r\n', /200|416/],
      ['foreign destination', 'MOVE ' + token + '/f0000.dat HTTP/1.1\r\n' + H + 'Destination: http://evil.com/x\r\n\r\n', /400/],
      ['missing destination', 'MOVE ' + token + '/f0000.dat HTTP/1.1\r\n' + H + '\r\n', /400/],
      ['traversal attempt', 'GET ' + token + '/../../../etc/passwd HTTP/1.1\r\n' + H + '\r\n', /404|400/],
      ['double-encoded token', 'GET /%74' + token.slice(1) + '/f0000.dat HTTP/1.1\r\n' + H + '\r\n', /401|404/],
    ];
    for (const [label, text, expect] of cases) {
      const out = await rawRequest(port, text, 1500);
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(out)?.[1]);
      assert.ok(expect.test(out), label + ': expected ' + expect + ', got: ' + JSON.stringify(out.slice(0, 80)));
      assert.ok(status >= 200, label + ': no status line');
    }
    // still alive and correct
    const res = await fetch('http://127.0.0.1:' + port + token + '/', { method: 'PROPFIND', headers: { Depth: '0' } });
    assert.equal(res.status, 207);
  } finally {
    await server.closeAsync();
  }
});

test('one keep-alive connection serves many sequential requests', async () => {
  const { server } = makeStack(10);
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    for (let i = 0; i < 50; i++) {
      const res = await fetch(base + '/f' + String(i % 10).padStart(4, '0') + '.dat', { agent });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    const prop = await fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '0' }, agent });
    assert.equal(prop.status, 207);
  } finally {
    agent.destroy();
    await server.closeAsync();
  }
});

test('sustained writes to distinct paths leave no lock or cache residue', async () => {
  const { server, qfs } = makeStack(0);
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;
  try {
    await Promise.all(Array.from({ length: 100 }, (_v, i) =>
      fetch(base + '/w' + i + '.bin', { method: 'PUT', body: Buffer.alloc(2048, i) }).then((r) => r.status)));
    // every write finished: the per-path lock map must be empty again
    assert.equal(qfs._writeLocks.size, 0, 'write locks must be released (got ' + qfs._writeLocks.size + ')');
    assert.ok(qfs.dirCache.size <= 512, 'dir cache stays bounded');
    const names = (await qfs.list('/')).map((s) => s.name);
    for (let i = 0; i < 100; i++) {
      assert.ok(names.includes('w' + i + '.bin'), 'missing w' + i + '.bin');
    }
  } finally {
    await server.closeAsync();
  }
});

test('a PUT that fails mid-upload does not wedge later writes', async () => {
  const quark = new FakeQuark();
  let failNext = true;
  const flakyUploader = {
    async upload(opts) {
      if (failNext) {
        failNext = false;
        // consume the stream so the request can end cleanly, then fail
        if (opts.stream) for await (const _c of opts.stream) { /* drain */ }
        throw new Error('simulated network failure');
      }
      return { fid: 'u-ok', rapid: false };
    },
  };
  const qfs = new QuarkFs({
    api: quark, uploader: flakyUploader, http: new FakeDownloadHttp(quark),
    logger: { debug() {}, warn() {}, error() {} },
  });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;
  try {
    const bad = await fetch(base + '/flaky.bin', { method: 'PUT', body: Buffer.alloc(1024, 1) });
    assert.equal(bad.status, 500);
    const good = await fetch(base + '/flaky.bin', { method: 'PUT', body: Buffer.alloc(1024, 2) });
    assert.ok([200, 201, 204].includes(good.status), 'a later write to the same path must succeed');
    assert.equal(qfs._writeLocks.size, 0);
  } finally {
    await server.closeAsync();
  }
});
