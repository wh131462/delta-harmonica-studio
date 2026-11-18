/**
 * 实时录入：把「按键时间戳」转换成顺序简谱。
 *
 * 输入是单声部录音（每个音有 MIDI 音高、开始/结束毫秒），输出是编辑器使用的
 * ScoreStep 序列：
 * - 起始拍 / 时值按当前 BPM 换算，并量化到指定网格（1/4、1/8、1/16 拍）；
 * - 音与音之间的空档补成休止符，间隔小于半格时并入前一个音，避免碎片；
 * - 音高按当前曲谱的 1=? 与基础八度写成简谱级数 / 升降 / 八度；
 * - 超出简谱 ±4 八度范围的音会被就近夹取并计数，供界面提示。
 *
 * 纯函数，不依赖 DOM / Electron，可直接单测。
 */
import { midiToWritten } from '../model/pitch';
import type { ScoreMeta } from '../model/score';
import { createStep, type ScoreStep } from './sequence';

export interface TimedRecordedNote {
  /** MIDI 音高（四舍五入到整数） */
  midi: number;
  /** 相对录音起点，毫秒 */
  startMs: number;
  /** 相对录音起点，毫秒 */
  endMs: number;
}

export interface RecordToStepsOptions {
  /** 用于把 MIDI 写成简谱的调号与基础八度 */
  meta: Pick<ScoreMeta, 'keyRoot' | 'baseOctave'>;
  /** 每分钟四分音符数 */
  tempo: number;
  /** 量化网格（拍），默认 0.25；范围 0.0625～4 */
  grid?: number;
  /** 生成的 step id 前缀，确保多次录入不会撞 id */
  idPrefix?: string;
}

export interface RecordToStepsResult {
  steps: ScoreStep[];
  /** 因量化 / 重叠被移动或缩短的音符数量 */
  shiftedCount: number;
  /** 超出简谱 ±4 八度范围、被就近夹取的音符数量 */
  outOfRangeCount: number;
  warnings: string[];
}

const EPS = 1e-6;
const DEFAULT_GRID = 0.25;
const MIN_GRID = 0.0625;
const MAX_GRID = 4;

function roundBeat(value: number): number {
  return Number(value.toFixed(6));
}

function clampTempo(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(320, Math.max(20, value));
}

function clampGrid(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_GRID;
  return Math.min(MAX_GRID, Math.max(MIN_GRID, value));
}

/** 时间戳录音 → 简谱序列 */
export function recordedNotesToSteps(
  notes: readonly TimedRecordedNote[],
  options: RecordToStepsOptions,
): RecordToStepsResult {
  const tempo = clampTempo(options.tempo);
  const grid = clampGrid(options.grid);
  const idPrefix = options.idPrefix && options.idPrefix.length > 0 ? options.idPrefix : 'record';
  const beatMs = 60000 / tempo;

  const sorted = notes
    .filter(
      (note) =>
        Number.isFinite(note.midi) && Number.isFinite(note.startMs) && Number.isFinite(note.endMs),
    )
    .map((note) => ({
      midi: Math.round(note.midi),
      startMs: Math.max(0, note.startMs),
      endMs: Math.max(0, note.endMs),
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const steps: ScoreStep[] = [];
  let cursor = 0;
  let shiftedCount = 0;
  let outOfRangeCount = 0;

  const quantize = (beats: number): number => roundBeat(Math.round(beats / grid) * grid);

  for (let index = 0; index < sorted.length; index += 1) {
    const note = sorted[index] as TimedRecordedNote;
    const rawStart = quantize(note.startMs / beatMs);
    const nextRawStart =
      index + 1 < sorted.length ? quantize((sorted[index + 1] as TimedRecordedNote).startMs / beatMs) : null;

    let start = rawStart;
    if (start < cursor - EPS) {
      // 量化后与前一个音重叠：后移，并记录调整次数
      shiftedCount += 1;
      start = cursor;
    }

    // 空档：>= 半格补休止；更小的空档并入前一个音，避免出现无法编辑的碎片
    const gap = roundBeat(start - cursor);
    if (gap >= grid / 2 - EPS) {
      steps.push(createStep({ id: `${idPrefix}-rest-${index}`, degree: 0, duration: gap }));
      cursor = roundBeat(cursor + gap);
    } else if (gap > EPS && steps.length > 0) {
      const last = steps[steps.length - 1] as ScoreStep;
      last.duration = roundBeat(last.duration + gap);
      cursor = roundBeat(cursor + gap);
    }

    // 结束拍：量化，且不超过下一个音的起点；最短保留一个网格
    let end = quantize(note.endMs / beatMs);
    if (nextRawStart !== null) {
      const limit = Math.max(start + grid, nextRawStart);
      if (end > limit + EPS) {
        end = limit;
        shiftedCount += 1;
      }
    }
    let duration = roundBeat(Math.max(grid, end - start));
    if (nextRawStart !== null && nextRawStart > start + EPS && nextRawStart < start + duration - EPS) {
      duration = roundBeat(Math.max(grid, nextRawStart - start));
    }

    const written = midiToWritten(note.midi, options.meta);
    if (written.octave < -4 || written.octave > 4) outOfRangeCount += 1;
    steps.push(
      createStep({
        id: `${idPrefix}-${index}`,
        degree: written.degree,
        accidental: written.accidental,
        octave: written.octave,
        duration,
        tie: false,
      }),
    );
    cursor = roundBeat(start + duration);
  }

  const warnings: string[] = [];
  if (shiftedCount > 0) warnings.push(`${shiftedCount} 个音因量化或重叠被调整了位置/长度`);
  if (outOfRangeCount > 0) warnings.push(`${outOfRangeCount} 个音超出简谱八度范围，已就近调整`);
  return { steps, shiftedCount, outOfRangeCount, warnings };
}

/** 录音总时长（拍），用于界面展示 */
export function recordedNotesTotalBeats(
  notes: readonly Pick<TimedRecordedNote, 'startMs' | 'endMs'>[],
  tempo: number,
): number {
  const beatMs = 60000 / clampTempo(tempo);
  let endMs = 0;
  for (const note of notes) endMs = Math.max(endMs, Number.isFinite(note.endMs) ? note.endMs : 0);
  return roundBeat(endMs / beatMs);
}
