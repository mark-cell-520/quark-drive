'use strict';
/**
 * device.js — stable device identity for the Quark desktop-client protocol.
 *
 * The Quark login/drive APIs expect a stable machine id (`ut` param) and a
 * human-readable device name (`mi` param). We generate a UUID once and persist
 * it next to the session file with 0600 permissions.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEVICE_FILE = 'device.json';
const APP_VERSION = '2.5.56';
const CHANNEL = 'pckk@information_ch';

/** Desktop-client User-Agent (matches the official Windows Electron client). */
function buildUserAgent() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) quark-cloud-drive/' + APP_VERSION + ' Chrome/100.0.4896.160 ' +
    'Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch';
}

class Device {
  /**
   * @param {{machineId: string, deviceName: string}} opts
   */
  constructor(opts) {
    this.machineId = String(opts && opts.machineId || '').trim();
    this.deviceName = String(opts && opts.deviceName || '').trim();
    if (!this.machineId) throw new Error('device: machineId is required');
    if (!this.deviceName) throw new Error('device: deviceName is required');
  }

  /** The `ut` query parameter value. */
  get ut() { return this.machineId; }

  /** The `mi` query parameter value (device display name). */
  get mi() { return this.deviceName; }

  userAgent() { return buildUserAgent(); }

  toJSON() {
    return { machineId: this.machineId, deviceName: this.deviceName };
  }

  /**
   * Load the device identity from `dir`, creating and persisting a new one on
   * first run. The file is written 0600 (it is a stable device fingerprint).
   */
  static load(dir, opts) {
    const file = path.join(dir, DEVICE_FILE);
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) { /* missing or corrupt → recreate */ }
    const machineId = (data && typeof data.machineId === 'string' && data.machineId)
      ? data.machineId
      : crypto.randomUUID();
    const fallbackName = 'QuarkDrive-' + (process.env.COMPUTERNAME || process.env.HOSTNAME || 'windows');
    const deviceName = (data && typeof data.deviceName === 'string' && data.deviceName)
      ? data.deviceName
      : ((opts && opts.deviceName) || fallbackName);
    const device = new Device({ machineId, deviceName });
    device.save(dir);
    return device;
  }

  save(dir) {
    const file = path.join(dir, DEVICE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_e) { /* best effort (win32) */ }
  }
}

module.exports = { Device, buildUserAgent, APP_VERSION, CHANNEL };
