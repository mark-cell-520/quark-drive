'use strict';
/**
 * index.test.js — stack assembly, logger redaction, CLI dispatch.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildStack, createLogger, cli, USAGE } = require('../../core/index.js');
const { CookieJar } = require('../../core/quark/http.js');

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-idx-'));
}

test('buildStack assembles every layer and restores a saved session', () => {
  const base = tmpBase();
  const stack = buildStack({ baseDir: base, quiet: true });
  assert.ok(stack.config);
  assert.ok(stack.device);
  assert.ok(stack.api);
  assert.ok(stack.uploader);
  assert.ok(stack.fs);
  assert.ok(stack.auth);
  assert.ok(stack.mount);
  assert.equal(stack.http.cookieJar.size, 0);
  // persist + rebuild -> cookies restored
  stack.config.saveSession({ cookies: { __puus: 'sess-1' }, user: { nickname: 'me' } });
  const stack2 = buildStack({ baseDir: base, quiet: true });
  assert.equal(stack2.http.cookieJar.header(), '__puus=sess-1');
  assert.equal(stack2.settings.driveLetter, 'Q');
});

test('createLogger redacts registered secrets from file output', () => {
  const base = tmpBase();
  const logFile = path.join(base, 'test.log');
  const logger = createLogger(logFile);
  logger.addSecret('__puus=supersecretcookievalue');
  logger.addSecret('tok-LIVE-login-token');
  logger.info('cookie is __puus=supersecretcookievalue and token tok-LIVE-login-token');
  const text = fs.readFileSync(logFile, 'utf8');
  assert.doesNotMatch(text, /supersecretcookievalue/);
  assert.doesNotMatch(text, /tok-LIVE-login-token/);
  assert.match(text, /<redacted>/);
  assert.match(text, /INFO/);
});

test('createLogger never throws when the log file is unwritable', () => {
  const logger = createLogger('Z:\\nonexistent-dir\\x.log');
  logger.info('still fine');
  logger.error('still fine');
});

test('cli status works without a session', async () => {
  const base = tmpBase();
  const code = await cliWithBase(['status'], base);
  assert.equal(code, 0);
});

test('cli logout clears the session', async () => {
  const base = tmpBase();
  const appDir = path.join(base, 'QuarkDrive'); // default baseDir = %LOCALAPPDATA%\QuarkDrive
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'session.json'), JSON.stringify({ cookies: { __puus: 'x' } }), { mode: 0o600 });
  const code = await cliWithBase(['logout'], base);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(appDir, 'session.json')), false);
});

test('cli doctor reports the environment', async () => {
  const base = tmpBase();
  const code = await cliWithBase(['doctor'], base);
  assert.equal(code, 0);
});

test('cli with no command prints usage and exits 0', async () => {
  const base = tmpBase();
  const code = await cliWithBase([], base);
  assert.equal(code, 0);
});

test('cli unknown command exits 1', async () => {
  const base = tmpBase();
  const code = await cliWithBase(['frobnicate'], base);
  assert.equal(code, 1);
});

/** Run the CLI against a temp base dir by swapping the config default. */
async function cliWithBase(argv, base) {
  const orig = process.env.LOCALAPPDATA;
  const origApp = process.env.APPDATA;
  process.env.LOCALAPPDATA = base;
  process.env.APPDATA = base;
  try {
    return await cli(argv);
  } finally {
    process.env.LOCALAPPDATA = orig;
    process.env.APPDATA = origApp;
  }
}
