'use strict';
/**
 * sha1ctx.js — minimal SHA-1 with incremental state export.
 *
 * The Quark upload flow proxies OSS multipart uploads. For part numbers >= 2
 * OSS requires the `X-Oss-Hash-Ctx` header: the *internal* SHA-1 state
 * (h0..h4 plus the processed bit count split into nl/nh 32-bit halves),
 * base64-encoded as JSON. Node's crypto cannot expose that intermediate state,
 * so we implement SHA-1 directly (~120 lines, no dependencies).
 *
 * The final digest is verified against node:crypto in the unit tests.
 */

const crypto = require('node:crypto');

class Sha1Ctx {
  constructor() {
    this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    /** pending bytes (< 64) */
    this.buf = Buffer.alloc(0);
    /** total bytes processed so far */
    this.len = 0;
  }

  /** @param {Buffer|string} data */
  update(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.len += bytes.length;
    let input = bytes;
    if (this.buf.length > 0) {
      const need = 64 - this.buf.length;
      const take = input.subarray(0, Math.min(need, input.length));
      this.buf = Buffer.concat([this.buf, take]);
      input = input.subarray(take.length);
      if (this.buf.length === 64) {
        this._block(this.buf);
        this.buf = Buffer.alloc(0);
      }
    }
    while (input.length >= 64) {
      this._block(input.subarray(0, 64));
      input = input.subarray(64);
    }
    if (input.length > 0) this.buf = Buffer.from(input); // copy tail
  }

  _block(block) {
    const w = new Array(80);
    for (let i = 0; i < 16; i++) {
      w[i] = block.readUInt32BE(i * 4);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let [a, b, c, d, e] = this.h;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
  }

  /** Finalize and return the 40-char hex digest (does not mutate state further). */
  digest() {
    const totalBits = this.len * 8;
    // padding: 0x80, zeros, 64-bit big-endian bit length
    const withOne = Buffer.concat([this.buf, Buffer.from([0x80])]);
    let padLen = (withOne.length <= 56) ? 64 : 128;
    const padded = Buffer.alloc(padLen);
    withOne.copy(padded, 0);
    padded.writeUInt32BE(Math.floor(totalBits / 0x100000000), padLen - 8);
    padded.writeUInt32BE(totalBits >>> 0, padLen - 4);
    // process on a copy so the object stays usable
    const saved = { h: this.h.slice(), buf: this.buf, len: this.len };
    for (let off = 0; off < padLen; off += 64) this._block(padded.subarray(off, off + 64));
    const out = this.h.map((x) => x.toString(16).padStart(8, '0')).join('');
    this.h = saved.h; this.buf = saved.buf; this.len = saved.len;
    return out;
  }

  /** Hex digest in one shot. */
  static hash(data) {
    const s = new Sha1Ctx();
    s.update(data);
    return s.digest();
  }

  /**
   * Export the OSS X-Oss-Hash-Ctx state (JSON-serialisable object).
   * h0..h4 are decimal strings; nl/nh are the low/high 32 bits of the
   * processed bit count as decimal strings. `data` carries the pending
   * (not yet block-aligned) bytes as hex and `num` their count, matching the
   * OSS hash-context format.
   */
  exportState() {
    const bits = this.len * 8;
    const lo = bits >>> 0;
    const hi = Math.floor(bits / 0x100000000) >>> 0;
    return {
      hash_type: 'sha1',
      h0: String(this.h[0]),
      h1: String(this.h[1]),
      h2: String(this.h[2]),
      h3: String(this.h[3]),
      h4: String(this.h[4]),
      nl: String(lo),
      nh: String(hi),
      data: this.buf.toString('hex'),
      num: String(this.buf.length),
    };
  }

  /** base64(JSON) form used for the X-Oss-Hash-Ctx header. */
  exportStateB64() {
    return Buffer.from(JSON.stringify(this.exportState()), 'utf8').toString('base64');
  }
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

module.exports = { Sha1Ctx, crypto };
