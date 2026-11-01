'use strict';
/**
 * fetch-vendor.mjs — download the binaries the installer bundles:
 *   - rclone.exe   (mount engine)
 *   - winfsp.msi   (Windows filesystem driver, installed silently if missing)
 *
 * Every download is SHA256-verified against a pinned value; re-running is a
 * no-op when the file is already present and correct.
 *
 * Usage: node scripts/fetch-vendor.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(__dirname, '..', 'vendor');
const FORCE = process.argv.includes('--force');

/**
 * Pinned artifacts. Update deliberately (bump version + hash together),
 * never blindly — the installer ships these binaries to end users.
 */
const ARTIFACTS = [
  {
    file: 'rclone.exe',
    url: 'https://downloads.rclone.org/rclone-current-windows-amd64.zip',
    // rclone ships as a zip; handled below
    zip: true,
    // SHA256 of the extracted rclone.exe (v1.75.2, 2026-11)
    sha256: '41eab3e118d264920b62c3327966c5ece0dc4dd715ee617d9e30450d8ead95a4',
  },
  {
    file: 'winfsp.msi',
    url: 'https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi',
    // SHA256 of winfsp-2.1.25156.msi
    sha256: '073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a',
  },
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function download(url, timeoutMs = 300000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'QuarkDrive-vendor-fetch/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/** Minimal ZIP reader: finds a stored/deflated entry by name (no deps). */
function unzipEntry(zipBuf, entryName) {
  // scan for the End of Central Directory
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let ptr = zipBuf.readUInt32LE(eocd + 16);
  const cdSig = 0x02014b50;
  for (let i = 0; i < count; i++) {
    if (zipBuf.readUInt32LE(ptr) !== cdSig) break;
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localOff = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    if (name === entryName || name.endsWith('/' + entryName)) {
      // local header
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = zipBuf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data); // stored
      if (method === 8) {
        return zlib.inflateRawSync(data);
      }
      throw new Error('unsupported zip method ' + method);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('entry not found in zip: ' + entryName);
}

fs.mkdirSync(VENDOR, { recursive: true });

let failures = 0;
for (const art of ARTIFACTS) {
  const dest = path.join(VENDOR, art.file);
  try {
    if (!art.sha256) throw new Error('no pinned sha256 for ' + art.file);
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      // verify what is already on disk
      const have = sha256(fs.readFileSync(dest));
      if (have === art.sha256) {
        console.log('SKIP  ' + art.file + ' (present, hash verified)');
        continue;
      }
      console.log('STALE ' + art.file + ' (hash mismatch, re-downloading)');
    }
    console.log('GET   ' + art.url);
    const buf = await download(art.url);
    let out = buf;
    if (art.zip) {
      out = unzipEntry(buf, path.basename(art.file));
    }
    const got = sha256(out);
    if (got !== art.sha256) {
      throw new Error('SHA256 mismatch: got ' + got + ', expected ' + art.sha256);
    }
    fs.writeFileSync(dest, out);
    console.log('OK    ' + art.file + ' (' + out.length + ' bytes, sha256 verified)');
  } catch (e) {
    failures++;
    console.error('FAIL  ' + art.file + ': ' + e.message);
  }
}

if (failures) {
  console.error(failures + ' artifact(s) failed');
  process.exit(1);
}
console.log('vendor/ is ready');
