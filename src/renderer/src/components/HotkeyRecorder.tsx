/**
 * 快捷键录制器（设置页专用组件）
 * ------------------------------------------------------------------
 * 交互说明：
 * - 点击输入框进入录制态，显示「请按下新的快捷键…」；
 * - 在 window 捕获阶段监听 keydown 并阻止冒泡，避免触发页面内其他快捷键；
 * - 单独按修饰键（Ctrl / Alt / Shift / Win）不会结束录制，会实时预览已按下的修饰键；
 * - Esc 取消录制；点击录制器之外的任何位置也会取消；
 * - 主键支持 F1-F24、A-Z、0-9、小键盘数字、方向键、Home/End/PageUp/PageDown、
 *   Space/Tab/Backspace/Delete/Insert/Enter 以及常用符号；
 * - 录制成功后回调形如 "Ctrl+Alt+F9" 的 Electron accelerator 字符串，由父组件保存。
 *
 * 注意：全局快捷键由主进程 globalShortcut 注册，录制期间旧快捷键仍可能在系统层被触发，
 *       这是 Electron 的固有限制（渲染进程无法临时注销主进程的热键）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface HotkeyRecorderProps {
  /** 当前快捷键（Electron accelerator；空字符串表示未设置） */
  value: string;
  /** 录制成功后的回调 */
  onChange: (accelerator: string) => void;
  /** 与其他动作冲突时的提示文案（由父组件计算，可选） */
  conflict?: string | null;
  /** 是否禁用录制（例如另一个录制器正处于录制态） */
  disabled?: boolean;
  /** 录制状态变化（父组件可用来互斥其他录制器） */
  onRecordingChange?: (recording: boolean) => void;
}

/** 非字母/数字/功能键的 event.code → Electron accelerator 主键映射 */
const MAIN_KEY_BY_CODE: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Return',
  NumpadEnter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

/** 单独按下时只作为修饰键、不结束录制的按键 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock']);

/** 展示用的主键名（Electron 名称 → 界面名称） */
const FRIENDLY_KEYS: Record<string, string> = {
  Return: 'Enter',
  Space: '空格',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
};

/** 展示用的修饰键名（accelerator 修饰键 → 界面名称） */
const FRIENDLY_MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  command: 'Cmd',
  cmd: 'Cmd',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Win',
  meta: 'Win',
};

/** 是否为“只按下了修饰键”的事件 */
function isModifierOnlyEvent(event: KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(event.key)) return true;
  // 某些键盘布局（如 AltGr）key 为 AltGraph，code 也可能落到 ControlRight
  return event.code === 'CapsLock' || event.code === 'NumLock' || event.code === 'ScrollLock';
}

/** 把按下的修饰键收集为 accelerator 片段（顺序固定，便于去重/比较） */
function collectModifiers(event: KeyboardEvent): string[] {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  return modifiers;
}

/** 把 keydown 事件的主键映射为 accelerator 主键（不支持时返回 null） */
function mapMainKey(event: KeyboardEvent): string | null {
  const matchFunctionKey = /^F([1-9]|1\d|2[0-4])$/.exec(event.key);
  if (matchFunctionKey) return event.key.toUpperCase();
  const matchLetter = /^Key([A-Z])$/.exec(event.code);
  if (matchLetter) return matchLetter[1];
  const matchDigit = /^Digit([0-9])$/.exec(event.code);
  if (matchDigit) return matchDigit[1];
  const matchNumpad = /^Numpad([0-9])$/.exec(event.code);
  if (matchNumpad) return `num${matchNumpad[1]}`;
  return MAIN_KEY_BY_CODE[event.code] ?? null;
}

/**
 * 把 Electron accelerator 格式化为更适合界面阅读的文本。
 * 例如 "CommandOrControl+Alt+P" → "Ctrl + Alt + P"，"F12" → "F12"。
 */
export function formatAccelerator(accelerator: string): string {
  const text = (accelerator ?? '').trim();
  if (!text) return '未设置';
  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return text;
  return parts
    .map((part) => {
      const lower = part.toLowerCase();
      const friendlyModifier = FRIENDLY_MODIFIERS[lower];
      if (friendlyModifier) return friendlyModifier;
      const upper = part.toUpperCase();
      if (/^F\d{1,2}$/.test(upper)) return upper;
      const friendlyKey = FRIENDLY_KEYS[part];
      if (friendlyKey) return friendlyKey;
      if (/^num[0-9]$/i.test(part)) return `小键盘${part.slice(3)}`;
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(' + ');
}

export function HotkeyRecorder({
  value,
  onChange,
  conflict = null,
  disabled = false,
  onRecordingChange,
}: HotkeyRecorderProps): JSX.Element {
  const [recording, setRecording] = useState(false);
  /** 只按下修饰键时的预览文案，例如 "Ctrl + Shift" */
  const [pending, setPending] = useState('');
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const recordingRef = useRef(false);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onRecordingChangeRef = useRef(onRecordingChange);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onRecordingChangeRef.current = onRecordingChange;
  }, [onRecordingChange]);

  /** 结束录制：nextValue 为 null 表示取消，否则提交新快捷键 */
  const stopRecording = useCallback((nextValue: string | null) => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    setPending('');
    setError(null);
    onRecordingChangeRef.current?.(false);
    if (nextValue && nextValue.trim() !== valueRef.current.trim()) {
      onChangeRef.current(nextValue);
    }
  }, []);

  const startRecording = useCallback(() => {
    if (disabled || recordingRef.current) return;
    recordingRef.current = true;
    setRecording(true);
    setPending('');
    setError(null);
    onRecordingChangeRef.current?.(true);
  }, [disabled]);

  // 录制期间拦截键盘事件：生成 accelerator / 取消录制
  useEffect(() => {
    if (!recording) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!recordingRef.current) return;
      // 捕获阶段拦截，避免页面/Electron 默认行为干扰（Esc、空格滚动等）
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      // Esc 取消录制
      if (event.key === 'Escape') {
        stopRecording(null);
        return;
      }
      const modifiers = collectModifiers(event);
      // 只按修饰键：不结束录制，实时预览
      if (isModifierOnlyEvent(event)) {
        setPending(modifiers.join(' + '));
        setError(null);
        return;
      }
      const mainKey = mapMainKey(event);
      if (!mainKey) {
        setPending(modifiers.join(' + '));
        setError('这个按键不能作为快捷键，请换一个（支持 F1-F24、字母、数字、方向键等）');
        return;
      }
      stopRecording([...modifiers, mainKey].join('+'));
    };

    // 点击录制器外部时取消录制
    const handlePointerDown = (event: PointerEvent) => {
      if (!recordingRef.current) return;
      const container = containerRef.current;
      if (container && event.target instanceof Node && container.contains(event.target)) return;
      stopRecording(null);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [recording, stopRecording]);

  // 父组件禁用录制器时自动退出录制态
  useEffect(() => {
    if (disabled && recordingRef.current) stopRecording(null);
  }, [disabled, stopRecording]);

  // 卸载时若仍在录制，通知父组件解除互斥
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current = false;
        onRecordingChangeRef.current?.(false);
      }
    };
  }, []);

  const display = recording ? (pending ? `${pending} + …` : '请按下新的快捷键…') : formatAccelerator(value);
  const className = [
    'settings-recorder__trigger',
    recording ? 'is-recording' : '',
    value ? '' : 'is-empty',
    conflict ? 'has-conflict' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="settings-recorder" ref={containerRef}>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => (recordingRef.current ? stopRecording(null) : startRecording())}
        title={recording ? '请按下新的组合键；按 Esc 取消' : `当前：${formatAccelerator(value)}（点击录制新快捷键）`}
        aria-label={recording ? '正在录制快捷键，按 Esc 取消' : `当前快捷键 ${formatAccelerator(value)}，点击重新录制`}
      >
        <span className="settings-recorder__accel">{display}</span>
        <span className="settings-recorder__hint">{recording ? 'Esc 取消' : '点击录制'}</span>
      </button>
      {recording && error ? (
        <p className="settings-recorder__note is-error" role="status">
          <Icon name="warning" size={12} /> {error}
        </p>
      ) : null}
      {!recording && conflict ? (
        <p className="settings-recorder__note is-conflict" role="status">
          <Icon name="warning" size={12} /> {conflict}
        </p>
      ) : null}
    </div>
  );
}
