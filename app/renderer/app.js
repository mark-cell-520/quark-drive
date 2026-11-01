'use strict';
/**
 * app.js — renderer logic. Talks to the main process ONLY through the
 * whitelisted window.quarkDrive bridge.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.quarkDrive;

  const views = { login: $('view-login'), main: $('view-main') };
  let settings = null;
  let drive = { mounted: false, letter: null };
  let loggingIn = false;
  /** true while a mount/unmount IPC call is in flight (buttons stay disabled) */
  let driveBusy = false;
  /** QR expiry countdown timer */
  let expiryTimer = null;

  // ---------------------------------------------------------------- helpers

  function show(name) {
    for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== name);
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  /** Map raw backend errors to something a user can act on. */
  function friendlyError(msg) {
    const m = String(msg || '');
    if (/already in use/.test(m)) return '盘符已被占用，请换一个盘符';
    if (/WinFsp/.test(m)) return '缺少文件系统驱动（WinFsp），请重新运行安装包';
    if (/rclone not found/.test(m)) return '找不到 rclone 组件，请重新安装应用';
    if (/did not become ready|timeout/i.test(m)) return '挂载超时，请检查网络后重试';
    if (/login timeout|二维码已过期/.test(m)) return '登录超时，请刷新二维码重试';
    if (/cancelled/.test(m)) return '已取消';
    if (/network|fetch|ECONN|socket/i.test(m)) return '网络异常，请检查连接后重试';
    return m || '操作失败';
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  // ------------------------------------------------------------------ events

  api.on('auth:state', (s) => {
    if (s.loggedIn) {
      show('main');
      renderAccount(s.user);
      refreshDrive();
    } else {
      show('login');
      if (!loggingIn) startLogin();
    }
  });

  api.on('auth:status', (s) => { $('login-status').textContent = s.msg || ''; });

  api.on('auth:qr', (qr) => {
    $('qr-img').src = qr.dataUrl;
    $('qr-img').classList.remove('hidden');
    $('qr-placeholder').classList.add('hidden');
    $('login-status').textContent = '请用夸克 APP 扫码';
    startExpiryCountdown(qr.expiresAt);
  });

  api.on('auth:done', () => {
    loggingIn = false;
    stopExpiryCountdown();
    toast('登录成功');
    show('main');
    refreshDrive();
  });

  api.on('auth:error', (e) => {
    loggingIn = false;
    stopExpiryCountdown();
    $('login-status').textContent = friendlyError(e.message) || '登录失败';
    toast(friendlyError(e.message), true);
  });

  api.on('drive:state', (s) => renderDrive(s));

  api.on('drive:transfers', (list) => renderTransfers(list));

  api.on('drive:error', (e) => toast(friendlyError(e.message), true));

  // ------------------------------------------------------------- transfers

  /** Show the in-flight VFS transfers (uploads/downloads through the drive). */
  function renderTransfers(list) {
    const el = $('transfer-line');
    const items = Array.isArray(list) ? list : [];
    if (!items.length) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const t = items[0];
    const pct = t.size ? Math.round(t.percentage) + '%' : fmtBytes(t.bytes);
    el.textContent = '传输中：' + t.name + ' ' + pct +
      (items.length > 1 ? '（共 ' + items.length + ' 个任务）' : '');
    el.classList.remove('hidden');
  }

  // ---------------------------------------------------------- qr countdown

  function startExpiryCountdown(expiresAt) {
    stopExpiryCountdown();
    const el = $('qr-expiry');
    if (!expiresAt) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (left <= 0) {
        el.textContent = '二维码即将过期，正在自动刷新…';
        return;
      }
      el.textContent = '二维码有效时长剩 ' + Math.floor(left / 60) + ' 分 ' + String(left % 60).padStart(2, '0') + ' 秒';
      expiryTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  function stopExpiryCountdown() {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    $('qr-expiry').classList.add('hidden');
  }

  // ------------------------------------------------------------------- login

  async function startLogin() {
    loggingIn = true;
    $('qr-img').classList.add('hidden');
    $('qr-placeholder').classList.remove('hidden');
    $('login-status').textContent = '正在获取二维码…';
    try {
      await api.invoke('auth:startLogin');
    } catch (e) {
      toast(friendlyError(e.message), true);
    }
  }

  $('btn-refresh-qr').addEventListener('click', async () => {
    await api.invoke('auth:cancelLogin');
    await startLogin();
  });
  $('btn-cancel-login').addEventListener('click', async () => {
    await api.invoke('auth:cancelLogin');
    loggingIn = false;
    $('login-status').textContent = '已取消';
  });

  $('btn-logout').addEventListener('click', async () => {
    await api.invoke('auth:logout');
    show('login');
  });

  // ------------------------------------------------------------------- drive

  async function refreshDrive() {
    const s = await api.invoke('drive:getState');
    renderDrive(s);
  }

  function renderDrive(s) {
    drive = s;
    const stateEl = $('mount-state');
    if (s.mounted) {
      stateEl.textContent = '已挂载到 ' + s.letter + ':\\';
      stateEl.classList.add('mounted');
    } else {
      stateEl.textContent = driveBusy ? '正在挂载…' : '未挂载';
      stateEl.classList.remove('mounted');
    }
    $('btn-mount').classList.toggle('hidden', !!s.mounted || driveBusy);
    $('btn-unmount').classList.toggle('hidden', !s.mounted || driveBusy);
    $('btn-open-drive').classList.toggle('hidden', !s.mounted);
    $('btn-mount').disabled = driveBusy;
    $('btn-unmount').disabled = driveBusy;
    if (s.capacity) {
      const used = s.capacity.used || 0;
      const total = s.capacity.total || 0;
      const pct = total ? Math.min(100, (used / total) * 100) : 0;
      $('cap-used').textContent = '已用 ' + fmtBytes(used) + (total ? '（' + pct.toFixed(1) + '%）' : '');
      $('cap-total').textContent = total ? '共 ' + fmtBytes(total) : '';
      $('cap-fill').style.width = total ? pct.toFixed(1) + '%' : '0%';
    }
  }

  function renderAccount(user) {
    $('account-name').textContent = (user && user.nickname) || '已登录';
    const type = user && user.member_type;
    $('account-type').textContent = type ? ('会员类型: ' + type) : '';
  }

  function fillLetters(selected) {
    const sel = $('sel-letter');
    const used = new Set(['A', 'B', 'C', 'D', 'E']); // common system letters
    const letters = [];
    for (let i = 'F'.charCodeAt(0); i <= 'Z'.charCodeAt(0); i++) {
      const L = String.fromCharCode(i);
      if (!used.has(L)) letters.push(L);
    }
    sel.innerHTML = '';
    for (const L of letters) {
      const opt = document.createElement('option');
      opt.value = L;
      opt.textContent = L + ':';
      sel.appendChild(opt);
    }
    sel.value = selected || 'Q';
  }

  $('btn-mount').addEventListener('click', async () => {
    if (driveBusy) return;
    driveBusy = true;
    renderDrive(drive);
    try {
      const letter = $('sel-letter').value;
      await api.invoke('drive:mount', letter);
      if (letter !== settings.driveLetter) {
        await api.invoke('settings:set', { driveLetter: letter });
        settings.driveLetter = letter;
      }
      toast('已挂载到 ' + letter + ':\\');
    } catch (e) {
      toast(friendlyError(e.message), true);
    } finally {
      driveBusy = false;
      renderDrive(drive);
    }
  });

  $('btn-unmount').addEventListener('click', async () => {
    if (driveBusy) return;
    driveBusy = true;
    renderDrive(drive);
    try {
      await api.invoke('drive:unmount');
      toast('已卸载');
    } catch (e) {
      toast(friendlyError(e.message), true);
    } finally {
      driveBusy = false;
      renderDrive(drive);
    }
  });

  $('btn-open-drive').addEventListener('click', async () => {
    try {
      const r = await api.invoke('app:openDrive');
      if (!r.opened) toast('无法打开资源管理器：' + (r.error || '未知错误'), true);
    } catch (e) {
      toast(friendlyError(e.message), true);
    }
  });

  // ---------------------------------------------------------------- settings

  async function loadSettings() {
    settings = await api.invoke('settings:get');
    fillLetters(settings.driveLetter);
    $('chk-automount').checked = !!settings.autoMount;
    $('chk-autostart').checked = !!settings.startWithWindows;
    $('chk-startmin').checked = !!settings.startMinimized;
    const version = await api.invoke('app:version');
    $('version').textContent = 'v' + version;
  }

  $('chk-automount').addEventListener('change', async (e) => {
    await api.invoke('settings:set', { autoMount: e.target.checked });
  });
  $('chk-autostart').addEventListener('change', async (e) => {
    await api.invoke('settings:set', { startWithWindows: e.target.checked });
  });
  $('chk-startmin').addEventListener('change', async (e) => {
    await api.invoke('settings:set', { startMinimized: e.target.checked });
  });
  $('btn-logs').addEventListener('click', () => api.invoke('app:openLogs'));

  $('btn-quit').addEventListener('click', async () => {
    // Graceful quit: the main process unmounts (flushing pending uploads)
    // before exiting — the same path as the tray's quit item.
    try {
      await api.invoke('app:quit');
    } catch (e) {
      toast(friendlyError(e.message), true);
    }
  });

  // -------------------------------------------------------------------- boot

  (async function boot() {
    await loadSettings();
    const s = await api.invoke('auth:getState');
    if (s.loggedIn) {
      show('main');
      renderAccount(s.user);
      refreshDrive();
    } else {
      show('login');
      await startLogin();
    }
  })().catch((e) => toast(friendlyError(e.message), true));
})();
