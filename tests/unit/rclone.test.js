'use strict';
/**
 * rclone.test.js — mount manager unit tests (no real mount performed).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { MountManager, MountError, normalizeLetter } = require('../../core/mount/rclone.js');

function makeManager(overrides = {}) {
  return new MountManager(Object.assign({
    settings: { driveLetter: 'Q' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    rclonePath: 'C:\\Users\\USER782663\\.local\\bin\\rclone.exe',
    freePort: async () => 55999,
  }, overrides));
}

test('normalizeLetter accepts letters with optional colon/backslash', () => {
  assert.equal(normalizeLetter('q'), 'Q');
  assert.equal(normalizeLetter('Q:'), 'Q');
  assert.equal(normalizeLetter('z\\'), 'Z');
  assert.equal(normalizeLetter(' M '), 'M');
  assert.throws(() => normalizeLetter(''), MountError);
  assert.throws(() => normalizeLetter('QQ'), MountError);
  assert.throws(() => normalizeLetter('1'), MountError);
  assert.throws(() => normalizeLetter('../etc'), MountError);
});

test('findRclone accepts a working explicit path', () => {
  const m = makeManager();
  const found = m.findRclone();
  assert.match(found, /rclone\.exe$/);
});

test('findRclone throws a clear error when nothing is available', () => {
  const m = makeManager({ rclonePath: 'C:\\nonexistent\\rclone.exe', vendorDir: 'C:\\nonexistent-vendor' });
  // PATH lookup of bare "rclone" may still succeed on this machine; force failure
  m.rclonePath = 'C:\\nonexistent\\rclone.exe';
  const origPath = process.env.PATH;
  try {
    process.env.PATH = 'C:\\nonexistent';
    m.rclonePath = 'C:\\nonexistent\\rclone.exe';
    m.findRcloneOrg = m.findRclone;
    // bare "rclone" on an empty PATH must fail
    assert.throws(() => m.findRclone(), /rclone not found/);
  } finally {
    process.env.PATH = origPath;
  }
});

test('status reports unmounted initially and after unmount', async () => {
  const m = makeManager();
  assert.equal(m.isMounted, false);
  assert.deepEqual(m.status(), { mounted: false, letter: null, port: null });
  const res = await m.unmount();
  assert.equal(res.unmounted, false);
});

test('mount refuses to double-mount and reports in-use letters', async () => {
  const m = makeManager();
  // pretend a mount exists
  m.child = { exitCode: null, pid: 1 };
  m.mountInfo = { letter: 'Q', port: 1234 };
  await assert.rejects(m.mount({ port: 9999 }), /already mounted/);
  m.child = null;
  m.mountInfo = null;
});

test('checkWinFsp returns a structured result', () => {
  const m = makeManager();
  const w = m.checkWinFsp();
  assert.equal(typeof w.ok, 'boolean');
  if (!w.ok) assert.match(w.reason, /WinFsp/);
});

test('mount on an occupied letter fails fast', async () => {
  const m = makeManager();
  // C: definitely exists on any Windows box
  await assert.rejects(m.mount({ port: 1234, letter: 'C' }), /already in use/);
});

test('mount surfaces an early rclone exit with stderr', async () => {
  const { EventEmitter } = require('node:events');
  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.pid = 4242;
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};
  const spawnCalls = [];
  const m = makeManager({
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      // emit exit on the next tick with stderr output
      setImmediate(() => {
        fakeChild.stderr.emit('data', Buffer.from('rclone: fatal error\n'));
        fakeChild.exitCode = 1;
        fakeChild.emit('exit', 1);
      });
      return fakeChild;
    },
  });
  await assert.rejects(m.mount({ port: 1234, letter: 'Y' }), (e) => {
    assert.match(e.message, /exited early/);
    assert.match(e.message, /fatal error/);
    return true;
  });
  // the args were built as documented (rcd daemon + rc-addr)
  assert.equal(spawnCalls[0].args[0], 'rcd');
  assert.ok(spawnCalls[0].args.includes('--rc-addr'));
  assert.equal(spawnCalls[0].opts.windowsHide, true);
  // state was cleaned up
  assert.equal(m.isMounted, false);
  assert.equal(m.mountInfo, null);
});

test('mount times out when the rclone RC never comes up', async () => {
  const { EventEmitter } = require('node:events');
  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.pid = 1;
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};
  const m = makeManager({
    spawn: () => fakeChild,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 60000); })(), // fast-forward past the deadlines
    freePort: async () => 59999, // nothing listens there -> RC poll fails fast
  });
  await assert.rejects(m.mount({ port: 1234, letter: 'Y' }), /RC did not come up/);
  assert.equal(m.isMounted, false);
});

test('mount succeeds through the RC API (rcd + mount/mount + listmounts)', async () => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');

  // fake rclone RC endpoint
  const rcServer = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = { 'Content-Type': 'application/json' };
      if (req.url === '/core/version') {
        res.writeHead(200, json);
        res.end(JSON.stringify({ version: 'v1.75.2' }));
      } else if (req.url === '/mount/mount') {
        const parsed = JSON.parse(body);
        // the fs spec must carry the webdav remote with the token prefix
        assert.match(parsed.fs, /^:webdav,url='http:\/\/127\.0\.0\.1:1234\/[0-9a-f]{48}',vendor='other':$/);
        assert.equal(parsed.mountPoint, 'Y:\\');
        assert.equal(parsed.vfsOpt.VfsCacheMode, 'writes');
        res.writeHead(200, json);
        res.end(JSON.stringify({ mountPoint: parsed.mountPoint }));
      } else if (req.url === '/mount/listmounts') {
        res.writeHead(200, json);
        res.end(JSON.stringify({ mountPoints: [{ mountPoint: 'Y:\\', mounted: true }] }));
      } else {
        res.writeHead(404); res.end();
      }
    });
  });
  const rcPort = await new Promise((r) => rcServer.listen(0, '127.0.0.1', () => r(rcServer.address().port)));

  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.pid = 777;
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};

  const spawnCalls = [];
  const m = makeManager({
    spawn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      assert.equal(args[0], 'rcd', 'rclone must be started as the RC daemon');
      assert.ok(args.includes('--rc-addr'));
      assert.ok(args.some((a) => a === '127.0.0.1:' + rcPort), 'rc-addr must use the chosen port');
      return fakeChild;
    },
    sleep: async () => {},
    freePort: async () => rcPort,
  });
  try {
    const out = await m.mount({ port: 1234, letter: 'Y', urlPrefix: '/' + 'a'.repeat(48) });
    assert.equal(out.letter, 'Y');
    assert.equal(out.rcPort, rcPort);
    assert.equal(m.isMounted, true);
    assert.equal(m.status().mounted, true);
  } finally {
    rcServer.close();
  }
});

test('unmount asks rclone via RC first', async () => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');

  let unmountCalled = false;
  const rcServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mount/unmount') {
      unmountCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else { res.writeHead(404); res.end(); }
  });
  const rcPort = await new Promise((r) => rcServer.listen(0, '127.0.0.1', () => r(rcServer.address().port)));

  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.stderr = new EventEmitter();
  let killed = false;
  fakeChild.kill = () => { killed = true; fakeChild.exitCode = 0; fakeChild.emit('exit', 0); };

  const m = makeManager();
  m.child = fakeChild;
  m.mountInfo = { letter: 'Q', port: 1, rcPort, startedAt: 0 };
  // simulate rclone exiting on its own shortly after the RC unmount
  const rcServerForExit = rcServer;
  rcServerForExit.on('request', (req) => {
    if (req.url === '/mount/unmount') {
      setTimeout(() => { fakeChild.exitCode = 0; fakeChild.emit('exit', 0); }, 200);
    }
  });
  try {
    const res = await m.unmount();
    assert.equal(res.unmounted, true);
    assert.equal(unmountCalled, true, 'RC unmount must be called');
    assert.equal(killed, false, 'rclone exits by itself after RC unmount — no kill needed');
  } finally {
    rcServer.close();
  }
});

test('unmount kills a live child', async () => {
  const { EventEmitter } = require('node:events');
  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.stderr = new EventEmitter();
  let killed = false;
  fakeChild.kill = () => { killed = true; fakeChild.exitCode = 0; fakeChild.emit('exit', 0); };
  const m = makeManager({ spawn: () => fakeChild });
  m.child = fakeChild;
  m.mountInfo = { letter: 'Q', port: 1, startedAt: 0 };
  const res = await m.unmount();
  assert.equal(res.unmounted, true);
  assert.equal(killed, true);
  assert.equal(m.isMounted, false);
});
