/**
 * 把「带时间的原始旋律音符」转换成简谱 Score：
 * - 量化到节拍网格
 * - 修正重叠 / 过短音符
 * - 检测调性、自动选择基础八度
 * - 生成 MIDI / 音频导入共用的乐谱
 */
import {
  EPSILON,
  createEmptyScore,
  createNote,
  normalizeScore,
  nowIso,
  type Meter,
  type Score,
  type ScoreNote,
  type ScoreSource,
} from '../model/score';
import { detectKey, type KeyDetection } from '../music/keydetect';
import { midiToWritten } from '../model/pitch';
import {
  melodyDensityLabel,
  simplifyMelodyNotes,
  type MelodyDensity,
  type MelodySimplifyStats,
} from '../music/melody-simplify';

export interface RawMelodyNote {
  midi: number;
  /** 秒 */
  startSec: number;
  /** 秒 */
  durSec: number;
  /** 0-1 */
  confidence?: number;
}

export interface MelodyToScoreOptions {
  title: string;
  /** 每分钟四分音符数 */
  tempo: number;
  meter?: Meter;
  /** 量化网格（单位：拍；0.25 = 十六分音符；0 = 不量化） */
  quantizeGrid?: number;
  /** 指定调号（0-11）；不传则自动检测 */
  keyRoot?: number;
  baseOctave?: number;
  source?: Partial<ScoreSource>;
  /** 来源类型（默认 midi；音频导入请传 audio） */
  sourceKind?: ScoreSource['kind'];
  /** 是否移除置信度过低的音符 */
  minConfidence?: number;
  maxNotes?: number;
  /**
   * 音频主旋律的“可演奏化”密度：宽松（每拍 1 音）/ 标准（每拍最多 2 音）/ 精细（保留 1/16 细节）。
   * 不传时保持原有的逐音量化行为（MIDI 导入走这条路径）。
   */
  density?: MelodyDensity;
}

export interface MelodyToScoreResult {
  score: Score;
  warnings: string[];
  key: KeyDetection;
  /** 量化前的拍位（便于 UI 展示原始时间） */
  rawBeats: Array<{ startBeat: number; duration: number; midi: number }>;
  /** 音频密度精简统计（未启用 density 时为 undefined） */
  simplifyStats?: MelodySimplifyStats;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function autoBaseOctave(medianMidi: number, keyRoot: number): number {
  // 让中位音高落在简谱“中音区”（octave = 0）
  const octave = Math.floor((medianMidi - keyRoot) / 12) - 1;
  return clampNumber(octave, 1, 7);
}

/** 量化时值到网格的“自然写法”候选，优先附着常用时值 */
export function quantizeDuration(beats: number, grid: number): number {
  if (grid <= 0) return beats;
  const snapped = Math.round(beats / grid) * grid;
  return Math.max(grid, snapped);
}

export function melodyToScore(rawNotes: readonly RawMelodyNote[], options: MelodyToScoreOptions): MelodyToScoreResult {
  const warnings: string[] = [];
  const rawGrid = options.quantizeGrid ?? 0.25;
  const grid = Number.isFinite(rawGrid) && rawGrid > 0 ? rawGrid : 0;
  const minConfidence = options.minConfidence ?? 0;
  const tempo = clampNumber(options.tempo || 100, 20, 320);
  const meter: Meter = options.meter ?? { num: 4, den: 4 };
  const secPerBeat = 60 / tempo;

  const cleaned = [...rawNotes]
    .filter((note) => Number.isFinite(note.midi) && Number.isFinite(note.startSec) && Number.isFinite(note.durSec))
    .filter((note) => note.durSec >= 0.03 && note.midi >= 12 && note.midi <= 120)
    .filter((note) => (note.confidence ?? 1) >= minConfidence)
    .sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);

  if (cleaned.length === 0) {
    throw new Error('没有可用的旋律音符（可能是静音、噪声过大或解析失败）');
  }
  if (cleaned.length > (options.maxNotes ?? 6000)) {
    warnings.push(`音符数量过多（${cleaned.length}），已截断到前 ${options.maxNotes ?? 6000} 个`);
    cleaned.length = options.maxNotes ?? 6000;
  }

  // 调性检测（按时值加权）
  const key = options.keyRoot !== undefined
    ? {
        tonic: options.keyRoot,
        mode: 'major' as const,
        keyRoot: ((options.keyRoot % 12) + 12) % 12,
        confidence: 1,
        candidates: [],
      }
    : detectKey(cleaned.map((note) => ({ midi: note.midi, weight: Math.max(0.05, note.durSec) })));
  if (options.keyRoot === undefined && key.confidence < 0.12) {
    warnings.push('调性检测把握不大，可在编辑器里手动修改“1=?”');
  }
  const keyRoot = key.keyRoot;

  // 基础八度：使中位音高落在中音区
  const sortedPitches = [...cleaned].map((note) => note.midi).sort((a, b) => a - b);
  const medianMidi = sortedPitches[Math.floor(sortedPitches.length / 2)];
  const baseOctave = options.baseOctave ?? autoBaseOctave(medianMidi, keyRoot);
  let displayBaseOctave = baseOctave;

  const rawBeats: Array<{ startBeat: number; duration: number; midi: number }> = cleaned.map((raw) => ({
    startBeat: raw.startSec / secPerBeat,
    duration: raw.durSec / secPerBeat,
    midi: raw.midi,
  }));
  const scoreNotes: ScoreNote[] = [];
  let simplifyStats: MelodySimplifyStats | undefined;

  if (options.density) {
    // 音频路径：先做“可演奏化”精简，再直接写入谱面（不再逐音量化）。
    const simplified = simplifyMelodyNotes(cleaned, {
      tempo,
      grid,
      density: options.density,
    });
    simplifyStats = simplified.stats;
    if (simplified.notes.length === 0) {
      throw new Error('没有可用的旋律音符（可能是静音、噪声过大或解析失败）');
    }
    // 精简可能改变音高分布（合并碎片、修正八度），重新选显示八度，避免整页都是 ^ 或 ,。
    if (options.baseOctave === undefined) {
      const simplifiedPitches = simplified.notes.map((note) => note.midi).sort((a, b) => a - b);
      displayBaseOctave = autoBaseOctave(simplifiedPitches[Math.floor(simplifiedPitches.length / 2)], keyRoot);
    }
    for (const note of simplified.notes) {
      const written = midiToWritten(note.midi, { keyRoot, baseOctave: displayBaseOctave });
      scoreNotes.push(
        createNote({
          degree: written.degree,
          accidental: written.accidental,
          octave: written.octave,
          startBeat: note.startBeat,
          duration: note.duration,
          tie: false,
        }),
      );
    }
    const stats = simplified.stats;
    const details: string[] = [];
    if (stats.mergedFragments > 0) details.push(`合并 ${stats.mergedFragments} 个同音碎片`);
    if (stats.droppedNotes > 0) details.push(`精简 ${stats.droppedNotes} 个重复/弱音符`);
    if (stats.octaveFixes > 0) details.push(`修正 ${stats.octaveFixes} 处八度跳变`);
    warnings.push(
      `已按「${melodyDensityLabel(options.density)}」密度精简`
        + `${details.length > 0 ? `：${details.join('、')}` : ''}，`
        + `保留 ${stats.outputNotes} 个主旋律音（平均 ${stats.notesPerBeat.toFixed(2)} 音/拍）`,
    );
  } else {
    let lastEndBeat = 0;
    let quantizedAway = 0;
    for (const raw of cleaned) {
      const rawStartBeat = raw.startSec / secPerBeat;
      const rawDurBeats = raw.durSec / secPerBeat;
      let startBeat = grid > 0 ? Math.round(rawStartBeat / grid) * grid : rawStartBeat;
      let duration = quantizeDuration(rawDurBeats, grid);
      // 单声部：不与前一个音重叠
      if (startBeat < lastEndBeat - 1e-3) {
        const shifted = lastEndBeat;
        if (Math.abs(shifted - startBeat) > grid * 0.5) quantizedAway += 1;
        startBeat = shifted;
      }
      if (duration < (grid > 0 ? grid : 0.05)) duration = grid > 0 ? grid : 0.05;
      // 去掉相邻完全重复且无可闻间隔的重叠
      if (startBeat - lastEndBeat < -1e-6) {
        startBeat = lastEndBeat;
      }
      lastEndBeat = startBeat + duration;

      const written = midiToWritten(raw.midi, { keyRoot, baseOctave });
      scoreNotes.push(
        createNote({
          degree: written.degree,
          accidental: written.accidental,
          octave: written.octave,
          startBeat: Number(startBeat.toFixed(6)),
          duration: Number(duration.toFixed(6)),
          tie: false,
        }),
      );
    }

    if (quantizedAway > 0) {
      warnings.push(`有 ${quantizedAway} 个音符因节奏量化/单声部限制被移动了位置`);
    }
  }

  const score = createEmptyScore({
    title: options.title || '导入的旋律',
    meta: { title: options.title || '导入的旋律', tempo, meter, keyRoot, baseOctave: displayBaseOctave },
  });
  score.notes = scoreNotes;
  score.source = {
    kind: options.sourceKind ?? 'midi',
    importedAt: nowIso(),
    confidence: key.confidence,
    ...(options.source ?? {}),
  };
  const normalized = normalizeScore(score);
  warnings.push(...normalized.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message));

  return { score: normalized.score, warnings, key, rawBeats, simplifyStats };
}

/** 供测试使用：把 MIDI 序列铺到网格上，验证去重叠 */
export function normalizeStartBeats(notes: readonly RawMelodyNote[], tempo: number, grid: number): number[] {
  const secPerBeat = 60 / Math.max(20, Math.min(320, tempo));
  let lastEnd = 0;
  return notes.map((note) => {
    const start = grid > 0 ? Math.round(note.startSec / secPerBeat / grid) * grid : note.startSec / secPerBeat;
    const clamped = Math.max(lastEnd, start);
    const duration = Math.max(grid > 0 ? grid : 0.05, grid > 0 ? Math.round(note.durSec / secPerBeat / grid) * grid : note.durSec / secPerBeat);
    lastEnd = clamped + duration + EPSILON;
    return clamped;
  });
}
