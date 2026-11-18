import { DEFAULT_TIMING } from '@core/instrument/plan';
import type { AppSettings, InputCheck, InputSettings } from './types';

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  backend: 'software',
  allowModifierCombos: true,
  countdownSeconds: 3,
  focusGuard: true,
  autoFocusTarget: true,
  targetWindowHandle: null,
  targetWindowTitle: null,
  timing: { ...DEFAULT_TIMING },
  serialPort: null,
  serialBaudRate: 115200,
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  disclaimerAccepted: false,
  favorites: [],
  input: DEFAULT_INPUT_SETTINGS,
  audio: {
    quantizeGrid: 0.25,
    autoKey: true,
    melodyMode: 'auto',
    pitchMin: 48,
    pitchMax: 84,
    minNoteMs: 70,
    suppressAccompaniment: true,
  },
  hotkeys: {
    togglePlay: 'F9',
    panicStop: 'F10',
    toggleOverlay: 'Ctrl+Alt+O',
    showMain: 'Ctrl+Alt+M',
  },
  overlay: {
    visible: false,
    alwaysOnTop: true,
    opacity: 0.96,
    position: null,
    showHotkeyHint: true,
  },
  preview: {
    instrument: 'harmonica',
    volume: 0.55,
  },
};

export function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    favorites: Array.isArray(patch.favorites) ? patch.favorites : base.favorites,
    input: {
      ...base.input,
      ...(patch.input ?? {}),
      timing: { ...base.input.timing, ...(patch.input?.timing ?? {}) },
    },
    audio: { ...base.audio, ...(patch.audio ?? {}) },
    hotkeys: { ...base.hotkeys, ...(patch.hotkeys ?? {}) },
    overlay: {
      ...base.overlay,
      ...(patch.overlay ?? {}),
      position: patch.overlay && 'position' in patch.overlay ? patch.overlay.position ?? null : base.overlay.position,
    },
    preview: { ...base.preview, ...(patch.preview ?? {}) },
  };
}

export function describeInputReadiness(check: InputCheck): { level: 'ok' | 'warn' | 'error'; message: string } {
  const elevatedIssue = check.notes.find((note) => note.includes('管理员'));
  if (!check.elevated) {
    return { level: 'warn', message: '未以管理员身份运行：向游戏注入按键可能被 Windows UIPI 静默拦截' };
  }
  if (!check.helperAvailable && check.backend === 'software') {
    return { level: 'error', message: '按键桥接组件不可用，请检查安装是否完整' };
  }
  if (check.warnings.length > 0) {
    return { level: 'warn', message: check.warnings[0] };
  }
  return { level: 'ok', message: check.notes[0] ?? '输入通道就绪' };
}
