/**
 * electron-vite 开发模式包装器：清理 ELECTRON_RUN_AS_NODE（部分 Electron/沙箱环境下会被设置，
 * 导致 electron 二进制退化成 Node 运行，界面无法启动）。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
