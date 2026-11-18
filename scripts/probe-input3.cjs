/**
 * 输入注入诊断探针 v3：验证「系统级 SendInput 是否生效」+「能否把目标窗口切到前台」。
 * 关键手段：
 *  - CapsLock 状态翻转探针（不依赖窗口焦点，直接判断事件是否进入系统输入队列）
 *  - AttachThreadInput + SetForegroundWindow 强制切换前台
 *  - 前台切换成功后再用真实 SendInput 验证窗口接收
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const koffi = require('koffi');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#0b1220;color:#e8eefc;font-family:Consolas,monospace;padding:20px}
#box{border:1px dashed #475569;border-radius:8px;padding:12px;min-height:80px;white-space:pre-wrap}
</style></head><body>
<h3>probe v3</h3><p>focus: <span id="f">-</span> | events: <span id="c">0</span></p>
<div id="box" tabindex="0">（点击以获取焦点）</div>
<script>
window.__events=[];
const box=document.getElementById('box');
const add=(kind,detail)=>{const e={kind,detail,t:Math.round(performance.now())};window.__events.push(e);
 const d=document.createElement('div');d.textContent=JSON.stringify(e);box.appendChild(d);
 document.getElementById('c').textContent=window.__events.length;};
addEventListener('keydown',e=>add('keydown',(e.code||'')+':'+e.key));
addEventListener('keyup',e=>add('keyup',(e.code||'')+':'+e.key));
addEventListener('mousedown',e=>{add('mousedown','b'+e.button);e.preventDefault();});
addEventListener('mouseup',e=>{add('mouseup','b'+e.button);e.preventDefault();});
addEventListener('focus',()=>document.getElementById('f').textContent='focused');
addEventListener('blur',()=>document.getElementById('f').textContent='blurred');
box.focus();
</script></body></html>`;

function loadWin32() {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const winmm = koffi.load('winmm.dll');
  const shell32 = koffi.load('shell32.dll');

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });

  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
  const GetKeyState = user32.func('int16 __stdcall GetKeyState(int nVirtKey)');
  const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const FindWindowW = user32.func('void * __stdcall FindWindowW(str16 cls, str16 title)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *h)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(void *h, int cmd)');
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *h)');
  const SetActiveWindow = user32.func('void * __stdcall SetActiveWindow(void *h)');
  const SetFocus = user32.func('void * __stdcall SetFocus(void *h)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, uint32 *pid)');
  const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
  const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)');
  const timeBeginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 p)');
  const timeEndPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 p)');
  const IsUserAnAdmin = shell32.func('bool __stdcall IsUserAnAdmin()');

  const keyInput = (vk, scan, flags) => ({ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const mouseInput = (flags) => ({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });

  return {
    SendInput, GetKeyState, GetAsyncKeyState, GetForegroundWindow, FindWindowW, SetForegroundWindow, ShowWindow,
    BringWindowToTop, SetActiveWindow, SetFocus, GetWindowThreadProcessId, AttachThreadInput, GetCurrentThreadId,
    IsWindowVisible, timeBeginPeriod, timeEndPeriod, IsUserAnAdmin, keyInput, mouseInput, sizeofInput: koffi.sizeof(INPUT),
  };
}

async function main() {
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const report = { timestamp: new Date().toISOString(), steps: [] };

  const win = new BrowserWindow({
    width: 980, height: 620, show: true, alwaysOnTop: true, title: 'probe v3',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  win.show();
  win.focus();
  await sleep(400);

  const w = loadWin32();
  w.timeBeginPeriod(1);
  const log = (name, data) => {
    report.steps.push({ name, ...data });
    console.log('[v3]', name, JSON.stringify(data));
  };

  log('env', {
    sizeofInput: w.sizeofInput,
    elevated: w.IsUserAnAdmin(),
    capsState: w.GetKeyState(0x14) & 1,
    capsAsync: w.GetAsyncKeyState(0x14) & 1,
  });

  // ---------- 1. CapsLock 系统级注入探针 ----------
  const capsBefore = w.GetKeyState(0x14) & 1;
  const sendRet = w.SendInput(2, [w.keyInput(0x14, 0, 0), w.keyInput(0x14, 0, 2)], w.sizeofInput);
  await sleep(200);
  const capsAfter = w.GetKeyState(0x14) & 1;
  log('capslock-probe', {
    capsBefore,
    capsAfter,
    sendInputReturn: sendRet,
    toggled: capsBefore !== capsAfter,
    note: capsBefore !== capsAfter ? 'SendInput 已进入系统输入队列（系统级注入可用）' : 'SendInput 未改变系统状态（可能被环境阻断）',
  });
  // 恢复原状态
  if (capsAfter !== capsBefore) {
    w.SendInput(2, [w.keyInput(0x14, 0, 0), w.keyInput(0x14, 0, 2)], w.sizeofInput);
    await sleep(150);
    log('capslock-restore', { capsNow: w.GetKeyState(0x14) & 1 });
  }

  // ---------- 2. 前台窗口现状 ----------
  const ourHwnd = w.FindWindowW(null, 'probe v3');
  const fgBefore = w.GetForegroundWindow();
  log('window-handles', {
    ourHwnd: String(ourHwnd),
    foreground: String(fgBefore),
    sameWindow: String(ourHwnd) === String(fgBefore),
    ourVisible: w.IsWindowVisible(ourHwnd),
  });

  // ---------- 3. AttachThreadInput 强制前台 ----------
  const pidBuf = Buffer.alloc(4);
  const fgThread = w.GetWindowThreadProcessId(fgBefore, pidBuf);
  const ourThread = w.GetCurrentThreadId();
  const attached = w.AttachThreadInput(ourThread, fgThread, true);
  const showRet = w.ShowWindow(ourHwnd, 5);
  const topRet = w.BringWindowToTop(ourHwnd);
  const activeRet = w.SetActiveWindow(ourHwnd);
  const setFgRet = w.SetForegroundWindow(ourHwnd);
  const focusRet = w.SetFocus(ourHwnd);
  w.AttachThreadInput(ourThread, fgThread, false);
  await sleep(400);
  const fgAfter = w.GetForegroundWindow();
  log('force-foreground', {
    attached, showRet, topRet, activeSame: String(activeRet) === String(ourHwnd), setFgRet,
    focusSame: String(focusRet) === String(ourHwnd), foregroundAfter: String(fgAfter),
    success: String(fgAfter) === String(ourHwnd),
  });

  // ---------- 4. 若已前台，验证窗口接收 ----------
  const before = await win.webContents.executeJavaScript('window.__events.length');
  w.SendInput(2, [w.keyInput(0x5a, 0x2c, 8), w.keyInput(0x5a, 0x2c, 8 | 2)], w.sizeofInput);
  w.SendInput(2, [w.mouseInput(0x20), w.mouseInput(0x40)], w.sizeofInput);
  await sleep(300);
  const received = await win.webContents.executeJavaScript(`window.__events.slice(${before})`);
  const fgFinal = w.GetForegroundWindow();
  log('window-injection', {
    foreground: String(fgFinal),
    foregroundIsOurs: String(fgFinal) === String(ourHwnd),
    receivedCount: received.length,
    received,
  });

  w.timeEndPeriod(1);
  const shot = path.join(artifactsDir, 'probe-input-v3.png');
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  report.screenshot = shot;
  fs.writeFileSync(path.join(artifactsDir, 'probe-input-v3.json'), JSON.stringify(report, null, 2));
  console.log('[v3] report written');
  win.destroy();
  app.quit();
}

// 硬超时，避免挂死
setTimeout(() => { console.error('[v3] TIMEOUT'); app.exit(2); }, 30000);

app.whenReady().then(main).catch((e) => { console.error('[v3] FATAL', e); app.exit(1); });
