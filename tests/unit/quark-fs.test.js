'use strict';
/**
 * quark-fs.test.js — path mapping, caching and mutation semantics.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const { QuarkFs, normalizePath, splitPath, parentOf, baseName } = require('../../core/webdav/quark-fs.js');

/** Recording fake API. */
function fakeApi(tree) {
  const calls = { list: 0, remove: [], rename: [], move: [], mkdir: [] };
  const api = {
    calls,
    async listDirAll(fid) {
      calls.list++;
      return (tree[fid] || []).map((e) => ({ ...e }));
    },
    async getDownloadUrl(fid) {
      const e = findEntry(tree, fid);
      if (!e) throw new Error('ENOENT');
      return { url: 'http://x/' + fid, size: e.size };
    },
    async mkdir(pdirFid, name) {
      calls.mkdir.push([pdirFid, name]);
      const fid = 'gen' + (calls.mkdir.length);
      (tree[pdirFid] = tree[pdirFid] || []).push({
        fid, file_name: name, dir: 1, file_type: 0, size: 0,
        updated_at: 1, created_at: 1,
      });
      tree[fid] = [];
      return fid;
    },
    async rename(fid, name) { calls.rename.push([fid, name]); },
    async move(fids, to) { calls.move.push([fids, to]); },
    async remove(fids) { calls.remove.push(fids); },
  };
  return api;
}

function findEntry(tree, fid) {
  for (const list of Object.values(tree)) {
    const e = list.find((x) => x.fid === fid);
    if (e) return e;
  }
  return null;
}

const TREE = {
  '0': [
    { fid: 'd1', file_name: 'docs', dir: 1, file_type: 0, size: 0, updated_at: 100, created_at: 90 },
    { fid: 'f1', file_name: 'a.txt', dir: 0, file_type: 4, size: 11, updated_at: 200, created_at: 90 },
  ],
  d1: [
    { fid: 'f2', file_name: 'b.txt', dir: 0, file_type: 4, size: 5, updated_at: 150, created_at: 90 },
  ],
};

function fakeUploader() {
  const uploads = [];
  return {
    uploads,
    async upload(opts) {
      const chunks = [];
      if (opts.buffer) chunks.push(opts.buffer);
      else for await (const c of opts.stream) chunks.push(c);
      uploads.push({ name: opts.fileName, parentFid: opts.parentFid, size: opts.size, data: Buffer.concat(chunks) });
      return { fid: 'newfid', rapid: false };
    },
  };
}

function makeFs(tree) {
  const api = fakeApi(tree || TREE);
  const fs = new QuarkFs({ api, uploader: fakeUploader(), http: {}, cacheTtlMs: 60000, now: () => 1000 });
  return { fs, api };
}

test('path helpers', () => {
  assert.equal(normalizePath('/a//b/'), '/a/b');
  assert.equal(normalizePath('a/b'), '/a/b');
  assert.equal(normalizePath('/'), '/');
  assert.deepEqual(splitPath('/a/b/c'), ['a', 'b', 'c']);
  assert.equal(parentOf('/a/b/c'), '/a/b');
  assert.equal(parentOf('/a'), '/');
  assert.equal(baseName('/a/b/c.txt'), 'c.txt');
});

test('stat resolves files and directories with mapped fields', async () => {
  const { fs } = makeFs();
  const root = await fs.stat('/');
  assert.equal(root.isDir, true);
  const dir = await fs.stat('/docs');
  assert.equal(dir.fid, 'd1');
  assert.equal(dir.isDir, true);
  const file = await fs.stat('/a.txt');
  assert.equal(file.fid, 'f1');
  assert.equal(file.size, 11);
  assert.equal(file.isDir, false);
  assert.equal(file.mtime.getTime(), 200000);
  assert.equal(await fs.stat('/nope'), null);
});

test('resolve caches directory listings (second walk costs no API call)', async () => {
  const { fs, api } = makeFs();
  await fs.stat('/docs');
  assert.equal(api.calls.list, 1);
  await fs.stat('/docs/b.txt');
  assert.equal(api.calls.list, 2, 'one new listing for the child dir');
  await fs.stat('/docs/b.txt');
  assert.equal(api.calls.list, 2, 'cached');
});

test('F-8: the directory cache stays bounded (LRU eviction)', async () => {
  const { fs } = makeFs();
  // cache 600 distinct directory listings directly
  for (let i = 0; i < 600; i++) {
    fs._cacheSet('fid' + i, { ts: fs.now(), entries: [{ fid: 'x' + i, file_name: 'f' }] });
  }
  assert.ok(fs.dirCache.size <= 512, 'cache size ' + fs.dirCache.size + ' must stay bounded');
  // the most recent entries survive, the oldest are gone
  assert.ok(fs.dirCache.has('fid599'));
  assert.ok(!fs.dirCache.has('fid0'));
  // a cached listing is still served
  const entries = await fs.listFid('fid599');
  assert.equal(entries[0].file_name, 'f');
});

test('list maps children to stat objects', async () => {
  const { fs } = makeFs();
  const items = await fs.list('/');
  assert.deepEqual(items.map((i) => i.name).sort(), ['a.txt', 'docs']);
  assert.equal(await fs.list('/a.txt'), null); // not a directory
});

test('writeFile uploads into the parent fid', async () => {
  const { fs } = makeFs();
  const up = fs.uploader;
  const out = await fs.writeFile('/docs/c.txt', Readable.from([Buffer.from('xyz')]), 3);
  assert.equal(out.fid, 'newfid');
  assert.equal(up.uploads[0].parentFid, 'd1');
  assert.equal(up.uploads[0].name, 'c.txt');
  assert.equal(up.uploads[0].size, 3);
  assert.equal(up.uploads[0].data.toString(), 'xyz');
});

test('writeFile overwrites by deleting the existing entry afterwards', async () => {
  const { fs, api } = makeFs();
  await fs.writeFile('/a.txt', Readable.from([Buffer.from('new')]), 3);
  assert.deepEqual(api.calls.remove, [['f1']]);
  // cache was invalidated: a fresh listing hits the API again
  await fs.list('/');
  assert.equal(api.calls.list, 3); // resolve root + initial + fresh re-list before delete
});

test('writeFile into a missing parent is 409', async () => {
  const { fs } = makeFs();
  await assert.rejects(
    fs.writeFile('/nodir/x.txt', Readable.from([Buffer.from('x')]), 1),
    (e) => e.httpStatus === 409,
  );
});

test('mkdir validates the parent and duplicates', async () => {
  const { fs, api } = makeFs();
  const out = await fs.mkdir('/docs/sub');
  assert.equal(out.fid, 'gen1');
  assert.deepEqual(api.calls.mkdir, [['d1', 'sub']]);
  await assert.rejects(fs.mkdir('/docs'), (e) => e.httpStatus === 405);
});

test('unlink removes files and subtrees', async () => {
  const { fs, api } = makeFs();
  await fs.unlink('/docs');
  assert.deepEqual(api.calls.remove, [['d1']]);
  await assert.rejects(fs.unlink('/nope'), (e) => e.httpStatus === 404);
});

test('rename rejects path separators in the new name', async () => {
  const { fs } = makeFs();
  await assert.rejects(fs.rename('/a.txt', 'b/c'), (e) => e.httpStatus === 409);
  await assert.rejects(fs.rename('/a.txt', '..'), (e) => e.httpStatus === 409);
  await fs.rename('/a.txt', 'b.txt');
});

test('move into an existing directory vs renaming in place', async () => {
  const tree = JSON.parse(JSON.stringify(TREE));
  const { fs, api } = makeFs(tree);
  await fs.move('/a.txt', '/docs'); // into dir
  assert.deepEqual(api.calls.move, [[['f1'], 'd1']]);
  await fs.move('/docs/b.txt', '/docs/renamed.txt'); // rename
  assert.deepEqual(api.calls.rename[0], ['f2', 'renamed.txt']);
  assert.deepEqual(api.calls.move[1], [['f2'], 'd1']);
});

test('move onto an existing file target is 409', async () => {
  const { fs } = makeFs();
  await assert.rejects(fs.move('/docs/b.txt', '/a.txt'), (e) => e.httpStatus === 409);
});
