'use strict';
/**
 * bench.js — QuarkDrive performance benchmark suite (offline, fake backend).
 *
 * Measures the hot paths that decide how fluid the mounted drive feels:
 *   1. fs      — path→fid resolution, directory listing, stat (QuarkFs)
 *   2. xml     — PROPFIND 207 Multi-Status building for large directories
 *   3. webdav  — real HTTP round-trips through the WebDAV server
 *               (PROPFIND depth-1, GET with Range, PUT upload)
 *   4. hash    — pure-JS SHA-1 throughput (the upload critical path)
 *   5. upload  — part splitting + hashing pipeline throughput
 *
 * Usage:  node scripts/bench.js [--json] [--quick]
 * Exit code is always 0; this is a measurement tool, not a gate.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { performance } = require('node:perf_hooks');

const { QuarkFs } = require('../core/webdav/quark-fs.js');
const { createWebDavServer } = require('../core/webdav/server.js');
const { multistatus } = require('../core/webdav/xml.js');
const { Uploader } = require('../core/quark/upload.js');
const { Sha1Ctx } = require('../core/quark/sha1ctx.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../tests/helpers/fake-quark.js');

const jsonOut = process.argv.includes('--json');
const quick = process.argv.includes('--quick');

/** Build a fake Quark namespace: `big` dir with N entries + a deep chain. */
function makeNamespace(fileCount) {
  const quark = new FakeQuark();
  // N files in one directory (PROPFIND depth-1 stress)
  for (let i = 0; i < fileCount; i++) {
    const fid = 'b' + i;
    quark.entries.set(fid, {
      fid, file_name: 'file-' + String(i).padStart(5, '0') + '.dat',
      pdir_fid: '0', dir: 0, file_type: 4, size: 1024 + i,
      updated_at: 1700000000 + i, created_at: 1699999000,
    });
    quark.contents.set(fid, Buffer.alloc(1024 + i, i & 0xff));
  }
  // a deep directory chain /a/a/a/.../leaf for path-resolution stress
  let parent = '0';
  const chain = [];
  for (let d = 0; d < 10; d++) {
    const fid = 'd' + d;
    quark.entries.set(fid, {
      fid, file_name: 'a', pdir_fid: parent, dir: 1, file_type: 0, size: 0,
      updated_at: 1700000000, created_at: 1699999000,
    });
    chain.push(fid);
    parent = fid;
  }
  quark.entries.set('deepfile', {
    fid: 'deepfile', file_name: 'leaf.bin', pdir_fid: parent, dir: 0, file_type: 4,
    size: 4096, updated_at: 1700000000, created_at: 1699999000,
  });
  quark.contents.set('deepfile', Buffer.alloc(4096, 0x5a));
  return { quark, deepPath: '/' + chain.map(() => 'a').join('/') + '/leaf.bin' };
}

async function timeIt(label, iters, fn) {
  // warmup
  await fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await fn();
  const ms = performance.now() - t0;
  const perOp = ms / iters;
  return { label, iters, totalMs: round2(ms), perOpMs: round4(perOp), opsPerSec: Math.round(iters / (ms / 1000)) };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function fmtRow(r) {
  const label = r.label.padEnd(34);
  const n = String(r.iters).padStart(6);
  const total = (r.totalMs + 'ms').padStart(12);
  const per = (r.perOpMs + 'ms').padStart(12);
  const ops = String(r.opsPerSec).padStart(10);
  return `${label} ${n} ${total} ${per} ${ops}`;
}

const results = [];
function record(section, r) { r.section = section; results.push(r); }

// --------------------------------------------------------------------- fs

async function benchFs(namespace) {
  const qfs = new QuarkFs({
    api: namespace.quark,
    uploader: new FakeUploader(namespace.quark),
    http: new FakeDownloadHttp(namespace.quark),
    cacheTtlMs: 30000,
    logger: { debug() {}, warn() {} },
  });
  const deepPath = namespace.deepPath;

  record('fs', await timeIt('fs.stat deep path (cold-ish)', quick ? 20 : 50, async () => {
    qfs.dirCache.clear();
    await qfs.stat(deepPath);
  }));
  record('fs', await timeIt('fs.stat deep path (warm cache)', quick ? 2000 : 5000, async () => {
    await qfs.stat(deepPath);
  }));
  record('fs', await timeIt('fs.list root (cached)', quick ? 2000 : 5000, async () => {
    await qfs.list('/');
  }));
  record('fs', await timeIt('fs.stat single file (warm)', quick ? 2000 : 5000, async () => {
    await qfs.stat('/file-00042.dat');
  }));
}

// -------------------------------------------------------------------- xml

function benchXml(fileCount) {
  const items = [];
  for (let i = 0; i < fileCount; i++) {
    items.push({
      href: '/token/file-' + String(i).padStart(5, '0') + '.dat',
      isDir: false, name: 'file-' + String(i).padStart(5, '0') + '.dat',
      size: 1024 + i, mtime: new Date(1700000000000 + i), ctime: new Date(1699999000000),
      etag: '"b' + i + '-1024-1700000000"',
    });
  }
  record('xml', timeItSync('xml.multistatus ' + fileCount + ' entries', quick ? 20 : 100, () => {
    multistatus(items);
  }));
}

function timeItSync(label, iters, fn) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  return { label, iters, totalMs: round2(ms), perOpMs: round4(ms / iters), opsPerSec: Math.round(iters / (ms / 1000)) };
}

// ------------------------------------------------------------------ webdav

async function benchWebdav(namespace, fileCount) {
  const qfs = new QuarkFs({
    api: namespace.quark,
    uploader: new FakeUploader(namespace.quark),
    http: new FakeDownloadHttp(namespace.quark),
    cacheTtlMs: 30000,
    logger: { debug() {}, warn() {} },
  });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  const base = 'http://127.0.0.1:' + port + server.urlPrefix;

  // a 4 MiB file for GET/PUT throughput
  const bigBuf = Buffer.alloc(4 * 1024 * 1024, 0x7f);
  namespace.quark.entries.set('bench-big', {
    fid: 'bench-big', file_name: 'bench-big.bin', pdir_fid: '0', dir: 0, file_type: 4,
    size: bigBuf.length, updated_at: 1700000000, created_at: 1699999000,
  });
  namespace.quark.contents.set('bench-big', bigBuf);

  try {
    record('webdav', await timeIt('webdav PROPFIND depth1 root', quick ? 20 : 100, async () => {
      const res = await fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
      await res.arrayBuffer();
      if (res.status !== 207) throw new Error('propfind status ' + res.status);
    }));

    record('webdav', await timeIt('webdav PROPFIND depth0 single', quick ? 200 : 1000, async () => {
      const res = await fetch(base + '/file-00042.dat', { method: 'PROPFIND', headers: { Depth: '0' } });
      await res.arrayBuffer();
      if (res.status !== 207) throw new Error('propfind status ' + res.status);
    }));

    // GET throughput: keep-alive matters here (rclone reuses connections)
    const getBytes = quick ? 4 * 1024 * 1024 : 64 * 1024 * 1024;
    const iters = Math.max(1, Math.floor(getBytes / bigBuf.length));
    await (async () => {
      const res = await fetch(base + '/bench-big.bin');
      await res.arrayBuffer();
    })();
    const t0 = performance.now();
    let bytes = 0;
    for (let i = 0; i < iters; i++) {
      const res = await fetch(base + '/bench-big.bin');
      const buf = Buffer.from(await res.arrayBuffer());
      bytes += buf.length;
    }
    const ms = performance.now() - t0;
    record('webdav', {
      label: 'webdav GET 4MiB x' + iters + ' (fake CDN)',
      iters, totalMs: round2(ms), perOpMs: round4(ms / iters),
      mbPerSec: round2(bytes / 1024 / 1024 / (ms / 1000)),
      opsPerSec: Math.round(iters / (ms / 1000)),
    });

    // Range GET (rclone VFS read-ahead path)
    await (async () => {
      const res = await fetch(base + '/bench-big.bin', { headers: { Range: 'bytes=0-1023' } });
      await res.arrayBuffer();
    })();
    const t1 = performance.now();
    const rangeIters = quick ? 100 : 500;
    for (let i = 0; i < rangeIters; i++) {
      const res = await fetch(base + '/bench-big.bin', { headers: { Range: 'bytes=0-1023' } });
      await res.arrayBuffer();
    }
    const ms1 = performance.now() - t1;
    record('webdav', {
      label: 'webdav GET range 1KiB x' + rangeIters,
      iters: rangeIters, totalMs: round2(ms1), perOpMs: round4(ms1 / rangeIters),
      opsPerSec: Math.round(rangeIters / (ms1 / 1000)),
    });

    // PUT throughput (upload path through the fake uploader)
    const putIters = quick ? 10 : 50;
    await (async () => {
      const res = await fetch(base + '/bench-put.bin', { method: 'PUT', body: bigBuf });
      await res.arrayBuffer();
    })();
    const t2 = performance.now();
    for (let i = 0; i < putIters; i++) {
      const res = await fetch(base + '/bench-put.bin', { method: 'PUT', body: bigBuf });
      await res.arrayBuffer();
    }
    const ms2 = performance.now() - t2;
    record('webdav', {
      label: 'webdav PUT 4MiB x' + putIters + ' (fake OSS)',
      iters: putIters, totalMs: round2(ms2), perOpMs: round4(ms2 / putIters),
      mbPerSec: round2((bigBuf.length * putIters) / 1024 / 1024 / (ms2 / 1000)),
      opsPerSec: Math.round(putIters / (ms2 / 1000)),
    });
  } finally {
    await server.closeAsync();
  }
}

// ------------------------------------------------------------------- hash

function benchHash() {
  const buf = Buffer.alloc(16 * 1024 * 1024, 0x42); // 16 MiB
  const iters = quick ? 2 : 5;
  const sha = new Sha1Ctx();
  sha.update(buf.subarray(0, 1024)); // warm JIT
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const h = new Sha1Ctx();
    h.update(buf);
    h.digest();
  }
  const ms = performance.now() - t0;
  const bytes = buf.length * iters;
  record('hash', {
    label: 'sha1ctx 16MiB x' + iters,
    iters, totalMs: round2(ms), perOpMs: round4(ms / iters),
    mbPerSec: round2(bytes / 1024 / 1024 / (ms / 1000)),
    opsPerSec: Math.round(iters / (ms / 1000)),
  });
}

// ----------------------------------------------------------------- upload

async function benchUpload(namespace) {
  const uploader = new Uploader({
    http: { async requestJson() { return { code: 0, data: {} }; }, async request() { return { status: 200, headers: { get: () => 'x' } }; } },
    device: { ut: 'u', mi: 'm', userAgent: () => 'x' },
    logger: { debug() {}, warn() {} },
  });
  // part-splitting throughput only (no network), buffer path
  const buf = Buffer.alloc(16 * 1024 * 1024, 0x33);
  const iters = quick ? 2 : 5;
  const t0 = performance.now();
  let parts = 0;
  for (let i = 0; i < iters; i++) {
    for await (const part of uploader._iterParts({ buffer: buf }, 8 * 1024 * 1024)) {
      parts += part.length;
    }
  }
  const ms = performance.now() - t0;
  record('upload', {
    label: 'upload iterParts 16MiB x' + iters,
    iters, totalMs: round2(ms), perOpMs: round4(ms / iters),
    mbPerSec: round2((buf.length * iters) / 1024 / 1024 / (ms / 1000)),
    opsPerSec: Math.round(iters / (ms / 1000)),
  });

  // STREAM ingestion (the H1 quadratic-copy path): drain the generator while
  // hashing like the real upload loop does
  const chunkSize = 400 * 1024;
  const src = Buffer.alloc(16 * 1024 * 1024, 0x33);
  async function* streamOf() {
    for (let off = 0; off < src.length; off += chunkSize) {
      yield src.subarray(off, Math.min(off + chunkSize, src.length));
    }
  }
  const t1 = performance.now();
  let streamed = 0;
  for (let i = 0; i < iters; i++) {
    for await (const part of uploader._iterParts({ stream: streamOf() }, 8 * 1024 * 1024)) {
      streamed += part.length;
    }
  }
  const ms1 = performance.now() - t1;
  record('upload', {
    label: 'upload stream ingest 16MiB x' + iters,
    iters, totalMs: round2(ms1), perOpMs: round4(ms1 / iters),
    mbPerSec: round2((src.length * iters) / 1024 / 1024 / (ms1 / 1000)),
    opsPerSec: Math.round(iters / (ms1 / 1000)),
  });
}

// -------------------------------------------------------------------- main

(async () => {
  const fileCount = quick ? 500 : 2000;
  const namespace = makeNamespace(fileCount);
  const lines = [];
  const say = (s) => { lines.push(s); if (!jsonOut) console.log(s); };

  say('QuarkDrive benchmark — ' + new Date().toISOString());
  say('node ' + process.version + ' · ' + os.cpus()[0].model.trim() + ' · ' + fileCount + ' entries');
  say('');
  say('section  benchmark                            iters     total      per-op        ops/s');
  say('------- ------------------------------------ ------ ----------- ----------- ----------');

  await benchFs(namespace);
  benchXml(fileCount);
  await benchWebdav(namespace, fileCount);
  benchHash();
  await benchUpload(namespace);

  for (const r of results) say(fmtRow(r));
  for (const r of results) {
    if (r.mbPerSec) say(r.label + ' -> ' + r.mbPerSec + ' MB/s');
  }

  if (jsonOut) {
    const out = path.join(os.tmpdir(), 'quarkdrive-bench.json');
    fs.writeFileSync(out, JSON.stringify({
      node: process.version, date: new Date().toISOString(), results,
    }, null, 2));
    console.log(out);
  }
  say('');
  say('DONE');
})().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exitCode = 1;
});
