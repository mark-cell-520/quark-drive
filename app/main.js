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

const isPackaged = app.isPackaged;
const RESOURCES_VENDOR = path.join(process.resourcesPath || '', 'vendor');

/** Settings the renderer is allowed to change (everything else is ignored).
 *  rclonePath is deliberately NOT settable from the renderer — it selects the
 *  binary that gets executed, so it stays env/CLI-only. */
const SETTINGS_WHITELIST = new Set([
  'driveLetter', 'autoMount', 'startWithWindows', 'webdavPort',
]);

let mainWindow = null;
let tray = null;
let stack = null;
let server = null;
let loginAbort = null;

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
  if (loginAbort) return; // already running
  const ac = new AbortController();
  loginAbort = ac;
  send('auth:status', { msg: '正在获取二维码…' });
  try {
    const QR = require('qrcode');
    // We drive the flow manually so we can push QR/status events live.
    const started = await stack.auth.start();
    const dataUrl = await QR.toDataURL(started.qrUrl, { width: 320, margin: 1 });
    send('auth:qr', { dataUrl, redactedUrl: started.redactedUrl, expiresAt: started.expiresAt });

    const deadline = Date.now() + 3 * 60 * 1000;
    for (;;) {
      if (ac.signal.aborted) throw new Error('login cancelled');
      const poll = await stack.auth.poll();
      if (poll.status === 'confirmed') {
        send('auth:status', { msg: '扫码成功，正在建立会话…' });
        await stack.auth.complete(poll.ticket);
        let user = null;
        try { user = await stack.api.userInfo(); } catch (_e) { /* non-fatal */ }
        core.persistSession(stack, user);
        send('auth:done', { user });
        send('auth:status', { msg: '登录成功' });
        break;
      }
      if (poll.status === 'expired') {
        send('auth:status', { msg: '二维码已过期，正在刷新…' });
        const refreshed = await stack.auth.start();
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
  } finally {
    loginAbort = null;
    pushAuthState();
  }
}

// --------------------------------------------------------------------- mount

async function startServer() {
  if (server) return { port: server.address().port, urlPrefix: server.urlPrefix };
  const settings = stack.settings;
  server = createWebDavServer({ fs: stack.fs, host: '127.0.0.1', port: settings.webdavPort, logger: stack.logger });
  const port = await server.listenAsync(settings.webdavPort);
  stack.logger.info('webdav listening on 127.0.0.1:' + port + server.urlPrefix);
  return { port, urlPrefix: server.urlPrefix };
}

async function mountDrive(letter) {
  const { port, urlPrefix } = await startServer();
  const res = await stack.mount.mount({
    port,
    urlPrefix,
    letter: letter || stack.settings.driveLetter,
    logFile: stack.config.logFile('rclone.log'),
  });
  await pushDriveState();
  return res;
}

async function unmountDrive() {
  await stack.mount.unmount();
  await pushDriveState();
}

// ---------------------------------------------------------------------- tray

function trayIconPath() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function buildTray() {
  tray = new Tray(trayIconPath());
  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => { showWindow(); } },
    { type: 'separator' },
    {
      label: '挂载',
      click: async () => {
        try { await mountDrive(); } catch (e) { send('drive:error', { message: e.message }); }
      },
    },
    {
      label: '卸载',
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
  tray.setToolTip('QuarkDrive — 夸克网盘本地硬盘');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
}

// -------------------------------------------------------------------- windows

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'QuarkDrive',
    icon: trayIconPath(),
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
  ipcMain.handle('auth:cancelLogin', async () => {
    if (loginAbort) loginAbort.abort();
  });
  ipcMain.handle('auth:logout', async () => {
    stack.config.clearSession();
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
    createWindow();
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
