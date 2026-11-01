'use strict';
/**
 * xml.test.js — XML escaping/hrefs, Range and Destination parsing.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  escapeXml, encodeHref, mimeTypeOf, multistatus, parseRange, destinationPath,
} = require('../../core/webdav/xml.js');

test('escapeXml escapes all five entities', () => {
  assert.equal(escapeXml('<a>&"\''), '&lt;a&gt;&amp;&quot;&apos;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(42), '42');
});

test('encodeHref percent-encodes segments but keeps slashes', () => {
  assert.equal(encodeHref('/a b/c+d.txt'), '/a%20b/c%2Bd.txt');
  assert.equal(encodeHref('/中文/文件.txt'), '/%E4%B8%AD%E6%96%87/%E6%96%87%E4%BB%B6.txt');
  assert.equal(encodeHref('/'), '/');
});

test('mimeTypeOf maps common extensions and defaults to octet-stream', () => {
  assert.equal(mimeTypeOf('a.txt'), 'text/plain');
  assert.equal(mimeTypeOf('A.PNG'), 'image/png');
  assert.equal(mimeTypeOf('movie.mkv'), 'video/x-matroska');
  assert.equal(mimeTypeOf('noext'), 'application/octet-stream');
  assert.equal(mimeTypeOf(''), 'application/octet-stream');
});

test('multistatus builds a well-formed 207 body', () => {
  const xml = multistatus([
    { href: '/', isDir: true, name: '', size: 0 },
    { href: '/a b.txt', isDir: false, name: 'a b.txt', size: 3, mtime: new Date(0) },
  ]);
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/);
  assert.match(xml, /xmlns:D="DAV:"/);
  assert.match(xml, /<D:href>\/<\/D:href>/);
  assert.match(xml, /<D:href>\/a%20b\.txt<\/D:href>/);
  assert.match(xml, /<D:getcontentlength>3<\/D:getcontentlength>/);
  assert.match(xml, /<D:getcontenttype>text\/plain<\/D:getcontenttype>/);
  assert.match(xml, /Thu, 01 Jan 1970 00:00:00 GMT/);
  // balanced tags
  const open = (xml.match(/<D:response>/g) || []).length;
  const close = (xml.match(/<\/D:response>/g) || []).length;
  assert.equal(open, close);
});

test('parseRange handles normal, open-ended, suffix and invalid ranges', () => {
  assert.deepEqual(parseRange('bytes=0-4', 11), { start: 0, end: 4 });
  assert.deepEqual(parseRange('bytes=6-', 11), { start: 6, end: 10 });
  assert.deepEqual(parseRange('bytes=-5', 11), { start: 6, end: 10 });
  assert.deepEqual(parseRange('bytes=0-999', 11), { start: 0, end: 10 }); // clamped
  assert.equal(parseRange('bytes=20-30', 11), null); // beyond size
  assert.equal(parseRange('bytes=abc', 11), null);
  assert.equal(parseRange('items=0-1', 11), null);
  assert.equal(parseRange(null, 11), null);
  assert.deepEqual(parseRange('bytes=0-', 0), null); // empty file
});

test('destinationPath parses absolute URLs, paths and strips the mount prefix', () => {
  assert.equal(destinationPath('http://127.0.0.1:9798/docs/', ''), '/docs');
  assert.equal(destinationPath('/docs/a.txt', ''), '/docs/a.txt');
  assert.equal(destinationPath('http://127.0.0.1:9798/dav/docs/', '/dav'), '/docs');
  assert.equal(destinationPath('/dav/docs/', '/dav'), '/docs');
  assert.equal(destinationPath(null, ''), null);
});
