'use strict';
/* One-off packaging verification (run manually, not part of the test suite). */
const path = require('node:path');
const asar = require('@electron/asar');

const asarPath = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
// listPackage flattens with the host separator; normalise to '/'
const files = asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/').replace(/^\/+/, ''));
console.log('total entries:', files.length);
const must = [
  'app/main.js', 'app/preload.js',
  'app/renderer/index.html', 'app/renderer/app.js', 'app/renderer/styles.css',
  'core/index.js', 'core/quark/auth.js', 'core/quark/api.js', 'core/quark/upload.js',
  'core/webdav/server.js', 'core/webdav/quark-fs.js', 'core/mount/rclone.js',
  'core/config.js', 'core/device.js', 'package.json',
];
let missing = 0;
for (const m of must) {
  const ok = files.includes(m);
  if (!ok) missing++;
  console.log((ok ? 'OK   ' : 'MISS ') + m);
}
console.log('tests leaked into package:', files.some((f) => f.startsWith('tests/')));
console.log('vendor binaries inside asar (should be false):', files.some((f) => f.startsWith('vendor/')));
console.log('node_modules bundled:', files.filter((f) => f.startsWith('node_modules/')).length, 'entries');
console.log('secrets inside asar (session.json/device.json — should be false):',
  files.some((f) => /session\.json|device\.json/.test(f)));
process.exitCode = missing ? 1 : 0;
