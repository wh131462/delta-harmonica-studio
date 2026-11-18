/**
 * 椤甸潰鎴浘宸ュ叿锛堢敤浜庢枃妗?楠屾敹锛夛細
 *   node scripts/screenshot.cjs [page] [杈撳嚭鏂囦欢]
 * page: play | practice | editor | import | library | settings
 * 闇€瑕佸厛 `npm run build`銆? */
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
env.DFH_SCREENSHOT_USER_DATA =
  process.env.DFH_SCREENSHOT_USER_DATA || path.join(root, 'artifacts', 'screenshot-user-data');
env.DFH_SCREENSHOT_DELAY = process.env.DFH_SCREENSHOT_DELAY || '3000';
// 隔离的用户目录首次运行会弹风险提示；截图前直接标记为已确认，保证截到被测页面
const userDataDir = env.DFH_SCREENSHOT_USER_DATA;
if (process.env.DFH_SCREENSHOT_RESET === '1') fs.rmSync(userDataDir, { recursive: true, force: true });
const settingsFile = path.join(userDataDir, 'settings.json');
if (process.env.DFH_SCREENSHOT_KEEP_DISCLAIMER !== '1' && !fs.existsSync(settingsFile)) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ disclaimerAccepted: true }, null, 2), 'utf8');
}
if (process.env.DFH_AUTOTEST === '1') env.DFH_AUTOTEST = '1';

console.log(`[screenshot] page=${page} -> ${output}`);
const child = spawn(electronPath, ['.'], { stdio: 'inherit', cwd: root, env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));

