'use strict';
/**
 * main.js — QuarkDrive Electron main process.
 *
 * Hosts the core stack in-process:
 *   - WebDAV server on 127.0.0.1 (the Quark namespace)
 *   - rclone mount lifecycle (drive letter)
 *   - QR login flow (events pushed to the renderer)
 *   - tray + single instance + autostart
 *
 * Security: contextIsolation on, nodeIntegration off, preload exposes a
 * whitelisted bridge only. The renderer never sees cookies or tokens.
 */
const path = require('node:path');
const fs = require('node:fs');

const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');

const core = require('../core/index.js');
const { createWebDavServer } = require('../core/webdav/server.js');
const { createOpQueue } = require('./op-queue.js');

const isPackaged = app.isPackaged;
const RESOURCES_VENDOR = path.join(process.resourcesPath || '', 'vendor');

/** Settings the renderer is allowed to change (everything else is ignored).
 *  rclonePath is deliberately NOT settable from the renderer — it selects the
 *  binary that gets executed, so it stays env/CLI-only. */
const SETTINGS_WHITELIST = new Set([
  'driveLetter', 'autoMount', 'startWithWindows', 'webdavPort', 'startMinimized',
]);

let mainWindow = null;
let tray = null;
let stack = null;
let server = null;
let loginAbort = null;
/** the in-flight login loop (cancel/refresh wait for it to settle) */
let loginLoop = null;
/** serialises server/mount/unmount operations (no concurrent rclone spawns) */
const { serialize } = createOpQueue();
/** interval id for the in-flight transfer poller */
let transferPoll = null;

// ------------------------------------------------------------------ bootstrap

function vendorDir() {
  if (isPackaged && fs.existsSync(RESOURCES_VENDOR)) return RESOURCES_VENDOR;
  return path.join(__dirname, '..', 'vendor');
}

function initStack() {
  const { ConfigStore } = require('../core/config.js');
  const config = new ConfigStore({});
  config.ensureDirs();
  const logger = core.createLogger(config.logFile('quark-drive.log'));
  stack = core.buildStack({
    config,
    logger,
    rclonePath: process.env.QUARK_RCLONE_PATH || '',
  });
  // MountManager needs the vendor dir hint
  stack.mount.vendorDir = vendorDir();
  // rclone dying under us (crash / external kill) must refresh the UI
  stack.mount.onStateChange = () => { pushDriveState(); };
  return stack;
}

// ------------------------------------------------------------------- UI events

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function driveState() {
  const st = stack.mount.status();
  let capacity = null;
  if (stack.config.isLoggedIn()) {
    try {
      const m = await stack.api.member();
      capacity = {
        used: Number(m.use_capacity) || 0,
        total: Number(m.total_capacity) || 0,
        memberType: m.member_type || null,
      };
    } catch (e) {
      stack.logger.warn('member() failed: ' + e.message);
    }
  }
  return { ...st, capacity, serverRunning: !!server };
}

async function pushDriveState() {
  send('drive:state', await driveState());
  refreshTray();
}

/** Poll rclone for in-flight transfers (uploads/downloads through the VFS)
 *  and push them to the renderer's progress line. Runs only while mounted. */
function startTransferPoll() {
  if (transferPoll) return;
  const tick = async () => {
    if (!stack.mount.isMounted) { stopTransferPoll(); return; }
    try {
      send('drive:transfers', await stack.mount.listTransfers());
    } catch (_e) { /* transient RC errors are not worth surfacing */ }
  };
  tick();
  transferPoll = setInterval(tick, 2000);
  if (typeof transferPoll.unref === 'function') transferPoll.unref();
}

function stopTransferPoll() {
  if (transferPoll) { clearInterval(transferPoll); transferPoll = null; }
  send('drive:transfers', []);
}

async function pushAuthState() {
  const session = stack.config.loadSession();
  let user = session && session.user ? session.user : null;
  if (session && !user) {
    try { user = await stack.api.userInfo(); } catch (_e) { /* offline */ }
  }
  send('auth:state', { loggedIn: !!session, user });
}

// --------------------------------------------------------------------- login

async function startLogin() {
  // One attempt at a time. A previous attempt that is being cancelled is
  // awaited first, so "refresh QR" always starts a genuinely new flow
  // instead of silently returning while the old poll is still in flight.
  while (loginLoop) {
    try { await loginLoop; } catch (_e) { /* the old attempt is over */ }
  }
  const ac = new AbortController();
  loginAbort = ac;
  const loop = (async () => {
    send('auth:status', { msg: '正在获取二维码…' });
    try {
      const QR = require('qrcode');
      // We drive the flow manually so we can push QR/status events live.
      const started = await stack.auth.start({ signal: ac.signal });
      const dataUrl = await QR.toDataURL(started.qrUrl, { width: 320, margin: 1 });
      send('auth:qr', { dataUrl, redactedUrl: started.redactedUrl, expiresAt: started.expiresAt });

      const deadline = Date.now() + 3 * 60 * 1000;
      for (;;) {
        if (ac.signal.aborted) throw new Error('login cancelled');
        const poll = await stack.auth.poll({ signal: ac.signal });
        if (poll.status === 'confirmed') {
          send('auth:status', { msg: '扫码成功，正在建立会话…' });
          await stack.auth.complete(poll.ticket, { signal: ac.signal });
          let user = null;
          try { user = await stack.api.userInfo(); } catch (_e) { /* non-fatal */ }
          core.persistSession(stack, user);
          send('auth:done', { user });
          send('auth:status', { msg: '登录成功' });
          break;
        }
        if (poll.status === 'expired') {
          send('auth:status', { msg: '二维码已过期，正在刷新…' });
          const refreshed = await stack.auth.start({ signal: ac.signal });
          const url = await QR.toDataURL(refreshed.qrUrl, { width: 320, margin: 1 });
          send('auth:qr', { dataUrl: url, redactedUrl: refreshed.redactedUrl, expiresAt: refreshed.expiresAt });
        } else {
          send('auth:status', { msg: '等待扫码…' });
        }
        if (Date.now() > deadline) throw new Error('login timeout');
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      send('auth:error', { message: e.message });
    }
  })();
  loginLoop = loop;
  try {
    await loop;
  } finally {
    loginLoop = null;
    loginAbort = null;
    pushAuthState();
  }
}

/** Abort the in-flight login and WAIT for it to unwind (its HTTP calls carry
 *  the abort signal, so this returns as soon as the requests are cancelled). */
async function cancelLogin() {
  if (loginAbort) loginAbort.abort();
  while (loginLoop) {
    try { await loginLoop; } catch (_e) { /* expected: the loop reports its own error */ }
  }
}

// --------------------------------------------------------------------- mount

async function startServer() {
  return serialize(async () => {
    // A server object that is not listening (a failed earlier attempt) must
    // not be reused — server.address() would be null and crash the mount.
    // (Nested serialize calls run inline — see op-queue.js — so calling this
    // from inside mountDrive's own serialized block is safe.)
    if (server && server.listening) {
      return { port: server.address().port, urlPrefix: server.urlPrefix };
    }
    const settings = stack.settings;
    const srv = createWebDavServer({ fs: stack.fs, host: '127.0.0.1', port: settings.webdavPort, logger: stack.logger });
    const port = await srv.listenAsync(settings.webdavPort);
    server = srv; // publish only after the listen succeeded
    stack.logger.info('webdav listening on 127.0.0.1:' + port + srv.urlPrefix);
    return { port, urlPrefix: srv.urlPrefix };
  });
}

async function mountDrive(letter) {
  return serialize(async () => {
    const { port, urlPrefix } = await startServer();
    const res = await stack.mount.mount({
      port,
      urlPrefix,
      letter: letter || stack.settings.driveLetter,
      logFile: stack.config.logFile('rclone.log'),
    });
    startTransferPoll();
    await pushDriveState();
    return res;
  });
}

async function unmountDrive() {
  return serialize(async () => {
    stopTransferPoll();
    await stack.mount.unmount();
    await pushDriveState();
  });
}

// ---------------------------------------------------------------------- tray

function trayIconPath() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function buildTray() {
  tray = new Tray(trayIconPath());
  refreshTray();
  tray.on('double-click', () => showWindow());
}

/** Rebuild the tray menu so it reflects the live mount state. */
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const st = stack ? stack.mount.status() : { mounted: false, letter: null };
  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => { showWindow(); } },
    { type: 'separator' },
    {
      label: st.mounted ? '已挂载 ' + st.letter + ':\\' : '未挂载',
      enabled: false,
    },
    {
      label: '挂载',
      enabled: !st.mounted,
      click: async () => {
        try { await mountDrive(); } catch (e) { send('drive:error', { message: e.message }); }
      },
    },
    {
      label: '卸载',
      enabled: st.mounted,
      click: async () => {
        try { await unmountDrive(); } catch (e) { send('drive:error', { message: e.message }); }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: async () => {
        // Unmount first: app.exit skips before-quit and would orphan rclone.
        try { await unmountDrive(); } catch (_e) { /* best effort */ }
        app.exit(0);
      },
    },
  ]);
  tray.setToolTip(st.mounted
    ? 'QuarkDrive — 已挂载 ' + st.letter + ':\\'
    : 'QuarkDrive — 夸克网盘本地硬盘');
  tray.setContextMenu(menu);
}

// -------------------------------------------------------------------- windows

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'QuarkDrive',
    icon: trayIconPath(),
    show,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs the `electron` subset (contextBridge/ipcRenderer),
      // so it runs sandboxed — no Node.js access in the renderer at all.
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    // Minimize to tray instead of quitting.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());
}

// ------------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('auth:getState', async () => {
    const session = stack.config.loadSession();
    let user = session && session.user ? session.user : null;
    if (session && !user) {
      try { user = await stack.api.userInfo(); } catch (_e) { /* offline */ }
    }
    return { loggedIn: !!session, user };
  });

  ipcMain.handle('auth:startLogin', async () => { await startLogin(); });
  ipcMain.handle('auth:cancelLogin', async () => { await cancelLogin(); });
  ipcMain.handle('auth:logout', async () => {
    // stop any in-flight login first (its loop would re-persist a session)
    await cancelLogin();
    stack.config.clearSession();
    // Drop the in-memory session cookies AND stop serving the namespace:
    // a local process that learned this run's URL prefix must lose access
    // the moment the user logs out.
    const { CookieJar } = require('../core/quark/http.js');
    stack.http.cookieJar = new CookieJar();
    if (server) {
      const srv = server;
      server = null;
      try { await srv.closeAsync(); } catch (_e) { /* best effort */ }
    }
    if (stack.mount.isMounted) await unmountDrive();
    pushAuthState();
    pushDriveState();
  });

  ipcMain.handle('drive:getState', async () => driveState());
  ipcMain.handle('drive:mount', async (_e, letter) => mountDrive(letter));
  ipcMain.handle('drive:unmount', async () => unmountDrive());

  ipcMain.handle('settings:get', async () => stack.settings);
  ipcMain.handle('settings:set', async (_e, patch) => {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (SETTINGS_WHITELIST.has(k)) clean[k] = v;
    }
    if (clean.driveLetter != null) {
      // validate early: single A-Z letter
      if (!/^[A-Za-z]$/.test(String(clean.driveLetter).replace(/[:\\]/, ''))) {
        throw new Error('invalid drive letter');
      }
    }
    if (clean.webdavPort != null) {
      const p = Number(clean.webdavPort);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('invalid port');
    }
    const next = { ...stack.settings, ...clean };
    stack.config.saveSettings(next);
    stack.settings = next;
    if (clean.driveLetter) stack.mount.settings.driveLetter = clean.driveLetter;
    if (clean.startWithWindows !== undefined) {
      app.setLoginItemSettings({ openAtLogin: !!clean.startWithWindows, args: [] });
    }
    return stack.settings;
  });

  ipcMain.handle('app:openLogs', async () => {
    shell.openPath(stack.config.paths.logDir);
  });
  ipcMain.handle('app:openDrive', async () => {
    // Open the mounted drive in Explorer (no-op when unmounted)
    const st = stack.mount.status();
    if (!st.mounted || !st.letter) return { opened: false };
    const err = await shell.openPath(st.letter + ':\\');
    return { opened: !err, error: err || null };
  });
  ipcMain.handle('app:quit', async () => {
    // Graceful quit: flush the VFS (unmount) before exiting, exactly like
    // the tray's quit item — never leave rclone or a mounted drive behind.
    try {
      if (stack.mount.isMounted) await unmountDrive();
    } catch (_e) { /* best effort */ }
    app.isQuitting = true;
    app.exit(0);
  });
  ipcMain.handle('app:version', async () => app.getVersion());
}

// -------------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => { showWindow(); });

  app.whenReady().then(async () => {
    initStack();
    registerIpc();
    createWindow({ show: !stack.settings.startMinimized });
    buildTray();
    await pushAuthState();
    await pushDriveState();

    // Auto-mount on start when enabled and a session exists.
    if (stack.settings.autoMount && stack.config.isLoggedIn()) {
      try {
        await mountDrive();
      } catch (e) {
        stack.logger.warn('auto-mount failed: ' + e.message);
        send('drive:error', { message: e.message });
      }
    }

    app.on('activate', () => showWindow());
  });

  app.isQuitting = false;
  app.on('before-quit', (e) => {
    // Never leave a mounted drive / rclone process behind.
    if (stack && stack.mount && stack.mount.isMounted) {
      e.preventDefault();
      stack.mount.unmount().finally(() => { app.isQuitting = true; app.quit(); });
    } else {
      app.isQuitting = true;
    }
  });
  app.on('window-all-closed', () => { /* stay in tray */ });
}

module.exports = {};
