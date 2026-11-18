/**
 * 主进程 ↔ 渲染进程 的 IPC 契约与共享配置类型。
 * 这里只放类型与纯数据（不引用 electron 模块），可被 Node 测试直接 import。
 */
import type { Score } from '@core/model/score';
import type { InputEvent } from '@core/instrument/plan';

export type InputBackend = 'software' | 'serial' | 'dry-run';

export interface TimingSettings {
  transitionGapMs: number;
  modifierSettleMs: number;
  minNoteHoldMs: number;
  modifierReleaseGapMs: number;
  leadInMs: number;
}

export interface InputSettings {
  backend: InputBackend;
  /** 是否允许“八度键 + 半音键”组合（不同版本/实测可能不同，可在校准里切换） */
  allowModifierCombos: boolean;
  /** 开始前倒计时秒数 */
  countdownSeconds: number;
  /** 目标窗口不在前台时是否自动中止（强烈建议开启） */
  focusGuard: boolean;
  /** 开始演奏前自动把目标窗口切到前台 */
  autoFocusTarget: boolean;
  /** 目标窗口（Windows HWND） */
  targetWindowHandle: number | null;
  targetWindowTitle: string | null;
  timing: TimingSettings;
  /** Arduino / 串口输出（预留） */
  serialPort: string | null;
  serialBaudRate: number;
}

export interface AppSettings {
  version: 1;
  /** 首次启动风险提示是否已确认 */
  disclaimerAccepted: boolean;
  disclaimerAcceptedAt?: string;
  /** 收藏的曲谱 id */
  favorites: string[];
  input: InputSettings;
  audio: {
    /** 音频导入量化网格（拍） */
    quantizeGrid: number;
    /** 是否自动检测调性 */
    autoKey: boolean;
  };
}

export interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  /** 当前进程是否为管理员（注入游戏必需） */
  elevated: boolean;
  userDataPath: string;
  isPackaged: boolean;
  /** 启动页（截图/调试用，来自 --start-page 或 DFH_START_PAGE） */
  startPage: string;
  /** 自动化自检模式（DFH_AUTOTEST=1 时打开输入自检弹窗） */
  autotest: boolean;
}

export interface WindowInfo {
  handle: number;
  title: string;
  processName: string;
  isForeground: boolean;
  /** 是否疑似三角洲行动窗口 */
  looksLikeGame: boolean;
}

export interface LibraryEntry {
  id: string;
  title: string;
  artist?: string;
  tempo: number;
  meter: { num: number; den: number };
  keyRoot: number;
  noteCount: number;
  durationBeats: number;
  updatedAt: string;
  sourceKind: string;
  favorite: boolean;
}

export interface PickedFile {
  name: string;
  path: string;
  size: number;
  /** 文件内容（二进制） */
  data: Uint8Array;
}

export interface SaveFileRequest {
  suggestedName: string;
  filters: Array<{ name: string; extensions: string[] }>;
  /** 文本或二进制内容 */
  data: string | Uint8Array;
}

export type ExportFormat = 'json' | 'dsl' | 'midi' | 'keys' | 'txt';

export interface PlaybackRequest {
  events: InputEvent[];
  durationMs: number;
  countdownSeconds: number;
  /** 仅当目标窗口在前台时发送输入 */
  focusGuard: boolean;
  /** 开始前尝试把目标窗口切到前台 */
  autoFocusTarget: boolean;
  targetWindowHandle: number | null;
  backend: InputBackend;
  /** 展示用名称 */
  title: string;
}

export type PlaybackState =
  | 'idle'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'stopped'
  | 'error'
  | 'focus-lost';

export interface PlaybackStatus {
  state: PlaybackState;
  countdown?: number;
  elapsedMs?: number;
  totalMs?: number;
  message?: string;
  /** 已执行的输入事件数 */
  eventsSent?: number;
}

export interface InputCheck {
  elevated: boolean;
  backend: InputBackend;
  helperAvailable: boolean;
  helperPath: string | null;
  warnings: string[];
  notes: string[];
}

export interface StartPlaybackResult {
  ok: boolean;
  message?: string;
}

export interface RendererApi {
  app: {
    getInfo(): Promise<AppInfo>;
    relaunchElevated(): Promise<{ ok: boolean; message: string }>;
    openUserData(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  library: {
    list(): Promise<LibraryEntry[]>;
    load(id: string): Promise<Score>;
    save(score: Score): Promise<LibraryEntry>;
    remove(id: string): Promise<void>;
    toggleFavorite(id: string): Promise<string[]>;
    exportScore(score: Score, format: ExportFormat): Promise<string | null>;
    importScoreFile(): Promise<PickedFile[]>;
  };
  files: {
    pick(filters: Array<{ name: string; extensions: string[] }>): Promise<PickedFile[]>;
    save(request: SaveFileRequest): Promise<string | null>;
  };
  playback: {
    start(request: PlaybackRequest): Promise<StartPlaybackResult>;
    stop(): Promise<void>;
    onStatus(callback: (status: PlaybackStatus) => void): () => void;
    /** 在应用自己的窗口里回环验证按键注入链路 */
    selfTest(): Promise<StartPlaybackResult>;
    /** 紧急释放所有按下的键（F12/停止时调用） */
    panicRelease(): Promise<void>;
  };
  windows: {
    list(): Promise<WindowInfo[]>;
    focus(handle: number): Promise<boolean>;
  };
  input: {
    check(): Promise<InputCheck>;
    onGlobalCommand(callback: (command: GlobalCommand) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
}

export type GlobalCommand = 'toggle-play' | 'panic-stop';
