'use strict';
/**
 * xml.js — minimal WebDAV XML helpers (no dependencies).
 *
 * Covers everything rclone/Windows-Explorer need from a WebDAV server:
 *  - PROPFIND 207 Multi-Status responses (depth 0 and 1)
 *  - live properties: displayname, getcontentlength, getcontenttype,
 *    getlastmodified, resourcetype, getetag, creationdate, supportedlock
 *  - XML escaping and href percent-encoding
 */

const D = 'D';
const NS = 'xmlns:D="DAV:"';

/** Characters that need entity escaping in XML text/attributes. */
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
/** Anything that needs escaping OR stripping (XML 1.0 illegal control chars). */
const XML_NEEDS_WORK = /[&<>"'\x00-\x08\x0b\x0c\x0e-\x1f]/;
const XML_ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * XML-escape text and strip characters that are illegal in XML 1.0
 * (\x00-\x08\x0b\x0c\x0e-\x1f). Hostile file names must never produce a
 * malformed 207 body — strict WebDAV clients would fail the whole listing.
 *
 * Hot path: listings call this ~6x per entry, so the common case (nothing to
 * do) must cost a single regex test and zero allocations.
 */
function escapeXml(s) {
  const str = s == null ? '' : String(s);
  if (!XML_NEEDS_WORK.test(str)) return str; // fast path
  return str
    .replace(XML_ILLEGAL, '')
    .replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]);
}

/** Percent-encode each path segment, keeping slashes (for D:href). */
const HREF_SAFE = /^[A-Za-z0-9\-_.!~*'()/]*$/;
function encodeHref(posixPath) {
  const p = String(posixPath || '/');
  // Fast path: encodeURIComponent() passes these through unchanged.
  if (HREF_SAFE.test(p)) return p;
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

const RFC1123_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC1123_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); }

/**
 * RFC 1123 date ("Mon, 02 Jan 2006 15:04:05 GMT").
 * Byte-identical to Date#toUTCString for in-range dates, ~10x faster
 * (lookup tables instead of C++->JS string building). Listings format two
 * dates per entry, so this is a measurable hot path.
 */
function rfc1123(date) {
  const d = date instanceof Date ? date : new Date(date);
  const t = d.getTime();
  if (!Number.isFinite(t)) return 'Invalid Date';
  const y = d.getUTCFullYear();
  // Negative years need an explicit sign ("-0062"), not zero-padding ("0-62").
  const yearStr = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0');
  return RFC1123_DAYS[d.getUTCDay()] + ', ' + pad2(d.getUTCDate()) + ' ' +
    RFC1123_MONTHS[d.getUTCMonth()] + ' ' + yearStr + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + ' GMT';
}

/** ISO 8601 ("2006-01-02T15:04:05.000Z"); matches Date#toISOString output. */
function iso8601(date) {
  const d = date instanceof Date ? date : new Date(date);
  const t = d.getTime();
  if (!Number.isFinite(t)) return new Date(0).toISOString();
  // Years outside 0000..9999 use the expanded ±YYYYYY form (like toISOString).
  const y = d.getUTCFullYear();
  const yearStr = (y < 0 || y > 9999)
    ? (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(6, '0')
    : String(y).padStart(4, '0');
  return yearStr + '-' + pad2(d.getUTCMonth() + 1) + '-' +
    pad2(d.getUTCDate()) + 'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' +
    pad2(d.getUTCSeconds()) + '.' + pad3(d.getUTCMilliseconds()) + 'Z';
}

/** Extension -> content type (hoisted: mimeTypeOf runs once per listed entry). */
const MIME_MAP = {
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  json: 'application/json', xml: 'application/xml',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/x-wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  exe: 'application/x-msdownload', msi: 'application/x-msdownload', iso: 'application/x-iso9660-image',
};
/** Extension -> resolved type cache (bounded by the extension alphabet). */
const MIME_CACHE = new Map();

/** Guess a content type from the file name (small built-in table). */
function mimeTypeOf(name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!ext) return 'application/octet-stream';
  let mime = MIME_CACHE.get(ext[1]);
  if (mime === undefined) {
    mime = MIME_MAP[ext[1]] || 'application/octet-stream';
    MIME_CACHE.set(ext[1], mime);
  }
  return mime;
}

/**
 * Build one <D:response> element.
 *
 * Memoized per item object: directory listings reuse the cached stat objects
 * (quark-fs.list), so repeated PROPFIND depth-1 on the same directory — the
 * Explorer/rclone browsing hot path — rebuilds nothing. The WeakMap keyed by
 * the item object expires with the cache entry (fresh entries after any
 * mutation invalidate).
 *
 * @param {{
 *   href: string, isDir?: boolean, name: string, size?: number,
 *   mtime?: Date, etag?: string, ctime?: Date,
 * }} item
 */
const RESPONSE_CACHE = new WeakMap();
function responseElement(item) {
  const cached = RESPONSE_CACHE.get(item);
  if (cached !== undefined) return cached;
  const href = encodeHref(item.href);
  const name = item.name;
  let props = '';
  props += '<D:displayname>' + escapeXml(name) + '</D:displayname>';
  if (item.isDir) {
    props += '<D:resourcetype><D:collection/></D:resourcetype>';
  } else {
    props += '<D:resourcetype/>';
    props += '<D:getcontentlength>' + (Number(item.size) || 0) + '</D:getcontentlength>';
    props += '<D:getcontenttype>' + escapeXml(mimeTypeOf(name)) + '</D:getcontenttype>';
  }
  if (item.mtime) {
    props += '<D:getlastmodified>' + escapeXml(rfc1123(item.mtime)) + '</D:getlastmodified>';
  }
  if (item.ctime) {
    props += '<D:creationdate>' + escapeXml(iso8601(item.ctime)) + '</D:creationdate>';
  }
  if (item.etag) {
    props += '<D:getetag>' + escapeXml(item.etag) + '</D:getetag>';
  }
  // NOTE: no <D:supportedlock> — this server implements no LOCK/UNLOCK, and
  // advertising it only invites clients to call methods we 405.
  const out = '<D:response>' +
    '<D:href>' + escapeXml(href) + '</D:href>' +
    '<D:propstat>' +
    '<D:prop>' + props + '</D:prop>' +
    '<D:status>HTTP/1.1 200 OK</D:status>' +
    '</D:propstat>' +
    '</D:response>';
  RESPONSE_CACHE.set(item, out);
  return out;
}

/**
 * Build a full 207 Multi-Status document.
 * @param {Array<Parameters<typeof responseElement>[0]>} items
 */
function multistatus(items) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:multistatus ' + NS + '>' +
    items.map(responseElement).join('') +
    '</D:multistatus>';
}

/** Minimal well-formed error body (e.g. for 409/507). */
function errorBody(condition, message) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:error ' + NS + '><D:' + condition + '>' + escapeXml(message || '') + '</D:' + condition + '></D:error>';
}

/** Parse a Range header ("bytes=0-99"). Returns null when absent/invalid. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '') {
    // suffix range: last N bytes
    if (m[2] === '') return null;
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }
  // `size != null`, not `size &&`: an EMPTY file (size 0) must reject every
  // range (proxying "bytes=0-0" upstream would earn a 416 and a 502 here).
  if (start > end || (size != null && start >= size)) return null;
  if (size != null && end >= size) end = size - 1;
  return { start, end };
}

/** Parse a MOVE/COPY Destination header into a POSIX path. */
function destinationPath(destination, basePath) {
  if (!destination) return null;
  try {
    // Destination may be an absolute URI or a path.
    let p = String(destination);
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      // RFC 4918: a Destination on another host is not ours to fulfil
      const host = u.hostname.toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
        return null;
      }
      p = decodeURIComponent(u.pathname);
    } else {
      p = decodeURIComponent(p);
    }
    // strip the mount prefix if the client echoed it — SEGMENT-aware, like
    // toNamespace: '/dav' must not strip from '/david/x'
    if (basePath && basePath !== '/') {
      if (p === basePath) p = '/';
      else if (p.startsWith(basePath + '/')) p = p.slice(basePath.length);
    }
    if (!p.startsWith('/')) p = '/' + p;
    return p.replace(/\/+$/, '') || '/';
  } catch (_e) {
    return null;
  }
}

module.exports = {
  escapeXml, encodeHref, rfc1123, iso8601, mimeTypeOf,
  responseElement, multistatus, errorBody, parseRange, destinationPath,
};
