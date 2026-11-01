'use strict';
/**
 * audit-regressions.test.js — regression tests for the phase-6 security audit
 * findings. Each test maps to a documented finding in docs/AUDIT.md.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWebDavServer, MAX_CHUNKED_BODY_BYTES } = require('../../core/webdav/server.js');
const { QuarkFs } = require('../../core/webdav/quark-fs.js');
const { Uploader } = require('../../core/quark/upload.js');
const { createLogger } = require('../../core/index.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../helpers/fake-quark.js');

// ---------------------------------------------------------------- A-01 chunked PUT cap

test('A-01: chunked PUT above the configured cap is rejected with 413', async () => {
  const quark = new FakeQuark();
  const qfs = new QuarkFs({ api: quark, uploader: new FakeUploader(quark), http: new FakeDownloadHttp(quark) });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, maxChunkedBodyBytes: 1024, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  try {
    const res = await fetch('http://127.0.0.1:' + port + server.urlPrefix + '/big.bin', {
      method: 'PUT',
      body: ReadableStreamFrom([Buffer.alloc(2048, 0x41)]),
      duplex: 'half',
    });
    assert.equal(res.status, 413);
  } finally {
    await server.closeAsync();
  }
});

test('A-03: a LARGE chunked body still receives the 413 (not ECONNRESET)', async () => {
  // The cap must be enforced by answering first and then draining: a client
  // uploading 4 MB against a 64 KiB cap used to get a reset connection with
  // no response at all (it could not tell "too large" from "network error").
  const quark = new FakeQuark();
  const qfs = new QuarkFs({ api: quark, uploader: new FakeUploader(quark), http: new FakeDownloadHttp(quark) });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, maxChunkedBodyBytes: 64 * 1024, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  try {
    // 4 MB in 64 KiB chunks — many chunks arrive after the cap is exceeded
    const chunks = [];
    for (let i = 0; i < 64; i++) chunks.push(Buffer.alloc(64 * 1024, 0x42));
    const res = await fetch('http://127.0.0.1:' + port + server.urlPrefix + '/big.bin', {
      method: 'PUT',
      body: ReadableStreamFrom(chunks),
      duplex: 'half',
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /too large/);
  } finally {
    await server.closeAsync();
  }
});

test('A-01: default chunked cap is 256 MiB and exported for reference', () => {
  assert.equal(MAX_CHUNKED_BODY_BYTES, 256 * 1024 * 1024);
});

function ReadableStreamFrom(buffers) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < buffers.length) controller.enqueue(buffers[i++]);
      else controller.close();
    },
  });
}

// ---------------------------------------------------------------- A-02 overwrite order

test('A-02: a failed overwrite upload leaves the previous version intact', async () => {
  const quark = new FakeQuark();
  const removed = [];
  const failingUploader = {
    uploads: 0,
    async upload() {
      this.uploads++;
      throw new Error('network down');
    },
  };
  const api = Object.create(quark);
  api.remove = async (fids) => { removed.push(fids); return {}; };
  const qfs = new QuarkFs({ api, uploader: failingUploader, http: {}, logger: { debug() {}, warn() {} } });
  await assert.rejects(qfs.writeFile('/docs/a.txt', null, 3, { buffer: Buffer.from('new') }), /network down/);
  assert.deepEqual(removed, [], 'the old file must NOT be deleted when the upload fails');
  assert.equal(failingUploader.uploads, 1);
});

test('A-02: a successful overwrite deletes the old version afterwards', async () => {
  const quark = new FakeQuark();
  const removed = [];
  const api = Object.create(quark);
  api.remove = async (fids) => { removed.push(fids); return {}; };
  const uploader = {
    async upload(opts) {
      return { fid: 'f-new', rapid: false, opts };
    },
  };
  const qfs = new QuarkFs({ api, uploader, http: {}, logger: { debug() {}, warn() {} } });
  const out = await qfs.writeFile('/docs/a.txt', null, 3, { buffer: Buffer.from('new') });
  assert.equal(out.fid, 'f-new');
  assert.deepEqual(removed, [['f1']], 'old fid f1 removed after the new upload succeeded');
});

test('A-02: 秒传 returning the same fid does not delete it', async () => {
  const quark = new FakeQuark();
  const removed = [];
  const api = Object.create(quark);
  api.remove = async (fids) => { removed.push(fids); return {}; };
  const uploader = { async upload() { return { fid: 'f1', rapid: true }; } };
  const qfs = new QuarkFs({ api, uploader, http: {}, logger: { debug() {}, warn() {} } });
  const out = await qfs.writeFile('/docs/a.txt', null, 3, { buffer: Buffer.from('same') });
  assert.equal(out.fid, 'f1');
  assert.deepEqual(removed, [], 'same-fid rapid upload must not delete the file');
});

// ---------------------------------------------------------------- A-03 part size clamp

test('A-03: a huge server part_size is clamped to 64 MiB', async () => {
  const events = [];
  const http = {
    events,
    cookieJar: { header: () => '' },
    async requestJson(method, url, opts = {}) {
      events.push({ kind: 'json', url, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/file/upload/pre')) {
        return {
          code: 0, status: 200,
          data: {
            task_id: 't', bucket: 'b', obj_key: 'o', upload_id: 'u', upload_url: 'oss.example.com',
            auth_info: {}, callback: {},
            metadata: { part_size: 1024 * 1024 * 1024 * 5, part_thread: 3 }, // 5 GiB from "server"
          },
        };
      }
      if (url.includes('/file/upload/auth')) return { code: 0, status: 200, data: { auth_key: 'k' } };
      if (url.includes('/file/update/hash')) return { code: 0, status: 200, data: { finish: false } };
      if (url.includes('/file/upload/finish')) return { code: 0, status: 200, data: { fid: 'x' } };
      throw new Error('unexpected ' + url);
    },
    async request(method, url, opts = {}) {
      events.push({ kind: 'raw', method, url, bodyLen: opts.body ? opts.body.length : 0, body: opts.body });
      if (method === 'PUT') {
        return { status: 200, headers: { get: (k) => (k.toLowerCase() === 'etag' ? '"e' + events.filter((e) => e.method === 'PUT').length + '"' : null) }, body: Buffer.alloc(0) };
      }
      return { status: 200, headers: { get: () => null }, body: Buffer.from('<r/>') };
    },
  };
  const up = new Uploader({ http, device: { ut: 'm', mi: 'd', userAgent: () => 'ua' }, logger: { debug() {}, warn() {} } });
  const data = Buffer.alloc(70 * 1024 * 1024, 0x5a); // 70 MiB -> must split into 64M + 6M
  await up.upload({ parentFid: '0', fileName: 'x.bin', size: data.length, buffer: data });
  const puts = events.filter((e) => e.kind === 'raw' && e.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[0].bodyLen, 64 * 1024 * 1024);
  assert.equal(puts[1].bodyLen, 6 * 1024 * 1024);
});

// ---------------------------------------------------------------- A-04 log injection

test('A-04: log lines are flattened (no forged entries via newlines)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-log-'));
  const logFile = path.join(dir, 't.log');
  const logger = createLogger(logFile);
  logger.info('evil\n2026-01-01T00:00:00.000Z INFO forged entry');
  logger.info('ctrl\x00\x07chars');
  const text = fs.readFileSync(logFile, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2, 'each log call is exactly one line');
  assert.ok(text.includes('forged entry'), 'content preserved, on the same line');
  assert.ok(lines[0].startsWith('20'), 'line 0 is the real entry');
  assert.doesNotMatch(text, /[\x00\x07]/);
});

// ---------------------------------------------------------------- A-05 settings whitelist (static)

test('A-05: main.js whitelists settings keys and validates driveLetter/port', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'main.js'), 'utf8');
  assert.match(src, /SETTINGS_WHITELIST/);
  for (const key of ['driveLetter', 'autoMount', 'startWithWindows', 'webdavPort']) {
    assert.ok(src.includes("'" + key + "'"), 'whitelist missing ' + key);
  }
  // rclonePath must NOT be renderer-settable (it selects the executed binary)
  const wl = /SETTINGS_WHITELIST = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(wl, 'whitelist literal not found');
  assert.doesNotMatch(wl[1], /rclonePath/, 'rclonePath must not be in the settings whitelist');
  assert.match(src, /invalid drive letter/);
  assert.match(src, /invalid port/);
  // no blind merge of arbitrary patches
  assert.doesNotMatch(src, /\.\.\.stack\.settings, \.\.\.patch\b/);
});
