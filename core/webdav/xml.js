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

/**
 * XML-escape text and strip characters that are illegal in XML 1.0
 * (\x00-\x08\x0b\x0c\x0e-\x1f). Hostile file names must never produce a
 * malformed 207 body — strict WebDAV clients would fail the whole listing.
 */
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Percent-encode each path segment, keeping slashes (for D:href). */
function encodeHref(posixPath) {
  const p = String(posixPath || '/');
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function rfc1123(date) {
  return (date instanceof Date ? date : new Date(date)).toUTCString();
}

function iso8601(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

/** Guess a content type from the file name (small built-in table). */
function mimeTypeOf(name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const map = {
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
  return (ext && map[ext[1]]) || 'application/octet-stream';
}

/**
 * Build one <D:response> element.
 * @param {{
 *   href: string, isDir?: boolean, name: string, size?: number,
 *   mtime?: Date, etag?: string, ctime?: Date,
 * }} item
 */
function responseElement(item) {
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
  props += '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>' +
    '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';
  return '<D:response>' +
    '<D:href>' + escapeXml(href) + '</D:href>' +
    '<D:propstat>' +
    '<D:prop>' + props + '</D:prop>' +
    '<D:status>HTTP/1.1 200 OK</D:status>' +
    '</D:propstat>' +
    '</D:response>';
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
  if (start > end || (size && start >= size)) return null;
  if (size && end >= size) end = size - 1;
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
      p = decodeURIComponent(u.pathname);
    } else {
      p = decodeURIComponent(p);
    }
    // strip the mount prefix if the client echoed it
    if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length);
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
