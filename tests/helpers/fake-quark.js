'use strict';
/**
 * fake-quark.js — in-memory Quark API/uploader/download doubles shared by the
 * integration tests and the mount smoke script.
 */
const { Readable } = require('node:stream');

class FakeQuark {
  constructor() {
    /** fid -> entry */
    this.entries = new Map();
    /** fid -> content Buffer */
    this.contents = new Map();
    this.nextFid = 1000;
    const mk = (fid, name, parent, dir, size, content) => {
      const e = {
        fid, file_name: name, pdir_fid: parent, dir: dir ? 1 : 0,
        file_type: dir ? 0 : 4, size: dir ? 0 : size,
        updated_at: 1700000000, created_at: 1699999000,
      };
      this.entries.set(fid, e);
      if (content) this.contents.set(fid, content);
      return e;
    };
    mk('0', '/', null, true, 0, null);
    mk('d1', 'docs', '0', true, 0, null);
    mk('f1', 'a.txt', 'd1', false, 11, Buffer.from('hello world'));
    mk('f2', 'sp ace.txt', '0', false, 5, Buffer.from('sp ce'));
    mk('f3', 'big.bin', '0', false, 1024, Buffer.alloc(1024, 0xab));
  }

  _children(fid) {
    return [...this.entries.values()].filter((e) => e.pdir_fid === fid);
  }

  async listDirAll(fid) {
    return this._children(fid);
  }

  async getDownloadUrl(fid) {
    if (!this.entries.has(fid)) throw new Error('ENOENT');
    return { url: 'http://127.0.0.1:1/fake/' + fid, size: this.contents.get(fid).length };
  }

  async mkdir(pdirFid, name) {
    const fid = 'n' + this.nextFid++;
    this.entries.set(fid, {
      fid, file_name: name, pdir_fid: pdirFid, dir: 1, file_type: 0, size: 0,
      updated_at: 1700000001, created_at: 1700000001,
    });
    return fid;
  }

  async rename(fid, newName) {
    this.entries.get(fid).file_name = newName;
    return {};
  }

  async move(fids, toPdirFid) {
    for (const f of fids) this.entries.get(f).pdir_fid = toPdirFid;
    return {};
  }

  async remove(fids) {
    for (const f of fids) {
      const stack = [f];
      while (stack.length) {
        const cur = stack.pop();
        this.entries.delete(cur);
        this.contents.delete(cur);
        for (const c of this._children(cur)) stack.push(c.fid);
      }
    }
    return {};
  }

  async member() { return { use_capacity: 1, total_capacity: 10 }; }
}

class FakeUploader {
  constructor(quark) { this.quark = quark; }
  async upload(opts) {
    const chunks = [];
    if (opts.buffer) chunks.push(opts.buffer);
    else for await (const c of opts.stream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const fid = 'u' + this.quark.nextFid++;
    this.quark.entries.set(fid, {
      fid, file_name: opts.fileName, pdir_fid: opts.parentFid, dir: 0, file_type: 4,
      size: buf.length, updated_at: 1700000002, created_at: 1700000002,
    });
    this.quark.contents.set(fid, buf);
    return { fid, rapid: false };
  }
}

/** Fake HttpClient serving stored contents with Range support. */
class FakeDownloadHttp {
  constructor(quark) { this.quark = quark; }
  async request(method, url, opts = {}) {
    const fid = decodeURIComponent(url.split('/fake/')[1] || '');
    const buf = this.quark.contents.get(fid);
    if (!buf) return { status: 404, headers: { get: () => null }, body: Buffer.from('') };
    let slice = buf;
    let status = 200;
    if (opts.headers && opts.headers.Range) {
      const m = /bytes=(\d+)-(\d*)/.exec(opts.headers.Range);
      const start = Number(m[1]);
      const end = m[2] === '' ? buf.length - 1 : Number(m[2]);
      slice = buf.subarray(start, end + 1);
      status = 206;
    }
    return {
      status,
      headers: {
        get: (k) => ({
          'content-type': 'application/octet-stream',
          'content-length': String(slice.length),
        }[String(k).toLowerCase()] || null),
      },
      response: { body: Readable.toWeb(Readable.from([slice])) },
      body: null,
    };
  }
}

module.exports = { FakeQuark, FakeUploader, FakeDownloadHttp };
