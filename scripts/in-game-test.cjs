/**
 * 游戏内实机分级测试脚本（需要游戏已启动、且用户明确同意后再运行）。
 *
 * 用法：
 *   node scripts/in-game-test.cjs detect                 # 零风险：只检测窗口/进程/前台，不注入
 *   node scripts/in-game-test.cjs keys   --allow-inject  # 低风险：向游戏发送 Z X C V B N M ,（约 1.7s）
 *   node scripts/in-game-test.cjs notes  --allow-inject  # 口琴界面：发送 1 2 3（Z X C，约 0.6s）
 *   node scripts/in-game-test.cjs octave --allow-inject --allow-mouse  # 口琴界面：右键+Z/C（高八度）
 *   node scripts/in-game-test.cjs semitone --allow-inject --allow-mouse # 口琴界面：中键+Z（升半音）
 *
 * 安全设计：
 *   - 除 detect 外必须显式 --allow-inject；
 *   - 必须检测到游戏窗口且游戏在前台，否则拒绝发送；
 *   - 发送前 2 秒倒计时；任何异常/退出都会释放所有按下的键；
 *   - 鼠标左/右键默认禁止（--allow-mouse 才允许，且只用于口琴修饰键测试，不点击界面）；
 *   - 单次测试不超过 ~2 秒，结束后立即输出时间轴日志。
 */
const koffi = require('koffi');

const mode = process.argv[2] || 'detect';
const flags = new Set(process.argv.slice(3));
const ALLOW_INJECT = flags.has('--allow-inject');
const ALLOW_MOUSE = flags.has('--allow-mouse');

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;

const koffiUser32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');
const path = require('node:path');

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
const WNDENUMPROC = koffi.proto('int __stdcall WNDENUMPROC(void *, intptr_t)');

const SendInput = koffiUser32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
const GetForegroundWindow = koffiUser32.func('void * __stdcall GetForegroundWindow()');
const FindWindowW = koffiUser32.func('void * __stdcall FindWindowW(str16 cls, str16 title)');
const SetForegroundWindow = koffiUser32.func('bool __stdcall SetForegroundWindow(void *h)');
const ShowWindow = koffiUser32.func('bool __stdcall ShowWindow(void *h, int cmd)');
const BringWindowToTop = koffiUser32.func('bool __stdcall BringWindowToTop(void *h)');
const SetActiveWindow = koffiUser32.func('void * __stdcall SetActiveWindow(void *h)');
const SetFocus = koffiUser32.func('void * __stdcall SetFocus(void *h)');
const GetWindowTextW = koffiUser32.func('int __stdcall GetWindowTextW(void *h, void *buf, int max)');
const GetWindowTextLengthW = koffiUser32.func('int __stdcall GetWindowTextLengthW(void *h)');
const IsWindowVisible = koffiUser32.func('bool __stdcall IsWindowVisible(void *h)');
const EnumWindows = koffiUser32.func('bool __stdcall EnumWindows(WNDENUMPROC *cb, intptr_t lp)');
const GetWindowThreadProcessId = koffiUser32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const AttachThreadInput = koffiUser32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
koffi.struct('POINT_T', { x: 'int32', y: 'int32' });
koffi.struct('RECT_T', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GetCursorPos = koffiUser32.func('bool __stdcall GetCursorPos(_Out_ POINT_T *p)');
const SetCursorPos = koffiUser32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetWindowRect = koffiUser32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT_T *r)');
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ char16_t *buf, _Inout_ uint32 *size)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
const IsUserAnAdmin = shell32.func('bool __stdcall IsUserAnAdmin()');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readTitle = (hwnd) => {
  const len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = Buffer.alloc((len + 1) * 2);
  const copied = GetWindowTextW(hwnd, buf, len + 1);
  return buf.subarray(0, copied * 2).toString('utf16le');
};
const processName = (pid) => {
  if (!pid) return '';
  let h = null;
  try {
    h = OpenProcess(0x1000, false, pid);
    if (!h) return '';
    const buf = Buffer.alloc(2048);
    const size = [1024];
    if (!QueryFullProcessImageNameW(h, 0, buf, size) || !size[0]) return '';
    return path.win32.basename(buf.subarray(0, size[0] * 2).toString('utf16le'));
  } finally {
    if (h) CloseHandle(h);
  }
};
const GAME_PROCESS = /deltaforce|delta[\s_-]?force/i;
const GAME_TITLE = /^(三角洲行动|Delta\s*Force)/i;
/** 明显不是游戏的进程/标题（防止把 DSH、浏览器等误判为游戏窗口） */
const NON_GAME_EXE = /chrome|msedge|firefox|wechat|weixin|qq\.exe|deepseek|harness|electron|explorer|notepad/i;
const NON_GAME_TITLE = /chrome|edge|firefox|浏览器|deepseek|harness|bilibili|哔哩|文档|wiki|攻略|nga|微信|weixin|qq|口琴工坊/i;

function findGameWindows() {
  const results = [];
  const cb = koffi.register((hwnd) => {
    try {
      if (!hwnd || !IsWindowVisible(hwnd)) return 1;
      const title = readTitle(hwnd);
      if (!title) return 1;
      const pidArr = [null];
      GetWindowThreadProcessId(hwnd, pidArr);
      const exe = processName(Number(pidArr[0] ?? 0));
      const looksLikeGame =
        GAME_PROCESS.test(exe) ||
        (GAME_TITLE.test(title) &&
          !NON_GAME_EXE.test(exe) &&
          !NON_GAME_TITLE.test(title.toLowerCase()) &&
          !NON_GAME_TITLE.test(exe.toLowerCase()));
      if (looksLikeGame) results.push({ hwnd, handle: String(hwnd), title, pid: pidArr[0], exe });
      return 1;
    } catch {
      return 1;
    }
  }, koffi.pointer(WNDENUMPROC));
  try {
    EnumWindows(cb, 0n);
  } finally {
    koffi.unregister(cb);
  }
  return results;
}

let pressedKey = null;
let pressedMouse = new Set();

function keyInput(down, scan) {
  return { type: 1, u: { ki: { wVk: 0, wScan: scan, dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | KEYEVENTF_SCANCODE, time: 0, dwExtraInfo: 0 } } };
}
function mouseInput(down, button) {
  const map = {
    left: down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP,
    right: down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP,
    middle: down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP,
  };
  return { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: map[button], time: 0, dwExtraInfo: 0 } } };
}
function send(list) {
  const n = SendInput(list.length, list, koffi.sizeof(INPUT));
  if (!n) throw new Error('SendInput 返回 0');
  return n;
}
async function keyTap(scan, holdMs = 90, gapMs = 110) {
  send([keyInput(true, scan)]);
  pressedKey = scan;
  await sleep(holdMs);
  send([keyInput(false, scan)]);
  pressedKey = null;
  await sleep(gapMs);
}
async function mouseHold(button, down) {
  send([mouseInput(down, button)]);
  if (down) pressedMouse.add(button); else pressedMouse.delete(button);
}
function releaseAll() {
  try {
    if (pressedKey !== null) send([keyInput(false, pressedKey)]);
    const list = [];
    for (const b of pressedMouse) list.push(mouseInput(false, b));
    if (list.length) send(list);
  } catch {
    /* 忽略退出时错误 */
  }
  pressedKey = null;
  pressedMouse.clear();
}

function focusGame(targetPtr) {
  ShowWindow(targetPtr, 9);
  const fg = GetForegroundWindow();
  const fgThread = fg ? GetWindowThreadProcessId(fg, null) : 0;
  const selfThread = GetCurrentThreadId();
  let attached = false;
  if (fgThread && fgThread !== selfThread) attached = AttachThreadInput(selfThread, fgThread, true);
  try {
    BringWindowToTop(targetPtr);
    const ok = SetForegroundWindow(targetPtr);
    SetActiveWindow(targetPtr);
    SetFocus(targetPtr);
    return ok;
  } finally {
    if (attached) AttachThreadInput(selfThread, fgThread, false);
  }
}

/** 鼠标事件会投递到光标下的窗口：确保光标在游戏窗口内（不在则移动到窗口中心） */
function ensureCursorInside(targetPtr) {
  try {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetWindowRect(targetPtr, rect) || rect.right <= rect.left) return false;
    const cursor = { x: 0, y: 0 };
    if (!GetCursorPos(cursor)) return false;
    const inside = cursor.x >= rect.left && cursor.x < rect.right && cursor.y >= rect.top && cursor.y < rect.bottom;
    if (inside) {
      log('光标已在游戏窗口内：', cursor);
      return true;
    }
    const cx = Math.round((rect.left + rect.right) / 2);
    const cy = Math.round((rect.top + rect.bottom) / 2);
    SetCursorPos(cx, cy);
    const after = { x: 0, y: 0 };
    GetCursorPos(after);
    log('光标已移动到游戏窗口中心：', after);
    return true;
  } catch {
    return false;
  }
}

const SCAN = { Z: 0x2c, X: 0x2d, C: 0x2e, V: 0x2f, B: 0x30, N: 0x31, M: 0x32, COMMA: 0x33 };
const t0 = Date.now();
const log = (...args) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms]`, ...args);

async function main() {
  log('isAdmin =', IsUserAnAdmin());
  const games = findGameWindows();
  log('检测到疑似游戏窗口：', games.length);
  for (const g of games) log('  ', g.exTitle ?? g.title, '| exe=', g.exe, '| pid=', g.pid, '| hwnd=', g.handle);
  const fg = GetForegroundWindow();
  log('当前前台 hwnd =', String(fg), '| title =', readTitle(fg));
  const game = games[0];
  if (!game) {
    log('未找到游戏窗口：请先启动游戏并进入大厅/对局，然后再运行本脚本。');
    return;
  }
  if (mode === 'detect') {
    log('detect 完成：未发送任何按键。');
    return;
  }
  if (!ALLOW_INJECT) {
    log('拒绝执行：注入模式必须显式加 --allow-inject（请先确认你同意向游戏发送模拟按键）。');
    return;
  }
  if (
    mode !== 'keys' &&
    mode !== 'notes' &&
    mode !== 'octave' &&
    mode !== 'lowoctave' &&
    mode !== 'combo' &&
    mode !== 'semitone' &&
    mode !== 'phrase'
  ) {
    log('未知模式：', mode);
    return;
  }
  log('目标测试模式：', mode, ALLOW_MOUSE ? '(允许鼠标按键)' : '(不发送鼠标左右键)');
  // 统一用 FindWindowW 返回的同一窗口指针做焦点切换与前台校验
  const targetPtr = FindWindowW(null, game.title) ?? game.hwnd;
  log('目标窗口指针 =', String(targetPtr), '| exe =', game.exe, '| title =', game.title);
  log('2 秒后开始注入，请保持游戏窗口在前台…');
  focusGame(targetPtr);
  await sleep(2000);

  const fgNow = GetForegroundWindow();
  if (String(fgNow) !== String(targetPtr)) {
    log('前台校验失败：游戏不在前台，已取消注入（foreground=', String(fgNow), ')。');
    return;
  }
  log('前台校验通过，开始注入');

  const needsMouse = mode === 'semitone' || mode === 'octave' || mode === 'lowoctave' || mode === 'combo';
  if (needsMouse) {
    if (!ALLOW_MOUSE) {
      log('该模式需要鼠标按键，但你未授权 --allow-mouse，已取消。');
      return;
    }
    if (!ensureCursorInside(targetPtr)) {
      log('无法确认光标位于游戏窗口内，已取消鼠标测试（避免鼠标事件发到其他程序）。');
      return;
    }
  }

  if (mode === 'keys') {
    const keys = [['Z', SCAN.Z], ['X', SCAN.X], ['C', SCAN.C], ['V', SCAN.V], ['B', SCAN.B], ['N', SCAN.N], ['M', SCAN.M], [',', SCAN.COMMA]];
    for (const [name, scan] of keys) {
      log('key', name, 'down');
      await keyTap(scan);
    }
  } else if (mode === 'notes') {
    for (const [name, scan] of [['1/Z', SCAN.Z], ['2/X', SCAN.X], ['3/C', SCAN.C]]) {
      log('note', name);
      await keyTap(scan, 180, 120);
    }
  } else if (mode === 'phrase') {
    // 小星星第一句前四音：1 1 5 5（Z Z B B），测试节奏与重复音重触发
    for (const [name, scan, hold, gap] of [
      ['1/Z', SCAN.Z, 260, 90],
      ['1/Z', SCAN.Z, 260, 90],
      ['5/B', SCAN.B, 260, 90],
      ['5/B', SCAN.B, 620, 90],
    ]) {
      log('phrase note', name);
      await keyTap(scan, hold, gap);
    }
  } else if (mode === 'octave') {
    if (!ALLOW_MOUSE) { log('octave 模式需要 --allow-mouse'); return; }
    log('按住右键（高八度）+ Z，再 + C');
    await mouseHold('right', true);
    await keyTap(SCAN.Z, 300, 120);
    await keyTap(SCAN.C, 300, 120);
    await mouseHold('right', false);
  } else if (mode === 'lowoctave') {
    if (!ALLOW_MOUSE) { log('lowoctave 模式需要 --allow-mouse'); return; }
    log('按住左键（低八度）+ Z，再 + C');
    await mouseHold('left', true);
    await keyTap(SCAN.Z, 300, 120);
    await keyTap(SCAN.C, 300, 120);
    await mouseHold('left', false);
  } else if (mode === 'combo') {
    if (!ALLOW_MOUSE) { log('combo 模式需要 --allow-mouse'); return; }
    log('组合测试：右键+中键+Z（期望=高音#1），左键+中键+C（期望=低音#3）');
    await mouseHold('right', true);
    await mouseHold('middle', true);
    await keyTap(SCAN.Z, 340, 180);
    await mouseHold('middle', false);
    await mouseHold('right', false);
    await sleep(220);
    await mouseHold('left', true);
    await mouseHold('middle', true);
    await keyTap(SCAN.C, 340, 180);
    await mouseHold('middle', false);
    await mouseHold('left', false);
  } else if (mode === 'semitone') {
    if (!ALLOW_MOUSE) { log('semitone 模式需要 --allow-mouse'); return; }
    log('按住中键（升半音）+ Z');
    await mouseHold('middle', true);
    await keyTap(SCAN.Z, 220, 120);
    await mouseHold('middle', false);
  }
  await sleep(200);
  releaseAll();
  log('注入完成，已释放所有按键/鼠标。');
}

main()
  .catch((error) => {
    console.error('测试失败：', error);
  })
  .finally(() => {
    releaseAll();
    console.log('=== 测试脚本退出（按键已全部释放）===');
    process.exit(0);
  });
