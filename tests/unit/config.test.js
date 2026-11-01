'use strict';
/**
 * config.test.js — session/settings persistence and path containment.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore, DEFAULT_SETTINGS, isInside, deepMerge, defaultBaseDir } = require('../../core/config.js');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-cfg-'));
  return new ConfigStore({ baseDir: dir });
}

test('defaults cover the documented settings', () => {
  assert.equal(DEFAULT_SETTINGS.driveLetter, 'Q');
  assert.equal(DEFAULT_SETTINGS.webdavPort, 9798);
  assert.equal(DEFAULT_SETTINGS.mountOptions.vfsCacheMode, 'writes');
  // fluidity defaults forwarded to rclone
  assert.equal(DEFAULT_SETTINGS.mountOptions.bufferSize, '64M');
  assert.equal(DEFAULT_SETTINGS.mountOptions.vfsCacheMaxSize, '10G');
  assert.equal(DEFAULT_SETTINGS.mountOptions.vfsReadChunkStreams, 8);
  assert.equal(DEFAULT_SETTINGS.startMinimized, false);
});

test('session round-trip and clear', () => {
  const store = tmpStore();
  assert.equal(store.loadSession(), null);
  assert.equal(store.isLoggedIn(), false);
  store.saveSession({ cookies: { __puus: 'abc' }, user: { nickname: 'me' } });
  const s = store.loadSession();
  assert.equal(s.cookies.__puus, 'abc');
  assert.equal(s.user.nickname, 'me');
  assert.ok(s.createdAt);
  assert.equal(store.isLoggedIn(), true);
  store.clearSession();
  assert.equal(store.loadSession(), null);
});

test('empty cookie session is treated as logged out', () => {
  const store = tmpStore();
  store.saveSession({ cookies: {} });
  assert.equal(store.loadSession(), null);
});

test('corrupt session file is ignored, not fatal', () => {
  const store = tmpStore();
  store.ensureDirs();
  fs.writeFileSync(store.paths.sessionFile, '{broken');
  assert.equal(store.loadSession(), null);
});

test('settings merge keeps defaults for missing keys', () => {
  const store = tmpStore();
  assert.deepEqual(store.loadSettings(), DEFAULT_SETTINGS);
  store.saveSettings({ driveLetter: 'Z', mountOptions: { bufferSize: '128M' } });
  const s = store.loadSettings();
  assert.equal(s.driveLetter, 'Z');
  assert.equal(s.mountOptions.bufferSize, '128M');
  assert.equal(s.mountOptions.vfsCacheMode, 'writes'); // default preserved
  assert.equal(s.webdavPort, 9798);
});

test('isInside detects traversal', () => {
  assert.equal(isInside('C:\\a\\b', 'C:\\a\\b\\c.txt'), true);
  assert.equal(isInside('C:\\a\\b', 'C:\\a\\b'), true);
  assert.equal(isInside('C:\\a\\b', 'C:\\a\\bc'), false);
  assert.equal(isInside('C:\\a\\b', 'C:\\a\\b\\..\\..\\etc'), false);
});

test('logFile rejects escaping names but accepts normal ones', () => {
  const store = tmpStore();
  const ok = store.logFile('app.log');
  assert.equal(path.dirname(ok), store.paths.logDir);
  assert.throws(() => store.logFile('../evil.log'), /escapes/);
  assert.throws(() => store.logFile('C:\\Windows\\evil.log'), /escapes/);
});

test('deepMerge is recursive and non-destructive', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, e: [1, 2] };
  const out = deepMerge(base, { b: { c: 9 }, f: 5 });
  assert.deepEqual(out, { a: 1, b: { c: 9, d: 3 }, e: [1, 2], f: 5 });
  assert.deepEqual(base, { a: 1, b: { c: 2, d: 3 }, e: [1, 2] }); // untouched
});

test('defaultBaseDir points at LOCALAPPDATA/QuarkDrive', () => {
  const dir = defaultBaseDir();
  assert.match(dir, /QuarkDrive$/);
});
