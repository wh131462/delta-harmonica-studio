/**
 * 音高计算：简谱（级数 + 升降号 + 八度）↔ MIDI ↔ 音名。
 */
import type { Accidental, Degree, ScoreMeta, ScoreNote } from './score';

/** 大调音阶各音级相对主音的半音数（1-7 级） */
export const MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11] as const;

export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const FLAT_PITCH_CLASS_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export const SOLFEGE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'] as const;

export type WrittenPitch = {
  degree: Exclude<Degree, 0>;
  accidental: Accidental;
  octave: number;
};

export function clampPitchClass(pc: number): number {
  return ((pc % 12) + 12) % 12;
}

export function degreeSemitone(degree: Exclude<Degree, 0>): number {
  return MAJOR_SCALE_SEMITONES[degree - 1];
}

export function midiToName(midi: number): string {
  const m = Math.round(midi);
  return `${PITCH_CLASS_NAMES[clampPitchClass(m)]}${Math.floor(m / 12) - 1}`;
}

export function pitchClassOf(midi: number): number {
  return clampPitchClass(Math.round(midi));
}

/** 简谱“1”对应的 MIDI（默认 octave=0 时） */
export function keyBaseMidi(meta: Pick<ScoreMeta, 'keyRoot' | 'baseOctave'>): number {
  return 12 * (meta.baseOctave + 1) + meta.keyRoot;
}

/** 音符 → MIDI（休止符返回 null） */
export function noteToMidi(
  note: Pick<ScoreNote, 'degree' | 'accidental' | 'octave'>,
  meta: Pick<ScoreMeta, 'keyRoot' | 'baseOctave'>,
): number | null {
  if (note.degree === 0) return null;
  return keyBaseMidi(meta) + degreeSemitone(note.degree) + note.accidental + 12 * note.octave;
}

/** MIDI → 简谱写法（选择最自然的级数 + 升降号） */
export function midiToWritten(midi: number, meta: Pick<ScoreMeta, 'keyRoot' | 'baseOctave'>): WrittenPitch {
  const rel = Math.round(midi) - keyBaseMidi(meta);
  const octave = Math.floor(rel / 12);
  const pc = rel - octave * 12;
  for (let i = 0; i < MAJOR_SCALE_SEMITONES.length; i += 1) {
    if (MAJOR_SCALE_SEMITONES[i] === pc) {
      return { degree: (i + 1) as WrittenPitch['degree'], accidental: 0, octave };
    }
  }
  // 非大调音级：用相邻级数加升/降号表示
  const preferFlat = isFlatKey(meta.keyRoot);
  if (preferFlat) {
    for (let i = 0; i < MAJOR_SCALE_SEMITONES.length; i += 1) {
      if (MAJOR_SCALE_SEMITONES[i] - 1 === pc) {
        return { degree: (i + 1) as WrittenPitch['degree'], accidental: -1, octave };
      }
    }
  }
  for (let i = 0; i < MAJOR_SCALE_SEMITONES.length; i += 1) {
    if (MAJOR_SCALE_SEMITONES[i] + 1 === pc) {
      return { degree: (i + 1) as WrittenPitch['degree'], accidental: 1, octave };
    }
  }
  if (!preferFlat) {
    for (let i = 0; i < MAJOR_SCALE_SEMITONES.length; i += 1) {
      if (MAJOR_SCALE_SEMITONES[i] - 1 === pc) {
        return { degree: (i + 1) as WrittenPitch['degree'], accidental: -1, octave };
      }
    }
  }
  // 理论上不可达（大调相邻音级最大间隔 2 个半音）
  return { degree: 1, accidental: 0, octave };
}

export function isFlatKey(keyRoot: number): boolean {
  // F, Bb, Eb, Ab, Db, Gb
  return [5, 10, 3, 8, 1, 6].includes(clampPitchClass(keyRoot));
}

/** 调号显示名（默认用升号记法） */
export function keyName(keyRoot: number): string {
  return PITCH_CLASS_NAMES[clampPitchClass(keyRoot)];
}

export function keyNameFlat(keyRoot: number): string {
  return FLAT_PITCH_CLASS_NAMES[clampPitchClass(keyRoot)];
}

const KEY_NAME_TO_ROOT: Record<string, number> = {
  C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7,
  'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11,
};

const NATURAL_LETTER_TO_ROOT: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** 解析调号文本：支持 "C"、"C#"、"Db"、"bB"、"B♭"、"1=C"、"1 = bB"、"C大调" */
export function parseKeyRoot(input: string): number | null {
  if (!input) return null;
  let text = input.trim();
  const eq = text.indexOf('=');
  if (eq >= 0) text = text.slice(eq + 1).trim();
  text = text
    .replace(/^1\s*=\s*/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/大调|小调|调/g, '')
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .trim();
  if (!text) return null;

  const normalized = text.toUpperCase();
  const direct = KEY_NAME_TO_ROOT[normalized];
  if (direct !== undefined) return direct;

  // 前缀降号：bE / bA / bD / bG / bB
  const flatPrefix = /^B([A-G])$/.exec(normalized);
  if (flatPrefix) {
    const natural = NATURAL_LETTER_TO_ROOT[flatPrefix[1]];
    if (natural !== undefined) return clampPitchClass(natural - 1);
  }
  // 后缀降号：Eb（兼容用户习惯写法）
  const flatSuffix = /^([A-G])B$/.exec(normalized);
  if (flatSuffix) {
    const natural = NATURAL_LETTER_TO_ROOT[flatSuffix[1]];
    if (natural !== undefined) return clampPitchClass(natural - 1);
  }
  return null;
}

export function formatWrittenNote(note: WrittenPitch): string {
  const acc = note.accidental === 1 ? '#' : note.accidental === -1 ? 'b' : '';
  return `${acc}${note.degree}${note.octave > 0 ? "'".repeat(note.octave) : note.octave < 0 ? ','.repeat(-note.octave) : ''}`;
}
