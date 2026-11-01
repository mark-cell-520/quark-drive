'use strict';
/**
 * device.test.js — unit tests for the device identity module.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Device, buildUserAgent } = require('../../core/device.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quarkdrive-device-'));
}

test('buildUserAgent matches the official desktop client identity', () => {
  const ua = buildUserAgent();
  assert.match(ua, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
  assert.match(ua, /quark-cloud-drive\/2\.5\.56/);
  assert.match(ua, /Channel\/pckk_other_ch/);
});

test('Device requires machineId and deviceName', () => {
  assert.throws(() => new Device({ machineId: '', deviceName: 'x' }), /machineId/);
  assert.throws(() => new Device({ machineId: 'x', deviceName: '' }), /deviceName/);
});

test('Device.load persists and reuses the machine id', () => {
  const dir = tmpdir();
  const d1 = Device.load(dir);
  assert.match(d1.machineId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(d1.deviceName.length > 0);
  const d2 = Device.load(dir);
  assert.equal(d2.machineId, d1.machineId);
  assert.equal(d2.deviceName, d1.deviceName);
  // device.json exists and is valid JSON
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'));
  assert.equal(raw.machineId, d1.machineId);
});

test('Device.load recovers from a corrupt device file', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'device.json'), '{not json');
  const d = Device.load(dir);
  assert.match(d.machineId, /^[0-9a-f-]{36}$/);
});

test('Device.load honours an explicit deviceName override', () => {
  const dir = tmpdir();
  const d = Device.load(dir, { deviceName: 'My-PC' });
  assert.equal(d.deviceName, 'My-PC');
});
