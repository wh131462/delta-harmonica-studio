/**
 * MIDI 导入：解析 → 逐轨统计 → 自动/指定选轨 → 单音化 → 交给 melody-to-score 生成简谱。
 *
 * 设计约束（MVP）：
 * - 纯 TypeScript，不依赖 Electron / DOM，可在 Node 中直接单测；
 * - 只使用 MIDI 的第一个速度事件（暂不支持变速），并在 warnings 中提示；
 * - 主旋律默认选择“非鼓轨 + 单音比例高 + 音符数足够 + 平均音高较高”的轨道；
 * - 单声部口琴：重叠音符保留较高音（主旋律通常在高音声部），前一个音在下一个音起点被截断，
 *   完全同音高的重叠合并为一个长音；
 * - 不修改任何已有模块，超出可演奏音域的音符不在此处理（交由演奏编排折返/移调）。
 */
import { Midi, type Track } from '@tonejs/midi';
import type { KeyDetection } from '../music/keydetect';
import { DEFAULT_HARMONICA, instrumentRange } from '../model/instrument';
import { midiToName } from '../model/pitch';
import type { Score } from '../model/score';
import { melodyToScore, type RawMelodyNote } from './melody-to-score';

/** 单条 MIDI 轨道的统计摘要（供 UI 展示与选轨使用） */
export interface MidiTrackSummary {
  /** 在解析后的 MIDI 轨道数组中的下标（selectedTrack / options.trackIndex 均使用它） */
  index: number;
  name: string;
  noteCount: number;
  /** 最低音 MIDI（空轨为 0） */
  pitchMin: number;
  /** 最高音 MIDI（空轨为 0） */
  pitchMax: number;
  /** 平均音高 MIDI（空轨为 0） */
  averagePitch: number;
  /** 单音比例：未与其他音符同时发声的音符占比，1 = 完全单音（空轨记为 1） */
  monophonicRatio: number;
  /** 是否鼓轨（channel 9 / 打击乐音色 / 名称含 drum、鼓 等） */
  isDrum: boolean;
  /** 轨道实际时长（秒，按 MIDI 速度事件换算） */
  durationSec: number;
}

/** MIDI 导入选项（全部可选） */
export interface MidiImportOptions {
  /** 指定轨道下标（不传则自动挑选主旋律轨） */
  trackIndex?: number;
  /** 量化网格，单位：拍（0.25 = 十六分音符；0 = 不量化），默认 0.25 */
  quantizeGrid?: number;
  /** 覆盖 MIDI 内部速度（BPM），优先于文件中的速度事件 */
  tempoOverride?: number;
  /** 指定调号 0-11（不传则自动检测） */
  keyRoot?: number;
  /** 最大音符数（防止超长 MIDI 卡顿） */
  maxNotes?: number;
  /** 原文件名（写入 score.source.fileName，并用于推导默认标题） */
  fileName?: string;
  /** 乐谱标题（优先于文件名推导） */
  title?: string;
}

/** MIDI 导入结果 */
export interface MidiImportResult {
  score: Score;
  /** 全部轨道的统计摘要（含鼓轨，便于 UI 展示） */
  tracks: MidiTrackSummary[];
  /** 实际使用的轨道下标 */
  selectedTrack: number;
  /** 导入过程中的提示与警告（选轨、变速、单音化、量化、超音域等） */
  warnings: string[];
  /** 实际使用的 BPM */
  tempo: number;
  /** 调性检测结果（指定 keyRoot 时 confidence = 1） */
  key: KeyDetection;
}

/** 无速度事件时的默认 BPM */
const DEFAULT_TEMPO = 120;
/** 默认量化网格（拍）：0.25 = 十六分音符 */
const DEFAULT_QUANTIZE_GRID = 0.25;
const MIN_TEMPO = 20;
const MAX_TEMPO = 320;
/** 自动选轨时“音符数足够”的门槛 */
const MIN_AUTO_TRACK_NOTES = 8;
/** 过短音符（秒）：melodyToScore 内部同样按 0.03s 过滤，这里提前计数并丢弃 */
const MIN_NOTE_SECONDS = 0.03;
/** 简谱可表示的音高范围（melodyToScore 内部也按此过滤） */
const MIN_REPRESENTABLE_MIDI = 12;
const MAX_REPRESENTABLE_MIDI = 120;
/** 拍位比较容差 */
const BEAT_EPSILON = 1e-6;
/** 打击乐通道：GM 约定 channel 9（0 基） */
const DRUM_CHANNEL = 9;
/** 轨道名中的鼓轨关键词 */
const DRUM_NAME_PATTERN = /drum|percussion|kit|鼓|打击/i;

/** 从 MIDI 轨道中抽出的绝对拍位音符（已排序） */
interface TrackNote {
  midi: number;
  startBeat: number;
  durationBeats: number;
}

/** 单音化处理的统计与结果 */
interface MonophonicResult {
  notes: TrackNote[];
  /** 被缩短（截断）的低音数量 */
  truncated: number;
  /** 因同音高重叠被合并的数量 */
  merged: number;
  /** 被更高音覆盖 / 被截断为 0 / 过短而丢弃的数量 */
  dropped: number;
}

/**
 * 只解析并统计每一轨，不生成乐谱。
 * 用于 UI 先展示轨道列表让用户选轨；损坏数据会抛出可读 Error。
 */
export function summarizeMidiTracks(data: ArrayBuffer | Uint8Array): MidiTrackSummary[] {
  const midi = parseMidi(data);
  return midi.tracks.map((track, index) => summarizeTrack(track, index, midi.header.ppq));
}

/**
 * 解析 MIDI 并生成简谱 Score。
 * @throws 数据为空 / 损坏、没有可用音符、trackIndex 无效时抛出可读 Error
 */
export function importMidiFile(data: ArrayBuffer | Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  const midi = parseMidi(data);
  const tracks = midi.tracks.map((track, index) => summarizeTrack(track, index, midi.header.ppq));

  // ---- 选轨 ----
  const selection = selectTrack(tracks, options.trackIndex);
  const warnings = selection.warnings;
  const selectedTrack = selection.index;
  const selected = midi.tracks[selectedTrack];
  if (!selected) throw new Error(`第 ${selectedTrack + 1} 轨不存在，无法导入`);

  // ---- 速度 ----
  const tempoInfo = resolveTempo(midi.header.tempos, options.tempoOverride);
  const tempo = tempoInfo.tempo;
  warnings.push(...tempoInfo.warnings);
  const secPerBeat = 60 / tempo;

  // ---- 单音化 ----
  const trackNotes = extractTrackNotes(selected, midi.header.ppq);
  const monophonic = monophonize(trackNotes);
  const playable: TrackNote[] = [];
  let tooShortCount = 0;
  for (const note of monophonic.notes) {
    if (note.durationBeats * secPerBeat < MIN_NOTE_SECONDS) {
      tooShortCount += 1;
      continue;
    }
    playable.push(note);
  }
  const droppedCount = monophonic.dropped + tooShortCount;
  if (monophonic.truncated > 0 || monophonic.merged > 0 || droppedCount > 0) {
    warnings.push(
      `单音化处理：截断 ${monophonic.truncated} 个重叠音、合并 ${monophonic.merged} 个同音重叠、丢弃 ${droppedCount} 个被覆盖/过短的音符`,
    );
  }
  if (playable.length === 0) throw new Error(`第 ${selectedTrack + 1} 轨没有可用的旋律音符，无法导入`);

  // ---- 简谱音高范围（超出者 melodyToScore 会过滤，这里显式计数并提示）----
  const representable: TrackNote[] = [];
  let unrepresentableCount = 0;
  for (const note of playable) {
    if (note.midi < MIN_REPRESENTABLE_MIDI || note.midi > MAX_REPRESENTABLE_MIDI) {
      unrepresentableCount += 1;
    } else {
      representable.push(note);
    }
  }
  if (unrepresentableCount > 0) {
    warnings.push(
      `有 ${unrepresentableCount} 个音符超出简谱可表示范围（MIDI ${MIN_REPRESENTABLE_MIDI}-${MAX_REPRESENTABLE_MIDI}），已忽略`,
    );
  }
  if (representable.length === 0) throw new Error(`第 ${selectedTrack + 1} 轨没有可用的旋律音符，无法导入`);

  // ---- 量化移动数量（真正量化由 melodyToScore 执行，这里用于生成提示）----
  const quantizeGrid = normalizeQuantizeGrid(options.quantizeGrid);
  const movedCount = countQuantizedMoves(representable, quantizeGrid);
  if (movedCount > 0) {
    warnings.push(`有 ${movedCount} 个音符的起点被量化到 ${formatGrid(quantizeGrid)} 拍网格`);
  }

  // ---- 超出可演奏音域：不处理，交由演奏编排 ----
  const range = instrumentRange(DEFAULT_HARMONICA);
  const outOfRangeCount = representable.filter((note) => note.midi < range.min || note.midi > range.max).length;
  if (outOfRangeCount > 0) {
    warnings.push(
      `有 ${outOfRangeCount} 个音符超出可演奏音域 ${midiToName(range.min)}-${midiToName(range.max)}，暂不处理，交由演奏编排折返或移调`,
    );
  }

  // ---- 交给 melodyToScore 生成乐谱 ----
  const fileName = normalizeFileName(options.fileName);
  const title = resolveTitle(options.title, fileName);
  const keyRoot = normalizeKeyRoot(options.keyRoot);
  if (options.keyRoot !== undefined && keyRoot === undefined) {
    warnings.push('keyRoot 参数无效（应为 0-11 的整数），已改为自动检测调性');
  }
  const maxNotes = normalizeMaxNotes(options.maxNotes);

  const rawMelody: RawMelodyNote[] = representable.map((note) => ({
    midi: note.midi,
    startSec: note.startBeat * secPerBeat,
    durSec: note.durationBeats * secPerBeat,
  }));
  const converted = melodyToScore(rawMelody, {
    title,
    tempo,
    quantizeGrid,
    ...(keyRoot !== undefined ? { keyRoot } : {}),
    ...(maxNotes !== undefined ? { maxNotes } : {}),
    source: { kind: 'midi', ...(fileName ? { fileName } : {}) },
  });

  // 确保来源信息符合 MIDI 导入约定（melodyToScore 已设置大部分字段，这里做兜底）
  converted.score.source = {
    ...converted.score.source,
    kind: 'midi',
    ...(fileName ? { fileName } : {}),
  };

  warnings.push(...converted.warnings);

  return {
    score: converted.score,
    tracks,
    selectedTrack,
    warnings,
    tempo,
    key: converted.key,
  };
}

/** 把入参统一转成字节视图；空数据直接抛出可读错误 */
function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (!data) throw new Error('MIDI 数据为空，无法导入');
  if (ArrayBuffer.isView(data)) {
    // Uint8Array / Node Buffer 等视图：按实际区间创建视图，避免带偏移时读错数据
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('MIDI 数据类型不受支持：需要 ArrayBuffer 或 Uint8Array');
}

/** 解析 MIDI，把底层解析器的（可能是字符串的）异常包装成可读 Error */
function parseMidi(data: ArrayBuffer | Uint8Array): Midi {
  const bytes = toBytes(data);
  if (bytes.length === 0) throw new Error('MIDI 数据为空，无法导入');
  try {
    return new Midi(bytes);
  } catch (error) {
    // @tonejs/midi 底层的 midi-file 可能直接 throw 字符串，这里统一兜底
    const detail = error instanceof Error ? error.message : String(error ?? '');
    throw new Error(`MIDI 文件解析失败：${detail || '文件可能已损坏或不是有效的 MIDI'}`);
  }
}

/** 从解析后的轨道提取音符（拍位 = ticks / ppq），按起点升序、同起点高音在前 */
function extractTrackNotes(track: Track, ppq: number): TrackNote[] {
  const safePpq = Number.isFinite(ppq) && ppq > 0 ? ppq : 480;
  const notes: TrackNote[] = [];
  for (const note of track.notes) {
    if (!Number.isFinite(note.midi) || !Number.isFinite(note.ticks) || !Number.isFinite(note.durationTicks)) continue;
    if (!(note.durationTicks > 0)) continue;
    notes.push({
      midi: Math.round(note.midi),
      startBeat: note.ticks / safePpq,
      durationBeats: note.durationTicks / safePpq,
    });
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || b.midi - a.midi);
  return notes;
}

/** 是否鼓轨：channel 9 / 打击乐音色 / 轨道名关键词 */
function isDrumTrack(track: Track): boolean {
  if (track.channel === DRUM_CHANNEL) return true;
  if (track.instrument?.percussion) return true;
  return DRUM_NAME_PATTERN.test(track.name ?? '');
}

/** 统计同时发声的音符对数量，并换算成“未参与重叠的音符占比” */
function analyzeOverlaps(notes: readonly TrackNote[]): { monophonicRatio: number; overlapPairs: number } {
  if (notes.length === 0) return { monophonicRatio: 1, overlapPairs: 0 };
  const order = notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.startBeat - b.note.startBeat || a.index - b.index);
  const involved = new Set<number>();
  let overlapPairs = 0;
  let active: number[] = [];
  for (const { note, index } of order) {
    const nextActive: number[] = [];
    for (const activeIndex of active) {
      const prev = notes[activeIndex];
      if (prev && prev.startBeat + prev.durationBeats > note.startBeat + BEAT_EPSILON) {
        nextActive.push(activeIndex);
        overlapPairs += 1;
        involved.add(activeIndex);
        involved.add(index);
      }
    }
    nextActive.push(index);
    active = nextActive;
  }
  return { monophonicRatio: Math.max(0, 1 - involved.size / notes.length), overlapPairs };
}

/** 单轨统计摘要 */
function summarizeTrack(track: Track, index: number, ppq: number): MidiTrackSummary {
  const notes = extractTrackNotes(track, ppq);
  const summary: MidiTrackSummary = {
    index,
    name: (track.name ?? '').trim(),
    noteCount: notes.length,
    pitchMin: 0,
    pitchMax: 0,
    averagePitch: 0,
    monophonicRatio: 1,
    isDrum: isDrumTrack(track),
    durationSec: roundNumber(track.duration, 3),
  };
  if (notes.length === 0) return summary;
  let pitchMin = Number.POSITIVE_INFINITY;
  let pitchMax = Number.NEGATIVE_INFINITY;
  let pitchSum = 0;
  for (const note of notes) {
    pitchMin = Math.min(pitchMin, note.midi);
    pitchMax = Math.max(pitchMax, note.midi);
    pitchSum += note.midi;
  }
  const overlap = analyzeOverlaps(notes);
  return {
    ...summary,
    pitchMin,
    pitchMax,
    averagePitch: roundNumber(pitchSum / notes.length, 2),
    monophonicRatio: roundNumber(overlap.monophonicRatio, 4),
  };
}

/**
 * 选轨：默认排除鼓轨，优先音符数 >= 8 的轨道，再按单音比例高、平均音高高排序。
 * 用户显式指定 trackIndex 时以用户选择为准（允许选鼓轨，但会提示）。
 */
function selectTrack(tracks: readonly MidiTrackSummary[], requestedIndex?: number): { index: number; warnings: string[] } {
  const warnings: string[] = [];
  if (tracks.length === 0) throw new Error('MIDI 中没有包含音符的轨道，无法导入');
  const playable = tracks.filter((track) => track.noteCount > 0);
  if (playable.length === 0) throw new Error('MIDI 中没有包含音符的轨道，无法导入');

  if (requestedIndex !== undefined) {
    if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= tracks.length) {
      throw new Error(`指定的轨道序号 ${requestedIndex} 无效（MIDI 共 ${tracks.length} 轨，序号从 0 开始）`);
    }
    const target = tracks[requestedIndex];
    if (!target || target.noteCount === 0) {
      throw new Error(`指定的第 ${requestedIndex + 1} 轨「${target?.name || '未命名'}」没有音符，无法导入`);
    }
    const drumHint = target.isDrum ? '（该轨被识别为鼓轨，可能不适合口琴演奏）' : '';
    warnings.push(`按指定轨道导入：第 ${requestedIndex + 1} 轨「${target.name || '未命名'}」，共 ${target.noteCount} 个音符${drumHint}`);
    return { index: requestedIndex, warnings };
  }

  const melodic = playable.filter((track) => !track.isDrum);
  const drumCount = playable.length - melodic.length;
  if (drumCount > 0) warnings.push(`已排除 ${drumCount} 个鼓轨`);

  if (melodic.length === 0) {
    // 只有鼓轨时退回使用鼓轨，保证至少有结果可以打开（提示用户不适合口琴）
    warnings.push('没有找到非鼓轨，只能从鼓轨中选择（可能不适合口琴演奏）');
    const fallback = pickBestTrack(playable);
    warnings.push(formatSelectionWarning(fallback, tracks.length, true));
    return { index: fallback.index, warnings };
  }

  const enoughNotes = melodic.filter((track) => track.noteCount >= MIN_AUTO_TRACK_NOTES);
  const candidates = enoughNotes.length > 0 ? enoughNotes : melodic;
  if (enoughNotes.length > 0 && enoughNotes.length < melodic.length) {
    warnings.push(`已跳过 ${melodic.length - enoughNotes.length} 个音符数不足 ${MIN_AUTO_TRACK_NOTES} 的轨道`);
  }
  const best = pickBestTrack(candidates);
  warnings.push(formatSelectionWarning(best, tracks.length, enoughNotes.length === 0));
  return { index: best.index, warnings };
}

/** 候选轨道排序：单音比例优先，其次平均音高，再其次音符数（最后按下标稳定） */
function pickBestTrack(candidates: readonly MidiTrackSummary[]): MidiTrackSummary {
  const sorted = [...candidates].sort(
    (a, b) =>
      roundNumber(b.monophonicRatio, 4) - roundNumber(a.monophonicRatio, 4) ||
      b.averagePitch - a.averagePitch ||
      b.noteCount - a.noteCount ||
      a.index - b.index,
  );
  const best = sorted[0];
  if (!best) throw new Error('MIDI 中没有可用的轨道');
  return best;
}

/** 自动选轨提示文案 */
function formatSelectionWarning(track: MidiTrackSummary, totalTracks: number, fewNotes: boolean): string {
  const reason = fewNotes ? '（所有非鼓轨音符都较少，导入结果可能不完整）' : '';
  const ratioPercent = (track.monophonicRatio * 100).toFixed(0);
  return `已自动选择第 ${track.index + 1} 轨「${track.name || '未命名'}」作为主旋律（共 ${totalTracks} 轨，单音比例 ${ratioPercent}%，平均音高 ${midiToName(track.averagePitch)}）${reason}`;
}

/**
 * 单音化：重叠时保留较高音；前面的音在后面的音起点截断；同音高重叠合并。
 * 输入须按 startBeat 升序（同起点高音在前），输出按起点升序且互不重叠。
 */
function monophonize(notes: readonly TrackNote[]): MonophonicResult {
  const finished: TrackNote[] = [];
  const result: MonophonicResult = { notes: finished, truncated: 0, merged: 0, dropped: 0 };
  let active: TrackNote[] = [];
  const endOf = (note: TrackNote) => note.startBeat + note.durationBeats;

  for (const raw of notes) {
    const start = raw.startBeat;
    const end = start + raw.durationBeats;

    // 1) 把已经结束（或恰好在此刻结束）的音符归档，减少活跃列表
    active = active.filter((note) => {
      if (endOf(note) <= start + BEAT_EPSILON) {
        finished.push(note);
        return false;
      }
      return true;
    });

    // 2) 找出与当前音重叠的活跃音符
    const overlapping = active.filter((note) => note.startBeat < end - BEAT_EPSILON && start < endOf(note) - BEAT_EPSILON);
    let skip = false;
    if (overlapping.length > 0) {
      let highestMidi = Number.NEGATIVE_INFINITY;
      for (const note of overlapping) highestMidi = Math.max(highestMidi, note.midi);

      if (raw.midi < highestMidi) {
        // 当前音更低：被上方持续音覆盖，直接丢弃
        result.dropped += 1;
        skip = true;
      } else if (raw.midi === highestMidi) {
        // 完全同音高重叠：合并为更长的音（避免产生碎音）
        const target = overlapping.find((note) => note.midi === raw.midi);
        if (target) {
          target.durationBeats = Math.max(endOf(target), end) - target.startBeat;
          result.merged += 1;
          skip = true;
        }
      } else {
        // 当前音更高：截断所有被覆盖的低音
        for (const note of overlapping) {
          if (start > note.startBeat + BEAT_EPSILON) {
            note.durationBeats = start - note.startBeat;
            result.truncated += 1;
          } else {
            // 与低音同时起音：低音完全被覆盖，整段丢弃
            note.durationBeats = 0;
            result.dropped += 1;
          }
        }
        active = active.filter((note) => note.durationBeats > BEAT_EPSILON);
      }
    }
    if (skip) continue;
    active.push({ midi: raw.midi, startBeat: start, durationBeats: raw.durationBeats });
  }

  for (const note of active) finished.push(note);
  finished.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
  return result;
}

/** 解析速度：tempoOverride 优先；否则取第一个速度事件；都没有则 120 */
function resolveTempo(tempos: readonly { bpm: number }[], tempoOverride?: number): { tempo: number; warnings: string[] } {
  const warnings: string[] = [];
  const overrideBpm = tempoOverride ?? Number.NaN;
  let bpm: number;
  if (Number.isFinite(overrideBpm) && overrideBpm > 0) {
    bpm = overrideBpm;
  } else {
    const first = tempos[0];
    if (first && Number.isFinite(first.bpm) && first.bpm > 0) {
      bpm = first.bpm;
    } else {
      bpm = DEFAULT_TEMPO;
      warnings.push(`MIDI 没有可用的速度信息，已按默认 ${DEFAULT_TEMPO} BPM 导入`);
    }
  }
  const tempo = normalizeTempo(bpm);
  // 同 BPM 的重复速度事件不算变速；只有真正出现不同速度时才提示（MVP 不支持变速）
  const distinctBpms = new Set<string>();
  for (const event of tempos) distinctBpms.add(String(roundNumber(event.bpm, 2)));
  if (distinctBpms.size > 1) {
    warnings.push(`MIDI 存在 ${distinctBpms.size} 种速度（变速），MVP 不支持变速，已统一按第一个速度 ${formatTempo(tempo)} BPM 处理`);
  }
  return { tempo, warnings };
}

/** 速度取整并夹在 20-320 之间（与 melodyToScore 的限制保持一致） */
function normalizeTempo(bpm: number): number {
  const safe = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_TEMPO;
  const rounded = Math.round(safe);
  // MIDI 速度以微秒/拍存储，回读时会出现 140.00014 这类浮点误差，接近整数时取整
  const cleaned = Math.abs(safe - rounded) < 0.02 ? rounded : Math.round(safe * 100) / 100;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, cleaned));
}

/** 量化网格规范化：undefined/非法 → 默认 0.25；0 表示不量化 */
function normalizeQuantizeGrid(grid: number | undefined): number {
  if (grid === undefined) return DEFAULT_QUANTIZE_GRID;
  if (!Number.isFinite(grid) || grid < 0) return DEFAULT_QUANTIZE_GRID;
  return grid;
}

/** 统计有多少音符的起点会被量化移出原位置 */
function countQuantizedMoves(notes: readonly TrackNote[], grid: number): number {
  if (!(grid > 0)) return 0;
  let moved = 0;
  for (const note of notes) {
    const snapped = Math.round(note.startBeat / grid) * grid;
    if (Math.abs(snapped - note.startBeat) > BEAT_EPSILON) moved += 1;
  }
  return moved;
}

/** 调号参数规范化：仅接受 0-11 的整数 */
function normalizeKeyRoot(keyRoot: number | undefined): number | undefined {
  if (keyRoot === undefined) return undefined;
  if (!Number.isInteger(keyRoot) || keyRoot < 0 || keyRoot > 11) return undefined;
  return keyRoot;
}

/** 最大音符数规范化：非法值视为未指定 */
function normalizeMaxNotes(maxNotes: number | undefined): number | undefined {
  if (maxNotes === undefined) return undefined;
  if (!Number.isFinite(maxNotes) || maxNotes <= 0) return undefined;
  return Math.floor(maxNotes);
}

/** 文件名规范化：去空白，空字符串视为未提供 */
function normalizeFileName(fileName: string | undefined): string | undefined {
  if (typeof fileName !== 'string') return undefined;
  const trimmed = fileName.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 标题：options.title > 文件名去目录去扩展名 > 'MIDI 导入' */
function resolveTitle(title: string | undefined, fileName: string | undefined): string {
  const explicit = typeof title === 'string' ? title.trim() : '';
  if (explicit) return explicit;
  if (fileName) {
    const base = stripExtension(fileName);
    if (base) return base;
  }
  return 'MIDI 导入';
}

/** 去掉目录部分与扩展名（如 "C:\music\demo.mid" → "demo"） */
function stripExtension(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 数值取整，过滤 NaN/Infinity */
function roundNumber(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 展示用 BPM 文本 */
function formatTempo(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(2);
}

/** 展示用量化网格文本（去掉无意义的末尾 0） */
function formatGrid(grid: number): string {
  return String(Number(grid.toFixed(4)));
}
