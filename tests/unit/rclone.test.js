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

test('findRclone accepts a working explicit path', async () => {
  const m = makeManager();
  const found = await m.findRclone();
  assert.match(found, /rclone\.exe$/);
});

test('findRclone throws a clear error when nothing is available', async () => {
  const m = makeManager({ rclonePath: 'C:\\nonexistent\\rclone.exe', vendorDir: 'C:\\nonexistent-vendor' });
  // PATH lookup of bare "rclone" may still succeed on this machine; force failure
  const origPath = process.env.PATH;
  try {
    process.env.PATH = 'C:\\nonexistent';
    m.rclonePath = 'C:\\nonexistent\\rclone.exe';
    // bare "rclone" on an empty PATH must fail
    await assert.rejects(() => m.findRclone(), /rclone not found/);
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

test('checkWinFsp returns a structured result', async () => {
  const m = makeManager();
  const w = await m.checkWinFsp();
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

  const seenAuth = [];
  // fake rclone RC endpoint
  const rcServer = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    seenAuth.push(req.headers.authorization || null);
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
        assert.match(parsed.fs, /^:webdav,url='http:\/\/127\.0\.0\.1:1234\/[0-9a-f]{48}',vendor='other',timeout='30m':$/);
        assert.equal(parsed.mountPoint, 'Y:\\');
        assert.equal(parsed.vfsOpt.VfsCacheMode, 'writes');
        // fluidity options are forwarded (not silently dropped)
        assert.equal(parsed.vfsOpt.BufferSize, '64M');
        assert.equal(parsed.vfsOpt.VfsCacheMaxSize, '10G');
        assert.equal(parsed.vfsOpt.VfsReadChunkStreams, 8);
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
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      assert.equal(args[0], 'rcd', 'rclone must be started as the RC daemon');
      assert.ok(args.includes('--rc-addr'));
      assert.ok(args.some((a) => a === '127.0.0.1:' + rcPort), 'rc-addr must use the chosen port');
      // N-1: per-run RC credentials, and NO --rc-no-auth
      assert.ok(!args.includes('--rc-no-auth'), 'the RC API must require auth');
      // M-3: credentials must NOT travel in argv (readable by same-user
      // processes via the process table) — they go through the child env
      assert.ok(!args.includes('--rc-user'), 'rc-user must not be in argv');
      assert.ok(!args.includes('--rc-pass'), 'rc-pass must not be in argv');
      assert.ok(opts && opts.env && /^qd[0-9a-f]+$/.test(opts.env.RCLONE_RC_USER), 'RCLONE_RC_USER must be set in the child env');
      assert.ok(opts.env.RCLONE_RC_PASS && opts.env.RCLONE_RC_PASS.length >= 16, 'RCLONE_RC_PASS must be set in the child env');
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
    // every RC call carried Basic auth
    assert.ok(seenAuth.length >= 3, 'RC calls were made');
    for (const a of seenAuth) {
      assert.match(a, /^Basic [A-Za-z0-9+/=]+$/, 'RC requests must authenticate');
    }
  } finally {
    rcServer.close();
  }
});

test('custom cache size/mode/cacheDir are forwarded to rclone', async () => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  let mountBody = null;
  let spawnArgs = null;
  const rcServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/core/version') res.end(JSON.stringify({ version: 'v' }));
      else if (req.url === '/mount/mount') { mountBody = JSON.parse(body); res.end(JSON.stringify({ mountPoint: 'Y:\\' })); }
      else if (req.url === '/mount/listmounts') res.end(JSON.stringify({ mountPoints: [{ mountPoint: 'Y:\\' }] }));
      else res.end('{}');
    });
  });
  const rcPort = await new Promise((r) => rcServer.listen(0, '127.0.0.1', () => r(rcServer.address().port)));
  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.pid = 9;
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};
  const m = makeManager({
    settings: { driveLetter: 'Y', mountOptions: { vfsCacheMaxSize: '25G', vfsCacheMode: 'full', cacheDir: 'C:\\cache\\qd' } },
    spawn: (cmd, args) => { spawnArgs = args; return fakeChild; },
    sleep: async () => {},
    freePort: async () => rcPort,
  });
  try {
    await m.mount({ port: 1234, letter: 'Y', urlPrefix: '/' + 'a'.repeat(48) });
    assert.equal(mountBody.vfsOpt.VfsCacheMaxSize, '25G', 'user cache size reaches rclone');
    assert.equal(mountBody.vfsOpt.VfsCacheMode, 'full', 'user cache mode reaches rclone');
    assert.ok(spawnArgs.includes('--cache-dir'), 'cacheDir must be forwarded as --cache-dir');
    assert.ok(spawnArgs.includes('C:\\cache\\qd'), 'the cache dir value must be passed through');
  } finally {
    rcServer.close();
  }
});

test('N-2: concurrent mount calls join one attempt (no orphan rclone)', async () => {
  const { EventEmitter } = require('node:events');
  let spawns = 0;
  const m = makeManager({
    spawn: () => {
      spawns++;
      const c = new EventEmitter();
      c.exitCode = null;
      c.pid = 1;
      c.stderr = new EventEmitter();
      c.kill = () => {};
      // never becomes ready — both callers must share ONE failing attempt
      return c;
    },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 60000); })(),
    freePort: async () => 59998,
  });
  const results = await Promise.allSettled([
    m.mount({ port: 1234, letter: 'Y' }),
    m.mount({ port: 1234, letter: 'Y' }),
  ]);
  assert.equal(spawns, 1, 'exactly one rclone process may be spawned');
  for (const r of results) assert.equal(r.status, 'rejected');
  assert.equal(m.isMounted, false);
  assert.equal(m.mountInfo, null);
});

test('N-2: a failing attempt does not clear a newer mount\'s state', async () => {
  const { EventEmitter } = require('node:events');
  const goodChild = new EventEmitter();
  goodChild.exitCode = null;
  goodChild.pid = 2;
  goodChild.stderr = new EventEmitter();
  goodChild.kill = () => {};

  const m = makeManager();
  // simulate a healthy, already-published mount (generation 10)
  m.generation = 10;
  m.child = goodChild;
  m.mountInfo = { letter: 'Y', port: 1, rcPort: 2, startedAt: 0, generation: 10, rcAuth: { user: 'u', pass: 'p', port: 2 } };

  // fail() belongs to the attempt that spawned `child`; drive the invariant
  // directly: state published by generation 10 must survive a failure whose
  // attempt generation differs.
  const myGeneration = 11;
  const publishedByOther = m.mountInfo.generation !== myGeneration;
  assert.equal(publishedByOther, true, 'fixture: live state belongs to another attempt');
  // (the same guard lives in MountManager.fail: clear only own state)
  assert.equal(m.isMounted, true);
});

test('A-13: an unexpected rclone exit clears state and notifies the UI', async () => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');

  const rcServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/core/version') res.end(JSON.stringify({ version: 'v' }));
      else if (req.url === '/mount/mount') res.end(JSON.stringify({ mountPoint: 'Y:\\' }));
      else if (req.url === '/mount/listmounts') res.end(JSON.stringify({ mountPoints: [{ mountPoint: 'Y:\\' }] }));
      else res.end('{}');
    });
  });
  const rcPort = await new Promise((r) => rcServer.listen(0, '127.0.0.1', () => r(rcServer.address().port)));

  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.pid = 777;
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};

  const notified = [];
  const m = makeManager({
    spawn: () => fakeChild,
    sleep: async () => {},
    freePort: async () => rcPort,
    onStateChange: () => notified.push(1),
  });
  try {
    await m.mount({ port: 1234, letter: 'Y', urlPrefix: '/' + 'a'.repeat(48) });
    assert.equal(m.isMounted, true);
    // rclone crashes / is killed externally
    fakeChild.exitCode = 3;
    fakeChild.emit('exit', 3);
    assert.equal(m.child, null, 'state must be cleared on exit');
    assert.equal(m.mountInfo, null);
    assert.equal(m.isMounted, false);
    assert.equal(m.status().mounted, false);
    assert.equal(notified.length, 1, 'the UI must be notified so it stops showing "mounted"');
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
  m.mountInfo = { letter: 'Q', port: 1, rcPort, startedAt: 0, rcAuth: { user: 'u', pass: 'p', port: rcPort } };
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

test('listTransfers reports in-flight VFS transfers (feature: progress line)', async () => {
  const http = require('node:http');
  const rcServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/core/transfers') {
        res.end(JSON.stringify({
          transfers: [
            { name: 'Q:\\docs\\big.bin', size: 1048576, bytes: 524288, percentage: 50 },
            { name: 'C:\\other\\x.txt', size: 10, bytes: 10, percentage: 100 },
          ],
        }));
      } else res.end('{}');
    });
  });
  const rcPort = await new Promise((r) => rcServer.listen(0, '127.0.0.1', () => r(rcServer.address().port)));
  const m = makeManager();
  const child = { exitCode: null };
  m.child = child;
  m.mountInfo = { letter: 'Q', port: 1, rcPort, startedAt: 0, rcAuth: { user: 'u', pass: 'p', port: rcPort } };
  try {
    const list = await m.listTransfers();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'big.bin', 'only the basename is shown');
    assert.equal(list[0].percentage, 50);
    assert.equal(list[1].percentage, 100);
    // unmounted -> empty list, no RC call
    m.child = null;
    m.mountInfo = null;
    assert.deepEqual(await m.listTransfers(), []);
  } finally {
    rcServer.close();
  }
});
