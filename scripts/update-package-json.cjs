const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts = {
  ...pkg.scripts,
  dev: 'node scripts/dev.cjs dev',
  start: 'node scripts/run-electron.cjs .',
  screenshot: 'node scripts/screenshot.cjs',
  'probe:input': 'node scripts/run-electron.cjs scripts/probe-input3.cjs',
  'dist:dir': 'npm run build && electron-builder --win --dir --config electron-builder.yml',
  dist: 'npm run build && electron-builder --win --config electron-builder.yml',
};
delete pkg.scripts['verify:input'];
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(pkg.scripts, null, 2));
