'use strict';
/**
 * webdav.test.js — end-to-end WebDAV protocol tests against a QuarkFs backed
 * by an in-memory fake Quark API. Exercises the real HTTP surface.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const { createWebDavServer } = require('../../core/webdav/server.js');
const { QuarkFs } = require('../../core/webdav/quark-fs.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../helpers/fake-quark.js');

// ---------------------------------------------------------------- test harness

let server;
let base;
let quark;

before(async () => {
  quark = new FakeQuark();
  const fs = new QuarkFs({
    api: quark,
    uploader: new FakeUploader(quark),
    http: new FakeDownloadHttp(quark),
    cacheTtlMs: 60000,
  });
  server = createWebDavServer({ fs, host: '127.0.0.1', port: 0, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  base = 'http://127.0.0.1:' + port + server.urlPrefix;
});

after(async () => { await server.closeAsync(); });

async function dav(method, path, { headers = {}, body = null } = {}) {
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

// ---------------------------------------------------------------- tests

test('OPTIONS advertises DAV and the allowed methods', async () => {
  const r = await dav('OPTIONS', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('dav') || '', /1, 2/);
  for (const m of ['PROPFIND', 'GET', 'PUT', 'DELETE', 'MKCOL', 'MOVE']) {
    assert.match(r.headers.get('allow') || '', new RegExp(m));
  }
});

test('PROPFIND depth 0 on / returns the root collection', async () => {
  const r = await dav('PROPFIND', '/', { headers: { Depth: '0' } });
  assert.equal(r.status, 207);
  assert.match(r.text, /<D:multistatus/);
  assert.match(r.text, /<D:resourcetype><D:collection\/><\/D:resourcetype>/);
  assert.match(r.text, /<D:href>[^<]*\/<\/D:href>/); // root href (token-prefixed)
  // depth 0 must NOT list children
  assert.doesNotMatch(r.text, /docs/);
});

test('PROPFIND depth 1 on / lists children with sizes and dates', async () => {
  const r = await dav('PROPFIND', '/', { headers: { Depth: '1' } });
  assert.equal(r.status, 207);
  assert.match(r.text, /docs/);
  assert.match(r.text, /sp%20ace\.txt/);
  assert.match(r.text, /<D:getcontentlength>5<\/D:getcontentlength>/);
  assert.match(r.text, /<D:getcontentlength>1024<\/D:getcontentlength>/);
  assert.match(r.text, /<D:getlastmodified>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
  // a.txt lives inside /docs, not at the root
  assert.doesNotMatch(r.text, /a\.txt/);
});

test('PROPFIND on a directory path returns the collection and its children', async () => {
  const r = await dav('PROPFIND', '/docs', { headers: { Depth: '1' } });
  assert.equal(r.status, 207);
  assert.match(r.text, /<D:href>[^<]*\/docs<\/D:href>/);
  assert.match(r.text, /<D:href>[^<]*\/docs\/a\.txt<\/D:href>/);
  assert.match(r.text, /<D:getcontentlength>11<\/D:getcontentlength>/);
});

test('PROPFIND on unknown path is 404', async () => {
  const r = await dav('PROPFIND', '/nope', { headers: { Depth: '0' } });
  assert.equal(r.status, 404);
});

test('GET streams file content with content-type and length', async () => {
  const r = await dav('GET', '/docs/a.txt');
  assert.equal(r.status, 200);
  assert.equal(r.text, 'hello world');
  assert.equal(r.headers.get('content-length'), '11');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
});

test('GET with Range returns 206 and the slice', async () => {
  const r = await dav('GET', '/docs/a.txt', { headers: { Range: 'bytes=0-4' } });
  assert.equal(r.status, 206);
  assert.equal(r.text, 'hello');
  assert.equal(r.headers.get('content-range'), 'bytes 0-4/11');
  const r2 = await dav('GET', '/docs/a.txt', { headers: { Range: 'bytes=6-' } });
  assert.equal(r2.text, 'world');
});

test('HEAD returns headers without a body', async () => {
  const r = await dav('HEAD', '/docs/a.txt');
  assert.equal(r.status, 200);
  assert.equal(r.text, '');
  assert.equal(r.headers.get('content-length'), '11');
});

test('GET on a directory returns an HTML listing', async () => {
  const r = await dav('GET', '/docs');
  assert.equal(r.status, 200);
  assert.match(r.text, /a\.txt/);
});

test('PUT creates a file (201) then overwrites (204)', async () => {
  const r1 = await dav('PUT', '/new.txt', {
    headers: { 'Content-Length': '5' }, body: 'abcde',
  });
  assert.equal(r1.status, 201);
  const g = await dav('GET', '/new.txt');
  assert.equal(g.text, 'abcde');

  const r2 = await dav('PUT', '/new.txt', {
    headers: { 'Content-Length': '2' }, body: 'hi',
  });
  assert.equal(r2.status, 204);
  assert.equal((await dav('GET', '/new.txt')).text, 'hi');
});

test('PUT with a chunked body (no content-length) works', async () => {
  const res = await fetch(base + '/chunked.bin', {
    method: 'PUT',
    body: Readable.from([Buffer.from('chun'), Buffer.from('ked!')]),
    duplex: 'half',
  });
  assert.equal(res.status, 201);
  assert.equal((await dav('GET', '/chunked.bin')).text, 'chunked!');
});

test('PUT into a missing parent directory is 409', async () => {
  const r = await dav('PUT', '/nodir/x.txt', { headers: { 'Content-Length': '1' }, body: 'x' });
  assert.equal(r.status, 409);
});

test('MKCOL creates a directory (201); duplicate is 405', async () => {
  const r = await dav('MKCOL', '/newdir');
  assert.equal(r.status, 201);
  const prop = await dav('PROPFIND', '/newdir', { headers: { Depth: '0' } });
  assert.match(prop.text, /<D:collection\/>/);
  const dup = await dav('MKCOL', '/newdir');
  assert.equal(dup.status, 405);
});

test('DELETE removes files (204); missing is 404', async () => {
  await dav('PUT', '/tmp-del.txt', { headers: { 'Content-Length': '1' }, body: 'z' });
  const r = await dav('DELETE', '/tmp-del.txt');
  assert.equal(r.status, 204);
  assert.equal((await dav('GET', '/tmp-del.txt')).status, 404);
  assert.equal((await dav('DELETE', '/tmp-del.txt')).status, 404);
});

test('MOVE relocates a file into a directory', async () => {
  await dav('PUT', '/mv-src.txt', { headers: { 'Content-Length': '3' }, body: 'src' });
  const r = await dav('MOVE', '/mv-src.txt', { headers: { Destination: base + '/docs/' } });
  assert.ok(r.status === 201 || r.status === 204, 'status ' + r.status);
  assert.equal((await dav('GET', '/docs/mv-src.txt')).text, 'src');
  assert.equal((await dav('GET', '/mv-src.txt')).status, 404);
});

test('MOVE with a new name renames in place', async () => {
  await dav('PUT', '/ren-me.txt', { headers: { 'Content-Length': '3' }, body: 'ren' });
  const r = await dav('MOVE', '/ren-me.txt', { headers: { Destination: base + '/renamed.txt' } });
  assert.ok(r.status === 201 || r.status === 204);
  assert.equal((await dav('GET', '/renamed.txt')).text, 'ren');
});

test('MOVE with Overwrite: F on an existing target is 412', async () => {
  await dav('PUT', '/ow1.txt', { headers: { 'Content-Length': '1' }, body: '1' });
  await dav('PUT', '/ow2.txt', { headers: { 'Content-Length': '1' }, body: '2' });
  const r = await dav('MOVE', '/ow1.txt', {
    headers: { Destination: base + '/ow2.txt', Overwrite: 'F' },
  });
  assert.equal(r.status, 412);
  assert.equal((await dav('GET', '/ow1.txt')).text, '1');
});

test('percent-encoded names round-trip', async () => {
  const r = await dav('GET', '/sp%20ace.txt');
  assert.equal(r.status, 200);
  assert.equal(r.text, 'sp ce');
});

test('path traversal cannot escape the namespace', async () => {
  for (const p of ['/../secret.txt', '/a/../../b.txt', '/..%2f..%2fetc']) {
    const r = await dav('GET', p);
    // 401 (no token), 404 (not found) or 400 — never a file outside the namespace
    assert.ok([400, 401, 404].includes(r.status), p + ' -> ' + r.status);
  }
});

test('raw un-normalized traversal requests stay inside the namespace', async () => {
  // Bypass client-side URL normalization: send the request line verbatim.
  const net = require('node:net');
  const port = Number(base.split(':')[2].split('/')[0]);
  const sendRaw = (reqPath) => new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET ' + reqPath + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.on('data', (d) => { data += d.toString(); });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  for (const p of [
    '/' + server.authToken + '/../../etc/passwd',
    '/' + server.authToken + '/..%2f..%2fwindows/win.ini',
    '/' + server.authToken + '/docs/../../../etc/passwd',
  ]) {
    const res = await sendRaw(p);
    const status = Number(/^HTTP\/1\.1 (\d+)/.exec(res)[1]);
    assert.ok([400, 401, 404].includes(status), p + ' -> ' + status);
    assert.doesNotMatch(res, /root:x:|\[fonts\]/i, 'must not read host files');
  }
});

test('unknown method is 405', async () => {
  const r = await dav('COPY', '/docs/a.txt');
  assert.equal(r.status, 405);
});

test('PROPPATCH is accepted (207)', async () => {
  const r = await dav('PROPPATCH', '/docs/a.txt', { headers: {} });
  assert.equal(r.status, 207);
});
