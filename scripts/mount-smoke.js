'use strict';
/**
 * scripts/mount-smoke.js — development smoke test: mount the WebDAV server
 * (in-memory fake Quark backend) as a real drive letter via rclone + WinFsp and
 * verify listing / reading / writing / mkdir through the Windows filesystem.
 *
 * NOTE: all filesystem access here MUST be async — the WebDAV server runs in
 * this same process, and blocking I/O would deadlock the mount.
 *
 * Usage: node scripts/mount-smoke.js [driveLetter]
 * Requires: rclone (PATH or RCLONE_PATH) + WinFsp installed.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createWebDavServer } = require('../core/webdav/server.js');
const { QuarkFs } = require('../core/webdav/quark-fs.js');
const { MountManager } = require('../core/mount/rclone.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../tests/helpers/fake-quark.js');

const RCLONE = process.env.RCLONE_PATH || 'rclone';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const letter = (process.argv[2] || 'Q').replace(/[:\\]/, '');
  const root = letter + ':\\';
  // isolate rclone's on-disk VFS cache so runs never inherit pending uploads
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-smoke-cache-'));

  const quark = new FakeQuark();
  const qfs = new QuarkFs({
    api: quark,
    uploader: new FakeUploader(quark),
    http: new FakeDownloadHttp(quark),
  });
  const server = createWebDavServer({ fs: qfs, host: '127.0.0.1', port: 0, logger: { debug() {}, warn() {}, error() {} } });
  const port = await server.listenAsync(0);
  console.log('webdav on 127.0.0.1:' + port);

  const mount = new MountManager({
    settings: { driveLetter: letter, mountOptions: { cacheDir } },
    logger: {
      debug() {}, warn: (...a) => console.log('[mount:warn]', ...a), error: (...a) => console.log('[mount:error]', ...a),
      info: (...a) => console.log('[mount]', ...a),
    },
    rclonePath: RCLONE,
  });

  const cleanup = async () => {
    await mount.unmount();
    await server.closeAsync();
  };

  try {
    const res = await mount.mount({ port, letter, urlPrefix: server.urlPrefix, logFile: null });
    console.log('mounted ' + res.letter + ':\\ pid=' + res.pid);

    // 1. listing (async — keeps the event loop serving rclone)
    const names = (await fsp.readdir(root)).sort();
    console.log('dir ' + root + ' -> ' + JSON.stringify(names));
    if (!names.includes('docs') || !names.includes('big.bin')) throw new Error('root listing mismatch');
    if (names.includes('smoke-test.txt')) throw new Error('stale state leaked into a fresh run');

    // 2. read
    const content = await fsp.readFile(root + 'docs\\a.txt', 'utf8');
    console.log('read docs\\a.txt -> ' + JSON.stringify(content));
    if (content !== 'hello world') throw new Error('read mismatch');

    // 3. write + read back
    await fsp.writeFile(root + 'smoke-test.txt', 'written through the mount');
    await sleep(6000); // let the VFS flush the upload
    const back = await fsp.readFile(root + 'smoke-test.txt', 'utf8');
    console.log('read back smoke-test.txt -> ' + JSON.stringify(back));
    if (back !== 'written through the mount') throw new Error('write/read-back mismatch');

    // 4. mkdir
    await fsp.mkdir(root + 'smoke-dir');
    await sleep(3000);
    const stat = await fsp.stat(root + 'smoke-dir');
    if (!stat.isDirectory()) throw new Error('mkdir not visible');
    console.log('mkdir smoke-dir -> OK');

    console.log('SMOKE TEST PASSED');
  } finally {
    await cleanup();
  }
})().catch(async (e) => {
  console.error('SMOKE TEST FAILED: ' + e.message);
  process.exitCode = 1;
});
