'use strict';
/**
 * xml.test.js — XML escaping/hrefs, Range and Destination parsing.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  escapeXml, encodeHref, mimeTypeOf, multistatus, parseRange, destinationPath,
  rfc1123, iso8601,
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

test('A-8: an empty file rejects every range (no upstream 416)', () => {
  // size 0 must behave like "beyond size", not like "unknown size"
  assert.equal(parseRange('bytes=0-0', 0), null);
  assert.equal(parseRange('bytes=0-99', 0), null);
  assert.equal(parseRange('bytes=5-', 0), null);
  // unknown size (null) keeps the old permissive behaviour
  assert.deepEqual(parseRange('bytes=0-4', null), { start: 0, end: 4 });
});

test('destinationPath parses absolute URLs, paths and strips the mount prefix', () => {
  assert.equal(destinationPath('http://127.0.0.1:9798/docs/', ''), '/docs');
  assert.equal(destinationPath('/docs/a.txt', ''), '/docs/a.txt');
  assert.equal(destinationPath('http://127.0.0.1:9798/dav/docs/', '/dav'), '/docs');
  assert.equal(destinationPath('/dav/docs/', '/dav'), '/docs');
  assert.equal(destinationPath(null, ''), null);
});

test('A-9: destinationPath strips the prefix per segment, not per string', () => {
  // '/dav' must not eat into '/david/x'
  assert.equal(destinationPath('/david/x.txt', '/dav'), '/david/x.txt');
  assert.equal(destinationPath('/dav', '/dav'), '/');
  assert.equal(destinationPath('http://localhost:9798/dav/a', '/dav'), '/a');
});

test('A-9: a Destination on a foreign host is rejected (RFC 4918)', () => {
  assert.equal(destinationPath('http://evil.example.com/token/x', '/token'), null);
  assert.equal(destinationPath('http://127.0.0.1.evil.com/token/x', '/token'), null);
  // loopback forms are accepted
  assert.equal(destinationPath('http://127.0.0.1:9798/token/x', '/token'), '/x');
  assert.equal(destinationPath('http://localhost/token/x', '/token'), '/x');
});

test('rfc1123/iso8601 fast formatters are byte-identical to the native methods', () => {
  // The lookup-table formatters must never drift from Date#toUTCString /
  // Date#toISOString — WebDAV clients parse these literally.
  const stamps = [
    0, 1, 999, 1000, 1700000000123, 1699999000000,
    Date.UTC(1999, 11, 31, 23, 59, 59), Date.UTC(2024, 1, 29, 12, 0, 0),
    Date.UTC(2100, 0, 1), Date.UTC(1970, 0, 1), Date.UTC(2038, 0, 19, 3, 14, 7),
    -1000, -8640000000000000, 8640000000000000, 951782400000, // 2000-02-29
  ];
  for (const ms of stamps) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) continue;
    assert.equal(rfc1123(d), d.toUTCString(), 'rfc1123 ms=' + ms);
    assert.equal(iso8601(d), d.toISOString(), 'iso8601 ms=' + ms);
  }
  // millisecond padding is exercised too
  for (let i = 0; i < 200; i++) {
    const d = new Date(1700000000000 + i * 37);
    assert.equal(rfc1123(d), d.toUTCString());
    assert.equal(iso8601(d), d.toISOString());
  }
  // invalid input must not throw (toISOString would)
  assert.doesNotThrow(() => iso8601(new Date(NaN)));
  assert.doesNotThrow(() => rfc1123(new Date(NaN)));
});

test('rfc1123 formats negative years with a sign (regression: "0-323")', () => {
  // toUTCString renders negative years as "-0323"/"-0001"; padStart alone
  // produced "0-323" — an unparseable HTTP date.
  for (const ms of [-72341856000000, -62198755200000]) {
    const d = new Date(ms);
    assert.ok(d.getUTCFullYear() < 0, 'fixture must be a negative year, got ' + d.getUTCFullYear());
    assert.equal(rfc1123(d), d.toUTCString(), 'ms=' + ms);
    assert.match(rfc1123(d), /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} -\d{4} \d{2}:\d{2}:\d{2} GMT$/);
  }
});
