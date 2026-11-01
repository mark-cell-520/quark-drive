'use strict';
/**
 * app-contract.test.js — static contract tests for the Electron shell.
 *
 * The GUI cannot run inside the CI sandbox (Chromium needs APIs the sandbox
 * blocks), so we verify the parts that break silently instead:
 *   - every ipcMain.handle channel is whitelisted in preload
 *   - every channel the renderer uses is whitelisted in preload
 *   - every getElementById in the renderer exists in index.html
 *   - every api.invoke in the renderer matches a handler in main.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', '..', 'app');
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');

function handlers(src) {
  return new Set([...src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]));
}
function invokeChannels(src) {
  return new Set([...src.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]));
}
function eventChannels(src) {
  return new Set([...src.matchAll(/\.on\(\s*'([^']+)'/g)].map((m) => m[1]));
}
function listLiteral(src, name) {
  const m = new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(src);
  assert.ok(m, 'list ' + name + ' not found in preload');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

test('preload whitelists exactly the channels main handles', () => {
  const handled = handlers(mainSrc);
  const whitelisted = listLiteral(preloadSrc, 'INVOKE_CHANNELS');
  for (const h of handled) {
    assert.ok(whitelisted.has(h), 'main handles ' + h + ' but preload does not whitelist it');
  }
  for (const w of whitelisted) {
    assert.ok(handled.has(w), 'preload whitelists ' + w + ' but main has no handler');
  }
  assert.ok(whitelisted.size > 0);
});

test('preload event whitelist matches the events main sends', () => {
  const sent = new Set([...mainSrc.matchAll(/send\(\s*'([^']+)'/g)].map((m) => m[1]));
  const whitelisted = listLiteral(preloadSrc, 'EVENT_CHANNELS');
  for (const s of sent) {
    assert.ok(whitelisted.has(s), 'main sends ' + s + ' but preload does not whitelist it');
  }
  for (const w of whitelisted) {
    assert.ok(sent.has(w), 'preload whitelists event ' + w + ' but main never sends it');
  }
});

test('renderer only invokes whitelisted channels that main handles', () => {
  const invoked = invokeChannels(rendererSrc);
  const whitelisted = listLiteral(preloadSrc, 'INVOKE_CHANNELS');
  const handled = handlers(mainSrc);
  for (const c of invoked) {
    assert.ok(whitelisted.has(c), 'renderer invokes ' + c + ' which is not whitelisted');
    assert.ok(handled.has(c), 'renderer invokes ' + c + ' which main does not handle');
  }
});

test('renderer only subscribes to whitelisted events', () => {
  const used = eventChannels(rendererSrc);
  const whitelisted = listLiteral(preloadSrc, 'EVENT_CHANNELS');
  for (const c of used) {
    assert.ok(whitelisted.has(c), 'renderer listens on ' + c + ' which is not whitelisted');
  }
});

test('every getElementById in the renderer exists in the HTML', () => {
  // the renderer uses $('id') (document.getElementById wrapper) plus direct calls
  const ids = new Set([
    ...[...rendererSrc.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...rendererSrc.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ]);
  const htmlIds = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of ids) {
    assert.ok(htmlIds.has(id), 'renderer references #' + id + ' missing from index.html');
  }
  assert.ok(ids.size >= 15, 'expected a decent number of element refs, got ' + ids.size);
});

test('renderer binds listeners for every button it defines', () => {
  const buttons = new Set([...htmlSrc.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]));
  for (const b of buttons) {
    assert.ok(rendererSrc.includes("'" + b + "'"), 'button #' + b + ' has no listener wiring');
  }
});

test('main.js hardens the BrowserWindow (no nodeIntegration, isolation on, sandboxed preload)', () => {
  assert.match(mainSrc, /contextIsolation:\s*true/);
  assert.match(mainSrc, /nodeIntegration:\s*false/);
  assert.match(mainSrc, /sandbox:\s*true/);
  assert.match(mainSrc, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/);
  assert.match(mainSrc, /requestSingleInstanceLock/);
  // renderer HTML must not inline remote scripts
  assert.doesNotMatch(htmlSrc, /<script[^>]+src="https?:/);
});
