'use strict';
/**
 * config.js — on-disk state: session cookies (secret), settings, device id.
 *
 * Layout (default base: %LOCALAPPDATA%\QuarkDrive):
 *   device.json    — stable machine id + device name     (0600)
 *   session.json   — login cookies + user snapshot       (0600, never commit)
 *   settings.json  — user preferences                    (0644)
 *   logs/          — rotating logs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR_NAME = 'QuarkDrive';

const DEFAULT_SETTINGS = {
  driveLetter: 'Q',
  autoMount: true,
  startWithWindows: false,
  startMinimized: false,
  webdavPort: 9798,
  rclonePath: '', // empty = auto-detect (PATH then vendor/)
  mountOptions: {
    vfsCacheMode: 'writes',
    dirCacheTime: '5m',
    bufferSize: '64M',
    // Bound the on-disk VFS cache (rclone's default is unlimited)
    vfsCacheMaxSize: '10G',
    // Flush pending writes quickly (graceful unmount covers the rest)
    vfsWriteBack: '5s',
    // Smaller read chunks + parallel streams: smoother sequential reads and
    // far less waste on preview/seek than rclone's 128 MiB default chunk
    vfsReadChunkSize: '16M',
    vfsReadChunkStreams: 8,
  },
};

function defaultBaseDir() {
  const local = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (local) return path.join(local, APP_DIR_NAME);
  return path.join(os.homedir(), '.quark-drive');
}

/** True when `target` is inside `baseDir` (both absolute, normalised). */
function isInside(baseDir, target) {
  const b = path.resolve(baseDir);
  const t = path.resolve(target);
  if (t === b) return true;
  return t.startsWith(b + path.sep);
}

class ConfigStore {
  /** @param {{baseDir?: string}} [opts] */
  constructor(opts = {}) {
    this.baseDir = opts.baseDir || defaultBaseDir();
    this.paths = {
      base: this.baseDir,
      deviceFile: path.join(this.baseDir, 'device.json'),
      sessionFile: path.join(this.baseDir, 'session.json'),
      settingsFile: path.join(this.baseDir, 'settings.json'),
      logDir: path.join(this.baseDir, 'logs'),
    };
  }

  ensureDirs() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.mkdirSync(this.paths.logDir, { recursive: true });
  }

  _readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) {
      return null;
    }
  }

  _writeJson(file, obj, mode) {
    this.ensureDirs();
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode });
    try { fs.chmodSync(file, mode); } catch (_e) { /* win32: best effort */ }
  }

  // ---- session ------------------------------------------------------------

  /**
   * @returns {{cookies: Record<string,string>, user: object|null, createdAt: string}|null}
   */
  loadSession() {
    const s = this._readJson(this.paths.sessionFile);
    if (!s || !s.cookies || typeof s.cookies !== 'object' || Object.keys(s.cookies).length === 0) {
      return null;
    }
    return { cookies: s.cookies, user: s.user || null, createdAt: s.createdAt || null };
  }

  /**
   * @param {{cookies: Record<string,string>, user?: object|null}} session
   */
  saveSession(session) {
    this._writeJson(this.paths.sessionFile, {
      cookies: session.cookies || {},
      user: session.user || null,
      createdAt: new Date().toISOString(),
    }, 0o600);
  }

  clearSession() {
    try { fs.unlinkSync(this.paths.sessionFile); } catch (_e) { /* already gone */ }
  }

  isLoggedIn() {
    return this.loadSession() !== null;
  }

  // ---- settings ------------------------------------------------------------

  loadSettings() {
    const s = this._readJson(this.paths.settingsFile);
    return deepMerge(DEFAULT_SETTINGS, s || {});
  }

  saveSettings(settings) {
    this._writeJson(this.paths.settingsFile, settings, 0o644);
  }

  // ---- log path ------------------------------------------------------------

  /** Log file path inside the app dir (rejects traversal). */
  logFile(name) {
    const n = String(name || 'quark-drive.log');
    // Only a bare file name is acceptable: no separators, no parent refs,
    // no drive letters / UNC prefixes.
    if (n !== path.basename(n) || n === '.' || n === '..' || path.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) {
      throw new Error('log path escapes log dir');
    }
    const file = path.join(this.paths.logDir, n);
    if (!isInside(this.paths.logDir, file)) throw new Error('log path escapes log dir');
    return file;
  }
}

/** Merge `patch` onto `base` (plain objects only, one level deep is enough). */
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    // never let a JSON-parsed __proto__/constructor key redefine prototypes
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { ConfigStore, DEFAULT_SETTINGS, defaultBaseDir, isInside, deepMerge };
