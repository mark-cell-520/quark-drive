'use strict';
/**
 * sha1ctx.test.js — SHA-1 vectors, cross-check vs node:crypto, state export.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { Sha1Ctx } = require('../../core/quark/sha1ctx.js');

test('standard SHA-1 test vectors', () => {
  assert.equal(Sha1Ctx.hash(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(Sha1Ctx.hash('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(
    Sha1Ctx.hash('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  // 1,000,000 x 'a' (multi-block)
  assert.equal(Sha1Ctx.hash('a'.repeat(1000000)), '34aa973cd4c4daa4f61eeb2bdbad27316534016f');
});

test('digest matches node:crypto for random incremental updates', () => {
  for (const size of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 1 << 16]) {
    const data = crypto.randomBytes(size);
    // feed in odd-sized chunks to exercise buffering
    const ctx = new Sha1Ctx();
    let off = 0;
    let step = 7;
    while (off < data.length) {
      ctx.update(data.subarray(off, off + step));
      off += step;
      step = (step * 3 + 1) % 97 + 1;
    }
    assert.equal(ctx.digest(), crypto.createHash('sha1').update(data).digest('hex'),
      'size=' + size);
  }
});

test('digest() is idempotent and does not mutate state', () => {
  const ctx = new Sha1Ctx();
  ctx.update('hello');
  const d1 = ctx.digest();
  const d2 = ctx.digest();
  assert.equal(d1, d2);
  ctx.update(' world');
  assert.equal(ctx.digest(), crypto.createHash('sha1').update('hello world').digest('hex'));
});

test('exportState matches a fresh SHA-1 after the same prefix', () => {
  const data = crypto.randomBytes(300);
  const ctx = new Sha1Ctx();
  ctx.update(data);
  const st = ctx.exportState();
  // state must equal the internal state of a hash that processed the same bytes
  const ref = new Sha1Ctx();
  ref.update(data);
  assert.deepEqual(st, ref.exportState());
  // decimal-string fields
  for (const k of ['h0', 'h1', 'h2', 'h3', 'h4', 'nl', 'nh']) {
    assert.match(st[k], /^\d+$/, k);
  }
  assert.equal(st.hash_type, 'sha1');
  // pending (not yet block-aligned) bytes are carried as hex with their count
  assert.equal(st.num, String(300 % 64));
  assert.equal(st.data, data.subarray(300 - (300 % 64)).toString('hex'));
  // bits: 300 bytes = 2400 bits, fits in nl; nh = 0
  assert.equal(st.nl, '2400');
  assert.equal(st.nh, '0');
  // base64 form is valid JSON round-trip
  const b64 = ctx.exportStateB64();
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), st);
});

test('exportState of a block-aligned prefix carries no pending bytes', () => {
  const ctx = new Sha1Ctx();
  ctx.update(crypto.randomBytes(128)); // exactly 2 blocks
  const st = ctx.exportState();
  assert.equal(st.num, '0');
  assert.equal(st.data, '');
  assert.equal(st.nl, String(128 * 8));
});

test('exportState splits bit counts above 32 bits into nh', () => {
  // White-box: simulate a processed byte count above 2^29 (bits > 2^32)
  // without hashing half a gigabyte.
  const bytes = 512 * 1024 * 1024 + 3;
  const ctx = new Sha1Ctx();
  ctx.len = bytes;
  const st = ctx.exportState();
  const bits = BigInt(bytes) * 8n;
  assert.equal(st.nh, String(bits >> 32n));
  assert.equal(st.nl, String(bits & 0xffffffffn));
  // and the real state fields still come from the untouched initial state
  assert.equal(st.h0, String(0x67452301));
});

test('real multi-megabyte hash crosses block boundaries and stays in sync', () => {
  const data = crypto.randomBytes(3 * 1024 * 1024 + 12345);
  assert.equal(Sha1Ctx.hash(data), crypto.createHash('sha1').update(data).digest('hex'));
});

test('state continues correctly: ctx after N bytes equals fresh hash of N bytes', () => {
  // The OSS protocol resumes a hash context; verify our exported state can be
  // "resumed" conceptually: hashing more bytes after exportState keeps the
  // same stream as one continuous update.
  const a = crypto.randomBytes(100);
  const b = crypto.randomBytes(100);
  const ctx = new Sha1Ctx();
  ctx.update(a);
  ctx.exportState(); // must not disturb
  ctx.update(b);
  assert.equal(ctx.digest(), crypto.createHash('sha1').update(Buffer.concat([a, b])).digest('hex'));
});
