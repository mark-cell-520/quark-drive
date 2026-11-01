'use strict';
/**
 * upload.test.js — OSS multipart upload flow against a stubbed HttpClient.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { Uploader } = require('../../core/quark/upload.js');
const { Sha1Ctx } = require('../../core/quark/sha1ctx.js');
const { Device } = require('../../core/device.js');

function makeDevice() {
  return new Device({ machineId: 'm1', deviceName: 'PC1' });
}

const PRE_OK = {
  code: 0, status: 200,
  data: {
    task_id: 'task-1', bucket: 'bkt', obj_key: 'obj/key.txt', upload_id: 'uid-9',
    upload_url: 'oss-cn-beijing.aliyuncs.com',
    auth_info: { k: 'v' }, callback: { cb: 'url' },
    metadata: { part_size: 1024 * 1024, part_thread: 3 },
  },
};

/**
 * Fake HttpClient driving the whole upload state machine.
 * opts: { hashFinish?: boolean, partStatus?: number }
 */
function fakeHttp(opts = {}) {
  const events = [];
  const parts = [];
  const http = {
    events,
    parts,
    cookieJar: { header: () => '__puus=secret' },
    async requestJson(method, url, o = {}) {
      events.push({ kind: 'json', method, url, body: o.body ? JSON.parse(o.body) : null });
      if (url.includes('/file/upload/pre')) return PRE_OK;
      if (url.includes('/file/upload/auth')) return { code: 0, status: 200, data: { auth_key: 'OSS signed-key' } };
      if (url.includes('/file/update/hash')) {
        return { code: 0, status: 200, data: { finish: !!opts.hashFinish } };
      }
      if (url.includes('/file/upload/finish')) {
        return { code: 0, status: 200, data: { fid: 'fid-new', file_name: 'x' } };
      }
      throw new Error('unexpected json url ' + url);
    },
    async request(method, url, o = {}) {
      events.push({
        kind: 'raw', method, url,
        headers: o.headers || {},
        bodyLen: o.body ? o.body.length : 0,
        noCookie: !!o.noCookie,
        body: o.body,
      });
      if (method === 'PUT') {
        parts.push(Buffer.from(o.body));
        const status = opts.partStatus || 200;
        if (status === 409) {
          return {
            status: 409,
            headers: { get: () => null },
            body: Buffer.from('<Error><Code>PartAlreadyExist</Code><PartEtag>"etag-existing"</PartEtag></Error>'),
          };
        }
        if (status !== 200) {
          return { status, headers: { get: () => null }, body: Buffer.from('<Error>boom</Error>') };
        }
        return { status: 200, headers: { get: (k) => (k.toLowerCase() === 'etag' ? '"etag-' + parts.length + '"' : null) }, body: Buffer.alloc(0) };
      }
      if (method === 'POST') {
        return { status: 200, headers: { get: () => null }, body: Buffer.from('<CompleteMultipartUploadResult/>') };
      }
      throw new Error('unexpected ' + method + ' ' + url);
    },
  };
  return http;
}

function uploader(http, extra) {
  return new Uploader(Object.assign({ http, device: makeDevice(), logger: { debug() {}, warn() {} } }, extra));
}

async function* streamOf(buf, chunkSize) {
  for (let off = 0; off < buf.length; off += chunkSize) {
    yield buf.subarray(off, Math.min(off + chunkSize, buf.length));
  }
}

test('single-part upload runs pre → put → hash → commit → finish', async () => {
  const http = fakeHttp();
  const data = crypto.randomBytes(500);
  const out = await uploader(http).upload({
    parentFid: '0', fileName: 'key.txt', mimeType: 'text/plain', size: data.length, buffer: data,
  });
  assert.equal(out.fid, 'fid-new');
  assert.equal(out.rapid, false);

  const kinds = http.events.map((e) => (e.kind === 'raw' ? e.method + ' ' : '') +
    e.url.split('?')[0].replace(/^https?:\/\/[^/]+/, ''));
  assert.deepEqual(kinds, [
    '/1/clouddrive/file/upload/pre',
    '/1/clouddrive/file/upload/auth',
    'PUT /obj/key.txt',                 // part 1
    '/1/clouddrive/file/update/hash',
    '/1/clouddrive/file/upload/auth',
    'POST /obj/key.txt',                // commit
    '/1/clouddrive/file/upload/finish',
  ]);

  // part PUT target + headers
  const put = http.events.find((e) => e.kind === 'raw' && e.method === 'PUT');
  assert.equal(put.url, 'https://bkt.oss-cn-beijing.aliyuncs.com/obj/key.txt?partNumber=1&uploadId=uid-9');
  assert.equal(put.headers['Content-Type'], 'text/plain');
  assert.match(put.headers['x-oss-date'], /GMT$/);
  assert.equal(put.headers.Authorization, 'OSS signed-key');
  assert.ok(put.headers['x-oss-user-agent'].startsWith('aliyun-sdk-js'));
  assert.equal(put.noCookie, true, 'OSS requests must not carry the session cookie');
  assert.ok(!('X-Oss-Hash-Ctx' in put.headers), 'part 1 needs no hash ctx');

  // commit POST
  const commit = http.events.filter((e) => e.kind === 'raw' && e.method === 'POST')[0];
  assert.equal(commit.url, 'https://bkt.oss-cn-beijing.aliyuncs.com/obj/key.txt?uploadId=uid-9');
  assert.equal(commit.headers['Content-Type'], 'application/xml');
  assert.ok(commit.headers['Content-MD5']);
  assert.equal(commit.headers['x-oss-callback'], Buffer.from(JSON.stringify({ cb: 'url' })).toString('base64'));
  assert.match(commit.body.toString(), /<CompleteMultipartUpload><Part><PartNumber>1<\/PartNumber><ETag>etag-1<\/ETag><\/Part><\/CompleteMultipartUpload>/);

  // pre body
  const preBody = http.events[0].body;
  assert.equal(preBody.file_name, 'key.txt');
  assert.equal(preBody.format_type, 'text/plain');
  assert.equal(preBody.pdir_fid, '0');
  assert.equal(preBody.size, 500);
  assert.equal(preBody.ccp_hash_update, true);
  assert.equal(preBody.parallel_upload, true);

  // hash body = real md5/sha1 of the data
  const hashBody = http.events.find((e) => e.url.includes('update/hash')).body;
  assert.equal(hashBody.md5, crypto.createHash('md5').update(data).digest('hex'));
  assert.equal(hashBody.sha1, crypto.createHash('sha1').update(data).digest('hex'));
  assert.equal(hashBody.task_id, 'task-1');
});

test('multi-part upload sends X-Oss-Hash-Ctx from part 2 with the right state', async () => {
  const http = fakeHttp();
  const partSize = 1024 * 1024;
  const data = crypto.randomBytes(partSize * 2 + 777);
  const out = await uploader(http).upload({
    parentFid: 'p1', fileName: 'big.bin', size: data.length, buffer: data,
  });
  assert.equal(out.rapid, false);
  const puts = http.events.filter((e) => e.kind === 'raw' && e.method === 'PUT');
  assert.equal(puts.length, 3);
  assert.equal(http.parts.length, 3);
  assert.equal(http.parts[0].length + http.parts[1].length + http.parts[2].length, data.length);
  assert.ok(!('X-Oss-Hash-Ctx' in puts[0].headers));
  assert.ok('X-Oss-Hash-Ctx' in puts[1].headers);
  assert.ok('X-Oss-Hash-Ctx' in puts[2].headers);
  assert.match(puts[1].url, /partNumber=2/);
  assert.match(puts[2].url, /partNumber=3/);

  // ctx after part 1 must equal a fresh SHA-1 over the first partSize bytes
  const ref = new Sha1Ctx();
  ref.update(data.subarray(0, partSize));
  assert.equal(puts[1].headers['X-Oss-Hash-Ctx'], ref.exportStateB64());

  // auth_meta of part 2 embeds the same ctx
  const auth2 = http.events.filter((e) => e.kind === 'json' && e.url.includes('upload/auth'))[1];
  assert.match(auth2.body.auth_meta, /^PUT\n\napplication\/octet-stream\n.+\nX-Oss-Hash-Ctx:/);
  assert.ok(auth2.body.auth_meta.includes(ref.exportStateB64()));
  assert.match(auth2.body.auth_meta, /\/bkt\/obj\/key\.txt\?partNumber=2&uploadId=uid-9$/);

  // commit lists 3 parts in order
  const commit = http.events.filter((e) => e.kind === 'raw' && e.method === 'POST')[0];
  assert.match(commit.body.toString(), /<PartNumber>3<\/PartNumber><ETag>etag-3<\/ETag>/);
});

test('stream input is split by partSize', async () => {
  const http = fakeHttp();
  const data = crypto.randomBytes(2500 * 1024); // part_size 1MiB -> 3 parts
  await uploader(http).upload({
    parentFid: '0', fileName: 's.bin', size: data.length, stream: streamOf(data, 400 * 1024),
  });
  const puts = http.events.filter((e) => e.kind === 'raw' && e.method === 'PUT');
  assert.equal(puts.length, 3);
  assert.deepEqual(http.parts.map((p) => p.length), [1048576, 1048576, 462848]);
  assert.equal(Buffer.concat(http.parts).equals(data), true);
});

test('rapid upload (秒传) skips commit', async () => {
  const http = fakeHttp({ hashFinish: true });
  const out = await uploader(http).upload({
    parentFid: '0', fileName: 'dup.txt', size: 10, buffer: Buffer.alloc(10, 1),
  });
  assert.equal(out.rapid, true);
  const urls = http.events.map((e) => e.url.split('?')[0]);
  assert.ok(!urls.some((u) => u.includes('aliyuncs.com') && http.events.find((e) => e.url === u && e.method === 'POST')), 'no commit POST');
  assert.equal(http.events.filter((e) => e.kind === 'raw').length, 1); // only the part PUT
  assert.ok(http.events.some((e) => e.url.includes('upload/finish')));
});

test('empty file uploads one empty part', async () => {
  const http = fakeHttp();
  await uploader(http).upload({ parentFid: '0', fileName: 'empty.txt', size: 0, buffer: Buffer.alloc(0) });
  const puts = http.events.filter((e) => e.kind === 'raw' && e.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].bodyLen, 0);
});

test('409 PartAlreadyExist recovers the ETag from the XML body', async () => {
  const http = fakeHttp({ partStatus: 409 });
  const out = await uploader(http).upload({
    parentFid: '0', fileName: 'x.bin', size: 100, buffer: crypto.randomBytes(100),
  });
  assert.equal(out.rapid, false);
  const commit = http.events.filter((e) => e.kind === 'raw' && e.method === 'POST')[0];
  assert.match(commit.body.toString(), /<ETag>etag-existing<\/ETag>/);
});

test('onProgress reports monotonic progress', async () => {
  const http = fakeHttp();
  const seen = [];
  await uploader(http).upload({
    parentFid: '0', fileName: 'p.bin', size: 2500 * 1024, buffer: crypto.randomBytes(2500 * 1024),
    onProgress: (loaded, total) => seen.push([loaded, total]),
  });
  assert.deepEqual(seen, [
    [1048576, 2500 * 1024],
    [2097152, 2500 * 1024],
    [2500 * 1024, 2500 * 1024],
  ]);
});

test('pre failure raises UploadError', async () => {
  const http = fakeHttp();
  http.requestJson = async () => ({ code: 700, message: 'nope' });
  await assert.rejects(
    uploader(http).upload({ parentFid: '0', fileName: 'x', size: 1, buffer: Buffer.alloc(1) }),
    /upload pre: code=700/,
  );
});

test('PUT failure raises UploadError with the stage', async () => {
  const http = fakeHttp({ partStatus: 403 });
  await assert.rejects(
    uploader(http).upload({ parentFid: '0', fileName: 'x', size: 10, buffer: Buffer.alloc(10) }),
    /upload part 1: http 403/,
  );
});
