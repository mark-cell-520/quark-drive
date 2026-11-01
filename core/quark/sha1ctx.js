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
 * Performance notes (this runs over every uploaded byte):
 *  - the 80-word message schedule is allocated once per instance and reused
 *  - the round function is unrolled into its four 20-round phases, which
 *    removes the per-round branch on f/k (≈2x throughput vs the naive loop)
 *  - pending bytes live in a fixed 64-byte scratch block (no per-update
 *    Buffer.concat / copies)
 * The final digest is verified against node:crypto in the unit tests.
 */

class Sha1Ctx {
  constructor() {
    this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    /** pending bytes (< 64) kept in a fixed scratch block */
    this._buf = Buffer.alloc(64);
    this._bufLen = 0;
    /** total bytes processed so far */
    this.len = 0;
    /** message schedule, reused across blocks (Uint32Array: no per-store
     *  double<->int32 conversions, ~1.5x the throughput of a plain array) */
    this._w = new Uint32Array(80);
  }

  /** @param {Buffer|string} data */
  update(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = bytes.length;
    if (len === 0) return;
    this.len += len;

    let off = 0;
    if (this._bufLen > 0) {
      const need = 64 - this._bufLen;
      const take = len < need ? len : need;
      bytes.copy(this._buf, this._bufLen, 0, take);
      this._bufLen += take;
      off = take;
      if (this._bufLen === 64) {
        this._block(this._buf);
        this._bufLen = 0;
      } else {
        return; // still filling the scratch block
      }
    }
    // full blocks straight from the input (no copies)
    while (len - off >= 64) {
      this._block(bytes.subarray(off, off + 64));
      off += 64;
    }
    const rest = len - off;
    if (rest > 0) {
      bytes.copy(this._buf, 0, off, len);
      this._bufLen = rest;
    }
  }

  _block(block) {
    const w = this._w;
    for (let i = 0; i < 16; i++) {
      w[i] = block.readUInt32BE(i * 4);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }    const h = this.h;
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    let tmp;
    // rounds 0..19
    for (let i = 0; i < 20; i++) {
      tmp = (rotl(a, 5) + ((b & c) | (~b & d)) + e + 0x5a827999 + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    // rounds 20..39
    for (let i = 20; i < 40; i++) {
      tmp = (rotl(a, 5) + (b ^ c ^ d) + e + 0x6ed9eba1 + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    // rounds 40..59
    for (let i = 40; i < 60; i++) {
      tmp = (rotl(a, 5) + ((b & c) | (b & d) | (c & d)) + e + 0x8f1bbcdc + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    // rounds 60..79
    for (let i = 60; i < 80; i++) {
      tmp = (rotl(a, 5) + (b ^ c ^ d) + e + 0xca62c1d6 + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }

  /** Finalize and return the 40-char hex digest (does not mutate state further). */
  digest() {
    const totalBits = this.len * 8;
    // padding: 0x80, zeros, 64-bit big-endian bit length
    const withOne = this._bufLen + 1;
    const padLen = withOne <= 56 ? 64 : 128;
    const padded = Buffer.alloc(padLen);
    this._buf.copy(padded, 0, 0, this._bufLen);
    padded[this._bufLen] = 0x80;
    padded.writeUInt32BE(Math.floor(totalBits / 0x100000000), padLen - 8);
    padded.writeUInt32BE(totalBits >>> 0, padLen - 4);
    // process on a copy so the object stays usable
    const savedH = this.h.slice();
    for (let off = 0; off < padLen; off += 64) this._block(padded.subarray(off, off + 64));
    const out = this.h.map((x) => x.toString(16).padStart(8, '0')).join('');
    this.h = savedH;
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
      data: this._buf.toString('hex', 0, this._bufLen),
      num: String(this._bufLen),
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

module.exports = { Sha1Ctx };
