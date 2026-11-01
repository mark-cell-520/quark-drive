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
  });

  api.on('auth:done', () => {
    loggingIn = false;
    toast('登录成功');
    show('main');
    refreshDrive();
  });

  api.on('auth:error', (e) => {
    loggingIn = false;
    $('login-status').textContent = e.message || '登录失败';
    toast(e.message || '登录失败', true);
  });

  api.on('drive:state', (s) => renderDrive(s));

  api.on('drive:error', (e) => toast(e.message || '操作失败', true));

  // ------------------------------------------------------------------- login

  async function startLogin() {
    loggingIn = true;
    $('qr-img').classList.add('hidden');
    $('qr-placeholder').classList.remove('hidden');
    $('login-status').textContent = '正在获取二维码…';
    try {
      await api.invoke('auth:startLogin');
    } catch (e) {
      toast(e.message, true);
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
      stateEl.textContent = '未挂载';
      stateEl.classList.remove('mounted');
    }
    $('btn-mount').classList.toggle('hidden', !!s.mounted);
    $('btn-unmount').classList.toggle('hidden', !s.mounted);
    if (s.capacity) {
      const used = s.capacity.used || 0;
      const total = s.capacity.total || 0;
      $('cap-used').textContent = '已用 ' + fmtBytes(used);
      $('cap-total').textContent = total ? '共 ' + fmtBytes(total) : '';
      $('cap-fill').style.width = total ? Math.min(100, (used / total) * 100).toFixed(1) + '%' : '0%';
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
    $('btn-mount').disabled = true;
    try {
      const letter = $('sel-letter').value;
      await api.invoke('drive:mount', letter);
      if (letter !== settings.driveLetter) {
        await api.invoke('settings:set', { driveLetter: letter });
        settings.driveLetter = letter;
      }
      toast('已挂载到 ' + letter + ':\\');
    } catch (e) {
      toast(e.message || '挂载失败', true);
    } finally {
      $('btn-mount').disabled = false;
    }
  });

  $('btn-unmount').addEventListener('click', async () => {
    try {
      await api.invoke('drive:unmount');
      toast('已卸载');
    } catch (e) {
      toast(e.message, true);
    }
  });

  // ---------------------------------------------------------------- settings

  async function loadSettings() {
    settings = await api.invoke('settings:get');
    fillLetters(settings.driveLetter);
    $('chk-automount').checked = !!settings.autoMount;
    $('chk-autostart').checked = !!settings.startWithWindows;
    const version = await api.invoke('app:version');
    $('version').textContent = 'v' + version;
  }

  $('chk-automount').addEventListener('change', async (e) => {
    await api.invoke('settings:set', { autoMount: e.target.checked });
  });
  $('chk-autostart').addEventListener('change', async (e) => {
    await api.invoke('settings:set', { startWithWindows: e.target.checked });
  });
  $('btn-logs').addEventListener('click', () => api.invoke('app:openLogs'));

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
  })().catch((e) => toast(e.message, true));
})();
