'use strict';
/**
 * preload.js — the ONLY bridge between the renderer and the main process.
 *
 * The renderer is untrusted UI: it gets a fixed set of invoke/on channels and
 * never touches cookies, tokens, or the filesystem.
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'auth:getState',
  'auth:startLogin',
  'auth:cancelLogin',
  'auth:logout',
  'drive:getState',
  'drive:mount',
  'drive:unmount',
  'settings:get',
  'settings:set',
  'app:openLogs',
  'app:openDrive',
  'app:clearCache',
  'app:quit',
  'app:version',
];

const EVENT_CHANNELS = [
  'auth:state',
  'auth:status',
  'auth:qr',
  'auth:done',
  'auth:error',
  'drive:state',
  'drive:transfers',
  'drive:error',
];

contextBridge.exposeInMainWorld('quarkDrive', {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error('blocked channel: ' + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error('blocked channel: ' + channel);
    }
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
