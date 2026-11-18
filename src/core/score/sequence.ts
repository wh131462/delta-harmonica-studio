/**
 * 顺序音符编辑（可视化编辑器使用）—— 纯函数，可在 Node 中直接单测。
 *
 * 简谱口琴是单声部乐器。可视化编辑器不再让用户直接填「起始拍 / 时值」，
 * 而是把乐谱看成一条连续的「音符 / 休止」序列：每个音只记录音级、八度、
 * 升降和时值，起始拍由前面所有时值累加得到。于是：
 *
 * - 插入一个音 = 后面的音整体后移，不会与已有音符重叠；
 * - 删除 / 改时值 = 后面的音整体前移或后移，小节线随时值自动重排；
 * - MIDI / 音频导入留下的时间空档会补成休止符（保存时写成显式 `0`，
 *   听感与原来完全一致）；
 * - 如果有非单声部的重叠音符，后面的音会被顺序后移，并通过 overlapCount
 *   报告，让页面提示用户。
 */

import {
  createId,
  createNote,
  normalizeScore,
  nowIso,
  type Accidental,
  type Degree,
  type Score,
  type ScoreNote,
} from '../model/score';

/** 与模型校验一致的最短时值（拍） */
export const MIN_STEP_BEATS = 0.05;

/** 时值键盘的基准时值：全音符 / 二分 / 四分 / 八分 / 十六分 */
export const DURATION_BASES = [4, 2, 1, 0.5, 0.25] as const;
export type DurationBase = (typeof DURATION_BASES)[number];

/** 序列中的一个音符或休止符（不含绝对拍位） */
export interface ScoreStep {
  id: string;
  degree: Degree;
  accidental: Accidental;
  /** 相对基础八度的偏移（0 = 中音） */
  octave: number;
  /** 时值，单位：拍（四分音符 = 1 拍） */
  duration: number;
  tie: boolean;
  lyric?: string;
}

/** 乐谱 → 顺序序列的转换结果 */
export interface SequenceConversion {
  steps: ScoreStep[];
  /** 为补齐时间空档而补出的休止符数量 */
  syntheticRestCount: number;
  /** 因单声部限制被后移的重叠音符数量 */
  overlapCount: number;
  /** 原谱本身是否已经是无空档 / 无重叠的顺序谱 */
  direct: boolean;
}

/** 时值键盘的选中状态 */
export interface DurationChoice {
  /** 命中的基准时值；不常见时值会原样返回 */
  base: number;
  /** 是否附点（×1.5） */
  dotted: boolean;
  /** 是否是键盘上的标准时值 */
  known: boolean;
}

const EPS = 1e-6;
const ROUND = 6;

function roundBeat(value: number): number {
  return Number(value.toFixed(ROUND));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 把任意时值收敛到模型允许的范围 */
export function clampStepDuration(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(64, Math.max(MIN_STEP_BEATS, roundBeat(value)));
}

/** 规范化一个音符体（音级 / 升降 / 八度 / 连音合法性） */
export function normalizeStep(input: Partial<ScoreStep> & { degree?: Degree }): ScoreStep {
  const degree = clampInt(input.degree, 0, 7, 1) as Degree;
  const rest = degree === 0;
  const step: ScoreStep = {
    id: input.id && input.id.length > 0 ? input.id : createId('n'),
    degree,
    accidental: rest ? 0 : (clampInt(input.accidental, -1, 1, 0) as Accidental),
    octave: rest ? 0 : clampInt(input.octave, -4, 4, 0),
    duration: clampStepDuration(Number(input.duration ?? 1)),
    tie: !rest && input.tie === true,
    ...(typeof input.lyric === 'string' && input.lyric !== '' ? { lyric: input.lyric } : {}),
  };
  return step;
}

/** 新建一个音符 / 休止符（编辑器键盘使用） */
export function createStep(partial: Partial<ScoreStep> = {}): ScoreStep {
  return normalizeStep({ degree: 1, ...partial });
}

function stepFromNote(note: ScoreNote): ScoreStep {
  return normalizeStep({
    id: note.id,
    degree: note.degree,
    accidental: note.accidental,
    octave: note.octave,
    duration: note.duration,
    tie: note.tie,
    ...(typeof note.lyric === 'string' ? { lyric: note.lyric } : {}),
  });
}

/**
 * 乐谱 → 顺序序列。
 *
 * 时间空档补成休止符；重叠音符后移并在 overlapCount 中计数。
 * 不会修改传入的乐谱。
 */
export function scoreToSteps(score: Score): SequenceConversion {
  const rawNotes = Array.isArray(score?.notes) ? score.notes : [];
  const sorted = rawNotes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => Number(a.note?.startBeat ?? 0) - Number(b.note?.startBeat ?? 0) || a.index - b.index)
    .map((item) => item.note);

  const steps: ScoreStep[] = [];
  let cursor = 0;
  let syntheticRestCount = 0;
  let overlapCount = 0;

  for (const raw of sorted) {
    if (!raw || typeof raw !== 'object') continue;
    const startInput = Number(raw.startBeat);
    const durationInput = Number(raw.duration);
    if (!Number.isFinite(startInput) || !Number.isFinite(durationInput)) continue;

    const start = Math.max(0, startInput);
    const duration = clampStepDuration(durationInput);
    const gap = roundBeat(start - cursor);

    if (gap >= MIN_STEP_BEATS - EPS) {
      // 空档：补一个休止符，保证后续编辑仍然是从左到右的连续序列。
      // id 由空档起点派生，保证元信息变化（速度/拍号）重新转换时选中状态不丢。
      steps.push(
        createStep({
          id: `auto-rest-${roundBeat(cursor)}`,
          degree: 0,
          duration: gap,
        }),
      );
      syntheticRestCount += 1;
      cursor = roundBeat(cursor + gap);
    } else if (gap > EPS) {
      // 极短空档（< 0.05 拍）并入前一个音符，避免出现无法编辑的碎片
      const last = steps[steps.length - 1];
      if (last) {
        last.duration = clampStepDuration(last.duration + gap);
        cursor = roundBeat(cursor + gap);
      }
    } else if (gap < -MIN_STEP_BEATS) {
      // 重叠：按单声部顺序后移
      overlapCount += 1;
    }

    steps.push(stepFromNote(raw));
    cursor = roundBeat(cursor + duration);
  }

  return {
    steps,
    syntheticRestCount,
    overlapCount,
    direct: syntheticRestCount === 0 && overlapCount === 0,
  };
}

/**
 * 顺序序列 → 乐谱。保持 base 的 id / 元信息 / 来源，起始拍按时值累加。
 * 会经过 normalizeScore（排序、夹取值域、清理失效连音）。
 */
export function stepsToScore(steps: readonly ScoreStep[], base: Score): Score {
  let cursor = 0;
  const notes: ScoreNote[] = [];

  for (const raw of steps) {
    const step = normalizeStep(raw);
    const note = createNote({
      id: step.id,
      degree: step.degree,
      accidental: step.accidental,
      octave: step.octave,
      duration: step.duration,
      startBeat: roundBeat(cursor),
      tie: step.tie,
      ...(step.lyric !== undefined ? { lyric: step.lyric } : {}),
    });
    notes.push(note);
    cursor = roundBeat(cursor + step.duration);
  }

  return normalizeScore({ ...base, notes, updatedAt: nowIso() }).score;
}

/** 每个序列项的起始拍（与 durations 前缀和一致） */
export function stepsStartBeats(steps: readonly ScoreStep[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const step of steps) {
    starts.push(roundBeat(cursor));
    cursor = roundBeat(cursor + clampStepDuration(step.duration));
  }
  return starts;
}

/** 序列总拍数 */
export function stepsTotalBeats(steps: readonly ScoreStep[]): number {
  let total = 0;
  for (const step of steps) total += clampStepDuration(step.duration);
  return roundBeat(total);
}

/** 序列中有音高的音符数量（不含休止符） */
export function countSoundingSteps(steps: readonly ScoreStep[]): number {
  let count = 0;
  for (const step of steps) if (step.degree !== 0) count += 1;
  return count;
}

/** 时值 → 键盘基准 + 附点状态 */
export function durationChoice(duration: number): DurationChoice {
  const value = clampStepDuration(duration);
  for (const base of DURATION_BASES) {
    if (Math.abs(value - base) < EPS) return { base, dotted: false, known: true };
    if (Math.abs(value - base * 1.5) < EPS) return { base, dotted: true, known: true };
  }
  return { base: value, dotted: false, known: false };
}

const FRACTION_GLYPHS: Record<string, string> = {
  '0.125': '⅛',
  '0.25': '¼',
  '0.375': '⅜',
  '0.5': '½',
  '0.625': '⅝',
  '0.75': '¾',
  '0.875': '⅞',
};

/** 拍数 → 简短的拍数标签（1拍 / ½拍 / 1½拍 / 1/16拍） */
export function beatLabel(duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return '0拍';
  const value = clampStepDuration(duration);
  const whole = Math.floor(value + EPS);
  const fraction = roundBeat(value - whole);
  if (fraction <= EPS) return `${whole}拍`;
  const glyph = FRACTION_GLYPHS[String(fraction)];
  if (glyph) return `${whole > 0 ? whole : ''}${glyph}拍`;
  // 1/16 量化网格会产生 1/16、3/16… 这类时值，用分数显示比小数更清楚
  const sixteenths = Math.round(fraction * 16);
  if (sixteenths > 0 && Math.abs(fraction - sixteenths / 16) < 1e-6) {
    return `${whole > 0 ? `${whole} ` : ''}${sixteenths}/16拍`;
  }
  return `${Number(value.toFixed(2))}拍`;
}

const SOLFEGE = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'] as const;

/** 音级唱名（休止符返回空字符串） */
export function stepSolfege(step: Pick<ScoreStep, 'degree'>): string {
  if (step.degree === 0) return '';
  return SOLFEGE[step.degree - 1] ?? '';
}

/** 音高的简短中文描述（用于选中状态 / tooltip） */
export function stepPitchLabel(step: Pick<ScoreStep, 'degree' | 'accidental' | 'octave'>): string {
  if (step.degree === 0) return '休止';
  const accidental = step.accidental === 1 ? '♯' : step.accidental === -1 ? '♭' : '';
  if (step.octave === 0) return `${accidental}${step.degree}`;
  const octaveText =
    step.octave === 1
      ? '高八度'
      : step.octave === -1
        ? '低八度'
        : step.octave > 0
          ? `高 ${step.octave} 个八度`
          : `低 ${-step.octave} 个八度`;
  return `${accidental}${step.degree}（${octaveText}）`;
}

/** 无障碍 / tooltip 用的一句话描述 */
export function stepAriaLabel(step: Pick<ScoreStep, 'degree' | 'accidental' | 'octave' | 'duration' | 'tie'>): string {
  const beats = beatLabel(step.duration);
  if (step.degree === 0) return `休止，${beats}`;
  const tie = step.tie ? '，连到下一个同音' : '';
  return `${stepPitchLabel(step)}，${stepSolfege(step)}，${beats}${tie}`;
}

/** 第 index 个音能否连到下一个（同音高、紧邻、都不是休止） */
export function canTie(steps: readonly ScoreStep[], index: number): boolean {
  const current = steps[index];
  const next = steps[index + 1];
  if (!current || !next) return false;
  if (current.degree === 0 || next.degree === 0) return false;
  return (
    current.degree === next.degree &&
    current.accidental === next.accidental &&
    current.octave === next.octave
  );
}

/** 清理失效的连音线（改音高 / 删除相邻音后调用） */
export function sanitizeTies(steps: readonly ScoreStep[]): ScoreStep[] {
  return steps.map((step, index) => {
    if (!step.tie) return step;
    return canTie(steps, index) ? step : { ...step, tie: false };
  });
}

/** 在指定位置插入一个音（数组下标，0..steps.length） */
export function insertStepAt(steps: readonly ScoreStep[], index: number, step: ScoreStep): ScoreStep[] {
  const safeIndex = Math.min(steps.length, Math.max(0, Math.round(index)));
  const next = [...steps.slice(0, safeIndex), normalizeStep(step), ...steps.slice(safeIndex)];
  return sanitizeTies(next);
}

/** 删除指定位置的音 */
export function removeStepAt(steps: readonly ScoreStep[], index: number): ScoreStep[] {
  if (index < 0 || index >= steps.length) return [...steps];
  const next = [...steps.slice(0, index), ...steps.slice(index + 1)];
  return sanitizeTies(next);
}

/** 修改指定位置的音（连音会按新的音高重新校验） */
export function updateStepAt(steps: readonly ScoreStep[], index: number, patch: Partial<ScoreStep>): ScoreStep[] {
  const current = steps[index];
  if (!current) return [...steps];
  const next = steps.map((step, i) => {
    if (i !== index) return step;
    const merged = { ...step, ...patch };
    // 把编辑器补出的休止符改成真实音符时换一个普通音符 id，
    // 避免以后在同一个拍位再补休止符时与它撞 id。
    if (step.degree === 0 && merged.degree !== 0 && merged.id.startsWith('auto-rest-')) {
      merged.id = createId('n');
    }
    return normalizeStep(merged);
  });
  return sanitizeTies(next);
}


