/**
 * 主旋律“可演奏化”精简：把逐帧/逐音高得到的原始旋律，压成适合口琴演奏的单声部谱面。
 *
 * 音频主旋律提取（melody.ts）输出的是“尽量跟住原曲”的音符，常带有：
 * - 同一长音被切成多个首尾相接的碎片（人声咬字、颤音、伴奏瞬态）；
 * - 16 分甚至 32 分音符式的快速经过音；
 * - 偶尔的八度误判；
 * 直接量化会把它们原样搬进谱面，看起来密密麻麻、听不出主旋律。
 *
 * 这里按“谱面密度”做第二次创作：
 * 1. 同音碎片合并（间隔 ≤ 80ms）；
 * 2. 修正“前后音都在附近、自己却跳了八度”的孤立音；
 * 3. 在节拍网格上每个槽位只保留最可信的一个音（强拍优先、长音优先）；
 * 4. 每拍限制音符数（宽松 1 个 / 标准 2 个 / 精细 4 个），第二、第三个音必须明显强于最强音；
 * 5. 时值按网格取整，并把同一乐句内的音连起来（留出长间隙作呼吸/休止）。
 *
 * 纯函数、不依赖音频，便于单元测试和 UI 侧“改密度立即重排”。
 */

export type MelodyDensity = 'loose' | 'normal' | 'fine';

/** 精简输入音符（与 RawMelodyNote 同形，避免模块间循环依赖） */
export interface SimplifyInputNote {
  midi: number;
  startSec: number;
  durSec: number;
  confidence?: number;
}

export interface MelodySimplifyOptions {
  /** 每分钟四分音符数 */
  tempo: number;
  /** 用户选择的量化网格（拍）；精细模式会直接使用它 */
  grid: number;
  density: MelodyDensity;
  /** 音域约束（防御性） */
  pitchMin?: number;
  pitchMax?: number;
}

export interface SimplifiedNote {
  midi: number;
  /** 拍 */
  startBeat: number;
  /** 拍 */
  duration: number;
  confidence: number;
}

export interface MelodySimplifyStats {
  inputNotes: number;
  outputNotes: number;
  /** 被合并进相邻同音音符的碎片数 */
  mergedFragments: number;
  /** 同一槽位/同一拍被更强音符挤掉的音符数 */
  droppedNotes: number;
  /** 被八度修正的音符数 */
  octaveFixes: number;
  /** 平均每拍音符数（按实际覆盖的拍数） */
  notesPerBeat: number;
  /** 实际采用的网格（拍） */
  stepBeats: number;
}

export interface MelodySimplifyResult {
  notes: SimplifiedNote[];
  stats: MelodySimplifyStats;
}

interface DensityProfile {
  /** 最小音符时值（拍），同时作为节奏网格下限 */
  minNoteBeats: number;
  /** 每拍最多保留几个音 */
  maxNotesPerBeat: number;
  /** 同一拍内，第 2/3/4 个音至少要达到最强音的这个比例 */
  secondNoteRatio: number;
  /** 单音最长时值（拍） */
  maxNoteBeats: number;
  /** 超过这个间隔就认为乐句结束，不再把音拖到下一个音 */
  phraseGapBeats: number;
}

/** 三档密度：数字越小越容易演奏 */
const PROFILES: Record<MelodyDensity, DensityProfile> = {
  loose: {
    minNoteBeats: 1,
    maxNotesPerBeat: 1,
    secondNoteRatio: 1.01,
    maxNoteBeats: 4,
    phraseGapBeats: 2,
  },
  normal: {
    minNoteBeats: 0.25,
    maxNotesPerBeat: 2,
    secondNoteRatio: 0.66,
    maxNoteBeats: 4,
    phraseGapBeats: 2,
  },
  fine: {
    minNoteBeats: 0.25,
    maxNotesPerBeat: 4,
    secondNoteRatio: 0.45,
    maxNoteBeats: 4,
    phraseGapBeats: 2,
  },
};

const DEFAULT_CONFIDENCE = 0.7;
/** 同音碎片合并的最大间隔（秒） */
const FRAGMENT_MERGE_GAP_SEC = 0.08;
/** 八度修正：当前音偏离前后音的半音数 */
const OCTAVE_JUMP_SEMITONES = 10;
/** 八度修正：前后音彼此接近的半音数 */
const OCTAVE_NEIGHBOR_SEMITONES = 2;
/** 八度修正后允许的相邻音程 */
const OCTAVE_FOLDED_MAX_SEMITONES = 7;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function roundToGrid(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * 合并首尾相接的同音碎片。
 * 只合并间隔很小的情况：真正的同音重复通常有 ≥100ms 的重新起音间隔，不会被并掉。
 */
function mergeFragments(notes: SimplifyInputNote[], maxGapSec: number): { notes: SimplifyInputNote[]; merged: number } {
  const out: SimplifyInputNote[] = [];
  let merged = 0;
  for (const note of notes) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && last.midi === note.midi && note.startSec - (last.startSec + last.durSec) <= maxGapSec) {
      const end = Math.max(last.startSec + last.durSec, note.startSec + note.durSec);
      last.durSec = end - last.startSec;
      last.confidence = Math.max(last.confidence ?? DEFAULT_CONFIDENCE, note.confidence ?? DEFAULT_CONFIDENCE);
      merged += 1;
      continue;
    }
    out.push({ ...note });
  }
  return { notes: out, merged };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >>> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle]);
}

/**
 * 修正“前后音都在附近、自己却跳了八度”的孤立音。
 * 例：C4 C5 C4 → C4 C4 C4；先看紧邻音，再用 ±0.6s 邻域中值兜底，
 * 只处理偏离 ≥10 半音、折回后落在邻域 5 半音内的情况。
 */
function repairOctaveJumps(notes: SimplifyInputNote[]): number {
  let fixes = 0;
  // 1) 紧邻音：前后音彼此接近，当前音却相差一个八度
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (let index = 1; index < notes.length - 1; index += 1) {
      const previous = notes[index - 1];
      const current = notes[index];
      const next = notes[index + 1];
      if (Math.abs(previous.midi - next.midi) > OCTAVE_NEIGHBOR_SEMITONES) continue;
      if (Math.abs(current.midi - previous.midi) < OCTAVE_JUMP_SEMITONES) continue;
      const folded = current.midi + (current.midi > previous.midi ? -12 : 12);
      if (Math.abs(folded - previous.midi) > OCTAVE_FOLDED_MAX_SEMITONES) continue;
      if (Math.abs(folded - next.midi) > OCTAVE_FOLDED_MAX_SEMITONES) continue;
      current.midi = folded;
      fixes += 1;
      changed = true;
    }
    if (!changed) break;
  }

  // 2) 邻域中值：处理“整小句被八度跟踪错”的情况（前后音不严格相邻时也有效）
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (let index = 0; index < notes.length; index += 1) {
      const current = notes[index];
      const neighborPitches: number[] = [];
      for (let offset = -4; offset <= 4; offset += 1) {
        if (offset === 0) continue;
        const neighbor = notes[index + offset];
        if (!neighbor) continue;
        if (Math.abs(neighbor.startSec - current.startSec) > 0.75) continue;
        neighborPitches.push(neighbor.midi);
      }
      if (neighborPitches.length < 2) continue;
      const center = median(neighborPitches);
      if (Math.abs(current.midi - center) < OCTAVE_JUMP_SEMITONES) continue;
      const folded = current.midi + (current.midi > center ? -12 : 12);
      if (Math.abs(folded - center) > 5) continue;
      current.midi = folded;
      fixes += 1;
      changed = true;
    }
    if (!changed) break;
  }
  return fixes;
}

/**
 * 把原始旋律压到节拍网格上，输出单声部、可直接写进简谱的音符。
 *
 * @param notes  原始旋律（秒）
 * @param options tempo / grid / density
 */
export function simplifyMelodyNotes(
  notes: readonly SimplifyInputNote[],
  options: MelodySimplifyOptions,
): MelodySimplifyResult {
  const profile = PROFILES[options.density] ?? PROFILES.normal;
  const tempo = clamp(options.tempo || 100, 20, 320);
  const secPerBeat = 60 / tempo;
  const grid = clamp(options.grid > 0 ? options.grid : 0.25, 0.0625, 2);
  // 密度决定节奏下限：宽松至少 1 拍、标准至少半拍；精细才使用用户选的 1/16 / 1/32。
  const stepBeats = options.density === 'fine'
    ? grid
    : Math.max(grid, profile.minNoteBeats);
  const pitchMin = options.pitchMin ?? 0;
  const pitchMax = options.pitchMax ?? 127;

  const filtered = notes
    .filter((note) => Number.isFinite(note.midi) && Number.isFinite(note.startSec) && Number.isFinite(note.durSec))
    .filter((note) => note.durSec >= 0.03 && note.startSec >= 0 && note.midi >= pitchMin && note.midi <= pitchMax)
    .slice()
    .sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);

  const fragmentResult = mergeFragments(filtered, FRAGMENT_MERGE_GAP_SEC);
  const merged = fragmentResult.notes;
  const octaveFixes = repairOctaveJumps(merged);

  if (merged.length === 0) {
    return {
      notes: [],
      stats: {
        inputNotes: notes.length,
        outputNotes: 0,
        mergedFragments: fragmentResult.merged,
        droppedNotes: 0,
        octaveFixes,
        notesPerBeat: 0,
        stepBeats,
      },
    };
  }

  const startBeatOf = (note: SimplifyInputNote): number => note.startSec / secPerBeat;

  // 1) 收集每个网格槽位的候选音；稍后按时间顺序结合“音高连续性”选出每个槽位的一个音。
  interface SlotNote {
    slot: number;
    startBeat: number;
    midi: number;
    durationBeats: number;
    confidence: number;
    score: number;
    order: number;
  }
  const slotCandidates = new Map<number, SlotNote[]>();
  let dropped = 0;
  let order = 0;
  for (const note of merged) {
    const rawStartBeat = startBeatOf(note);
    const slot = Math.max(0, Math.round(rawStartBeat / stepBeats));
    const startBeat = slot * stepBeats;
    const durationBeats = note.durSec / secPerBeat;
    const confidence = clamp(note.confidence ?? DEFAULT_CONFIDENCE, 0, 1);
    // 强拍（每拍起点）给一点加成；时值越长越可信（人声长音 > 伴奏经过音）。
    const onBeat = Math.abs(startBeat / 1 - Math.round(startBeat / 1)) < 1e-6;
    const score = confidence * (0.55 + 0.45 * Math.min(1, durationBeats)) * (onBeat ? 1.15 : 1);
    const candidate: SlotNote = {
      slot,
      startBeat,
      midi: note.midi,
      durationBeats,
      confidence,
      score,
      order: order += 1,
    };
    const list = slotCandidates.get(slot) ?? [];
    list.push(candidate);
    slotCandidates.set(slot, list);
  }

  // 2) 每个槽位选一个音：同槽位内分数接近时，优先选与上一个音级进/小跳的候选，
  //    避免伴奏经过音把旋律线拽得上下乱跳。
  const slots: SlotNote[] = [];
  let lastPitch: number | null = null;
  for (const slot of [...slotCandidates.keys()].sort((a, b) => a - b)) {
    const list = slotCandidates.get(slot) ?? [];
    let best: SlotNote | null = null;
    let bestAdjusted = -Infinity;
    for (const candidate of list) {
      const distance = lastPitch === null ? 0 : Math.abs(candidate.midi - lastPitch);
      const continuity = lastPitch === null
        ? 1
        : distance <= 2 ? 1.12
        : distance <= 5 ? 1.04
        : distance > 12 ? 0.88
        : 1;
      const adjusted = candidate.score * continuity;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        best = candidate;
      }
    }
    if (!best) continue;
    if (list.length > 1) dropped += list.length - 1;
    slots.push(best);
    lastPitch = best.midi;
  }

  // 3) 每拍限制音符数：第 2/3/4 个音必须明显强于本拍最强音，否则视为伴奏/经过音省略。
  const slotNotes = slots.slice().sort((a, b) => a.slot - b.slot);
  const byBeat = new Map<number, SlotNote[]>();
  for (const note of slotNotes) {
    const beat = Math.floor(note.startBeat + 1e-9);
    const list = byBeat.get(beat) ?? [];
    list.push(note);
    byBeat.set(beat, list);
  }
  const kept: SlotNote[] = [];
  for (const list of byBeat.values()) {
    list.sort((a, b) => b.score - a.score || a.order - b.order);
    const best = list[0]?.score ?? 0;
    for (let i = 0; i < list.length; i += 1) {
      if (i >= profile.maxNotesPerBeat) {
        dropped += 1;
        continue;
      }
      if (i > 0 && list[i].score < best * profile.secondNoteRatio) {
        dropped += 1;
        continue;
      }
      kept.push(list[i]);
    }
  }
  kept.sort((a, b) => a.slot - b.slot);

  // 3) 时值：同一乐句内连到下一个音（唱/吹的连音），长间隙处保留休止。
  const simplified: SimplifiedNote[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const note = kept[index];
    const next = kept[index + 1] ?? null;
    const gapBeats = next ? next.startBeat - note.startBeat : profile.maxNoteBeats;
    const rawDuration = Math.min(profile.maxNoteBeats, Math.max(profile.minNoteBeats, note.durationBeats));
    let duration: number;
    if (next && gapBeats <= profile.phraseGapBeats) {
      duration = Math.max(rawDuration, gapBeats);
    } else {
      duration = rawDuration;
    }
    duration = Math.max(stepBeats, Math.round(duration / stepBeats) * stepBeats);
    duration = Math.min(profile.maxNoteBeats, duration);
    if (next) duration = Math.min(duration, Math.max(stepBeats, next.startBeat - note.startBeat));
    simplified.push({
      midi: note.midi,
      startBeat: Number((note.startBeat + 1e-9).toFixed(6)),
      duration: Number(duration.toFixed(6)),
      confidence: Number(note.confidence.toFixed(3)),
    });
  }

  // 4) 相邻同音合并（半拍内重复多半是检测抖动；真正的重复音通常间隔 ≥1 拍）。
  const mergedNotes: SimplifiedNote[] = [];
  for (const note of simplified) {
    const last = mergedNotes.length > 0 ? mergedNotes[mergedNotes.length - 1] : null;
    if (last && last.midi === note.midi && note.startBeat - last.startBeat <= stepBeats * 1.5) {
      last.duration = Math.max(last.duration, note.startBeat + note.duration - last.startBeat);
      last.confidence = Math.max(last.confidence, note.confidence);
      continue;
    }
    mergedNotes.push({ ...note });
  }

  const lastEndBeat = mergedNotes.reduce((max, note) => Math.max(max, note.startBeat + note.duration), 0);
  const firstStartBeat = mergedNotes.length > 0 ? mergedNotes[0].startBeat : 0;
  const coveredBeats = Math.max(stepBeats, lastEndBeat - firstStartBeat);
  return {
    notes: mergedNotes,
    stats: {
      inputNotes: notes.length,
      outputNotes: mergedNotes.length,
      mergedFragments: fragmentResult.merged,
      droppedNotes: dropped,
      octaveFixes,
      notesPerBeat: mergedNotes.length / coveredBeats,
      stepBeats,
    },
  };
}

/** 密度对应的中文名，供 UI / 警告文案复用 */
export function melodyDensityLabel(density: MelodyDensity): string {
  if (density === 'loose') return '宽松';
  if (density === 'fine') return '精细';
  return '标准';
}
