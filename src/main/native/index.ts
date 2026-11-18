/**
 * 原生输入桥入口：把「平台能力」与「Windows 输入桥」收在一处。
 *
 * 主进程其余模块只从这里取能力/桥，不再直接依赖 native/win32：
 * - Windows：真实 Win32 SendInput 桥
 * - macOS / Linux：桥会安全降级为不可用，界面据此提示并以排练模式运行
 */
import { getWin32Bridge } from './win32';
import { detectPlatformCapabilities, type PlatformCapabilities } from '@shared/platform';

let cached: PlatformCapabilities | null = null;

/**
 * 截图 / 自动化验收用的平台覆盖：只有显式设置 DFH_FORCE_PLATFORM 时才生效，
 * 方便在 Windows 上预览 macOS / Linux 的界面降级效果。正常启动不受影响。
 */
function effectivePlatform(): string {
  const forced = process.env.DFH_FORCE_PLATFORM;
  return forced === 'win32' || forced === 'darwin' || forced === 'linux' ? forced : process.platform;
}

/** 当前平台能力（进程级缓存；平台在进程生命周期内不会变化） */
export function getPlatformCapabilities(): PlatformCapabilities {
  if (!cached) cached = detectPlatformCapabilities(effectivePlatform());
  return cached;
}

/** 是否具备向游戏窗口注入键鼠的能力（仅 Windows） */
export function canInjectInput(): boolean {
  return getPlatformCapabilities().gameInjection;
}

/** Win32 输入桥；在非 Windows 平台上所有方法都返回安全空值 */
export function getNativeBridge(): ReturnType<typeof getWin32Bridge> {
  return getWin32Bridge();
}

export { isTargetForeground } from './win32';
export type { WindowBounds } from './win32';
