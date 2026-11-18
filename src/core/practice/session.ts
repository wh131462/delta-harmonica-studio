/**
 * 练习会话（Practice Session）：把一份曲谱的某一段落，转换成「按时间排列、可直接判定」的练习目标。
 *
 * 与演奏编排（instrument/plan）的区别：
 * - 练习只关心「第几拍该按出哪个音」和「推荐按法」，不生成键鼠注入事件；
 * - 支持按小节切片、变速、移调与八度折返，供慢速 / 循环 / 等待模式练习；
 * - 附带的节拍器点击时间轴与界面轨道共用同一份毫秒时间轴，保证听、看、判一致。
 *
 * 纯 TypeScript：不依赖 Electron / DOM，可直接在 Node 中单测。
 */
import type { Meter, Score } from '../model/score';
import { EPSILON, meterBeats, scoreEndBeat } from '../model/score';
import { toTimedNotes } from '../music/timeline';
import {
  DEFAULT_HARMONICA,
  bestCombo,
  foldIntoRange,
  formatCombo,
  instrumentRange,
  type HarmonicaInstrument,
} from '../model/instrument';
import { midiToName, midiToWritten } from '../model/pitch';

export type PracticeMode = 'timing' | 'wait';

/** 速度倍率的安全范围；界面只暴露 50%–125%。 */
export const PRACTICE_SPEED_MIN = 0.25;
export const PRACTICE_SPEED_MAX = 2;
export const PRACTICE_SPEED_DEFAULT = 0.8;

/** 预备拍的目标时长：拍子越慢，预备拍数越少，避免开始前等太久。 */
const COUNT_IN_TARGET_MS = 2400;

export interface PracticeOptions {
  /** 速度倍率（1 = 原速） */
  speed?: number;
  /** 起始小节，1 起（默认 1） */
  startBar?: number;
  /** 结束小节，含端点；null / 省略 = 到曲末 */
  endBar?: number | null;
  /** 移调半音数（与演奏台共用），默认 0 */
  transpose?: number;
  /** 超音域时是否八度折返（默认 true，与演奏台一致） */
  allowOctaveFold?: boolean;
  instrument?: HarmonicaInstrument;
}

export interface PracticeStep {
  /** 在会话内的顺序，从 0 开始 */
  index: number;
  /** 稳定标识：取该音（连音时为首个音）的曲谱音符 id */
  id: string;
  /** 绝对小节号（1 起） */
  bar: number;
  /** 小节内拍位（0 起） */
  beatInBar: number;
  /** 相对会话起点的拍位（0 = 预备结束后的第一拍） */
  startBeat: number;
  /** 时值（拍），已按段落终点截断 */
  durationBeats: number;
  /** 实际发声的 MIDI（已移调、已折返） */
  midi: number;
  /** 移调后、折返前的目标 MIDI */
  targetMidi: number;
  /** 是否因超出音域折返了八度 */
  folded: boolean;
  /** 是否超出音域（折返前） */
  outOfRange: boolean;
  /** 是否由连音线合并而来 */
  tied: boolean;
  /** 按实际发声音高换算的简谱写法（移调后调号） */
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  accidental: -1 | 0 | 1;
  /** 简谱八度偏移：0 = 中音，+1 = 高音（点在上方） */
  octave: number;
  /** 音名，例如 C4 / F#5 */
  noteName: string;
  /** 推荐物理按法（修饰键最少），例如 ↑Z、↓#V、, */
  keys: string;
  /** 目标时刻（毫秒，含预备拍；0 = 练习按钮按下后的瞬间） */
  timeMs: number;
  /** 从按下到判定线的时间（毫秒），= timeMs - leadInMs */
  hitOffsetMs: number;
  /** 建议保持时长（毫秒），仅用于轨道显示 */
  holdMs: number;
}

export interface PracticeClick {
  /** 毫秒时间轴，与 step.timeMs 同一坐标系 */
  t: number;
  /** 小节重拍 / 预备第一拍 */
  accent: boolean;
}

export interface PracticeSession {
  scoreId: string;
  title: string;
  steps: PracticeStep[];
  clicks: PracticeClick[];
  startBar: number;
  endBar: number;
  barCount: number;
  /** 段落包含的小节数 */
  segmentBars: number;
  meter: Meter;
  measureBeats: number;
  /** 曲谱原始速度 */
  scoreTempo: number;
  /** 练习实际速度（原始速度 × 倍率） */
  tempo: number;
  speed: number;
  beatMs: number;
  countInBeats: number;
  leadInMs: number;
  totalBeats: number;
  durationMs: number;
  transpose: number;
  warnings: string[];
}

/** 曲谱共有多少小节（按拍号向上取整，至少 1 小节）。 */
export function scoreBarCount(score: Score): number {
  const measure = Math.max(0.5, meterBeats(score.meta.meter));
  const end = scoreEndBeat(score);
  if (!(end > EPSILON)) return 1;
  return Math.max(1, Math.ceil((end - EPSILON) / measure));
}

export function clampSpeed(speed: number | undefined): number {
  if (!Number.isFinite(speed)) return PRACTICE_SPEED_DEFAULT;
  return Math.min(PRACTICE_SPEED_MAX, Math.max(PRACTICE_SPEED_MIN, Number(speed)));
}

function clampBar(value: number | null | undefined, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 移调后的简谱基准（只影响练习轨道上显示的级数 / 八度点）。 */
export function transposedWrittenMeta(
  meta: Pick<Score['meta'], 'keyRoot' | 'baseOctave'>,
  transpose: number,
): { keyRoot: number; baseOctave: number } {
  const raw = meta.keyRoot + transpose;
  return {
    keyRoot: ((raw % 12) + 12) % 12,
    baseOctave: meta.baseOctave + Math.floor(raw / 12),
  };
}

function isDownbeat(beat: number, measureBeats: number): boolean {
  if (!(measureBeats > 0)) return beat === 0;
  const remainder = Math.abs(beat % measureBeats);
  return remainder < 1e-6 || Math.abs(remainder - measureBeats) < 1e-6;
}

/**
 * 构建练习会话。
 *
 * 切片规则：只保留「起点落在 [起始小节, 结束小节)」内的音符；跨小节延续到段落外的音不再计入，
 * 以免练习段落的判定线出现无法按出的幻觉音。连音在切片内仍会合并。
 */
export function buildPracticeSession(score: Score, options: PracticeOptions = {}): PracticeSession {
  const instrument = options.instrument ?? DEFAULT_HARMONICA;
  const warnings: string[] = [];
  const pushWarning = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const measure = Math.max(0.5, meterBeats(score.meta.meter));
  const barCount = scoreBarCount(score);
  const startBar = clampBar(options.startBar, 1, 1, barCount);
  const endBar = clampBar(options.endBar ?? barCount, barCount, startBar, barCount);
  const segmentBars = endBar - startBar + 1;
  const segmentStartBeat = (startBar - 1) * measure;
  const segmentEndBeat = endBar * measure;

  const speed = clampSpeed(options.speed);
  const scoreTempo = Math.min(320, Math.max(20, Number(score.meta.tempo) || 100));
  const tempo = scoreTempo * speed;
  const beatMs = 60000 / tempo;
  const countInBeats = Math.max(1, Math.min(measure, Math.ceil(COUNT_IN_TARGET_MS / beatMs)));
  const leadInMs = countInBeats * beatMs;

  const transpose = Number.isFinite(options.transpose) ? Math.round(Number(options.transpose)) : 0;
  const allowFold = options.allowOctaveFold !== false;
  const writtenMeta = transposedWrittenMeta(score.meta, transpose);
  const range = instrumentRange(instrument);

  const slicedNotes = (score.notes ?? [])
    .filter((note) => {
      if (!Number.isFinite(note.startBeat) || !(note.duration > 0)) return false;
      return note.startBeat >= segmentStartBeat - EPSILON && note.startBeat < segmentEndBeat - EPSILON;
    })
    .map((note) => ({ ...note, startBeat: note.startBeat - segmentStartBeat }))
    .sort((a, b) => a.startBeat - b.startBeat);

  const sliced: Score = { ...score, notes: slicedNotes };
  const timed = slicedNotes.length > 0 ? toTimedNotes(sliced) : { notes: [], totalBeats: 0, warnings: [] };
  for (const warning of timed.warnings) pushWarning(warning);

  const steps: PracticeStep[] = [];
  let foldedCount = 0;
  let skippedCount = 0;

  for (const timedNote of timed.notes) {
    if (timedNote.midi === null || timedNote.midi < 0) continue;
    const targetMidi = timedNote.midi + transpose;
    let midi = targetMidi;
    let folded = false;
    const outOfRange = targetMidi < range.min || targetMidi > range.max;
    if (outOfRange && allowFold) {
      const foldedResult = foldIntoRange(targetMidi, instrument);
      if (foldedResult) {
        midi = foldedResult.midi;
        folded = foldedResult.octaves !== 0;
      }
    }
    const combo = bestCombo(midi, instrument);
    if (!combo) {
      skippedCount += 1;
      continue;
    }
    if (folded) foldedCount += 1;

    const sourceNote = sliced.notes[timedNote.sourceIndices[0]];
    const written = midiToWritten(midi, writtenMeta);
    const startBeat = Math.max(0, timedNote.startBeat);
    const durationBeats = Math.max(0.05, Math.min(timedNote.duration, segmentEndBeat - segmentStartBeat - startBeat));
    const timeMs = leadInMs + startBeat * beatMs;
    steps.push({
      index: steps.length,
      id: sourceNote?.id ?? `practice-${steps.length}`,
      bar: Math.floor(timedNote.startBeat / measure + EPSILON) + startBar,
      beatInBar: Number((timedNote.startBeat % measure).toFixed(6)),
      startBeat,
      durationBeats,
      midi,
      targetMidi,
      folded,
      outOfRange,
      tied: timedNote.tied,
      degree: written.degree,
      accidental: written.accidental,
      octave: written.octave,
      noteName: midiToName(midi),
      keys: formatCombo(combo),
      timeMs,
      hitOffsetMs: timeMs - leadInMs,
      holdMs: durationBeats * beatMs,
    });
  }

  if (foldedCount > 0) {
    pushWarning(`有 ${foldedCount} 个音超出可演奏音域 ${midiToName(range.min)}-${midiToName(range.max)}，已自动折返到相近八度`);
  }
  if (skippedCount > 0) {
    pushWarning(`有 ${skippedCount} 个音无法在当前键位下演奏，已从本次练习中跳过`);
  }
  if (steps.length === 0) {
    pushWarning('所选段落没有可练习的音符，换一个段落或在简谱编辑器补充音符');
  }

  const totalBeats = segmentEndBeat - segmentStartBeat;
  const durationMs = leadInMs + totalBeats * beatMs;

  const clicks: PracticeClick[] = [];
  for (let beat = 0; beat < countInBeats - 1e-6; beat += 1) {
    clicks.push({ t: beat * beatMs, accent: beat === 0 });
  }
  for (let beat = 0; beat < totalBeats - 1e-6; beat += 1) {
    clicks.push({ t: leadInMs + beat * beatMs, accent: isDownbeat(beat, measure) });
  }

  return {
    scoreId: score.id,
    title: score.meta.title || '未命名',
    steps,
    clicks,
    startBar,
    endBar,
    barCount,
    segmentBars,
    meter: { ...score.meta.meter },
    measureBeats: measure,
    scoreTempo,
    tempo,
    speed,
    beatMs,
    countInBeats,
    leadInMs,
    totalBeats,
    durationMs,
    transpose,
    warnings,
  };
}
