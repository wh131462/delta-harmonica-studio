/**
 * 演奏编排（Performance Planner）：
 *   乐谱（绝对音高 + 拍位） → 物理键位组合（DP 最优） → 带绝对毫秒时间轴的输入事件序列
 *
 * 关键规则（来自实机/社区验证）：
 * 1. 先按住鼠标修饰键，稳定 ~24ms 后再按音符键；
 * 2. 相邻音符之间留 ~12ms 释放窗口；
 * 3. 单音最短保持 ~40ms（太短游戏可能不判定）；
 * 4. 只按一个音键（单声部），修饰键在换音间隙调整；
 * 5. 结束时必须释放所有按下的键（安全）。
 */
import { toTimedNotes } from '../music/timeline';
import type { Score } from '../model/score';
import {
  DEFAULT_HARMONICA,
  bestCombo,
  combosForMidi,
  foldIntoRange,
  formatCombo,
  instrumentRange,
  type HarmonicaInstrument,
  type KeyId,
  type MouseButton,
  type PhysicalCombo,
} from '../model/instrument';
import { midiToName } from '../model/pitch';

export interface TimingOptions {
  /** 相邻音符之间的释放/间隔窗口（毫秒） */
  transitionGapMs: number;
  /** 鼠标修饰键按下后到音符键按下的稳定时间（毫秒） */
  modifierSettleMs: number;
  /** 单个音最短保持时间（毫秒） */
  minNoteHoldMs: number;
  /** 松开上一个音后到调整修饰键的最小间隔（毫秒） */
  modifierReleaseGapMs: number;
  /** 开头留白（毫秒），保证初始修饰键有足够提前量 */
  leadInMs: number;
}

export const DEFAULT_TIMING: TimingOptions = {
  transitionGapMs: 12,
  modifierSettleMs: 24,
  minNoteHoldMs: 40,
  modifierReleaseGapMs: 6,
  leadInMs: 90,
};

export type InputEventKind = 'keydown' | 'keyup' | 'mousedown' | 'mouseup';

export interface InputEvent {
  /** 相对演奏开始的毫秒时间戳 */
  t: number;
  kind: InputEventKind;
  label: string;
  keyId?: KeyId;
  vk?: number;
  scan?: number;
  button?: MouseButton;
}

export interface PlannedNote {
  index: number;
  /** 折返前的目标音高（含移调） */
  targetMidi: number;
  /** 实际演奏音高 */
  midi: number;
  midiName: string;
  startMs: number;
  endMs: number;
  holdMs: number;
  startBeat: number;
  durationBeats: number;
  combo: PhysicalCombo;
  /** 是否因超出音域做了八度折返 */
  folded: boolean;
  /** 是否超出音域（未折返时无法演奏） */
  outOfRange: boolean;
  /** 可读按键记号：↑Z、↓#V、, 等 */
  keys: string;
}

export interface PlanStats {
  noteCount: number;
  modifierSwitchCount: number;
  initialModifierCount: number;
  finalModifierCount: number;
  foldedCount: number;
  outOfRangeCount: number;
  fastTransitionCount: number;
  /** 因超出音域（禁止折返）或节奏过密而被跳过的音符数 */
  droppedCount: number;
  minHoldMsUsed: number;
  maxHoldMsUsed: number;
  meanHoldMs: number;
  transpose: number;
  rangeMin: number;
  rangeMax: number;
}

export interface PlaybackPlan {
  events: InputEvent[];
  notes: PlannedNote[];
  durationMs: number;
  leadInMs: number;
  tempo: number;
  beatMs: number;
  transpose: number;
  instrumentId: string;
  warnings: string[];
  stats: PlanStats;
}

export interface PlanOptions {
  instrument?: HarmonicaInstrument;
  timing?: Partial<TimingOptions>;
  /** 整数 = 固定移调半音；'auto' = 自动挑最省事的调；默认 0 */
  transpose?: number | 'auto';
  tempoOverride?: number;
  /** 超音域时是否自动八度折返（默认 true） */
  allowOctaveFold?: boolean;
}

export interface TransposeEvaluation {
  transpose: number;
  outOfRangeCount: number;
  foldedCount: number;
  modifierCount: number;
  playableCount: number;
  rangeMin: number;
  rangeMax: number;
}

const MIN_SETTLE_MS = 6;
const EVENT_SPACING_MS = 2;
const TAIL_MS = 140;
/** 两个音之间允许的最小间隔（毫秒）；小于该值的音会被判定为“游戏无法稳定识别”而跳过 */
const MIN_NOTE_SPACING_MS = 28;

function toSet(mods: readonly MouseButton[]): Set<MouseButton> {
  return new Set(mods);
}

/** 两个物理组合之间需要切换的鼠标键数量 */
export function modifierDiff(a: PhysicalCombo, b: PhysicalCombo): { releases: MouseButton[]; presses: MouseButton[] } {
  const setA = toSet(a.mods);
  const setB = toSet(b.mods);
  const releases: MouseButton[] = [];
  const presses: MouseButton[] = [];
  for (const mod of setA) if (!setB.has(mod)) releases.push(mod);
  for (const mod of setB) if (!setA.has(mod)) presses.push(mod);
  return { releases, presses };
}

interface ResolvedNote {
  targetMidi: number;
  midi: number;
  candidates: PhysicalCombo[];
  folded: boolean;
  outOfRange: boolean;
  sourceIndex: number;
  startBeat: number;
  durationBeats: number;
}

function resolveNotes(
  score: Score,
  transpose: number,
  instrument: HarmonicaInstrument,
  allowFold: boolean,
): ResolvedNote[] {
  const timed = toTimedNotes(score);
  const range = instrumentRange(instrument);
  return timed.notes.map((note, index) => {
    const targetMidi = note.midi + transpose;
    let midi = targetMidi;
    let folded = false;
    const outOfRange = targetMidi < range.min || targetMidi > range.max;
    if (outOfRange && allowFold) {
      const foldedResult = foldIntoRange(targetMidi, instrument);
      if (foldedResult) {
        midi = foldedResult.midi;
        folded = true;
      }
    }
    let candidates = combosForMidi(midi, instrument);
    if (candidates.length === 0 && allowFold) {
      // 理论上连续半音内不会发生；兜底再折返
      const fallback = foldIntoRange(midi, instrument, 4);
      if (fallback) {
        midi = fallback.midi;
        candidates = combosForMidi(midi, instrument);
        folded = true;
      }
    }
    return {
      targetMidi,
      midi,
      candidates,
      folded,
      outOfRange,
      sourceIndex: index,
      startBeat: note.startBeat,
      durationBeats: note.duration,
    };
  });
}

function transitionCost(prev: PhysicalCombo, next: PhysicalCombo): number {
  const diff = modifierDiff(prev, next);
  return (diff.releases.length + diff.presses.length) * 1.0 + next.modCount * 0.01;
}

/** 用 DP 选出修饰键切换最少的键位组合序列 */
function optimizeCombos(resolved: readonly ResolvedNote[]): { combos: PhysicalCombo[]; switchCount: number } {
  const combos: PhysicalCombo[] = [];
  if (resolved.length === 0) return { combos, switchCount: 0 };

  const layers = resolved.map((note) => note.candidates);
  if (layers.some((layer) => layer.length === 0)) throw new Error('存在没有可用键位组合的音符');

  let prevCosts = layers[0].map((combo, index) => combo.modCount + index * 1e-4);
  const backPointers: number[][] = [];

  for (let i = 1; i < layers.length; i += 1) {
    const candidates = layers[i];
    const costs = new Array<number>(candidates.length).fill(Number.POSITIVE_INFINITY);
    const backs = new Array<number>(candidates.length).fill(-1);
    for (let c = 0; c < candidates.length; c += 1) {
      const cur = candidates[c];
      for (let p = 0; p < layers[i - 1].length; p += 1) {
        if (!Number.isFinite(prevCosts[p])) continue;
        const cost = prevCosts[p] + transitionCost(layers[i - 1][p], cur);
        if (cost < costs[c]) {
          costs[c] = cost;
          backs[c] = p;
        }
      }
      costs[c] += c * 1e-4;
    }
    backPointers.push(backs);
    prevCosts = costs;
  }

  let bestLast = 0;
  for (let c = 1; c < prevCosts.length; c += 1) if (prevCosts[c] < prevCosts[bestLast]) bestLast = c;
  const chosen = new Array<number>(layers.length).fill(0);
  chosen[layers.length - 1] = bestLast;
  for (let i = layers.length - 1; i > 0; i -= 1) {
    chosen[i - 1] = backPointers[i - 1][chosen[i]];
  }
  let switchCount = 0;
  for (let i = 0; i < layers.length; i += 1) {
    combos.push(layers[i][chosen[i]]);
    if (i > 0) {
      const diff = modifierDiff(layers[i - 1][chosen[i - 1]], layers[i][chosen[i]]);
      switchCount += diff.presses.length + diff.releases.length;
    }
  }
  return { combos, switchCount };
}

export function evaluateTranspositions(score: Score, options: PlanOptions = {}): TransposeEvaluation[] {
  const instrument = options.instrument ?? DEFAULT_HARMONICA;
  const timed = toTimedNotes(score);
  const range = instrumentRange(instrument);
  const result: TransposeEvaluation[] = [];
  for (let transpose = -11; transpose <= 11; transpose += 1) {
    let outOfRangeCount = 0;
    let foldedCount = 0;
    let modifierCount = 0;
    let playableCount = 0;
    let rangeMin = Number.POSITIVE_INFINITY;
    let rangeMax = Number.NEGATIVE_INFINITY;
    for (const note of timed.notes) {
      const target = note.midi + transpose;
      let midi = target;
      let folded = false;
      if (target < range.min || target > range.max) {
        outOfRangeCount += 1;
        const foldedResult = foldIntoRange(target, instrument);
        if (foldedResult) {
          midi = foldedResult.midi;
          folded = true;
        }
      }
      const candidates = combosForMidi(midi, instrument);
      if (candidates.length > 0) {
        playableCount += 1;
        modifierCount += candidates[0].modCount;
        if (folded) foldedCount += 1;
      } else {
        modifierCount += 99;
      }
      rangeMin = Math.min(rangeMin, midi);
      rangeMax = Math.max(rangeMax, midi);
    }
    result.push({
      transpose,
      outOfRangeCount,
      foldedCount,
      modifierCount,
      playableCount,
      rangeMin: Number.isFinite(rangeMin) ? rangeMin : 0,
      rangeMax: Number.isFinite(rangeMax) ? rangeMax : 0,
    });
  }
  return result;
}

function pickAutoTranspose(score: Score, options: PlanOptions): number {
  const evaluations = evaluateTranspositions(score, options);
  const totalNotes = Math.max(1, toTimedNotes(score).notes.length);
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const evaluation of evaluations) {
    const unplayable = totalNotes - evaluation.playableCount;
    const scoreValue =
      unplayable * 10000 +
      evaluation.foldedCount * 40 +
      evaluation.modifierCount * 8 +
      Math.abs(evaluation.transpose) * 0.5;
    if (scoreValue < bestScore) {
      bestScore = scoreValue;
      best = evaluation.transpose;
    }
  }
  return best;
}

/** 乐谱 → 演奏计划（可预览、可注入） */
export function planPerformance(score: Score, options: PlanOptions = {}): PlaybackPlan {
  const instrument = options.instrument ?? DEFAULT_HARMONICA;
  const timing: TimingOptions = { ...DEFAULT_TIMING, ...(options.timing ?? {}) };
  const warnings: string[] = [];
  const tempo = Math.min(320, Math.max(20, options.tempoOverride ?? score.meta.tempo ?? 100));
  const beatMs = 60000 / tempo;
  const timed = toTimedNotes(score);
  warnings.push(...timed.warnings);

  if (timed.notes.length === 0) {
    return {
      events: [],
      notes: [],
      durationMs: 0,
      leadInMs: timing.leadInMs,
      tempo,
      beatMs,
      transpose: 0,
      instrumentId: instrument.id,
      warnings: [...warnings, '乐谱没有可演奏的音符'],
      stats: {
        noteCount: 0,
        modifierSwitchCount: 0,
        initialModifierCount: 0,
        finalModifierCount: 0,
        foldedCount: 0,
        outOfRangeCount: 0,
        fastTransitionCount: 0,
        droppedCount: 0,
        minHoldMsUsed: 0,
        maxHoldMsUsed: 0,
        meanHoldMs: 0,
        transpose: 0,
        rangeMin: 0,
        rangeMax: 0,
      },
    };
  }

  const transpose =
    options.transpose === 'auto' ? pickAutoTranspose(score, options) : Number.isFinite(options.transpose) ? Number(options.transpose) : 0;
  const allowFold = options.allowOctaveFold !== false;
  const resolvedRaw = resolveNotes(score, transpose, instrument, allowFold);

  const range = instrumentRange(instrument);
  const outOfRangeCount = resolvedRaw.filter((note) => note.outOfRange).length;
  const droppedOutOfRange = resolvedRaw.filter((note) => note.candidates.length === 0).length;
  if (outOfRangeCount > 0) {
    if (allowFold) {
      warnings.push(`有 ${outOfRangeCount} 个音超出可演奏音域 ${midiToName(range.min)}-${midiToName(range.max)}，已自动折返到相近八度`);
    } else {
      warnings.push(`有 ${outOfRangeCount} 个音超出可演奏音域，且已关闭八度折返：这些音会被跳过，建议整体移调`);
    }
  }

  // 过滤不可演奏音 + 节奏过密的音（保证生成的事件在物理上一定成立）
  const minGapBeats = MIN_NOTE_SPACING_MS / beatMs;
  const resolved: ResolvedNote[] = [];
  let droppedDense = 0;
  let previousStartBeat = Number.NEGATIVE_INFINITY;
  for (const note of resolvedRaw) {
    if (note.candidates.length === 0) continue;
    if (note.startBeat - previousStartBeat < minGapBeats - 1e-6) {
      droppedDense += 1;
      continue;
    }
    resolved.push(note);
    previousStartBeat = note.startBeat;
  }
  if (droppedDense > 0) {
    warnings.push(`有 ${droppedDense} 个音间隔过短（<${MIN_NOTE_SPACING_MS}ms，游戏无法稳定识别），已被跳过（可降低速度后重新生成）`);
  }
  const droppedCount = droppedOutOfRange + droppedDense;
  if (resolved.length === 0) {
    return {
      events: [],
      notes: [],
      durationMs: 0,
      leadInMs: timing.leadInMs,
      tempo,
      beatMs,
      transpose,
      instrumentId: instrument.id,
      warnings: [...warnings, '没有可演奏的音符（超出音域或节奏过密的音已被过滤）'],
      stats: {
        noteCount: 0,
        modifierSwitchCount: 0,
        initialModifierCount: 0,
        finalModifierCount: 0,
        foldedCount: 0,
        outOfRangeCount,
        fastTransitionCount: 0,
        droppedCount,
        minHoldMsUsed: 0,
        maxHoldMsUsed: 0,
        meanHoldMs: 0,
        transpose,
        rangeMin: 0,
        rangeMax: 0,
      },
    };
  }

  const { combos, switchCount } = optimizeCombos(resolved);
  const foldedCount = resolved.filter((note) => note.folded).length;

  // ---- 计算每个音的起止与保持时长 ----
  const starts: number[] = [];
  const holds: number[] = [];
  const noteUps: number[] = [];
  let fastTransitionCount = 0;
  for (let i = 0; i < resolved.length; i += 1) {
    const startMs = timing.leadInMs + resolved[i].startBeat * beatMs;
    starts.push(startMs);
    const durationMs = Math.max(10, resolved[i].durationBeats * beatMs);
    const next = resolved[i + 1];
    let hold = Math.max(timing.minNoteHoldMs, durationMs - timing.transitionGapMs);
    if (next) {
      const nextStart = timing.leadInMs + next.startBeat * beatMs;
      const diff = modifierDiff(combos[i], combos[i + 1]);
      // 有修饰键切换时才需要完整的稳定时间；无需切换时只留释放间隔
      const settleNeed = diff.presses.length > 0 ? timing.modifierSettleMs : MIN_SETTLE_MS;
      const transitionNeed =
        timing.modifierReleaseGapMs + EVENT_SPACING_MS * (diff.releases.length + diff.presses.length) + settleNeed;
      const maxHold = nextStart - startMs - transitionNeed;
      if (maxHold < hold) {
        if (maxHold < timing.minNoteHoldMs) fastTransitionCount += 1;
        hold = maxHold;
      }
    }
    // 即便低于最短保持时间也必须 < 下一个音的起点，否则会生成“和弦”
    hold = Math.max(4, Math.floor(hold));
    holds.push(hold);
    noteUps.push(startMs + hold);
  }
  if (fastTransitionCount > 0) {
    warnings.push(`有 ${fastTransitionCount} 处节奏过快，音符保持时间低于 ${timing.minNoteHoldMs}ms（已尽力压缩，建议降低速度）`);
  }

  // ---- 生成输入事件 ----
  const events: InputEvent[] = [];
  const pushEvent = (t: number, event: Omit<InputEvent, 't'>) => {
    events.push({ ...event, t: Math.max(0, Math.round(t)) });
  };
  let activeMods: MouseButton[] = [];
  let fastSettleCount = 0;

  for (let i = 0; i < resolved.length; i += 1) {
    const combo = combos[i];
    const targetMods = combo.mods;
    const releases = activeMods.filter((mod) => !targetMods.includes(mod));
    const presses = targetMods.filter((mod) => !activeMods.includes(mod));
    const startMs = starts[i];

    if (i === 0) {
      const settle = Math.min(timing.modifierSettleMs, Math.max(MIN_SETTLE_MS, startMs));
      let t = Math.max(0, startMs - settle);
      for (const mod of presses) {
        pushEvent(t, { kind: 'mousedown', label: `${mod} down`, button: mod });
        t += EVENT_SPACING_MS;
      }
    } else {
      const previousUp = noteUps[i - 1];
      let t = previousUp + timing.modifierReleaseGapMs;
      for (const mod of releases) {
        pushEvent(t, { kind: 'mouseup', label: `${mod} up`, button: mod });
        t += EVENT_SPACING_MS;
      }
      let pressAt = Math.max(t, startMs - timing.modifierSettleMs);
      for (const mod of presses) {
        pushEvent(pressAt, { kind: 'mousedown', label: `${mod} down`, button: mod });
        pressAt += EVENT_SPACING_MS;
      }
      if (presses.length > 0) {
        const settleActual = startMs - (pressAt - EVENT_SPACING_MS);
        if (settleActual < timing.modifierSettleMs - 4) fastSettleCount += 1;
      }
    }
    activeMods = [...targetMods];

    pushEvent(startMs, {
      kind: 'keydown',
      label: `${combo.keyLabel} down`,
      keyId: combo.keyId,
      vk: combo.vk,
      scan: combo.scan,
    });
    pushEvent(noteUps[i], {
      kind: 'keyup',
      label: `${combo.keyLabel} up`,
      keyId: combo.keyId,
      vk: combo.vk,
      scan: combo.scan,
    });
  }
  if (fastSettleCount > 0) {
    warnings.push(`有 ${fastSettleCount} 处修饰键稳定时间不足 ${timing.modifierSettleMs}ms（已尽力压缩）`);
  }

  // 收尾：释放全部鼠标修饰键
  let tail = noteUps[noteUps.length - 1] + timing.transitionGapMs + 2;
  for (const mod of activeMods) {
    pushEvent(tail, { kind: 'mouseup', label: `${mod} up`, button: mod });
    tail += EVENT_SPACING_MS;
  }

  const eventPriority: Record<InputEventKind, number> = { keyup: 0, mouseup: 1, mousedown: 2, keydown: 3 };
  events.sort((a, b) => a.t - b.t || eventPriority[a.kind] - eventPriority[b.kind]);

  const notes: PlannedNote[] = resolved.map((note, index) => {
    const combo = combos[index];
    return {
      index,
      targetMidi: note.targetMidi,
      midi: note.midi,
      midiName: midiToName(note.midi),
      startMs: starts[index],
      endMs: noteUps[index],
      holdMs: holds[index],
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      combo,
      folded: note.folded,
      outOfRange: note.outOfRange,
      keys: formatCombo(combo),
    };
  });

  const durationMs = tail + TAIL_MS;
  const holdsTotal = holds.reduce((sum, hold) => sum + hold, 0);
  const stats: PlanStats = {
    noteCount: resolved.length,
    modifierSwitchCount: switchCount,
    initialModifierCount: combos[0]?.modCount ?? 0,
    finalModifierCount: activeMods.length,
    foldedCount,
    outOfRangeCount,
    fastTransitionCount,
    droppedCount,
    minHoldMsUsed: holds.length ? Math.min(...holds) : 0,
    maxHoldMsUsed: holds.length ? Math.max(...holds) : 0,
    meanHoldMs: holds.length ? Math.round(holdsTotal / holds.length) : 0,
    transpose,
    rangeMin: notes.length ? Math.min(...notes.map((note) => note.midi)) : 0,
    rangeMax: notes.length ? Math.max(...notes.map((note) => note.midi)) : 0,
  };

  if (transpose !== 0) {
    warnings.push(`已移调 ${transpose > 0 ? '+' : ''}${transpose} 个半音（1=${midiToName(12 * (score.meta.baseOctave + 1) + score.meta.keyRoot + transpose).replace(/-?\d+$/, '')}）`);
  }

  return {
    events,
    notes,
    durationMs,
    leadInMs: timing.leadInMs,
    tempo,
    beatMs,
    transpose,
    instrumentId: instrument.id,
    warnings,
    stats,
  };
}

export interface PlanValidationIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** 校验计划的物理可行性（测试与自检用） */
export function validatePlan(plan: PlaybackPlan): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const pressedKeys = new Map<string, InputEvent>();
  const pressedButtons = new Set<MouseButton>();
  let previousT = -1;

  for (const event of plan.events) {
    if (event.t < 0) issues.push({ severity: 'error', message: `事件时间为负：${event.label}` });
    if (event.t < previousT) issues.push({ severity: 'error', message: `事件未按时间排序：${event.label}` });
    previousT = Math.max(previousT, event.t);

    if (event.kind === 'keydown') {
      const key = event.keyId ?? 'unknown';
      if (pressedKeys.has(key)) issues.push({ severity: 'error', message: `同一音键重复按下：${event.label}` });
      if (pressedKeys.size > 0) issues.push({ severity: 'error', message: `出现和弦（多个音键同时按下）：${event.label}` });
      pressedKeys.set(key, event);
    } else if (event.kind === 'keyup') {
      const key = event.keyId ?? 'unknown';
      if (!pressedKeys.has(key)) issues.push({ severity: 'error', message: `释放了未按下的音键：${event.label}` });
      pressedKeys.delete(key);
    } else if (event.kind === 'mousedown') {
      if (!event.button) issues.push({ severity: 'error', message: `鼠标事件缺少 button：${event.label}` });
      else if (pressedButtons.has(event.button)) issues.push({ severity: 'error', message: `鼠标键重复按下：${event.label}` });
      else pressedButtons.add(event.button);
    } else if (event.kind === 'mouseup') {
      if (!event.button || !pressedButtons.has(event.button)) {
        issues.push({ severity: 'error', message: `释放了未按下的鼠标键：${event.label}` });
      } else pressedButtons.delete(event.button);
    }
  }

  if (pressedKeys.size > 0) issues.push({ severity: 'error', message: '结束时仍有音键处于按下状态' });
  if (pressedButtons.size > 0) issues.push({ severity: 'error', message: '结束时仍有鼠标键处于按下状态' });

  // 每个音的按下时刻，检查修饰键状态是否正确
  for (const note of plan.notes) {
    const downEvent = plan.events.find(
      (event) => event.kind === 'keydown' && event.keyId === note.combo.keyId && Math.abs(event.t - note.startMs) <= 1,
    );
    if (!downEvent) {
      issues.push({ severity: 'error', message: `音符 ${note.index} 没有对应的按下事件` });
      continue;
    }
    const buttons = new Set<MouseButton>();
    for (const event of plan.events) {
      if (event.t > downEvent.t) break;
      if (event.kind === 'mousedown' && event.button) buttons.add(event.button);
      else if (event.kind === 'mouseup' && event.button) buttons.delete(event.button);
    }
    const expected = new Set(note.combo.mods);
    const actual = [...buttons].sort().join(',');
    const wanted = [...expected].sort().join(',');
    if (actual !== wanted) {
      issues.push({
        severity: 'error',
        message: `音符 ${note.index}（${note.keys}）按下的修饰键状态不对：期望 [${wanted}]，实际 [${actual}]`,
      });
    }
    if (note.holdMs < 10) issues.push({ severity: 'warning', message: `音符 ${note.index} 保持时间过短（${note.holdMs}ms）` });
  }

  if (plan.events.length === 0 && plan.notes.length > 0) {
    issues.push({ severity: 'error', message: '计划有音符但没有输入事件' });
  }
  return issues;
}
