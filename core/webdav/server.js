'use strict';
/**
 * server.js — a compact WebDAV server backed by QuarkFs.
 *
 * Supported methods: OPTIONS, GET, HEAD, PUT, DELETE, PROPPATCH, MKCOL, MOVE.
 * PROPFIND answers depth 0/1 (depth infinity is treated as 1 — the namespace
 * can be arbitrarily large).
 *
 * Security posture:
 *  - binds to 127.0.0.1 by default (never exposes the session to the network)
 *  - no authentication (the port is local-only); rclone is the only client
 *  - all paths are normalised and confined to the served namespace
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { multistatus, errorBody, parseRange, destinationPath, mimeTypeOf } = require('./xml.js');
const { normalizePath, splitPath } = require('./quark-fs.js');

const ALLOW_METHODS = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE';
/** Chunked bodies (no Content-Length) are buffered in memory before upload. */
const MAX_CHUNKED_BODY_BYTES = 256 * 1024 * 1024; // 256 MiB

function decodePath(urlPath) {
  return urlPath.split('/').map((seg) => {
    try { return decodeURIComponent(seg); } catch (_e) { return seg; }
  }).join('/');
}

/**
 * @param {{
 *   fs: import('./quark-fs.js').QuarkFs,
 *   host?: string,
 *   port?: number,
 *   basePath?: string,       // namespace prefix, default "/"
 *   authToken?: string,      // required URL path prefix; generated when absent
 *   maxChunkedBodyBytes?: number,
 *   logger?: {debug: Function, warn: Function, error: Function},
 * }} opts
 */
function createWebDavServer(opts) {
  const fs = opts.fs;
  const host = opts.host || '127.0.0.1';
  const basePath = normalizePath(opts.basePath || '/');
  const maxChunkedBodyBytes = opts.maxChunkedBodyBytes == null ? MAX_CHUNKED_BODY_BYTES : opts.maxChunkedBodyBytes;
  const logger = opts.logger || { debug() {}, warn() {}, error() {} };
  // Defence in depth for a loopback service: a per-run random URL prefix makes
  // the endpoint unguessable for other local processes, and the Host check
  // blocks DNS-rebinding style attacks from browsers.
  const authToken = opts.authToken || crypto.randomBytes(24).toString('hex');
  const urlPrefix = '/' + authToken + (basePath === '/' ? '' : basePath);

  function toNamespace(reqPath) {
    let p = decodePath(reqPath.split('?')[0]);
    // the auth token prefixes every path: /<token>/docs
    const prefix = '/' + authToken;
    if (p === prefix || p.startsWith(prefix + '/')) {
      p = p.slice(prefix.length);
    } else {
      return null; // unauthorized
    }
    if (basePath !== '/') {
      if (p === basePath) return '/';
      if (p.startsWith(basePath + '/')) p = p.slice(basePath.length);
    }
    return normalizePath(p);
  }

  /** Requests must target us directly (blocks DNS-rebinding to the loopback). */
  function hostOk(req) {
    const h = String(req.headers.host || '').trim().toLowerCase();
    if (!h) return false;
    // userinfo trick: "127.0.0.1:80@evil.com" must not pass as loopback
    // (audit finding W-1 — browsers never send this, but be strict anyway)
    if (h.includes('@')) return false;
    // strip the port; for a bracketed IPv6 literal the port follows the ']'
    let hostpart = h;
    const close = h.lastIndexOf(']');
    if (close !== -1) {
      hostpart = h.slice(0, close + 1); // [::1]:9798 -> [::1]
    } else {
      const colon = h.indexOf(':');
      if (colon !== -1) hostpart = h.slice(0, colon);
    }
    const bare = hostpart.replace(/^\[/, '').replace(/]$/, '');
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
  }

  function sendDavHeaders(res, extra) {
    // class 1 only: LOCK/UNLOCK are not implemented (advertising class 2
    // would invite clients to call methods we 405 — audit finding W-4)
    res.setHeader('DAV', '1');
    res.setHeader('MS-Author-Via', 'DAV');
    res.setHeader('Allow', ALLOW_METHODS);
    res.setHeader('Accept-Ranges', 'bytes');
    if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }

  /** Constrain an upstream-supplied mime type to a token charset before it
   *  reaches setHeader (a CRLF-laden value would throw there — W-6). */
  function safeMime(mime) {
    const m = String(mime || '').trim();
    return /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+$/i.test(m)
      ? m
      : 'application/octet-stream';
  }

  function sendError(res, status, message, condition) {
    const body = condition ? errorBody(condition, message) : message + '\n';
    sendDavHeaders(res, { 'Content-Type': condition ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8' });
    res.writeHead(status);
    res.end(body);
  }

  async function handlePropfind(req, res, path) {
    const depth = String(req.headers.depth || '1').toLowerCase();
    const st = await fs.stat(path);
    if (!st) return sendError(res, 404, 'not found', 'NotFound');

    const items = [{
      href: urlPrefix + path,
      isDir: st.isDir, name: st.name === '/' ? '' : st.name,
      size: st.size, mtime: st.mtime, ctime: st.ctime, etag: st.etag,
    }];
    if (st.isDir && (depth === '1' || depth === 'infinity')) {
      const children = await fs.list(path);
      if (children) {
        for (const c of children) {
          items.push({
            href: urlPrefix + c.path,
            isDir: c.isDir, name: c.name, size: c.size,
            mtime: c.mtime, ctime: c.ctime, etag: c.etag,
          });
        }
      }
    }
    const body = multistatus(items);
    sendDavHeaders(res, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.writeHead(207);
    res.end(body);
  }

  async function handleGet(req, res, path, headOnly) {
    const st = await fs.stat(path);
    if (!st) return sendError(res, 404, 'not found');
    if (st.isDir) {
      // Browsers: a minimal listing beats a bare 405.
      sendDavHeaders(res, { 'Content-Type': 'text/html; charset=utf-8' });
      res.writeHead(200);
      if (!headOnly) {
        const children = (await fs.list(path)) || [];
        const links = children
          .map((c) => '<li><a href="./' + encodeURIComponent(c.name) + (c.isDir ? '/' : '') + '">' +
            escapeHtml(c.name) + '</a></li>')
          .join('');
        res.end('<!doctype html><meta charset="utf-8"><title>QuarkDrive</title><h1>QuarkDrive</h1><ul>' +
          (links || '<li>(empty)</li>') + '</ul>');
      } else res.end();
      return;
    }

    const range = parseRange(req.headers.range, st.size);

    if (headOnly) {
      // Answer HEAD from the stat alone: opening the stream would cost an
      // API call + a CDN socket just to throw the body away (audit finding
      // W-3). Headers match what a GET would return for a compliant CDN.
      if (range) {
        const length = range.end - range.start + 1;
        sendDavHeaders(res, {
          'Content-Type': mimeTypeOf(st.name),
          'Content-Length': String(length),
          'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + st.size,
          'ETag': st.etag,
          'Last-Modified': st.mtime.toUTCString(),
        });
        return res.writeHead(206).end();
      }
      sendDavHeaders(res, {
        'Content-Type': mimeTypeOf(st.name),
        'Content-Length': String(st.size),
        'ETag': st.etag,
        'Last-Modified': st.mtime.toUTCString(),
      });
      return res.writeHead(200).end();
    }

    // Abort the upstream fetch when the client goes away (no socket leaks).
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(new Error('client disconnected')); });

    let opened;
    try {
      opened = await fs.createReadStream(path, range, { signal: ac.signal });
    } catch (e) {
      logger.warn('GET ' + path + ' open failed: ' + e.message);
      return sendError(res, 502, 'upstream error');
    }
    if (!opened) return sendError(res, 404, 'not found');

    const serveRange = !!(range && opened.partial);
    if (serveRange) {
      const length = opened.size;
      // Clamp to the real file size: a misbehaving 206 with an over-long
      // body must not advertise a range end beyond the file (audit finding
      // W-5). A compliant CDN returns exactly the requested bytes, so the
      // clamp is a no-op there.
      const end = Math.min(range.start + length - 1, st.size - 1);
      sendDavHeaders(res, {
        'Content-Type': safeMime(opened.mime),
        'Content-Length': String(length),
        'Content-Range': 'bytes ' + range.start + '-' + end + '/' + st.size,
        'ETag': st.etag,
        'Last-Modified': st.mtime.toUTCString(),
      });
      res.writeHead(206);
    } else {
      sendDavHeaders(res, {
        'Content-Type': safeMime(opened.mime),
        'Content-Length': String(opened.size),
        'ETag': st.etag,
        'Last-Modified': st.mtime.toUTCString(),
      });
      res.writeHead(200);
    }
    opened.stream.on('error', (e) => {
      logger.warn('stream error on ' + path + ': ' + e.message);
      res.destroy();
    });
    opened.stream.pipe(res);
  }

  async function handlePut(req, res, path) {
    const st = await fs.stat(path);
    if (st && st.isDir) return sendError(res, 409, 'target is a directory');
    const sizeHeader = req.headers['content-length'];
    const size = sizeHeader == null ? null : Number(sizeHeader);
    if (size != null && (!Number.isFinite(size) || size < 0)) {
      return sendError(res, 411, 'invalid content-length');
    }
    const mimeType = req.headers['content-type'] || undefined;
    try {
      let out;
      if (size == null) {
        // Chunked body: the upload protocol needs the size up front, so buffer
        // it first (rare path — rclone/Explorer always send content-length).
        const chunks = [];
        let buffered = 0;
        let tooLarge = false;
        for await (const c of req) {
          if (tooLarge) continue; // keep draining so the client can finish sending
          buffered += c.length;
          if (buffered > maxChunkedBodyBytes) {
            // Answer FIRST and then drain the rest of the body. Destroying
            // the request/socket here (or setting Connection: close) makes
            // the client see ECONNRESET instead of the 413 — it cannot tell
            // "file too large" from "network failure" and may retry forever.
            tooLarge = true;
            sendError(res, 413, 'chunked body too large (max ' + maxChunkedBodyBytes + ' bytes)');
            continue;
          }
          chunks.push(c);
        }
        if (tooLarge) return;
        const buf = Buffer.concat(chunks);
        out = await fs.writeFile(path, null, buf.length, { buffer: buf, mimeType });
      } else {
        out = await fs.writeFile(path, req, size, { mimeType });
      }
      // Same ETag formula as stat/PROPFIND so caches see one identity per
      // resource across verbs (a fresh stat re-lists the parent — the same
      // listing the next PROPFIND would trigger anyway).
      let etag = '"' + (out.fid || 'w') + '"';
      try {
        const st2 = await fs.stat(path);
        if (st2) etag = st2.etag;
      } catch (_e) { /* keep the fallback */ }
      sendDavHeaders(res, { 'ETag': etag });
      res.writeHead(st ? 204 : 201);
      res.end();
    } catch (e) {
      logger.warn('PUT ' + path + ' failed: ' + e.message);
      // Never echo upstream/internal text to the client.
      sendError(res, e.httpStatus || 500, e.httpStatus ? e.message : 'upload failed');
    }
  }

  async function handleMkcol(req, res, path) {
    try {
      await fs.mkdir(path);
      sendDavHeaders(res);
      res.writeHead(201);
      res.end();
    } catch (e) {
      logger.warn('MKCOL ' + path + ' failed: ' + e.message);
      sendError(res, e.httpStatus || 500, e.httpStatus ? e.message : 'mkdir failed');
    }
  }

  async function handleDelete(req, res, path) {
    try {
      await fs.unlink(path);
      sendDavHeaders(res);
      res.writeHead(204);
      res.end();
    } catch (e) {
      logger.warn('DELETE ' + path + ' failed: ' + e.message);
      sendError(res, e.httpStatus || 500, e.httpStatus ? e.message : 'delete failed');
    }
  }

  async function handleMove(req, res, path) {
    const dest = destinationPath(req.headers.destination, urlPrefix);
    if (!dest) return sendError(res, 400, 'bad Destination header');
    if (dest === path) {
      // RFC 4918: source and destination are the same resource
      return sendError(res, 403, 'source and destination are identical');
    }
    const overwrite = String(req.headers.overwrite || 'T').toUpperCase() !== 'F';
    try {
      const existing = await fs.stat(dest);
      if (existing && !existing.isDir && !overwrite) {
        return sendError(res, 412, 'destination exists');
      }
      // NOTE: we never pre-delete the destination — fs.move owns replacement
      // and deletes the old version only after a successful move, so a failed
      // MOVE can never destroy the destination file.
      const existed = !!existing;
      await fs.move(path, dest, { overwrite });
      sendDavHeaders(res);
      res.writeHead(existed ? 204 : 201);
      res.end();
    } catch (e) {
      logger.warn('MOVE ' + path + ' -> ' + dest + ' failed: ' + e.message);
      sendError(res, e.httpStatus || 500, e.httpStatus ? e.message : 'move failed');
    }
  }

  async function handleProppatch(req, res, path) {
    // No writable live properties; report success for the requested props.
    const body = multistatus([{
      href: urlPrefix + path,
      isDir: false, name: '', size: 0,
    }]);
    sendDavHeaders(res, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.writeHead(207);
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    // loopback hardening: direct Host + secret URL prefix
    if (!hostOk(req)) {
      res.writeHead(421).end('misdirected request\n');
      return;
    }
    const path = toNamespace(req.url || '/');
    if (path === null) {
      sendError(res, 401, 'unauthorized');
      return;
    }
    try {
      switch (req.method) {
        case 'OPTIONS':
          sendDavHeaders(res, { 'Content-Length': '0' });
          res.writeHead(200);
          return res.end();
        case 'PROPFIND':
          return await handlePropfind(req, res, path);
        case 'GET':
          return await handleGet(req, res, path, false);
        case 'HEAD':
          return await handleGet(req, res, path, true);
        case 'PUT':
          return await handlePut(req, res, path);
        case 'MKCOL':
          return await handleMkcol(req, res, path);
        case 'DELETE':
          return await handleDelete(req, res, path);
        case 'MOVE':
          return await handleMove(req, res, path);
        case 'PROPPATCH':
          return await handleProppatch(req, res, path);
        case 'COPY':
          return sendError(res, 405, 'COPY not supported', 'MethodNotAllowed');
        default:
          return sendError(res, 405, 'method not allowed', 'MethodNotAllowed');
      }
    } catch (e) {
      logger.error(req.method + ' ' + path + ' -> ' + e.message);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.destroy();
    } finally {
      logger.debug(req.method + ' ' + path + ' ' + res.statusCode + ' (' + (Date.now() - started) + 'ms)');
    }
  });

  server.host = host;
  server.port = opts.port || 9798;
  server.basePath = basePath;
  server.authToken = authToken;
  /** The URL prefix rclone must use (includes the secret token). */
  server.urlPrefix = urlPrefix;

  /** Start listening; resolves with the actual bound port. */
  server.listenAsync = function listenAsync(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // port 0 = ephemeral (must not fall through to the default)
      server.listen(port == null ? server.port : port, host, () => {
        server.removeListener('error', reject);
        resolve(server.address().port);
      });
    });
  };

  server.closeAsync = function closeAsync() {
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return server;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { createWebDavServer, decodePath, ALLOW_METHODS, MAX_CHUNKED_BODY_BYTES };
