/**
 * 以 Electron 启动任意脚本/应用目录（自动清理 ELECTRON_RUN_AS_NODE）。
 * 用法：node scripts/run-electron.cjs <目标> [参数...]
 * 目标为 "." 时启动正式应用；也可以指向 scripts/probe-input3.cjs 这类探针脚本。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electronPath = require(path.join(root, 'node_modules', 'electron'));
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node scripts/run-electron.cjs <目标> [参数...]');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  cwd: root,
  env,
  windowsHide: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
