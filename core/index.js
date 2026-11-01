'use strict';
/**
 * index.js — QuarkDrive core entry point.
 *
 * Assembles the full stack and exposes:
 *   - buildStack()   programmatic use (Electron main, tests)
 *   - CLI            login / serve / mount / unmount / status / logout / doctor
 *
 * The core has ZERO runtime dependencies. QR rendering uses the optional
 * `qrcode` package when present (the Electron app ships it); the CLI falls
 * back to writing the scan URL to a file and printing it.
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { ConfigStore, DEFAULT_SETTINGS } = require('./config.js');
const { Device } = require('./device.js');
const { HttpClient, CookieJar } = require('./quark/http.js');
const { QrLogin, redactQrUrl } = require('./quark/auth.js');
const { QuarkApi } = require('./quark/api.js');
const { Uploader } = require('./quark/upload.js');
const { QuarkFs } = require('./webdav/quark-fs.js');
const { createWebDavServer } = require('./webdav/server.js');
const { MountManager } = require('./mount/rclone.js');

// ------------------------------------------------------------------- logger

/** Console+file logger that redacts anything secret-looking. */
function createLogger(logFile, { quiet = false, maxBytes = 5 * 1024 * 1024 } = {}) {
  const secrets = [];
  function redact(s) {
    let out = String(s);
    for (const sec of secrets) {
      if (sec && sec.length >= 6) out = out.split(sec).join('<redacted>');
    }
    // log-injection guard: file names and URLs end up in log lines
    return out.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  }
  function rotateIfNeeded() {
    try {
      if (!logFile || !fs.existsSync(logFile)) return;
      if (fs.statSync(logFile).size < maxBytes) return;
      fs.renameSync(logFile, logFile + '.1');
    } catch (_e) { /* rotation is best effort */ }
  }
  function write(level, args) {
    const line = new Date().toISOString() + ' ' + level + ' ' + redact(args.join(' '));
    if (logFile) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(logFile, line + '\n');
      } catch (_e) { /* ignore */ }
    }
    if (!quiet || level === 'ERROR') console.error(line);
  }
  return {
    addSecret(s) { if (s && !secrets.includes(s)) secrets.push(s); },
    debug: (...a) => write('DEBUG', a),
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
  };
}

// -------------------------------------------------------------------- stack

/**
 * Build the whole stack. Optionally restores a saved session.
 * @returns {{config: ConfigStore, device: Device, http: HttpClient, api: QuarkApi,
 *   uploader: Uploader, fs: QuarkFs, auth: QrLogin, mount: MountManager, logger: object}}
 */
function buildStack(opts = {}) {
  const config = opts.config || new ConfigStore({ baseDir: opts.baseDir });
  config.ensureDirs();
  const logger = opts.logger || createLogger(config.logFile('quark-drive.log'), { quiet: opts.quiet });
  const device = Device.load(config.baseDir, opts.deviceOptions);
  const http = new HttpClient({ userAgent: device.userAgent(), logger });
  const session = config.loadSession();
  if (session) {
    http.cookieJar = CookieJar.fromJSON(session.cookies);
    // Register the session cookie header as a secret so it can never leak into
    // logs, even from a future log statement.
    logger.addSecret(http.cookieJar.header());
  }
  const api = new QuarkApi({ http, device, logger });
  const uploader = new Uploader({ http, device, logger });
  const fsLayer = new QuarkFs({ api, uploader, http, logger });
  const auth = new QrLogin({ http, device, logger });
  // Register the QR login token as a secret the moment one is minted.
  const origStart = auth.start.bind(auth);
  auth.start = async (...args) => {
    const out = await origStart(...args);
    logger.addSecret(out.token);
    return out;
  };
  const settings = config.loadSettings();
  const mount = new MountManager({ settings, logger, rclonePath: opts.rclonePath });
  return { config, device, http, api, uploader, fs: fsLayer, auth, mount, logger, settings };
}

/** Persist the current session (cookies) after a successful login. */
function persistSession(stack, user) {
  stack.config.saveSession({ cookies: stack.http.cookieJar.toJSON(), user: user || null });
}

// --------------------------------------------------------------- QR helpers

/** Render the scan URL as a PNG (needs the optional `qrcode` package). */
async function qrToPngDataUrl(qrUrl) {
  try {
    const QR = require('qrcode');
    return await QR.toDataURL(qrUrl, { width: 320, margin: 1 });
  } catch (_e) {
    return null;
  }
}

/** Terminal ASCII QR (optional `qrcode` package). */
async function qrToAscii(qrUrl) {
  try {
    const QR = require('qrcode');
    return QR.toString(qrUrl, { type: 'terminal', small: true });
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------- CLI

const USAGE = `QuarkDrive — 夸克网盘本地硬盘挂载

Usage: quark-drive <command> [options]

Commands:
  login      Scan-to-login with the Quark app (prints a QR code)
  serve      Run the local WebDAV server (default port from settings)
  mount      Start the server and mount the drive letter
  unmount    Unmount the drive
  status     Show session / mount status
  logout     Delete the saved session
  doctor     Check the environment (session, rclone, WinFsp)

Options:
  --letter X       Drive letter for mount (default from settings)
  --port N         WebDAV port (default from settings)
`;

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
  };
  const stack = buildStack({ quiet: cmd !== 'login' });
  const { config, mount, logger, api, settings } = stack;

  switch (cmd) {
    case 'login': {
      if (!config.isLoggedIn()) {
        console.log('请用夸克 APP 扫码登录（扫描下方二维码）:');
      } else {
        console.log('已有会话，重新扫码将覆盖它。');
      }
      let ascii = null;
      const result = await stack.auth.run({
        intervalMs: 2000,
        onQr: async (info) => {
          ascii = await qrToAscii(info.qrUrl);
          if (ascii) console.log(ascii);
          else console.log('扫码地址 (qrcode 模块不可用): ' + info.redactedUrl);
        },
        onStatus: (s) => logger.debug('login status: ' + s),
      });
      let user = null;
      try { user = await api.userInfo(); } catch (_e) { /* non-fatal */ }
      persistSession(stack, user);
      console.log('登录成功' + (user && user.nickname ? '，欢迎 ' + user.nickname : '') + '。会话已保存。');
      return 0;
    }

    case 'serve': {
      requireSession(stack);
      const port = Number(flag('--port', settings.webdavPort));
      const server = createWebDavServer({ fs: stack.fs, host: '127.0.0.1', port, logger });
      const bound = await server.listenAsync(port);
      console.log('WebDAV server listening on http://127.0.0.1:' + bound + server.urlPrefix);
      await new Promise(() => {}); // run until killed
      return 0;
    }

    case 'mount': {
      requireSession(stack);
      const letter = flag('--letter', settings.driveLetter);
      const port = Number(flag('--port', settings.webdavPort));
      const server = createWebDavServer({ fs: stack.fs, host: '127.0.0.1', port, logger });
      const bound = await server.listenAsync(port);
      console.log('WebDAV server listening on http://127.0.0.1:' + bound + server.urlPrefix);
      const res = await mount.mount({
        port: bound,
        urlPrefix: server.urlPrefix,
        letter,
        logFile: config.logFile('rclone.log'),
      });
      console.log('Mounted at ' + res.letter + ':\\ (rclone pid ' + res.pid + ')');
      console.log('按 Ctrl+C 卸载并退出。');
      await new Promise((resolve) => {
        const shutdown = async () => {
          await mount.unmount();
          await server.closeAsync();
          resolve();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
      return 0;
    }

    case 'unmount': {
      const res = await mount.unmount();
      console.log(res.unmounted ? '已卸载。' : '当前没有挂载。');
      return 0;
    }

    case 'status': {
      const session = config.loadSession();
      const st = mount.status();
      console.log('会话: ' + (session ? '已登录 (' + Object.keys(session.cookies).length + ' cookies)' : '未登录'));
      console.log('挂载: ' + (st.mounted ? st.letter + ':\\ (port ' + st.port + ')' : '未挂载'));
      if (session && session.user && session.user.nickname) {
        console.log('账号: ' + session.user.nickname);
      }
      return 0;
    }

    case 'logout': {
      config.clearSession();
      console.log('会话已删除。');
      return 0;
    }

    case 'doctor': {
      const session = config.loadSession();
      console.log('config dir : ' + config.baseDir);
      console.log('session    : ' + (session ? 'present' : 'MISSING (run: quark-drive login)'));
      try {
        const rclone = mount.findRclone();
        console.log('rclone     : ' + rclone);
      } catch (e) {
        console.log('rclone     : NOT FOUND — ' + e.message);
      }
      const w = mount.checkWinFsp();
      console.log('winfsp     : ' + (w.ok ? 'OK' : 'MISSING — ' + w.reason));
      console.log('settings   : drive=' + settings.driveLetter + ' port=' + settings.webdavPort);
      return 0;
    }

    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

function requireSession(stack) {
  if (!stack.config.isLoggedIn()) {
    console.error('尚未登录。请先运行: quark-drive login');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------- main

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code || 0; }).catch((e) => {
    console.error('错误: ' + e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildStack, persistSession, createLogger, qrToPngDataUrl, qrToAscii, cli, USAGE,
};
