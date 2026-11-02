#!/usr/bin/env node
'use strict';
/**
 * verify-vendor.js — build-time integrity gate for the vendored binaries
 * (audit finding M-1).
 *
 * scripts/fetch-vendor.mjs pins the SHA256 of every artifact at DOWNLOAD
 * time, but nothing between `vendor/` and the end user re-checked it: a
 * substituted rclone.exe/winfsp.msi placed in vendor/ (compromised build
 * machine, stale artifact, malicious contributor) would be packaged and —
 * for the WinFsp MSI — installed silently with admin rights, unverified.
 *
 * This script re-verifies whatever is ABOUT TO BE PACKAGED against the same
 * pins (single source of truth: they are read straight out of
 * fetch-vendor.mjs) and fails closed. It is wired as:
 *   - electron-builder's `beforePack` hook (package.json build config), so
 *     even a bare `npx electron-builder` cannot package unverified binaries
 *   - `npm run predist`, so `npm run dist` fails before the build starts
 *
 * It works in both modes: as a CLI (`node scripts/verify-vendor.js
 * [vendorDir]`, exit code 0/1) and as electron-builder's beforePack hook
 * (the exported async function is called in-process).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Verify every pinned artifact inside `vendorDir`.
 * @param {string} [vendorDirArg] explicit vendor directory (optional)
 * @returns {Promise<boolean>} true when everything verified
 */
async function verifyVendor(vendorDirArg) {
  const rootCandidates = [
    path.join(__dirname, '..'),
    process.cwd(),
  ];
  // The hook is loaded in-process and its argv carries the builder's own CLI
  // flags, so an explicit positional dir is only honoured when it really is an
  // existing directory; otherwise probe the plausible project roots.
  const root = rootCandidates.find((d) => fs.existsSync(path.join(d, 'scripts', 'fetch-vendor.mjs')))
    || rootCandidates[0];
  const vendorDir = (vendorDirArg && fs.existsSync(vendorDirArg))
    ? vendorDirArg
    : path.join(root, 'vendor');

  // Read the pins from the fetcher so there is exactly one place to update.
  const fetcherSrc = fs.readFileSync(path.join(root, 'scripts', 'fetch-vendor.mjs'), 'utf8');
  const artifacts = [...fetcherSrc.matchAll(/file:\s*'([^']+)'[\s\S]*?sha256:\s*'([0-9a-f]{64})'/g)]
    .map((m) => ({ file: m[1], sha256: m[2] }));

  if (artifacts.length === 0) {
    console.error('verify-vendor: no pinned artifacts found in scripts/fetch-vendor.mjs');
    return false;
  }

  let failed = 0;
  for (const art of artifacts) {
    const dest = path.join(vendorDir, art.file);
    if (!fs.existsSync(dest)) {
      console.error('MISS  ' + art.file + ' — run `npm run vendor` first');
      failed++;
      continue;
    }
    const got = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (got !== art.sha256) {
      console.error('FAIL  ' + art.file + ': sha256 ' + got.slice(0, 12) + '… != pinned ' + art.sha256.slice(0, 12) + '…');
      failed++;
      continue;
    }
    console.log('OK    ' + art.file + ' (sha256 verified)');
  }

  if (failed) {
    console.error(failed + ' vendor artifact(s) failed verification — refusing to build');
    return false;
  }
  console.log('vendor integrity OK (' + artifacts.length + ' artifacts)');
  return true;
}

module.exports = verifyVendor;

// CLI mode: run immediately. (require.main !== module when electron-builder
// loads this file as its beforePack hook — then the exported function runs.)
if (require.main === module) {
  verifyVendor(process.argv[2]).then((ok) => { process.exit(ok ? 0 : 1); });
}
