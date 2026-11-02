'use strict';
/**
 * rclone.js — mount lifecycle management.
 *
 * The Quark namespace is exposed as a local drive by combining:
 *   our WebDAV server (127.0.0.1)  <-rclone mount->  WinFsp  ->  drive letter
 *
 * This module owns the rclone child process: locating the binary, building
 * the remote spec, spawning, readiness detection and teardown.
 *
 * Readiness is detected through rclone's own RC API (`--rc`): we poll
 * /mount/listmounts until our mount point appears. That avoids probing the
 * mounted filesystem (which can hang forever on a broken mount) and avoids
 * spawning helper processes — the Electron app's process.execPath is
 * electron.exe, which cannot run node scripts.
 *
 * Hardening:
 *  - the RC endpoint is protected by per-run random credentials (Basic auth)
 *    passed via the child's environment (argv is readable by same-user
 *    processes); without them any local process — or a browser page via a
 *    CORS simple request — could enumerate the filesystem or (un)mount
 *    drives.
 *  - mount/unmount are serialized by in-flight locks, and a failing attempt
 *    only clears state it owns (generation token), so a concurrent or failed
 *    mount can never orphan an rclone process holding the drive letter.
 */
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn: defaultSpawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
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

/** Random per-run RC credentials (never persisted, never logged). */
function randomCreds() {
  return {
    user: 'qd' + crypto.randomBytes(6).toString('hex'),
    pass: crypto.randomBytes(18).toString('base64url'),
  };
}

class MountManager {
  /**
   * @param {{
   *   settings: {driveLetter: string, rclonePath?: string, mountOptions?: object},
   *   logger?: {debug: Function, info: Function, warn: Function, error: Function},
   *   rclonePath?: string,          // explicit override
   *   vendorDir?: string,           // bundled rclone location
   *   spawn?: typeof defaultSpawn,  // injectable for tests
   *   execFile?: typeof execFile,   // injectable for tests
   *   freePort?: () => Promise<number>, // injectable for tests
   *   sleep?: (ms: number) => Promise<void>,
   *   now?: () => number,
   *   onStateChange?: () => void,   // notified when rclone exits unexpectedly
   * }} opts
   */
  constructor(opts = {}) {
    this.settings = opts.settings || {};
    this.logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.rclonePath = opts.rclonePath || this.settings.rclonePath || '';
    this.vendorDir = opts.vendorDir || path.join(__dirname, '..', '..', 'vendor');
    this.spawn = opts.spawn || defaultSpawn;
    this.execFile = opts.execFile || execFileAsync;
    this.freePort = opts.freePort || freePort;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now || (() => Date.now());
    this.onStateChange = opts.onStateChange || null;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    /** @type {{letter: string, port: number, startedAt: number, logFile: string}|null} */
    this.mountInfo = null;
    /** in-flight locks: a second concurrent call joins the first */
    this.mountPromise = null;
    this.unmountPromise = null;
    /** generation token: a failing attempt must only clear ITS OWN state */
    this.generation = 0;
  }

  /** Locate the rclone binary: explicit path → vendor/ → PATH. */
  async findRclone() {
    const candidates = [];
    if (this.rclonePath) candidates.push(this.rclonePath);
    candidates.push(path.join(this.vendorDir, 'rclone.exe'));
    candidates.push(DEFAULT_RCLONE);
    for (const c of candidates) {
      try {
        if (c === DEFAULT_RCLONE || fs.existsSync(c)) {
          // verify it runs
          await this.execFile(c, ['version'], { timeout: 10000, stdio: 'ignore' });
          return c;
        }
      } catch (_e) { /* try next */ }
    }
    throw new MountError('locate', 'rclone not found (looked in settings.rclonePath, vendor/, PATH)');
  }

  /**
   * Detect WinFsp (the kernel driver rclone needs on Windows).
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async checkWinFsp() {
    // The launcher service is the reliable signal (the .sys is loaded on demand).
    try {
      const { stdout } = await this.execFile('sc.exe', ['query', 'winfsp.launcher'], {
        timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (/STATE\s+:\s*4/.test(stdout)) return { ok: true }; // RUNNING
      if (/does not exist/i.test(stdout)) {
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
   * Concurrent calls join the in-flight mount (no orphan rclone processes).
   *
   * @param {{port: number, urlPrefix?: string, letter?: string, logFile?: string}} opts
   * @returns {Promise<{letter: string, pid: number, rcPort: number}>}
   */
  async mount(opts) {
    if (this.mountPromise) return this.mountPromise;
    const p = this._mountLocked(opts).finally(() => { this.mountPromise = null; });
    this.mountPromise = p;
    return p;
  }

  async _mountLocked(opts) {
    if (this.isMounted) throw new MountError('mount', 'already mounted at ' + this.mountInfo.letter + ':');
    const myGeneration = ++this.generation;
    const letter = normalizeLetter(opts.letter || this.settings.driveLetter || 'Q');
    const winfsp = await this.checkWinFsp();
    if (!winfsp.ok) throw new MountError('mount', winfsp.reason);

    const rclone = await this.findRclone();
    const root = letter + ':\\';
    if (fs.existsSync(root)) {
      throw new MountError('mount', 'drive ' + letter + ': is already in use');
    }

    // the WebDAV server's secret URL prefix (per-run auth token)
    const prefix = opts.urlPrefix || '/';
    // 30m matches the server-side download watchdog (rclone's webdav default
    // of 5m would abort slow CDN reads that the server is still serving)
    const remote = ":webdav,url='http://127.0.0.1:" + opts.port + prefix + "',vendor='other',timeout='30m':";
    const mo = this.settings.mountOptions || {};
    const rcPort = await this.freePort();
    // per-run RC credentials: the RC API can enumerate the filesystem and
    // (un)mount drives, so it must not be an open door on loopback
    const creds = randomCreds();

    // `rclone rcd` = the remote-control daemon (no filesystem side effects).
    // RC credentials are passed through the child's ENVIRONMENT, never argv:
    // argv is readable by any same-user process (Win32_Process.CommandLine),
    // which would hand out the very per-run credentials N-1 introduced
    // (audit finding M-3). rclone reads RCLONE_RC_USER/RCLONE_RC_PASS from
    // the environment (verified against the vendored binary: its log shows
    // "Using --user … --pass XXXX").
    const args = [
      'rcd',
      '--rc-addr', '127.0.0.1:' + rcPort,
      // parallel part uploads / multi-file copies through the VFS
      '--transfers', '8',
      '--log-level', 'INFO',
    ];
    if (mo.cacheDir) args.push('--cache-dir', mo.cacheDir);
    if (opts.logFile) args.push('--log-file', opts.logFile);
    this.logger.info('mounting ' + root + ' via ' + rclone + ' (rc ' + rcPort + ')');

    const child = this.spawn(rclone, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, RCLONE_RC_USER: creds.user, RCLONE_RC_PASS: creds.pass },
    });

    /** RC credentials live with this attempt (closure), never on the instance. */
    const rcAuth = { user: creds.user, pass: creds.pass, port: rcPort };

    let stderr = '';
    const onStderr = (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    };
    if (child.stderr && child.stderr.on) child.stderr.on('data', onStderr);
    const onExit = (code) => {
      this.logger.warn('rclone exited (code=' + code + ')' + (stderr ? ': ' + stderr.slice(-500) : ''));
      if (this.mountInfo) this.mountInfo.exitedAt = this.now();
      // Only clear state if it still belongs to THIS child: a newer mount may
      // already have replaced it.
      if (this.child === child) {
        this.child = null;
        this.mountInfo = null;
        if (this.onStateChange) {
          try { this.onStateChange(); } catch (_e) { /* listener errors are fatal-free */ }
        }
      }
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
      // Only clear the SHARED state when it was published by THIS attempt —
      // a healthy earlier/concurrent mount must keep its child/mountInfo
      // (otherwise a failed retry would orphan its rclone process).
      if (this.mountInfo && this.mountInfo.generation === myGeneration) {
        this.mountInfo = null;
        this.child = null;
      }
      try { child.kill(); } catch (_e) { /* ignore */ }
      releaseChild();
      throw new MountError('mount', msg + (tail ? ' — ' + tail.slice(-300) : ''));
    };

    try {
      // 1. wait for the RC endpoint to answer
      const rcDeadline = this.now() + 20000;
      for (;;) {
        if (child.exitCode !== null) {
          fail('rclone exited early: ' + (stderr.trim() || 'code ' + child.exitCode));
        }
        if (await this._rcPost(rcAuth, '/core/version', {}) !== null) break;
        if (this.now() > rcDeadline) fail('rclone RC did not come up');
        await this.sleep(250);
      }

      // 2. start the mount through the RC API.
      // NOTE: no `mountType` — this rclone version rejects it as an
      // unregistered mount option.
      const mountRes = await this._rcPost(rcAuth, '/mount/mount', {
        fs: remote,
        mountPoint: root,
        mountOpt: {},
        // VFS options live in vfsOpt (mountOpt is the FUSE layer)
        vfsOpt: {
          VfsCacheMode: mo.vfsCacheMode || 'writes',
          DirCacheTime: mo.dirCacheTime || '5m',
          VfsCacheMaxSize: mo.vfsCacheMaxSize || '10G',
          VfsWriteBack: mo.vfsWriteBack || '5s',
          BufferSize: mo.bufferSize || '64M',
          VfsReadChunkSize: mo.vfsReadChunkSize || '16M',
          VfsReadChunkStreams: mo.vfsReadChunkStreams == null ? 8 : mo.vfsReadChunkStreams,
        },
      });
      if (mountRes === null) fail('mount/mount failed');
      this.logger.debug('mount/mount accepted: ' + JSON.stringify(mountRes).slice(0, 200));

      // 3. wait until listmounts reports our mount point as mounted
      const deadline = this.now() + READY_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null) fail('rclone exited early: ' + (stderr.trim() || 'code ' + child.exitCode));
        if (await this._rcMountReady(rcAuth, root)) {
          // publish state only now that the mount is real
          this.child = child;
          this.mountInfo = {
            letter, port: opts.port, rcPort, startedAt: this.now(),
            logFile: opts.logFile || null, rcAuth, generation: myGeneration,
          };
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

  /** POST to the rclone RC API with this attempt's Basic-auth credentials. */
  async _rcPost(rcAuth, path, body) {
    const port = rcAuth && rcAuth.port;
    if (port == null) return null;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (rcAuth.user != null) {
        const token = Buffer.from(rcAuth.user + ':' + rcAuth.pass, 'utf8').toString('base64');
        headers.Authorization = 'Basic ' + token;
      }
      const res = await fetch('http://127.0.0.1:' + port + path, {
        method: 'POST',
        headers,
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
  async _rcMountReady(rcAuth, root) {
    const j = await this._rcPost(rcAuth, '/mount/listmounts', {});
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
  async _rcUnmount(rcAuth, mountPoint) {
    const j = await this._rcPost(rcAuth, '/mount/unmount', { mountPoint: mountPoint || '' });
    return j !== null;
 }

  /**
   * In-flight transfers (VFS uploads/downloads) for the UI's progress line.
   * @returns {Promise<Array<{name: string, size: number, bytes: number, percentage: number}>>}
   */
  async listTransfers() {
    const info = this.mountInfo;
    if (!info || !info.rcAuth || !this.isMounted) return [];
    const j = await this._rcPost(info.rcAuth, '/core/transfers', {});
    if (!j || !Array.isArray(j.transfers)) return [];
    return j.transfers.map((t) => ({
      name: String(t.name || '').split(/[\\/]/).pop() || 'file',
      size: Number(t.size) || 0,
      bytes: Number(t.bytes) || 0,
      percentage: Math.max(0, Math.min(100, Number(t.percentage) || 0)),
    }));
  }

  /** Unmount: ask rclone via RC (graceful, flushes the VFS), then kill. */
  async unmount() {
    if (this.unmountPromise) return this.unmountPromise;
    const p = this._unmountLocked().finally(() => { this.unmountPromise = null; });
    this.unmountPromise = p;
    return p;
  }

  async _unmountLocked() {
    const child = this.child;
    const info = this.mountInfo;
    this.mountInfo = null;
    this.child = null;
    if (!child || child.exitCode !== null) return { unmounted: false };

    if (info && info.rcAuth) {
      const ok = await this._rcUnmount(info.rcAuth, info.letter + ':');
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

module.exports = { MountManager, MountError, normalizeLetter, randomCreds };
