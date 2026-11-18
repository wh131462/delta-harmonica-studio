/** 绾?Node 鐜涓嬬殑 koffi Win32 API 绛惧悕蹇€熼獙璇侊紙涓嶅惎鍔?Electron锛?*/
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hWnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
const WNDENUMPROC = koffi.proto('int __stdcall WNDENUMPROC(void *, intptr_t)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, void *pid)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hWnd, int cmd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hWnd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
const IsUserAnAdmin = shell32.func('bool __stdcall IsUserAnAdmin()');

const readTitle = (hwnd) => {
  const len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = Buffer.alloc((len + 1) * 2);
  const copied = GetWindowTextW(hwnd, buf, len + 1);
  return buf.subarray(0, copied * 2).toString('utf16le');
};

console.log('=== basic ===');
console.log('isAdmin:', IsUserAnAdmin());
const fg = GetForegroundWindow();
console.log('foreground:', String(fg), 'title:', JSON.stringify(readTitle(fg)));
console.log('fg thread id (2nd arg null):', GetWindowThreadProcessId(fg, null));
console.log('our thread id:', GetCurrentThreadId());

console.log('=== enum windows (top 15 visible titled) ===');
let count = 0;
const cb = koffi.register((hwnd, _lParam) => {
  if (!IsWindowVisible(hwnd)) return 1;
  const title = readTitle(hwnd);
  if (!title) return 1;
  count += 1;
  if (count <= 15) console.log('win', String(hwnd), '| thread', GetWindowThreadProcessId(hwnd, null), '|', JSON.stringify(title));
  return 1;
}, koffi.pointer(WNDENUMPROC));
const enumResult = EnumWindows(cb, 0n);
koffi.unregister(cb);
console.log('EnumWindows returned:', enumResult, 'visible titled windows:', count);

console.log('=== focus probe: try attaching current thread to foreground thread ===');
const ourThread = GetCurrentThreadId();
const fgThread = GetWindowThreadProcessId(fg, null);
console.log('attach:', AttachThreadInput(ourThread, fgThread, true), 'detach:', AttachThreadInput(ourThread, fgThread, false));
console.log('ShowWindow fg:', ShowWindow(fg, 9));
console.log('done');

