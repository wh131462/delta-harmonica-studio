/**
 * 页面截图工具（用于文档/验收）：
 *   node scripts/screenshot.cjs [page] [输出文件]
 * page: play | editor | import | library | settings
 * 需要先 `npm run build`。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electronPath = require(path.join(root, 'node_modules', 'electron'));
const page = process.argv[2] || 'play';
const output = path.resolve(root, process.argv[3] || path.join('artifacts', `ui-${page}.png`));
fs.mkdirSync(path.dirname(output), { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DFH_START_PAGE = page;
env.DFH_SCREENSHOT_PATH = output;
env.DFH_SCREENSHOT_DELAY = process.env.DFH_SCREENSHOT_DELAY || '3000';
if (process.env.DFH_AUTOTEST === '1') env.DFH_AUTOTEST = '1';

console.log(`[screenshot] page=${page} -> ${output}`);
const child = spawn(electronPath, ['.'], { stdio: 'inherit', cwd: root, env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
