/**
 * Windows 原生输入桥（仅 Electron 主进程使用）。
 *
 * 技术要点（已在本机实测验证）：
 * - 用 koffi 动态调用 user32!SendInput；INPUT 结构体（含 union）在 x64 下 sizeof = 40。
 * - 键盘事件用「扫描码 + KEYEVENTF_SCANCODE」发送，避免受键盘布局/输入法影响。
 * - 鼠标修饰键（左/中/右）用 MOUSEEVENTF_* 发送，不移动光标。
 * - 游戏以管理员（High 完整性）运行，本程序必须以管理员运行，否则 SendInput 会被 UIPI 静默丢弃
 *   （函数返回成功但系统无事件，这是实测踩过的坑）。
 * - 把目标窗口切前台需要 AttachThreadInput + SetForegroundWindow + SetFocus 组合。
 */
import type koffiType from 'koffi';
import path from 'node:path';
import type { InputEvent } from '@core/instrument/plan';
import type { MouseButton } from '@core/model/instrument';
import type { WindowInfo } from '@shared/types';

type KoffiModule = typeof koffiType;

let koffiModule: KoffiModule | null = null;

/**
 * koffi 是平台相关的原生模块（FFI）。只在 Windows 上真正加载：
 * macOS / Linux 版没有 Win32 注入能力，也不应该因为原生模块缺失而启动失败。
 */
function loadKoffi(): KoffiModule {
  if (!koffiModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    koffiModule = require('koffi') as KoffiModule;
  }
  return koffiModule;
}

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const MOUSE_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

const SW_RESTORE = 9;

/** 游戏进程名特征（实测：DeltaForceClient-Win64-Shipping.exe） */
const GAME_PROCESS_PATTERN = /deltaforce|delta[_\s-]?force/i;
/** 标题特征：以游戏名开头，避免浏览器标签页/攻略标题误判 */
const GAME_TITLE_PATTERN = /^(三角洲行动|Delta\s*Force)(\s|$|[-–—:：])/i;
/** 明显不是游戏的窗口（浏览器/聊天/文档/本工具）标题关键词 */
const NON_GAME_TITLE_PATTERN = /chrome|edge|firefox|浏览器|deepseek|harness|bilibili|哔哩|文档|wiki|攻略|nga|微信|weixin|qq|口琴工坊/i;
const NON_GAME_PROCESS_PATTERN = /chrome|msedge|firefox|wechat|weixin|qq\.exe|electron|explorer|notepad/i;

type Ptr = bigint | number | null;

type SendInputFn = (count: number, inputs: unknown[], size: number) => number;

interface KeyboardInput {
  type: number;
  u: { ki: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number } };
}

interface MouseInput {
  type: number;
  u: { mi: { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: number } };
}

interface WinApi {
  sendInput: SendInputFn;
  timeBeginPeriod: (period: number) => number;
  timeEndPeriod: (period: number) => number;
  getForegroundWindow: () => Ptr;
  getWindowTextW: (hwnd: Ptr, buffer: Buffer, maxCount: number) => number;
  getWindowTextLengthW: (hwnd: Ptr) => number;
  isWindowVisible: (hwnd: Ptr) => boolean;
  enumWindows: (callbackPtr: bigint, lParam: bigint) => boolean;
  getWindowThreadProcessId: (hwnd: Ptr, pid: unknown) => number;
  attachThreadInput: (attachThread: number, attachTo: number, attach: boolean) => boolean;
  getCurrentThreadId: () => number;
  showWindow: (hwnd: Ptr, cmd: number) => boolean;
  bringWindowToTop: (hwnd: Ptr) => boolean;
  setForegroundWindow: (hwnd: Ptr) => boolean;
  setActiveWindow: (hwnd: Ptr) => Ptr;
  setFocus: (hwnd: Ptr) => Ptr;
  findWindowW: (cls: string | null, title: string | null) => Ptr;
  getCursorPos: (point: { x: number; y: number }) => boolean;
  setCursorPos: (x: number, y: number) => boolean;
  getWindowRect: (hwnd: Ptr, rect: { left: number; top: number; right: number; bottom: number }) => boolean;
  isUserAnAdmin: () => boolean;
  openProcess: (access: number, inherit: boolean, pid: number) => Ptr;
  queryFullProcessImageNameW: (handle: Ptr, flags: number, buffer: Buffer, size: number[]) => boolean;
  closeHandle: (handle: Ptr) => boolean;
}

export interface WindowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function toNumber(value: Ptr): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value);
}

class Win32Bridge {
  available = false;
  error: string | null = null;
  elevated = false;
  private api: WinApi | null = null;
  private inputType: unknown = null;
  private callbackType: unknown = null;
  private sizeOfInput = 0;
  private precisionActive = false;
  /** 枚举到的窗口句柄 → koffi 指针（用于切前台） */
  private pointerCache = new Map<number, Ptr>();

  constructor() {
    this.init();
  }

  private init(): void {
    if (process.platform !== 'win32') {
      this.available = false;
      this.error = '当前平台不是 Windows：Win32 键鼠注入不可用（macOS / Linux 版以排练模式运行）';
      return;
    }
    try {
      const koffi = loadKoffi();
      const user32 = koffi.load('user32.dll');
      const winmm = koffi.load('winmm.dll');
      const kernel32 = koffi.load('kernel32.dll');
      const shell32 = koffi.load('shell32.dll');

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
      const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
      const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
      koffi.struct('POINT', { x: 'int32', y: 'int32' });
      koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
      const WNDENUMPROC = koffi.proto('int __stdcall WNDENUMPROC(void *, intptr_t)');

      const api: WinApi = {
        sendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)') as unknown as SendInputFn,
        timeBeginPeriod: winmm.func('uint32 __stdcall timeBeginPeriod(uint32 period)') as unknown as WinApi['timeBeginPeriod'],
        timeEndPeriod: winmm.func('uint32 __stdcall timeEndPeriod(uint32 period)') as unknown as WinApi['timeEndPeriod'],
        getForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()') as unknown as WinApi['getForegroundWindow'],
        getWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)') as unknown as WinApi['getWindowTextW'],
        getWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hWnd)') as unknown as WinApi['getWindowTextLengthW'],
        isWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hWnd)') as unknown as WinApi['isWindowVisible'],
        enumWindows: user32.func('bool __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)') as unknown as WinApi['enumWindows'],
        getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)') as unknown as WinApi['getWindowThreadProcessId'],
        attachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)') as unknown as WinApi['attachThreadInput'],
        getCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()') as unknown as WinApi['getCurrentThreadId'],
        showWindow: user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)') as unknown as WinApi['showWindow'],
        bringWindowToTop: user32.func('bool __stdcall BringWindowToTop(void *hWnd)') as unknown as WinApi['bringWindowToTop'],
        setForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hWnd)') as unknown as WinApi['setForegroundWindow'],
        setActiveWindow: user32.func('void * __stdcall SetActiveWindow(void *hWnd)') as unknown as WinApi['setActiveWindow'],
        setFocus: user32.func('void * __stdcall SetFocus(void *hWnd)') as unknown as WinApi['setFocus'],
        findWindowW: user32.func('void * __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)') as unknown as WinApi['findWindowW'],
        getCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)') as unknown as WinApi['getCursorPos'],
        setCursorPos: user32.func('bool __stdcall SetCursorPos(int X, int Y)') as unknown as WinApi['setCursorPos'],
        getWindowRect: user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)') as unknown as WinApi['getWindowRect'],
        isUserAnAdmin: shell32.func('bool __stdcall IsUserAnAdmin()') as unknown as WinApi['isUserAnAdmin'],
        openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)') as unknown as WinApi['openProcess'],
        queryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ char16_t *lpExeName, _Inout_ uint32 *lpdwSize)') as unknown as WinApi['queryFullProcessImageNameW'],
        closeHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)') as unknown as WinApi['closeHandle'],
      };

      this.inputType = INPUT;
      this.callbackType = koffi.pointer(WNDENUMPROC);
      this.sizeOfInput = koffi.sizeof(INPUT) as number;
      this.api = api;
      this.elevated = Boolean(api.isUserAnAdmin());
      this.available = true;
    } catch (error) {
      this.available = false;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  get size(): number {
    return this.sizeOfInput;
  }

  /** 把精度定时器提升到 1ms（Windows 默认定时器精度 15.6ms） */
  beginPrecision(): void {
    if (!this.api || this.precisionActive) return;
    this.api.timeBeginPeriod(1);
    this.precisionActive = true;
  }

  endPrecision(): void {
    if (!this.api || !this.precisionActive) return;
    this.api.timeEndPeriod(1);
    this.precisionActive = false;
  }

  private makeKeyInput(down: boolean, vk: number, scan: number): KeyboardInput {
    const flags = (down ? 0 : KEYEVENTF_KEYUP) | (scan > 0 ? KEYEVENTF_SCANCODE : 0);
    return { type: INPUT_KEYBOARD, u: { ki: { wVk: scan > 0 ? 0 : vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
  }

  private makeMouseInput(button: MouseButton, down: boolean): MouseInput {
    return {
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSE_FLAGS[button][down ? 'down' : 'up'], time: 0, dwExtraInfo: 0 } },
    };
  }

  /** 发送一批输入事件；返回实际发送数量（0 表示失败/不可用） */
  sendEvents(events: readonly InputEvent[]): number {
    if (!this.api || events.length === 0) return 0;
    const inputs: unknown[] = [];
    for (const event of events) {
      if (event.kind === 'keydown' || event.kind === 'keyup') {
        inputs.push(this.makeKeyInput(event.kind === 'keydown', event.vk ?? 0, event.scan ?? 0));
      } else if ((event.kind === 'mousedown' || event.kind === 'mouseup') && event.button) {
        inputs.push(this.makeMouseInput(event.button, event.kind === 'mousedown'));
      }
    }
    if (inputs.length === 0) return 0;
    const sent = this.api.sendInput(inputs.length, inputs, this.sizeOfInput);
    return sent;
  }

  foregroundWindow(): number {
    if (!this.api) return 0;
    try {
      return toNumber(this.api.getForegroundWindow());
    } catch {
      return 0;
    }
  }

  /** 按标题查找窗口（用于切回本程序自己的窗口） */
  findWindowByTitle(title: string): number | null {
    if (!this.api || !title) return null;
    try {
      const pointer = this.api.findWindowW(null, title);
      const handle = toNumber(pointer);
      if (!handle) return null;
      this.pointerCache.set(handle, pointer);
      return handle;
    } catch {
      return null;
    }
  }

  /** 当前鼠标光标位置 */
  cursorPosition(): { x: number; y: number } | null {
    if (!this.api) return null;
    try {
      const point = { x: 0, y: 0 };
      if (!this.api.getCursorPos(point)) return null;
      return point;
    } catch {
      return null;
    }
  }

  moveCursor(x: number, y: number): boolean {
    if (!this.api) return false;
    try {
      return Boolean(this.api.setCursorPos(Math.round(x), Math.round(y)));
    } catch {
      return false;
    }
  }

  /** 窗口在屏幕上的矩形（含阴影边框） */
  windowBounds(handle: number): WindowBounds | null {
    if (!this.api || !handle) return null;
    const pointer = this.pointerCache.get(handle) ?? BigInt(Math.trunc(handle));
    try {
      const rect = { left: 0, top: 0, right: 0, bottom: 0 };
      if (!this.api.getWindowRect(pointer, rect)) return null;
      if (rect.right <= rect.left || rect.bottom <= rect.top) return null;
      return rect;
    } catch {
      return null;
    }
  }

  /** 鼠标事件投递到光标下的窗口，所以演奏前/期间必须让光标位于目标窗口内 */
  isCursorInsideWindow(handle: number): boolean {
    const bounds = this.windowBounds(handle);
    const cursor = this.cursorPosition();
    if (!bounds || !cursor) return false;
    return cursor.x >= bounds.left && cursor.x < bounds.right && cursor.y >= bounds.top && cursor.y < bounds.bottom;
  }

  /** 若光标不在窗口内，移动到窗口中心（返回是否成功位于窗口内） */
  ensureCursorInsideWindow(handle: number): boolean {
    if (!handle) return false;
    if (this.isCursorInsideWindow(handle)) return true;
    const bounds = this.windowBounds(handle);
    if (!bounds) return false;
    const x = Math.round((bounds.left + bounds.right) / 2);
    const y = Math.round((bounds.top + bounds.bottom) / 2);
    if (!this.moveCursor(x, y)) return false;
    return this.isCursorInsideWindow(handle);
  }

  /** 把窗口切到前台（需配合管理员权限 + AttachThreadInput） */
  focusWindow(handle: number): boolean {
    if (!this.api || !handle) return false;
    const pointer = this.pointerCache.get(handle) ?? BigInt(Math.trunc(handle));
    try {
      this.api.showWindow(pointer, SW_RESTORE);
      const foreground = this.api.getForegroundWindow();
      const foregroundThread = foreground ? this.api.getWindowThreadProcessId(foreground, null) : 0;
      const selfThread = this.api.getCurrentThreadId();
      let attached = false;
      if (foregroundThread && foregroundThread !== selfThread) {
        attached = Boolean(this.api.attachThreadInput(selfThread, foregroundThread, true));
      }
      try {
        this.api.bringWindowToTop(pointer);
        const ok = Boolean(this.api.setForegroundWindow(pointer));
        this.api.setActiveWindow(pointer);
        this.api.setFocus(pointer);
        return ok;
      } finally {
        if (attached) this.api.attachThreadInput(selfThread, foregroundThread, false);
      }
    } catch {
      return false;
    }
  }

  private readTitle(pointer: Ptr): string {
    if (!this.api) return '';
    try {
      const length = this.api.getWindowTextLengthW(pointer);
      if (length <= 0) return '';
      const buffer = Buffer.alloc((length + 1) * 2);
      const copied = this.api.getWindowTextW(pointer, buffer, length + 1);
      if (copied <= 0) return '';
      return buffer.subarray(0, copied * 2).toString('utf16le');
    } catch {
      return '';
    }
  }

  /** 通过 PID 读取进程可执行文件名（如 DeltaForceClient-Win64-Shipping.exe） */
  private readProcessName(pid: number): string {
    if (!this.api || !pid) return '';
    let handle: Ptr = null;
    try {
      handle = this.api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!handle) return '';
      const buffer = Buffer.alloc(2048);
      const size = [1024];
      const ok = this.api.queryFullProcessImageNameW(handle, 0, buffer, size);
      if (!ok || !size[0]) return '';
      const fullPath = buffer.subarray(0, size[0] * 2).toString('utf16le');
      return path.basename(fullPath);
    } catch {
      return '';
    } finally {
      if (handle) {
        try {
          this.api.closeHandle(handle);
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  private classifyWindow(title: string, processName: string): boolean {
    const exe = processName.toLowerCase();
    const titleText = title.toLowerCase();
    if (GAME_PROCESS_PATTERN.test(exe)) return true;
    if (exe && NON_GAME_PROCESS_PATTERN.test(exe)) return false;
    if (NON_GAME_TITLE_PATTERN.test(titleText)) return false;
    if (!GAME_TITLE_PATTERN.test(title)) return false;
    if (/deltaforce|三角洲行动|delta force/i.test(exe)) return true;
    return true;
  }

  /** 枚举当前可见、带标题的顶层窗口 */
  listWindows(): WindowInfo[] {
    if (!this.api || !this.callbackType) return [];
    const koffi = loadKoffi();
    const api = this.api;
    const results: WindowInfo[] = [];
    const foreground = this.foregroundWindow();
    const selfTitle = '口琴工坊';
    this.pointerCache.clear();
    const callback = koffi.register((hwnd: Ptr) => {
      try {
        if (!hwnd || !api.isWindowVisible(hwnd)) return 1;
        const title = this.readTitle(hwnd);
        if (!title.trim() || title.includes(selfTitle)) return 1;
        const handle = toNumber(hwnd);
        if (!handle) return 1;
        const pidOut: Array<number | null> = [null];
        api.getWindowThreadProcessId(hwnd, pidOut);
        const processName = this.readProcessName(Number(pidOut[0] ?? 0));
        this.pointerCache.set(handle, hwnd);
        results.push({
          handle,
          title,
          processName,
          isForeground: handle === foreground,
          looksLikeGame: this.classifyWindow(title, processName),
        });
        return 1;
      } catch {
        return 1;
      }
    }, this.callbackType as never) as unknown as bigint;
    try {
      api.enumWindows(callback, 0n);
    } finally {
      try {
        koffi.unregister(callback);
      } catch {
        /* 忽略 */
      }
    }
    const weight = (window: WindowInfo): number =>
      (window.looksLikeGame ? 100 : 0) + (window.isForeground ? 10 : 0);
    return results.sort((a, b) => weight(b) - weight(a) || a.title.localeCompare(b.title, 'zh-CN'));
  }

  getStatus(): { available: boolean; error: string | null; elevated: boolean; size: number } {
    return { available: this.available, error: this.error, elevated: this.elevated, size: this.sizeOfInput };
  }
}

let singleton: Win32Bridge | null = null;

export function getWin32Bridge(): Win32Bridge {
  if (!singleton) singleton = new Win32Bridge();
  return singleton;
}

/** 由编排器调用：目标窗口是否为前台 */
export function isTargetForeground(handle: number | null): boolean {
  if (!handle) return true;
  const bridge = getWin32Bridge();
  return bridge.foregroundWindow() === handle;
}

export function looksLikeGameWindow(title: string): boolean {
  return GAME_TITLE_PATTERN.test(title);
}
