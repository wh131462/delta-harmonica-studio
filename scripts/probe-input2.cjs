/**
 * 杈撳叆娉ㄥ叆璇婃柇鎺㈤拡 v2锛? * 閫愰」瀵规瘮涓嶅悓娉ㄥ叆鏂瑰紡涓庣劍鐐圭姸鎬侊紝瀹氫綅銆孲endInput 璋冪敤鎴愬姛浣嗙獥鍙ｆ敹涓嶅埌浜嬩欢銆嶇殑鍘熷洜銆? */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#0b1220;color:#e8eefc;font-family:Consolas,monospace;padding:20px}
#box{border:1px dashed #475569;border-radius:8px;padding:12px;min-height:80px}
</style></head><body>
<h3>probe v2</h3><p>focus: <span id="f">-</span> | events: <span id="c">0</span></p>
<div id="box" tabindex="0"></div>
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
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const winmm = koffi.load('winmm.dll');
  const shell32 = koffi.load('shell32.dll');

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16',
  });
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });

  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
  const keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)');
  const mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, int32 dx, int32 dy, uint32 dwData, uintptr_t dwExtraInfo)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
  const FindWindowW = user32.func('void * __stdcall FindWindowW(str lpClassName, str lpWindowName)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, uint32 *pid)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
  const timeBeginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 uPeriod)');
  const timeEndPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 uPeriod)');
  const IsUserAnAdmin = shell32.func('bool __stdcall IsUserAnAdmin()');

  const koffiErr = () => {
    try {
      const info = koffi.errno();
      return info;
    } catch { return null; }
  };

  const buf = Buffer.alloc(512);
  const foregroundInfo = () => {
    const hwnd = GetForegroundWindow();
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(hwnd, pidBuf);
    const len = GetWindowTextW(hwnd, buf, 250);
    return {
      hwnd: String(hwnd),
      title: buf.subarray(0, len * 2).toString('utf16le'),
      pid: pidBuf.readUInt32LE(0),
      visible: IsWindowVisible(hwnd),
    };
  };

  const makeInput = (type, payload) => ({ type, u: payload });
  const keyInput = (vk, scan, flags) => makeInput(1, { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } });
  const mouseInput = (flags, data = 0) => makeInput(0, { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } });

  return {
    koffi, INPUT, SendInput, keybd_event, mouse_event, GetForegroundWindow, GetWindowTextW, SetForegroundWindow, FindWindowW,
    timeBeginPeriod, timeEndPeriod, IsUserAnAdmin, foregroundInfo, keyInput, mouseInput, koffiErr,
    sizeofInput: koffi.sizeof(INPUT),
  };
}

async function main() {
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const win = new BrowserWindow({
    width: 980, height: 620, show: true, alwaysOnTop: true, title: 'probe v2',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  win.show();
  win.focus();
  win.webContents.focus();
  await sleep(400);

  const w = loadWin32();
  w.timeBeginPeriod(1);
  const ourHwnd = w.FindWindowW('', 'probe v2');
  console.log('[v2] our hwnd =', String(ourHwnd));
  console.log('[v2] sizeof(INPUT) =', w.sizeofInput, '| IsUserAnAdmin =', w.IsUserAnAdmin());
  console.log('[v2] foreground BEFORE force =', JSON.stringify(w.foregroundInfo()));
  const forced = w.SetForegroundWindow(ourHwnd);
  await sleep(300);
  console.log('[v2] SetForegroundWindow =', forced, '| foreground AFTER force =', JSON.stringify(w.foregroundInfo()));

  const results = [];
  const attempt = async (name, fn, readWait = 250) => {
    const before = await win.webContents.executeJavaScript('window.__events.length');
    let returned = null;
    let error = null;
    try { returned = fn(); } catch (e) { error = String(e && e.message ? e.message : e); }
    await sleep(readWait);
    const after = await win.webContents.executeJavaScript('window.__events.length');
    const delta = await win.webContents.executeJavaScript(`window.__events.slice(${before})`);
    const rec = { name, returned, error, sent: after - before, events: delta };
    results.push(rec);
    console.log('[v2]', name, '=> returned:', returned, '| error:', error, '| received:', after - before, JSON.stringify(delta.slice(0, 4)));
  };

  // 1. Electron 鑷甫 sendInputEvent锛堝鐓х粍锛氶獙璇佹覆鏌撹繘绋嬩簨浠剁洃鍚甯革級
  await attempt('electron.sendInputEvent keyDown Z', () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z' });
    return 'sent';
  });

  // 2. SendInput 铏氭嫙閿爜
  await attempt('SendInput VK Z', () => {
    const list = [w.keyInput(0x5a, 0, 0), w.keyInput(0x5a, 0, 0x0002)];
    return { ret: w.SendInput(list.length, list, w.sizeofInput), errno: w.koffiErr() };
  });

  // 3. SendInput 鎵弿鐮?  await attempt('SendInput SCAN Z', () => {
    const list = [w.keyInput(0, 0x2c, 0x0008), w.keyInput(0, 0x2c, 0x0008 | 0x0002)];
    return { ret: w.SendInput(list.length, list, w.sizeofInput), errno: w.koffiErr() };
  });

  // 4. keybd_event锛堝鐓э紝鑰?API锛?  await attempt('keybd_event Z', () => {
    w.keybd_event(0x5a, 0, 0, 0);
    w.keybd_event(0x5a, 0, 0x0002, 0);
    return 'sent';
  });

  // 5. mouse_event 涓敭锛堝鐓э紝鑰?API锛?  await attempt('mouse_event MIDDLE', () => {
    w.mouse_event(0x0020, 0, 0, 0, 0);
    w.mouse_event(0x0040, 0, 0, 0, 0);
    return 'sent';
  });

  // 6. SendInput 榧犳爣涓敭
  await attempt('SendInput MOUSE MIDDLE', () => {
    const list = [w.mouseInput(0x0020), w.mouseInput(0x0040)];
    return { ret: w.SendInput(list.length, list, w.sizeofInput), errno: w.koffiErr() };
  });

  // 7. 缁勫悎锛氫腑閿寜浣?+ 閫楀彿閿紙娓告垙閲岀殑鍗婇煶缁勫悎璇箟锛?  await attempt('SendInput MIDDLE+COMMA', () => {
    const list = [
      w.mouseInput(0x0020),
      w.keyInput(0, 0x33, 0x0008),
      w.keyInput(0, 0x33, 0x0008 | 0x0002),
      w.mouseInput(0x0040),
    ];
    return { ret: w.SendInput(list.length, list, w.sizeofInput), errno: w.koffiErr() };
  });

  // 8. 鍗曟璋冪敤 4 涓簨浠?vs 澶氭璋冪敤锛堝畾浣嶆暟缁勫皝閫侀棶棰橈級
  await attempt('SendInput single-call 4 events', () => {
    const list = [w.keyInput(0x58, 0x2d, 0), w.keyInput(0x58, 0x2d, 2)];
    return { ret: w.SendInput(list.length, list, w.sizeofInput), errno: w.koffiErr() };
  });

  // 9. 閫愭潯璋冪敤
  await attempt('SendInput one-by-one X', () => {
    const r1 = w.SendInput(1, [w.keyInput(0x58, 0, 0)], w.sizeofInput);
    const r2 = w.SendInput(1, [w.keyInput(0x58, 0, 2)], w.sizeofInput);
    return { r1, r2, errno: w.koffiErr() };
  });

  // 10. 鍓嶅彴鐘舵€佸啀娆＄‘璁?  await attempt('foreground check', () => w.foregroundInfo());

  w.timeEndPeriod(1);
  const allEvents = await win.webContents.executeJavaScript('window.__events');
  const shot = path.join(artifactsDir, 'probe-input-v2.png');
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  const report = {
    timestamp: new Date().toISOString(),
    ourHwnd: String(ourHwnd),
    sizeofInput: w.sizeofInput,
    elevated: w.IsUserAnAdmin(),
    focusedBeforeForce: results.length ? undefined : undefined,
    results,
    allEvents,
    screenshot: shot,
  };
  fs.writeFileSync(path.join(artifactsDir, 'probe-input-v2.json'), JSON.stringify(report, null, 2));
  console.log('[v2] ALL RECEIVED EVENTS:', JSON.stringify(allEvents));
  console.log('[v2] screenshot:', shot);
  await sleep(200);
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error('[v2] FATAL', e); app.exit(1); });

