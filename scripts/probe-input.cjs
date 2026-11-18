/**
 * 输入注入链路探针（开发自检用）：
 *   node_modules/.bin/electron scripts/probe-input.cjs
 *
 * 步骤：
 *  1. 打开一个监听 keydown/keyup/mousedown/mouseup 的测试窗口；
 *  2. 通过 koffi 调用 Win32 SendInput 注入音符键（扫描码）与鼠标修饰键；
 *  3. 回读窗口内记录到的事件，验证注入链路是否真正生效；
 *  4. 截图 artifacts/probe-input.png。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWin32() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const winmm = koffi.load('winmm.dll');

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32',
    wParamL: 'uint16',
    wParamH: 'uint16',
  });
  const INPUT_UNION = koffi.union('INPUT_UNION', {
    mi: MOUSEINPUT,
    ki: KEYBDINPUT,
    hi: HARDWAREINPUT,
  });
  const INPUT = koffi.struct('INPUT', {
    type: 'uint32',
    u: INPUT_UNION,
  });

  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)');
  const timeBeginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 uPeriod)');
  const timeEndPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 uPeriod)');

  const key = (scan, down) => ({
    type: 1,
    u: { ki: { wVk: 0, wScan: scan, dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | KEYEVENTF_SCANCODE, time: 0, dwExtraInfo: 0 } },
  });
  const mouse = (flag) => ({
    type: 0,
    u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flag, time: 0, dwExtraInfo: 0 } },
  });

  return {
    koffi,
    INPUT,
    SendInput,
    GetForegroundWindow,
    GetWindowTextW,
    timeBeginPeriod,
    timeEndPeriod,
    sizeofInput: koffi.sizeof(INPUT),
    eventBuilders: { key, mouse },
  };
}

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  body { background:#10151f; color:#e8eefc; font-family:Consolas, 'Microsoft YaHei', monospace; padding:24px; }
  h2 { color:#6ee7b7; }
  #box { border:1px dashed #475569; border-radius:8px; padding:16px; min-height:120px; background:#0b1220; }
  .ev { padding:2px 0; }
  .k { color:#93c5fd; } .m { color:#fca5a5; }
</style></head>
<body>
  <h2>Delta Harmonica Studio · 输入注入探针</h2>
  <p>焦点：<span id="focus">-</span> / 计数：<span id="count">0</span></p>
  <div id="box" tabindex="0">等待注入事件…（点击此处获取焦点）</div>
  <script>
    window.__events = [];
    const box = document.getElementById('box');
    const countEl = document.getElementById('count');
    const focusEl = document.getElementById('focus');
    const record = (kind, detail) => {
      const ev = { kind, detail, t: Math.round(performance.now() * 10) / 10 };
      window.__events.push(ev);
      const line = document.createElement('div');
      line.className = 'ev ' + (kind.startsWith('key') ? 'k' : 'm');
      line.textContent = ev.t + 'ms  ' + kind + '  ' + detail;
      box.appendChild(line);
      countEl.textContent = String(window.__events.length);
    };
    window.addEventListener('keydown', (e) => record('keydown', (e.code || '') + ' key=' + e.key + ' which=' + e.which));
    window.addEventListener('keyup', (e) => record('keyup', (e.code || '') + ' key=' + e.key + ' which=' + e.which));
    window.addEventListener('mousedown', (e) => { record('mousedown', 'button=' + e.button); e.preventDefault(); });
    window.addEventListener('mouseup', (e) => { record('mouseup', 'button=' + e.button); e.preventDefault(); });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('DOMContentLoaded', () => box.focus());
    box.focus();
    const updateFocus = () => { focusEl.textContent = document.hasFocus() ? 'window focused' : 'window blurred'; };
    window.addEventListener('focus', updateFocus);
    window.addEventListener('blur', updateFocus);
    updateFocus();
  </script>
</body></html>`;

async function main() {
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const win = new BrowserWindow({
    width: 900,
    height: 560,
    show: true,
    title: 'DHStudio Input Probe',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TEST_PAGE));
  win.show();
  win.focus();
  await sleep(600);

  const win32 = buildWin32();
  win32.timeBeginPeriod(1);
  const events = win32.eventBuilders;

  console.log('[probe] koffi loaded, sizeof(INPUT) =', win32.sizeofInput);

  // 发送：中键按下 → Z 按下 → Z 松开 → X 按下 → X 松开 → 中键松开
  const send = (list) => {
    const result = win32.SendInput(list.length, list, win32.sizeofInput);
    if (!result) {
      const err = require('koffi').errno();
      throw new Error('SendInput failed: ' + (err && err.message));
    }
    return result;
  };

  const t0 = Date.now();
  send([events.mouse(MOUSEEVENTF_MIDDLEDOWN)]);
  await sleep(30);
  send([events.key(0x2c, true)]); // Z
  await sleep(120);
  send([events.key(0x2c, false)]);
  await sleep(40);
  send([events.mouse(MOUSEEVENTF_MIDDLEUP)]);
  await sleep(30);
  send([events.key(0x58, true)]); // X
  await sleep(100);
  send([events.key(0x58, false)]);
  await sleep(60);
  // 逗号键
  send([events.key(0x33, true)]);
  await sleep(100);
  send([events.key(0x33, false)]);
  await sleep(120);
  // 鼠标中键 + 逗号组合（验证同时按住的顺序）
  send([events.mouse(MOUSEEVENTF_MIDDLEDOWN)]);
  await sleep(30);
  send([events.key(0x33, true)]);
  await sleep(100);
  send([events.key(0x33, false)]);
  await sleep(20);
  send([events.mouse(MOUSEEVENTF_MIDDLEUP)]);
  await sleep(300);

  const recorded = await win.webContents.executeJavaScript('window.__events');
  const active = await win.webContents.executeJavaScript('({ focused: document.hasFocus(), title: document.title })');
  win32.timeEndPeriod(1);

  const screenshotPath = path.join(artifactsDir, 'probe-input.png');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(screenshotPath, image.toPNG());

  const report = {
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    sizeofInput: win32.sizeofInput,
    windowFocused: active.focused,
    recordedCount: recorded.length,
    recorded,
    expected: [
      'mousedown button=1',
      'keydown Z',
      'keyup Z',
      'mouseup button=1',
      'keydown X',
      'keyup X',
      'keydown ,',
      'keyup ,',
      'mousedown button=1',
      'keydown ,',
      'keyup ,',
      'mouseup button=1',
    ],
    screenshotPath,
  };
  fs.writeFileSync(path.join(artifactsDir, 'probe-input.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const ok = recorded.length >= 10;
  console.log(ok ? '[probe] RESULT: PASS (注入事件已送达窗口)' : '[probe] RESULT: FAIL (窗口没有收到注入事件)');
  await sleep(300);
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error('[probe] FATAL', error);
  app.exit(1);
});
