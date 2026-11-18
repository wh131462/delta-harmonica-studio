/**
 * 主进程 ↔ 渲染进程 的 IPC 契约与共享配置类型。
 * 这里只放类型与纯数据（不引用 electron 模块），可被 Node 测试直接 import。
 */
import type { Score } from '@core/model/score';
import type { InputEvent } from '@core/instrument/plan';
import type { PracticeMode } from '@core/practice/session';
import type { MelodyDensity } from '@core/music/melody-simplify';
import type { PlatformCapabilities } from './platform';

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

export type PreviewInstrument = 'harmonica' | 'piano';

/** 应用内试听设置 */
export interface PreviewSettings {
  instrument: PreviewInstrument;
  /** 0..1 */
  volume: number;
}

/** 练习谱面显示方式：横向滚动 / 下落式 */
export type PracticeNoteStyle = 'scroll' | 'fall';

/** 练习模式偏好（段落随曲谱变化，不持久化） */
export interface PracticeSettings {
  /** 速度倍率：0.5–1.25（核心会把越界值夹回来） */
  speed: number;
  /** timing = 计时判定；wait = 等按对才继续 */
  mode: PracticeMode;
  /** 练完一段自动循环 */
  loop: boolean;
  /** 节拍器 */
  metronome: boolean;
  /** 按键发声（含失误低声提示） */
  hitSound: boolean;
  /** 谱面显示：横向滚动或按音键分列下落 */
  noteStyle: PracticeNoteStyle;
}

/** 可配置全局快捷键（Electron accelerator 字符串，例如 F9、CommandOrControl+Alt+P） */
export interface HotkeySettings {
  /** 开始/停止演奏 */
  togglePlay: string;
  /** 紧急停止并释放所有按键 */
  panicStop: string;
  /** 显示/隐藏悬浮控制窗 */
  toggleOverlay: string;
  /** 显示主窗口 */
  showMain: string;
}

export type HotkeyAction = keyof HotkeySettings;

export interface HotkeyRegistrationStatus {
  action: HotkeyAction;
  accelerator: string;
  registered: boolean;
  error?: string;
}

/** 悬浮控制窗设置 */
export interface OverlaySettings {
  visible: boolean;
  alwaysOnTop: boolean;
  /** 0.3 - 1 */
  opacity: number;
  position: { x: number; y: number } | null;
  showHotkeyHint: boolean;
}

export type MelodyAnalysisMode = 'auto' | 'monophonic' | 'polyphonic';

/** 音频扒谱（主旋律提取）设置 */
export interface AudioAnalysisSettings {
  /** 量化网格（拍） */
  quantizeGrid: number;
  /** 自动检测调性 */
  autoKey: boolean;
  /** auto = 自动判断单声部/复音，其余为强制模式 */
  melodyMode: MelodyAnalysisMode;
  /** 主旋律允许音域（MIDI 音高，含端点），默认 C3-C6 */
  pitchMin: number;
  pitchMax: number;
  /** 最短音符（毫秒） */
  minNoteMs: number;
  /** 是否做 HPSS 伴奏抑制（带伴奏歌曲推荐开启） */
  suppressAccompaniment: boolean;
  /**
   * 音频谱面密度：宽松（每拍最多 1 个音）/ 标准（每拍最多 2 个音）/ 精细（保留 1/16 细节）。
   * 只影响音频转谱的“可演奏化”精简，不改变原始旋律提取。
   */
  melodyDensity: MelodyDensity;
}

export interface AppSettings {
  version: 1;
  /** 首次启动风险提示是否已确认 */
  disclaimerAccepted: boolean;
  disclaimerAcceptedAt?: string;
  /** 收藏的曲谱 id */
  favorites: string[];
  input: InputSettings;
  audio: AudioAnalysisSettings;
  hotkeys: HotkeySettings;
  overlay: OverlaySettings;
  preview: PreviewSettings;
  practice: PracticeSettings;
}

export interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  /** CPU 架构（x64 / arm64），用于区分 macOS Apple Silicon 与 Intel 构建 */
  arch: string;
  /** 平台能力：游戏注入仅 Windows 可用 */
  capabilities: PlatformCapabilities;
  /** 当前进程是否为管理员（注入游戏必需） */
  elevated: boolean;
  userDataPath: string;
  isPackaged: boolean;
  /** 启动页（截图/调试用，来自 --start-page 或 DFH_START_PAGE） */
  startPage: string;
  /** 自动化自检模式（DFH_AUTOTEST=1 时打开输入自检弹窗） */
  autotest: boolean;
  /** 自动化实机测试模式（DFH_GAME_AUTOPLAY=1 时启动后自动开始演奏） */
  gameAutoplay: boolean;
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

export type ExportFormat =
  | 'json'
  | 'dsl'
  | 'midi'
  | 'keys'
  | 'txt'
  | 'macro-ahk'
  | 'macro-ahk2'
  | 'macro-lua'
  | 'macro-csv'
  | 'trigger-table';

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
  /** 归一化前的 process.platform（win32 / darwin / linux） */
  platform: string;
  /** 当前平台是否支持向游戏注入键鼠 */
  gameInjection: boolean;
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

/** 悬浮窗发出的控制命令 */
export type OverlayCommand = 'toggle-play' | 'stop' | 'panic-stop' | 'show-main' | 'hide-overlay';

/** 主窗口同步给悬浮窗的状态（标题/快捷键等） */
export interface OverlaySyncState {
  title: string;
  subtitle?: string;
  playback: PlaybackStatus;
  hotkeys: HotkeySettings;
  backend: InputBackend;
  targetWindowTitle?: string | null;
  overlayVisible?: boolean;
  showHotkeyHint?: boolean;
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
  samples: {
    /** 读取随应用分发的真实音源采样（resources/audio-samples 下的白名单文件） */
    read(file: string): Promise<Uint8Array>;
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
  hotkeys: {
    status(): Promise<HotkeyRegistrationStatus[]>;
    /** 录制新快捷键期间临时注销全部全局热键，避免录制按键触发旧动作 */
    setRecording(recording: boolean): Promise<void>;
  };
  overlay: {
    setVisible(visible: boolean): Promise<boolean>;
    syncState(state: OverlaySyncState): Promise<void>;
    sendCommand(command: OverlayCommand): Promise<void>;
    onState(callback: (state: OverlaySyncState) => void): () => void;
    onVisibility(callback: (visible: boolean) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
}

export type GlobalCommand = 'toggle-play' | 'panic-stop';
