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
const rcloneSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'mount', 'rclone.js'), 'utf8');

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

test('E-1: the renderer HTML carries a strict Content-Security-Policy', () => {
  const m = /<meta http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(htmlSrc);
  assert.ok(m, 'index.html must declare a CSP meta tag');
  const csp = m[1];
  assert.match(csp, /default-src 'none'/, 'default-src must deny everything by default');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self' data:/, 'the QR code is rendered from a data: URL');
  assert.match(csp, /connect-src 'none'/, 'the renderer must not be able to make network requests');
  assert.doesNotMatch(csp, /unsafe-inline/, 'no unsafe-inline');
  assert.doesNotMatch(csp, /unsafe-eval/, 'no unsafe-eval');
  // nothing the CSP would block may be loaded by the page
  assert.doesNotMatch(htmlSrc, /<link[^>]+href="https?:/);
  assert.doesNotMatch(htmlSrc, /<img[^>]+src="https?:/);
  assert.doesNotMatch(htmlSrc, /url\(['"]?https?:/);
});

test('N-2: mount/unmount/server operations are serialized in main.js', () => {
  // concurrent tray clicks must not spawn two rclone processes
  assert.match(mainSrc, /require\('\.\/op-queue\.js'\)/, 'main must use the op queue');
  assert.match(mainSrc, /createOpQueue\(\)/);
  assert.match(mainSrc, /mountDrive[\s\S]*?return serialize\(/);
  assert.match(mainSrc, /unmountDrive[\s\S]*?return serialize\(/);
  assert.match(mainSrc, /startServer[\s\S]*?return serialize\(/);
  // a failed listen must not leave a dead server object behind
  assert.match(mainSrc, /server && server\.listening/);
});

test('N-4: logout drops the in-memory session and stops the WebDAV server', () => {
  const logout = /auth:logout'[\s\S]*?\}\);/.exec(mainSrc);
  assert.ok(logout, 'logout handler not found');
  assert.match(logout[0], /new CookieJar\(\)/, 'logout must reset the cookie jar');
  assert.match(logout[0], /closeAsync\(\)/, 'logout must stop the WebDAV server');
  assert.match(logout[0], /cancelLogin\(\)/, 'logout must stop an in-flight login');
});

test('N-3: the login loop carries an abort signal into every HTTP call', () => {
  assert.match(mainSrc, /auth\.start\(\{ signal: ac\.signal \}\)/);
  assert.match(mainSrc, /auth\.poll\(\{ signal: ac\.signal \}\)/);
  assert.match(mainSrc, /auth\.complete\([^)]*\{ signal: ac\.signal \}\)/);
  assert.match(mainSrc, /async function cancelLogin\(/);
});

test('N-1/M-3: the rclone RC daemon requires per-run credentials passed via env (not argv)', () => {
  assert.doesNotMatch(rcloneSrc, /--rc-no-auth/, 'the RC API must never be unauthenticated');
  // credentials must NOT appear in argv — same-user processes can read the
  // process table (Win32_Process.CommandLine) and would recover them
  assert.doesNotMatch(rcloneSrc, /'--rc-user'/, 'rc-user must not be an argv flag');
  assert.doesNotMatch(rcloneSrc, /'--rc-pass'/, 'rc-pass must not be an argv flag');
  assert.match(rcloneSrc, /RCLONE_RC_USER/, 'RC user must come from the child environment');
  assert.match(rcloneSrc, /RCLONE_RC_PASS/, 'RC pass must come from the child environment');
  assert.match(rcloneSrc, /randomCreds/, 'credentials must be generated per run');
  assert.match(rcloneSrc, /Authorization.*Basic|Basic.*Authorization/, 'RC calls must authenticate');
});

test('feature: transfer progress polling and start-minimized are wired', () => {
  assert.match(mainSrc, /startTransferPoll\(\)/, 'mounting must start the transfer poll');
  assert.match(mainSrc, /stopTransferPoll\(\)/, 'unmounting must stop the transfer poll');
  assert.match(mainSrc, /listTransfers/, 'the poll must read rclone transfers');
  assert.match(mainSrc, /startMinimized/, 'the start-minimized setting must be honoured');
  assert.match(mainSrc, /createWindow\(\{ show: !stack\.settings\.startMinimized \}\)/);
  // the new settings key is whitelisted and the new channels exist
  const wl = /SETTINGS_WHITELIST = new Set\(\[([^\]]*)\]\)/.exec(mainSrc);
  assert.ok(wl[1].includes("'startMinimized'"), 'startMinimized must be renderer-settable');
  const events = listLiteral(preloadSrc, 'EVENT_CHANNELS');
  assert.ok(events.has('drive:transfers'), 'drive:transfers must be whitelisted');
  const invoke = listLiteral(preloadSrc, 'INVOKE_CHANNELS');
  for (const c of ['app:openDrive', 'app:quit']) {
    assert.ok(invoke.has(c), c + ' must be whitelisted');
  }
});

test('round-3: the window never navigates/opens popups; the log line drops the URL token', () => {
  assert.match(mainSrc, /will-navigate/, 'renderer-initiated navigation must be blocked');
  assert.match(mainSrc, /setWindowOpenHandler\(\s*\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)/, 'popups must be denied');
  // M-3: the per-run URL prefix is a secret — it must never reach the log file
  assert.doesNotMatch(mainSrc, /port \+ srv\.urlPrefix/, 'the URL token must not be logged');
  assert.match(mainSrc, /webdav listening on 127\.0\.0\.1:' \+ port\)/);
  // settings:set must not let an explicit undefined erase a stored key
  assert.match(mainSrc, /if \(v === undefined\) continue/, 'explicit undefined must not drop a settings key');
});

test('feature: cache size/mode are renderer-settable and sanitized', () => {
  // the renderer must not be able to smuggle arbitrary rclone options through
  // mountOptions — main.js routes them through the strict sanitizer
  assert.match(mainSrc, /sanitizeRendererMountOptions/, 'main must sanitize mountOptions patches');
  assert.match(mainSrc, /clean\.mountOptions/, 'main must merge only the cleaned cache keys');
  // cache clearing is guarded to the app data dir and refuses while mounted
  assert.match(mainSrc, /app:clearCache/, 'main must handle cache clearing');
  assert.match(mainSrc, /isInside\(stack\.config\.baseDir, dir\)/, 'clearCache must be path-guarded');
  assert.match(mainSrc, /if \(stack\.mount\.isMounted\)[\s\S]*?请先卸载/, 'clearCache must refuse while mounted');
  const invoke = listLiteral(preloadSrc, 'INVOKE_CHANNELS');
  assert.ok(invoke.has('app:clearCache'), 'app:clearCache must be whitelisted');
  // the renderer wires every cache control to an element that exists in the HTML
  for (const id of ['sel-cache-size', 'inp-cache-size', 'sel-cache-mode', 'btn-clear-cache', 'cache-status', 'cache-custom-row']) {
    assert.ok(rendererSrc.includes("'" + id + "'"), 'renderer must reference #' + id);
    assert.ok(htmlSrc.includes('id="' + id + '"'), 'html must define #' + id);
  }
});
