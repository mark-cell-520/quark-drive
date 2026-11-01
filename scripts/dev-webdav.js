'use strict';
/**
 * scripts/dev-webdav.js — run the WebDAV server with the fake Quark backend
 * for manual diagnostics (rclone ls/mount experiments).
 * Usage: node scripts/dev-webdav.js [port]
 */
const { createWebDavServer } = require('../core/webdav/server.js');
const { QuarkFs } = require('../core/webdav/quark-fs.js');
const { FakeQuark, FakeUploader, FakeDownloadHttp } = require('../tests/helpers/fake-quark.js');

(async () => {
  const port = Number(process.argv[2]) || 9798;
  const quark = new FakeQuark();
  const qfs = new QuarkFs({
    api: quark,
    uploader: new FakeUploader(quark),
    http: new FakeDownloadHttp(quark),
  });
  const server = createWebDavServer({
    fs: qfs, host: '127.0.0.1', port,
    logger: {
      debug: (...a) => console.log(new Date().toISOString(), 'DEBUG', ...a),
      warn: (...a) => console.log(new Date().toISOString(), 'WARN', ...a),
      error: (...a) => console.log(new Date().toISOString(), 'ERROR', ...a),
    },
  });
  await server.listenAsync(port);
  console.log('dev webdav listening on http://127.0.0.1:' + port);
})().catch((e) => { console.error(e); process.exit(1); });
