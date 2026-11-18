/**
 * 时间线：把 Score（可能带连音线）转换为可直接排程的「绝对音高 + 拍位」序列。
 * 单声部口琴：若出现重叠，后一个音的起点会截断前一个音的时值（并给出警告）。
 */
import { EPSILON, noteEnd, type Score, type ScoreNote } from '../model/score';
import { noteToMidi } from '../model/pitch';

export interface TimedNote {
  /** 最终 MIDI 音高 */
  midi: number;
  /** 起始拍位 */
  startBeat: number;
  /** 持续拍数（连音已合并，重叠已截断） */
  duration: number;
  /** 组成该音的原始音符下标 */
  sourceIndices: number[];
  /** 是否由连音线合并而来 */
  tied: boolean;
}

export interface TimedScore {
  notes: TimedNote[];
  /** 全曲总拍数（含末尾休止） */
  totalBeats: number;
  warnings: string[];
}

function samePitch(a: ScoreNote, b: ScoreNote): boolean {
  return a.degree === b.degree && a.accidental === b.accidental && a.octave === b.octave;
}

/**
 * @param includeRests 若为 true，休止符也会作为特殊项返回（midi = -1）——默认不返回
 */
export function toTimedNotes(score: Score, includeRests = false): TimedScore {
  const warnings: string[] = [];
  const sorted = (score.notes ?? [])
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.startBeat - b.note.startBeat || a.index - b.index);

  const merged: Array<{
    midi: number;
    startBeat: number;
    duration: number;
    sourceIndices: number[];
    tied: boolean;
  }> = [];

  let totalBeats = 0;
  /** tie 标记在「前一个」音符上，遍历时暂存 */
  let pendingTie = false;

  for (const { note, index } of sorted) {
    if (!Number.isFinite(note.startBeat) || !Number.isFinite(note.duration) || note.duration <= 0) continue;
    totalBeats = Math.max(totalBeats, note.startBeat + note.duration);
    const currentTie = note.tie === true;

    if (note.degree === 0) {
      if (pendingTie) {
        warnings.push(`连音线后面不是紧邻的同音高音符（第 ${index + 1} 个音符是休止符），已断开`);
        pendingTie = false;
      }
      if (includeRests) {
        merged.push({ midi: -1, startBeat: note.startBeat, duration: note.duration, sourceIndices: [index], tied: false });
      }
      continue;
    }

    const midi = noteToMidi(note, score.meta);
    if (midi === null) continue;
    const prev = merged[merged.length - 1];
    const joined =
      prev !== undefined &&
      pendingTie &&
      prev.midi === midi &&
      Math.abs(prev.startBeat + prev.duration - note.startBeat) < 0.01;
    if (joined) {
      prev.duration += note.duration;
      prev.sourceIndices.push(index);
      prev.tied = true;
      pendingTie = currentTie;
      continue;
    }
    if (pendingTie) {
      warnings.push(`连音线没有连接到紧邻的同音高音符（第 ${index + 1} 个音符），已忽略该连音`);
    }
    merged.push({ midi, startBeat: note.startBeat, duration: note.duration, sourceIndices: [index], tied: false });
    pendingTie = currentTie;
  }
  if (pendingTie) {
    warnings.push('最后一个音符带有连音线，但后面没有可连接的同音高音符');
  }

  // 单声部约束：后音截断前音
  const notes: TimedNote[] = [];
  for (let i = 0; i < merged.length; i += 1) {
    const current = merged[i];
    const next = merged[i + 1];
    let duration = current.duration;
    if (next) {
      const maxDuration = next.startBeat - current.startBeat;
      if (maxDuration < duration - EPSILON) {
        duration = Math.max(EPSILON, maxDuration);
        warnings.push(`音符重叠已被截断：起点 ${current.startBeat.toFixed(2)} 拍处的音符`);
      }
    }
    notes.push({
      midi: current.midi,
      startBeat: current.startBeat,
      duration,
      sourceIndices: current.sourceIndices,
      tied: current.tied,
    });
  }

  return { notes, totalBeats, warnings };
}

/** 生成按顺序填满的（无空拍）音符序列——用于按顺序编辑的辅助功能 */
export function repackNotesSequentially(notes: readonly ScoreNote[]): ScoreNote[] {
  let cursor = 0;
  return notes.map((note) => {
    const next = { ...note, startBeat: cursor };
    cursor += note.duration;
    return next;
  });
}

/** 计算小节的起止拍号边界 */
export function barBoundaries(totalBeats: number, measureBeats: number): number[] {
  const bars: number[] = [0];
  if (!(measureBeats > 0)) return bars;
  let boundary = measureBeats;
  while (boundary < totalBeats - EPSILON) {
    bars.push(Number(boundary.toFixed(6)));
    boundary += measureBeats;
  }
  return bars;
}

/** 某个音符是否跨过小节线 */
export function crossesBarline(note: Pick<ScoreNote, 'startBeat' | 'duration'>, measureBeats: number): boolean {
  if (!(measureBeats > 0)) return false;
  const startBar = Math.floor(note.startBeat / measureBeats + EPSILON);
  const endBar = Math.floor(noteEnd(note) / measureBeats - EPSILON);
  return endBar > startBar;
}
