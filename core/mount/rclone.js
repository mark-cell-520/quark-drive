'use strict';
/**
 * rclone.js — mount lifecycle management.
 *
 * The Quark namespace is exposed as a local drive by combining:
 *   our WebDAV server (127.0.0.1)  <-rclone mount->  WinFsp  ->  drive letter
 *
 * This module owns the rclone child process: locating the binary, building the
 * remote spec, spawning, readiness detection and teardown.
 *
 * Readiness is detected through rclone's own RC API (`--rc`): we poll
 * /mount/listmounts until our mount point appears. That avoids probing the
 * mounted filesystem (which can hang forever on a broken mount) and avoids
 * spawning helper processes — the Electron app's process.execPath is
 * electron.exe, which cannot run node scripts.
 */
const net = require('node:net');
const { spawn: defaultSpawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RCLONE = 'rclone';
const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 500;

class MountError extends Error {
  constructor(stage, message) {
    super('mount ' + stage + ': ' + message);
    this.name = 'MountError';
    this.stage = stage;
  }
}

/** Validate a drive letter (single A-Z, no colon/backslash). */
function normalizeLetter(letter) {
  const m = /^([a-z])[:\\.]?$/i.exec(String(letter || '').trim());
  if (!m) throw new MountError('config', 'invalid drive letter: ' + letter);
  return m[1].toUpperCase();
}

class MountManager {
  /**
   * @param {{
   *   settings: {driveLetter: string, rclonePath?: string, mountOptions?: object},
   *   logger?: {debug: Function, info: Function, warn: Function, error: Function},
   *   rclonePath?: string,          // explicit override
   *   vendorDir?: string,           // bundled rclone location
   *   spawn?: typeof defaultSpawn,  // injectable for tests
   *   freePort?: () => Promise<number>, // injectable for tests
   *   sleep?: (ms: number) => Promise<void>,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts = {}) {
    this.settings = opts.settings || {};
    this.logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.rclonePath = opts.rclonePath || this.settings.rclonePath || '';
    this.vendorDir = opts.vendorDir || path.join(__dirname, '..', '..', 'vendor');
    this.spawn = opts.spawn || defaultSpawn;
    this.freePort = opts.freePort || freePort;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now || (() => Date.now());
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    /** @type {{letter: string, port: number, startedAt: number, logFile: string}|null} */
    this.mountInfo = null;
  }

  /** Locate the rclone binary: explicit path → vendor/ → PATH. */
  findRclone() {
    const candidates = [];
    if (this.rclonePath) candidates.push(this.rclonePath);
    candidates.push(path.join(this.vendorDir, 'rclone.exe'));
    candidates.push(DEFAULT_RCLONE);
    for (const c of candidates) {
      try {
        if (c === DEFAULT_RCLONE || fs.existsSync(c)) {
          // verify it runs
          execFileSync(c, ['version'], { timeout: 10000, stdio: 'ignore' });
          return c;
        }
      } catch (_e) { /* try next */ }
    }
    throw new MountError('locate', 'rclone not found (looked in settings.rclonePath, vendor/, PATH)');
  }

  /**
   * Detect WinFsp (the kernel driver rclone needs on Windows).
   * @returns {{ok: boolean, reason?: string}}
   */
  checkWinFsp() {
    // The launcher service is the reliable signal (the .sys is loaded on demand).
    try {
      const out = execFileSync('sc.exe', ['query', 'winfsp.launcher'], {
        timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (/STATE\s+:\s*4/.test(out)) return { ok: true }; // RUNNING
      if (/does not exist/i.test(out)) {
        return { ok: false, reason: 'WinFsp is not installed (run the bundled winfsp installer)' };
      }
      return { ok: true }; // installed but stopped — rclone can start it
    } catch (e) {
      const msg = String(e.stderr || e.message || '');
      if (/does not exist/i.test(msg)) {
        return { ok: false, reason: 'WinFsp is not installed (run the bundled winfsp installer)' };
      }
      return { ok: true }; // sc failed for another reason; let rclone decide
    }
  }

  get isMounted() {
    return !!(this.child && this.mountInfo && this.child.exitCode === null);
  }

  /** Current mount state for the UI/CLI. */
  status() {
    if (!this.mountInfo) return { mounted: false, letter: null, port: null };
    return {
      mounted: this.isMounted,
      letter: this.mountInfo.letter,
      port: this.mountInfo.port,
      startedAt: this.mountInfo.startedAt,
    };
  }

  /**
   * Mount the WebDAV endpoint as a drive letter.
   *
   * Uses rclone's RC API end-to-end: we spawn `rclone rcd` and drive the
   * mount through POST /mount/mount. That gives us exact readiness
   * detection (listmounts) and graceful unmount (VFS flush) without probing
   * the mounted filesystem — which can hang forever on a broken mount.
   *
   * @param {{port: number, urlPrefix?: string, letter?: string, logFile?: string}} opts
   * @returns {Promise<{letter: string, pid: number, rcPort: number}>}
   */
  async mount(opts) {
    if (this.isMounted) throw new MountError('mount', 'already mounted at ' + this.mountInfo.letter + ':');
    const letter = normalizeLetter(opts.letter || this.settings.driveLetter || 'Q');
    const winfsp = this.checkWinFsp();
    if (!winfsp.ok) throw new MountError('mount', winfsp.reason);

    const rclone = this.findRclone();
    const root = letter + ':\\';
    if (fs.existsSync(root)) {
      throw new MountError('mount', 'drive ' + letter + ': is already in use');
    }

    // the WebDAV server's secret URL prefix (per-run auth token)
    const prefix = opts.urlPrefix || '/';
    const remote = ":webdav,url='http://127.0.0.1:" + opts.port + prefix + "',vendor='other':";
    const mo = this.settings.mountOptions || {};
    const rcPort = await this.freePort();

    // `rclone rcd` = the remote-control daemon (no filesystem side effects).
    const args = [
      'rcd',
      '--rc-addr', '127.0.0.1:' + rcPort,
      '--rc-no-auth',
      '--log-level', 'INFO',
    ];
    if (mo.cacheDir) args.push('--cache-dir', mo.cacheDir);
    if (opts.logFile) args.push('--log-file', opts.logFile);
    this.logger.info('mounting ' + root + ' via ' + rclone + ' (rc ' + rcPort + ')');

    const child = this.spawn(rclone, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    this.mountInfo = {
      letter, port: opts.port, rcPort, startedAt: this.now(),
      logFile: opts.logFile || null,
    };

    let stderr = '';
    const onStderr = (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    };
    if (child.stderr && child.stderr.on) child.stderr.on('data', onStderr);
    const onExit = (code) => {
      this.logger.warn('rclone exited (code=' + code + ')' + (stderr ? ': ' + stderr.slice(-500) : ''));
      if (this.mountInfo) this.mountInfo.exitedAt = this.now();
    };
    child.on('exit', onExit);

    /** Detach and release the child's pipes (test-safe, leak-safe). */
    const releaseChild = () => {
      try { child.removeListener('exit', onExit); } catch (_e) { /* ignore */ }
      try { if (child.stderr && child.stderr.removeListener) child.stderr.removeListener('data', onStderr); } catch (_e) { /* ignore */ }
      try { if (child.stderr && child.stderr.destroy) child.stderr.destroy(); } catch (_e) { /* ignore */ }
      try { child.unref && child.unref(); } catch (_e) { /* ignore */ }
    };

    const fail = (msg) => {
      const tail = stderr.trim();
      this.mountInfo = null;
      try { child.kill(); } catch (_e) { /* ignore */ }
      releaseChild();
      this.child = null;
      throw new MountError('mount', msg + (tail ? ' — ' + tail.slice(-300) : ''));
    };

    try {
      // 1. wait for the RC endpoint to answer
      const rcDeadline = this.now() + 20000;
      for (;;) {
        if (child.exitCode !== null) {
          fail('rclone exited early: ' + (stderr.trim() || 'code ' + child.exitCode));
        }
        if (await this._rcPost(rcPort, '/core/version', {}) !== null) break;
        if (this.now() > rcDeadline) fail('rclone RC did not come up');
        await this.sleep(250);
      }

      // 2. start the mount through the RC API.
      // NOTE: no `mountType` — this rclone version rejects it as an
      // unregistered mount option.
      const mountRes = await this._rcPost(rcPort, '/mount/mount', {
        fs: remote,
        mountPoint: root,
        mountOpt: {},
        // VFS options live in vfsOpt (mountOpt is the FUSE layer)
        vfsOpt: {
          VfsCacheMode: mo.vfsCacheMode || 'writes',
          DirCacheTime: mo.dirCacheTime || '10s',
        },
      });
      if (mountRes === null) fail('mount/mount failed');
      this.logger.debug('mount/mount accepted: ' + JSON.stringify(mountRes).slice(0, 200));

      // 3. wait until listmounts reports our mount point as mounted
      const deadline = this.now() + READY_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null) fail('rclone exited early: ' + (stderr.trim() || 'code ' + child.exitCode));
        if (await this._rcMountReady(rcPort, root)) {
          this.logger.info('mounted ' + root + ' (pid ' + child.pid + ', rc ' + rcPort + ')');
          return { letter, pid: child.pid, rcPort };
        }
        if (this.now() > deadline) fail('drive did not become ready within ' + READY_TIMEOUT_MS + 'ms');
        await this.sleep(READY_POLL_MS);
      }
    } catch (e) {
      if (e instanceof MountError) throw e;
      fail(e.message);
    }
  }

  /** POST to the rclone RC API; returns parsed JSON or null on any failure. */
  async _rcPost(rcPort, path, body) {
    try {
      const res = await fetch('http://127.0.0.1:' + rcPort + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_e) { /* keep null */ }
      if (!res.ok || (json && json.error)) {
        this.logger.warn('RC ' + path + ' -> ' + res.status + ' ' + (json && json.error ? json.error : text.slice(0, 200)));
        return null;
      }
      return json || {};
    } catch (e) {
      return null;
    }
  }

  /** Poll rclone's RC /mount/listmounts until our mount point shows up. */
  async _rcMountReady(rcPort, root) {
    const j = await this._rcPost(rcPort, '/mount/listmounts', {});
    if (!j) return false;
    const want = root.replace(/[\\/]+$/, '').toUpperCase();
    const points = Array.isArray(j.mountPoints) ? j.mountPoints : [];
    return points.some((m) => {
      // rclone returns "MountPoint" (Go field casing); tolerate both spellings
      const mp = m && (m.MountPoint != null ? m.MountPoint : m.mountPoint);
      return String(mp || '').replace(/[\\/]+$/, '').toUpperCase() === want;
    });
  }

  /** Ask rclone to unmount gracefully (flushes the VFS cache); kill as fallback. */
  async _rcUnmount(rcPort, mountPoint) {
    const j = await this._rcPost(rcPort, '/mount/unmount', { mountPoint: mountPoint || '' });
    return j !== null;
  }

  /** Unmount: ask rclone via RC (graceful, flushes the VFS), then kill. */
  async unmount() {
    const child = this.child;
    const info = this.mountInfo;
    this.mountInfo = null;
    this.child = null;
    if (!child || child.exitCode !== null) return { unmounted: false };

    if (info && info.rcPort) {
      const ok = await this._rcUnmount(info.rcPort, info.letter + ':');
      if (ok) {
        // wait briefly for rclone to exit on its own
        const deadline = this.now() + 15000;
        while (child.exitCode === null && this.now() < deadline) {
          await this.sleep(200);
        }
      }
    }
    if (child.exitCode === null) {
      child.kill();
      const deadline = this.now() + 10000;
      while (child.exitCode === null && this.now() < deadline) {
        await this.sleep(200);
      }
    }
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch (_e) { /* ignore */ }
    }
    this.logger.info('unmounted');
    return { unmounted: true };
  }
}

/** Grab a free localhost port (small race window, acceptable for the RC port). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

module.exports = { MountManager, MountError, normalizeLetter };
