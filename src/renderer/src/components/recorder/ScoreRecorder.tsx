/**
 * ScoreRecorder —— 用《三角洲行动》口琴键位实时录入谱面。
 *
 * 游戏键位（与 DEFAULT_HARMONICA 一致）：
 *   Z X C V B N M ,  → 1 2 3 4 5 6 7 高音1
 *   鼠标左键 = 降八度，中键 = 升半音，右键 = 升八度（可与音键组合）
 *
 * 交互：
 * - 按下第一个音键开始计时，松开音键结束该音；同时按下一个音时前一个音自动收尾；
 * - 音与音之间的空档、时值按当前 BPM 量化成简谱，实时显示在弹窗里；
 * - 点「完成录入」或按 Esc 把结果交给父组件；「取消」丢弃这次录音；
 * - 录音期间暂停全局热键，避免 F9/F12 误触；本窗口需要保持焦点。
 *
 * 音频监听使用全局试听音色/音量；采样未就绪时静默降级，不影响录入。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_HARMONICA, type KeyId, type NoteKeyBinding } from '@core/model/instrument';
import { createId, meterBeats, type ScoreMeta } from '@core/model/score';
import { midiToName } from '@core/model/pitch';
import {
  recordedNotesToSteps,
  type RecordToStepsResult,
  type TimedRecordedNote,
} from '@core/score/record';
import type { ScoreStep } from '@core/score/sequence';
import type { PreviewInstrument } from '@shared/types';
import { getAudioContext, preloadInstrument, scheduleInstrumentNote } from '@renderer/audio/instruments';
import { Icon } from '@renderer/components/Icon';
import { ScoreLineEditor } from '@renderer/components/score';
import './ScoreRecorder.css';

export interface ScoreRecorderProps {
  meta: ScoreMeta;
  instrument: PreviewInstrument;
  /** 0..1，监听音量 */
  volume: number;
  /** 将插入到哪里的说明文案 */
  insertionLabel: string;
  onComplete: (steps: ScoreStep[], result: RecordToStepsResult) => void;
  onCancel: () => void;
}

interface RawNote {
  keyId: KeyId;
  midi: number;
  startMs: number;
  endMs: number | null;
}

interface Mods {
  left: boolean;
  middle: boolean;
  right: boolean;
}

const EMPTY_MODS: Mods = { left: false, middle: false, right: false };

const GRID_OPTIONS = [
  { value: 0.25, label: '1/4 拍' },
  { value: 0.125, label: '1/8 拍' },
  { value: 0.0625, label: '1/16 拍' },
] as const;

const MODIFIER_OPTIONS: Array<{ key: keyof Mods; label: string; action: string }> = [
  { key: 'left', label: '鼠标左键', action: '降八度' },
  { key: 'middle', label: '鼠标中键', action: '升半音' },
  { key: 'right', label: '鼠标右键', action: '升八度' },
];

const KEY_ID_BY_CODE: Record<string, KeyId> = {
  KeyZ: 'k1',
  KeyX: 'k2',
  KeyC: 'k3',
  KeyV: 'k4',
  KeyB: 'k5',
  KeyN: 'k6',
  KeyM: 'k7',
  Comma: 'k8',
};

const KEY_ID_BY_CHAR: Record<string, KeyId> = {
  z: 'k1',
  x: 'k2',
  c: 'k3',
  v: 'k4',
  b: 'k5',
  n: 'k6',
  m: 'k7',
  ',': 'k8',
};

const GAME_KEYS: readonly NoteKeyBinding[] = DEFAULT_HARMONICA.noteKeys;
const KEY_BY_ID = new Map<KeyId, NoteKeyBinding>(GAME_KEYS.map((key) => [key.id, key]));
const NOOP = (): void => undefined;

function bindingForEvent(event: KeyboardEvent): NoteKeyBinding | null {
  const keyId = KEY_ID_BY_CODE[event.code] ?? KEY_ID_BY_CHAR[event.key?.toLowerCase?.() ?? ''];
  return keyId ? KEY_BY_ID.get(keyId) ?? null : null;
}

export function ScoreRecorder({
  meta,
  instrument,
  volume,
  insertionLabel,
  onComplete,
  onCancel,
}: ScoreRecorderProps): JSX.Element {
  const takeId = useMemo(() => createId('take'), []);
  const [rawNotes, setRawNotes] = useState<RawNote[]>([]);
  const [mods, setMods] = useState<Mods>(EMPTY_MODS);
  const [pressedKeys, setPressedKeys] = useState<Set<KeyId>>(new Set());
  const [nowMs, setNowMs] = useState(0);
  const [grid, setGrid] = useState(0.25);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startedAtRef = useRef<number | null>(null);
  const rawRef = useRef<RawNote[]>([]);
  const openRef = useRef<RawNote | null>(null);
  const pressedRef = useRef<Set<KeyId>>(new Set());
  const modsRef = useRef<Mods>(EMPTY_MODS);
  const gridRef = useRef(0.25);
  const metaRef = useRef(meta);
  const instrumentRef = useRef(instrument);
  const volumeRef = useRef(volume);
  const onCompleteRef = useRef(onComplete);
  const onCancelRef = useRef(onCancel);
  const finishedRef = useRef(false);
  const audioRef = useRef<{ context: AudioContext; master: GainNode } | null>(null);
  const hudRef = useRef<HTMLElement | null>(null);

  // 始终让事件处理器 / 完成回调拿到最新值
  gridRef.current = grid;
  metaRef.current = meta;
  instrumentRef.current = instrument;
  volumeRef.current = volume;
  onCompleteRef.current = onComplete;
  onCancelRef.current = onCancel;

  const openNote = rawNotes.find((note) => note.endMs === null) ?? null;
  const recordedForPreview = useMemo<TimedRecordedNote[]>(
    () =>
      rawNotes.map((note) => ({
        midi: note.midi,
        startMs: note.startMs,
        endMs: note.endMs ?? nowMs,
      })),
    [rawNotes, nowMs],
  );
  const live = useMemo(
    () =>
      recordedNotesToSteps(recordedForPreview, {
        meta,
        tempo: meta.tempo,
        grid,
        idPrefix: takeId,
      }),
    [grid, meta, recordedForPreview, takeId],
  );
  const revealStepId = live.steps.length > 0 ? (live.steps[live.steps.length - 1] as ScoreStep).id : null;
  const elapsedBeats = started ? nowMs / (60000 / Math.max(20, Math.min(320, meta.tempo))) : 0;
  const gridLabel = GRID_OPTIONS.find((option) => option.value === grid)?.label ?? '自定义';
  const soundingCount = rawNotes.length;
  const measureBeats = meterBeats(meta.meter);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    const raw = rawRef.current;
    if (raw.length === 0) {
      setError('还没有录到音符，先按 Z 开始');
      return;
    }
    const now = startedAtRef.current !== null ? performance.now() - startedAtRef.current : 0;
    if (openRef.current) {
      openRef.current.endMs = now;
      openRef.current = null;
    }
    const notes: TimedRecordedNote[] = raw.map((note) => ({
      midi: note.midi,
      startMs: note.startMs,
      endMs: note.endMs ?? now,
    }));
    const result = recordedNotesToSteps(notes, {
      meta: metaRef.current,
      tempo: metaRef.current.tempo,
      grid: gridRef.current,
      idPrefix: takeId,
    });
    if (result.steps.length === 0) {
      setError('没有可写入的音符');
      return;
    }
    finishedRef.current = true;
    onCompleteRef.current(result.steps, result);
  }, [takeId]);

  const cancel = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancelRef.current();
  }, []);

  // 悬浮条出现时不改变页面滚动/布局：只把焦点移入录制条，并且不走 scrollIntoView
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    hudRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    void window.api.hotkeys.setRecording(true).catch(() => undefined);

    let cancelled = false;
    void (async () => {
      try {
        await preloadInstrument(instrumentRef.current);
        if (cancelled) return;
        const context = getAudioContext();
        await context.resume().catch(() => undefined);
        if (cancelled) return;
        const master = context.createGain();
        master.gain.value = Math.min(1, Math.max(0, volumeRef.current)) * 0.8;
        master.connect(context.destination);
        audioRef.current = { context, master };
      } catch {
        /* 监听不可用时静默降级，录入仍然可用 */
      }
    })();

    const clock = setInterval(() => {
      if (startedAtRef.current === null) return;
      setNowMs(performance.now() - startedAtRef.current);
    }, 70);

    const playMonitor = (midi: number): void => {
      const audio = audioRef.current;
      if (!audio) return;
      try {
        scheduleInstrumentNote({
          context: audio.context,
          destination: audio.master,
          instrument: instrumentRef.current,
          midi,
          when: audio.context.currentTime + 0.005,
          duration: 0.4,
        });
      } catch {
        /* 采样未就绪时忽略监听 */
      }
    };

    const updateMods = (next: Mods): void => {
      const current = modsRef.current;
      if (current.left === next.left && current.middle === next.middle && current.right === next.right) return;
      modsRef.current = next;
      setMods(next);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      // 录制条没有遮罩层，仍需把 Tab 焦点留在条内，避免误触背后的编辑器/导航
      if (event.key === 'Tab') {
        const hud = hudRef.current;
        if (!hud) return;
        const nodes = Array.from(
          hud.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((node) => node.offsetParent !== null);
        if (nodes.length === 0) {
          event.preventDefault();
          return;
        }
        const first = nodes[0] as HTMLElement;
        const last = nodes[nodes.length - 1] as HTMLElement;
        const active = document.activeElement;
        const inside = active instanceof Node && hud.contains(active);
        if (event.shiftKey && (!inside || active === first || active === hud)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || active === last)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (rawRef.current.length === 0) cancel();
        else finish();
        return;
      }
      const binding = bindingForEvent(event);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (pressedRef.current.has(binding.id)) return;
      pressedRef.current.add(binding.id);
      setPressedKeys(new Set(pressedRef.current));

      const absoluteNow = performance.now();
      let now = 0;
      if (startedAtRef.current === null) {
        startedAtRef.current = absoluteNow;
      } else {
        now = absoluteNow - startedAtRef.current;
      }
      if (openRef.current) {
        openRef.current.endMs = now;
        openRef.current = null;
      }

      const currentMods = modsRef.current;
      const octaveShift = (currentMods.right ? 1 : 0) - (currentMods.left ? 1 : 0);
      const midi = binding.baseMidi + 12 * octaveShift + (currentMods.middle ? 1 : 0);
      const note: RawNote = { keyId: binding.id, midi, startMs: now, endMs: null };
      rawRef.current = [...rawRef.current, note];
      openRef.current = note;
      setRawNotes(rawRef.current);
      setNowMs(now);
      setStarted(true);
      setError(null);
      playMonitor(midi);
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      const binding = bindingForEvent(event);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      pressedRef.current.delete(binding.id);
      setPressedKeys(new Set(pressedRef.current));
      if (openRef.current?.keyId !== binding.id) return;
      const now = startedAtRef.current !== null ? performance.now() - startedAtRef.current : 0;
      openRef.current.endMs = now;
      openRef.current = null;
      setRawNotes(rawRef.current.slice());
      setNowMs(now);
    };

    const handleMouseDown = (event: MouseEvent): void => {
      if (event.button === 1 || event.button === 2) event.preventDefault();
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      updateMods({
        left: event.button === 0 ? true : modsRef.current.left,
        middle: event.button === 1 ? true : modsRef.current.middle,
        right: event.button === 2 ? true : modsRef.current.right,
      });
    };

    const handleMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      updateMods({
        left: event.button === 0 ? false : modsRef.current.left,
        middle: event.button === 1 ? false : modsRef.current.middle,
        right: event.button === 2 ? false : modsRef.current.right,
      });
    };

    const handleMouseMove = (event: MouseEvent): void => {
      updateMods({
        left: (event.buttons & 1) !== 0,
        right: (event.buttons & 2) !== 0,
        middle: (event.buttons & 4) !== 0,
      });
    };

    const handleBlur = (): void => {
      pressedRef.current.clear();
      setPressedKeys(new Set());
      updateMods(EMPTY_MODS);
      if (openRef.current && startedAtRef.current !== null) {
        const now = performance.now() - startedAtRef.current;
        openRef.current.endMs = now;
        openRef.current = null;
        setRawNotes(rawRef.current.slice());
        setNowMs(now);
      }
    };

    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mouseup', handleMouseUp, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('contextmenu', handleContextMenu, true);

    return () => {
      cancelled = true;
      clearInterval(clock);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      void window.api.hotkeys.setRecording(false).catch(() => undefined);
      const audio = audioRef.current;
      audioRef.current = null;
      if (audio) {
        try {
          audio.master.gain.value = 0;
          audio.master.disconnect();
        } catch {
          /* 忽略 */
        }
      }
    };
  }, [cancel, finish]);

  const handleGridChange = (value: number): void => {
    setGrid(value);
    gridRef.current = value;
  };

  const currentOctaveShift = (mods.right ? 1 : 0) - (mods.left ? 1 : 0);
  const currentSemitone = mods.middle ? 1 : 0;

  return (
    <>
      {/* 透明交互层：只挡住背后页面的鼠标操作，不遮罩、不改页面布局 */}
      <div className="record-blocker" aria-hidden="true" />
      <section
        className="record-hud"
        role="dialog"
        aria-modal="true"
        aria-label="实时录入"
        tabIndex={-1}
        ref={hudRef}
      >
        <div className="record-hud__head">
          <span className="record-hud__title">
            <Icon name="record" size={11} /> 实时录入
          </span>
          <span className={`badge ${started ? 'badge--accent' : ''}`}>{started ? 'REC' : '等待第一个音'}</span>
          <span className="record-hud__status">
            {started
              ? `已录 ${soundingCount} 个音 · 第 ${elapsedBeats.toFixed(1)} 拍`
              : '按 Z 开始，第一个音开始计时'}
          </span>
          <div className="segmented record-grid" role="group" aria-label="量化网格">
            {GRID_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="segmented__item"
                aria-pressed={grid === option.value}
                onClick={() => handleGridChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="record-hud__actions">
            <button type="button" className="btn btn--quiet btn--sm" onClick={cancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={rawNotes.length === 0}
              onClick={finish}
              title={rawNotes.length === 0 ? '先按 Z 录一个音' : '把录到的音符插入当前谱面'}
            >
              <Icon name="check" size={13} /> 完成录入
            </button>
          </div>
        </div>

        <div className="record-hud__keys">
          <div className="record-keys" role="group" aria-label="游戏口琴键位">
            {GAME_KEYS.map((key) => {
              const active = pressedKeys.has(key.id);
              const midi = key.baseMidi + 12 * currentOctaveShift + currentSemitone;
              return (
                <div
                  key={key.id}
                  className={`record-key${active ? ' is-active' : ''}`}
                  title={`${key.label} = ${key.degree === 8 ? '高音1' : key.degree}，当前 ${midiToName(midi)}`}
                >
                  <span className="record-key__label">{key.label}</span>
                  <span className="record-key__degree">{key.degree === 8 ? "1'" : key.degree}</span>
                </div>
              );
            })}
          </div>
          <div className="record-mods" role="group" aria-label="鼠标修饰键">
            {MODIFIER_OPTIONS.map((option) => (
              <div
                key={option.key}
                className={`record-mod${mods[option.key] ? ' is-active' : ''}`}
                title={`${option.label}：${option.action}`}
              >
                <span className="record-mod__label">{option.label}</span>
                <strong className="record-mod__action">{option.action}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="score-surface record-hud__paper">
          {live.steps.length === 0 ? (
            <div className="record-empty">
              <Icon name="record" size={14} />
              <p>按 Z 开始，弹奏会实时显示在这里</p>
            </div>
          ) : (
            <ScoreLineEditor
              steps={live.steps}
              measureBeats={measureBeats}
              measuresPerRow={8}
              readOnly
              revealStepId={revealStepId}
              onSelectStep={NOOP}
            />
          )}
        </div>

        <div className="record-hud__foot">
          <span className="record-hud__meta">
            {meta.tempo} BPM · 量化 {gridLabel} · {insertionLabel}
          </span>
          {openNote ? <span className="record-hud__live">保持 {midiToName(openNote.midi)}</span> : null}
          {live.warnings.length > 0 ? (
            <span className="record-warning" role="status">
              <Icon name="warning" size={11} /> {live.warnings.join('；')}
            </span>
          ) : null}
          {error ? (
            <span className="record-warning" role="alert">
              <Icon name="warning" size={11} /> {error}
            </span>
          ) : null}
          <span className="record-hud__hint">保持窗口焦点 · 鼠标左/中/右键修饰 · Esc 完成</span>
        </div>
      </section>
    </>
  );
}

export default ScoreRecorder;
