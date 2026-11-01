'use strict';
/**
 * scripts/make-icon.js — generate the app icons with zero dependencies:
 *   app/assets/icon.png  (256x256, used by electron-builder for the .exe/.ico)
 *   app/assets/tray.png  (32x32, tray icon)
 *
 * Deterministic output; safe to re-run.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** Draw the QuarkDrive glyph at an arbitrary size into an RGBA buffer. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const da = px[i + 3] / 255;
    const sa = a / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };
  const S = size / 64; // design grid is 64x64
  const R = 14 * S;
  const inRoundRect = (x, y) => {
    const cx = Math.min(Math.max(x, R), size - 1 - R);
    const cy = Math.min(Math.max(y, R), size - 1 - R);
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRoundRect(x, y)) put(x, y, 0x3b, 0x82, 0xf6, 255);
    }
  }
  const cx = 32 * S, cy = 30 * S, rOuter = 13 * S, rInner = 8 * S;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rOuter && d >= rInner) put(x, y, 255, 255, 255, 255);
      if (x >= 38 * S && x <= 50 * S && y >= 38 * S && y <= 50 * S &&
          (x - y) >= -3 * S && (x - y) <= 7 * S) {
        put(x, y, 255, 255, 255, 255);
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ASSETS = path.join(__dirname, '..', 'app', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });
for (const [name, size] of [['icon.png', 256], ['tray.png', 32]]) {
  const out = path.join(ASSETS, name);
  const png = encodePng(drawIcon(size), size, size);
  fs.writeFileSync(out, png);
  console.log('wrote ' + out + ' (' + png.length + ' bytes, ' + size + 'x' + size + ')');
}
