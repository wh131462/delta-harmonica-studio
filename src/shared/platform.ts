/**
 * 平台能力模型（纯函数，不引用 Electron / Node / DOM，可在任意平台单测）。
 *
 * 为什么需要它：游戏注入依赖 Windows 的 SendInput / UIPI / AttachThreadInput，
 * macOS 与 Linux 无法复刻同一条链路（游戏本身也只有 Windows 客户端）。
 * 因此三端共用同一套界面与核心逻辑，但「向其他窗口注入键鼠」只在 Windows 可用：
 * - Windows：编辑、导入、练习、试听、宏导出、游戏注入
 * - macOS / Linux：编辑、导入、练习、试听、宏导出（游戏注入置灰并说明原因）
 */

export type PlatformId = 'win32' | 'darwin' | 'linux' | 'other';

export interface PlatformCapabilities {
  /** 归一化平台标识 */
  platform: PlatformId;
  /** 面向界面的平台名：Windows / macOS / Linux */
  label: string;
  /** 是否为受支持的桌面平台之一 */
  supported: boolean;
  /** 能否向其他窗口注入键鼠事件（仅 Windows） */
  gameInjection: boolean;
  /** 是否需要且支持「以管理员身份重启」（仅 Windows） */
  elevation: boolean;
  /** 全局快捷键可用性（三端均支持；Linux 依赖桌面环境） */
  globalShortcuts: boolean;
  /** 悬浮控制窗可用性（Linux 透明/置顶依赖合成器） */
  overlay: boolean;
  /** 系统托盘可用性（Linux 依赖桌面托盘实现） */
  tray: boolean;
  /** 一句话说明该平台的能力边界，可直接用于界面提示 */
  note: string;
}

const WINDOWS: PlatformCapabilities = {
  platform: 'win32',
  label: 'Windows',
  supported: true,
  gameInjection: true,
  elevation: true,
  globalShortcuts: true,
  overlay: true,
  tray: true,
  note: '通过 Win32 SendInput 向游戏窗口注入键鼠事件，需要以管理员身份运行。',
};

const MACOS: PlatformCapabilities = {
  platform: 'darwin',
  label: 'macOS',
  supported: true,
  gameInjection: false,
  elevation: false,
  globalShortcuts: true,
  overlay: true,
  tray: true,
  note: 'macOS 版提供简谱编辑、导入、练习、试听与宏导出；游戏注入仅在 Windows 可用，演奏以排练模式运行。',
};

const LINUX: PlatformCapabilities = {
  platform: 'linux',
  label: 'Linux',
  supported: true,
  gameInjection: false,
  elevation: false,
  globalShortcuts: true,
  overlay: true,
  tray: true,
  note: 'Linux 版提供简谱编辑、导入、练习、试听与宏导出；游戏注入仅在 Windows 可用。Wayland 下悬浮窗的位置与置顶由合成器决定。',
};

const OTHER: PlatformCapabilities = {
  platform: 'other',
  label: '未知平台',
  supported: false,
  gameInjection: false,
  elevation: false,
  globalShortcuts: true,
  overlay: true,
  tray: false,
  note: '当前平台未经验证：编辑、导入、练习与试听仍可使用，游戏注入仅在 Windows 可用。',
};

/** 归一化 Node 的 process.platform；参数必填，避免把 Node 全局带进渲染进程。 */
export function normalizePlatform(platform: string): PlatformId {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'other';
}

export function detectPlatformCapabilities(platform: string): PlatformCapabilities {
  switch (normalizePlatform(platform)) {
    case 'win32':
      return { ...WINDOWS };
    case 'darwin':
      return { ...MACOS };
    case 'linux':
      return { ...LINUX };
    default:
      return { ...OTHER, label: platform || OTHER.label };
  }
}

/** 游戏注入是否可用（主进程与渲染进程共用的唯一判断） */
export function isGameInjectionSupported(platform: string): boolean {
  return detectPlatformCapabilities(platform).gameInjection;
}

/** 平台名，用于窗口标题、构建产物说明等 */
export function platformLabel(platform: string): string {
  return detectPlatformCapabilities(platform).label;
}

/** 平台能力说明，用于设置页、宏导出页脚等位置 */
export function platformNote(platform: string): string {
  return detectPlatformCapabilities(platform).note;
}

/** 停止演奏/排练时给用户的平台相关提示（macOS/Linux 说明为什么没有真实按键） */
export function platformBackendHint(platform: string, backend: 'software' | 'serial' | 'dry-run'): string {
  const capabilities = detectPlatformCapabilities(platform);
  if (backend === 'software' && !capabilities.gameInjection) {
    return `${capabilities.label} 版不发送真实按键：当前按排练模式走时间轴。`;
  }
  return capabilities.note;
}
