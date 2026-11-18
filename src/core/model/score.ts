/**
 * 简谱数据模型 —— 纯 TypeScript，不依赖 Electron / DOM，可在 Node 中直接单测。
 *
 * 设计要点：
 * - 所有音符使用「绝对拍位 startBeat + 时值 duration」，而不是隐式顺序，
 *   这样从 MIDI / 音频分析导入的非均匀节奏也能无歧义表达，休止符只是空档（也可显式记为 degree=0）。
 * - 1 拍 = 四分音符；tempo 是每分钟四分音符数。
 * - 简谱的“1”由 keyRoot（0=C … 11=B）+ baseOctave 决定绝对音高。
 */

export const SCORE_SCHEMA = 'dfh.score/1' as const;
export type ScoreSchema = typeof SCORE_SCHEMA;

/** 0 = 休止符；1-7 = do re mi fa sol la si */
export type Degree = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** -1 = ♭，0 = 本位，+1 = ♯ */
export type Accidental = -1 | 0 | 1;

export type MeterDen = 2 | 4 | 8 | 16;

export interface Meter {
  num: number;
  den: MeterDen;
}

export interface ScoreNote {
  id: string;
  degree: Degree;
  accidental: Accidental;
  /** 相对简谱基准八度的偏移：0=中音，+1=高音（点在上方），-1=低音（点在下方） */
  octave: number;
  /** 起始位置，单位：拍（四分音符 = 1 拍），从 0 开始 */
  startBeat: number;
  /** 时值，单位：拍 */
  duration: number;
  /** 与紧随其后的同音高音符连音（演奏时合并为一个长音） */
  tie: boolean;
  lyric?: string;
}

export interface ScoreMeta {
  title: string;
  artist?: string;
  comment?: string;
  /** 每分钟四分音符数 */
  tempo: number;
  meter: Meter;
  /** 简谱“1”的音高（0=C … 11=B） */
  keyRoot: number;
  /** 简谱“1”所在八度（科学音高记法，4 → C4 = MIDI 60） */
  baseOctave: number;
}

export type ScoreSourceKind = 'manual' | 'text' | 'midi' | 'audio' | 'builtin' | 'keyscore';

export interface ScoreSource {
  kind: ScoreSourceKind;
  fileName?: string;
  importedAt?: string;
  /** 自动转谱置信度 0-1（可选） */
  confidence?: number;
  note?: string;
}

export interface Score {
  schema: ScoreSchema;
  id: string;
  meta: ScoreMeta;
  notes: ScoreNote[];
  source: ScoreSource;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  noteIndex?: number;
}

export const DEFAULT_META: ScoreMeta = {
  title: '未命名',
  tempo: 100,
  meter: { num: 4, den: 4 },
  keyRoot: 0,
  baseOctave: 4,
};

export const EPSILON = 1e-6;

let idCounter = 0;
export function createId(prefix = 'n'): string {
  idCounter += 1;
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const rand =
    typeof cryptoObj?.randomUUID === 'function'
      ? cryptoObj.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${rand}-${idCounter.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 一小节的拍数（四分音符为单位） */
export function meterBeats(meter: Meter): number {
  return meter.num * (4 / meter.den);
}

export function createNote(partial: Partial<ScoreNote> = {}): ScoreNote {
  const note: ScoreNote = {
    id: partial.id ?? createId('n'),
    degree: partial.degree ?? 1,
    accidental: partial.accidental ?? 0,
    octave: partial.octave ?? 0,
    startBeat: partial.startBeat ?? 0,
    duration: partial.duration ?? 1,
    tie: partial.tie ?? false,
    ...(partial.lyric !== undefined ? { lyric: partial.lyric } : {}),
  };
  return note;
}

export function createEmptyScore(partial: { meta?: Partial<ScoreMeta>; title?: string } = {}): Score {
  const now = nowIso();
  const meta: ScoreMeta = {
    ...DEFAULT_META,
    ...(partial.meta ?? {}),
    meter: { ...DEFAULT_META.meter, ...(partial.meta?.meter ?? {}) },
  };
  if (partial.title) meta.title = partial.title;
  return {
    schema: SCORE_SCHEMA,
    id: createId('score'),
    meta,
    notes: [],
    source: { kind: 'manual', importedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

export function noteEnd(note: Pick<ScoreNote, 'startBeat' | 'duration'>): number {
  return note.startBeat + note.duration;
}

export function scoreEndBeat(score: Score): number {
  let end = 0;
  for (const note of score.notes) end = Math.max(end, noteEnd(note));
  return end;
}

/** 返回按 startBeat 排序的新数组（稳定：同拍位保持原顺序） */
export function sortNotes(notes: readonly ScoreNote[]): ScoreNote[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.startBeat - b.note.startBeat || a.index - b.index)
    .map((item) => item.note);
}

export function cloneScore(score: Score): Score {
  return JSON.parse(JSON.stringify(score)) as Score;
}

const VALID_DENS: readonly number[] = [2, 4, 8, 16];

/** 结构性校验：只报告问题，不修改数据 */
export function validateScore(score: Score): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (severity: 'error' | 'warning', code: string, message: string, noteIndex?: number) =>
    issues.push({ severity, code, message, ...(noteIndex !== undefined ? { noteIndex } : {}) });

  if (!score || typeof score !== 'object') {
    push('error', 'score.invalid', '乐谱对象无效');
    return issues;
  }
  if (score.schema !== SCORE_SCHEMA) {
    push('warning', 'schema.version', `乐谱 schema 为 ${String(score.schema)}，当前版本 ${SCORE_SCHEMA}`);
  }
  const meta = score.meta;
  if (!meta || typeof meta !== 'object') {
    push('error', 'meta.missing', '缺少乐谱元信息');
  } else {
    if (!Number.isFinite(meta.tempo) || meta.tempo < 20 || meta.tempo > 320) {
      push('error', 'meta.tempo', `速度应在 20-320 BPM 之间（当前 ${String(meta.tempo)}）`);
    }
    if (!Number.isInteger(meta.keyRoot) || meta.keyRoot < 0 || meta.keyRoot > 11) {
      push('error', 'meta.keyRoot', '调号 keyRoot 必须是 0-11 的整数');
    }
    if (!Number.isInteger(meta.baseOctave) || meta.baseOctave < 0 || meta.baseOctave > 8) {
      push('error', 'meta.baseOctave', '基础八度必须是 0-8 的整数');
    }
    if (!meta.meter || !Number.isInteger(meta.meter.num) || meta.meter.num < 1 || meta.meter.num > 16) {
      push('error', 'meta.meter.num', '拍号分子应为 1-16 的整数');
    } else if (!VALID_DENS.includes(meta.meter.den)) {
      push('error', 'meta.meter.den', '拍号分母应为 2/4/8/16');
    }
  }
  if (!Array.isArray(score.notes)) {
    push('error', 'notes.missing', '缺少音符列表');
    return issues;
  }
  if (score.notes.length === 0) {
    push('warning', 'notes.empty', '乐谱没有任何音符');
  }
  const ids = new Set<string>();
  let prevEnd = -Infinity;
  score.notes.forEach((note, index) => {
    if (!note || typeof note !== 'object') {
      push('error', 'note.invalid', `第 ${index + 1} 个音符无效`, index);
      return;
    }
    if (!Number.isInteger(note.degree) || note.degree < 0 || note.degree > 7) {
      push('error', 'note.degree', `第 ${index + 1} 个音符级数应为 0-7`, index);
    }
    if (note.accidental !== -1 && note.accidental !== 0 && note.accidental !== 1) {
      push('error', 'note.accidental', `第 ${index + 1} 个音符升降号无效`, index);
    }
    if (note.degree === 0 && note.accidental !== 0) {
      push('warning', 'rest.accidental', `第 ${index + 1} 个休止符不应带升降号`, index);
    }
    if (!Number.isInteger(note.octave) || note.octave < -4 || note.octave > 4) {
      push('error', 'note.octave', `第 ${index + 1} 个音符八度偏移应为 -4 到 4 的整数`, index);
    }
    if (!Number.isFinite(note.startBeat) || note.startBeat < 0) {
      push('error', 'note.start', `第 ${index + 1} 个音符起点非法`, index);
    }
    if (!Number.isFinite(note.duration) || note.duration < 0.05 || note.duration > 64) {
      push('error', 'note.duration', `第 ${index + 1} 个音符时值应在 0.05-64 拍之间`, index);
    }
    if (typeof note.tie !== 'boolean') {
      push('error', 'note.tie', `第 ${index + 1} 个音符 tie 字段非法`, index);
    }
    if (note.id) {
      if (ids.has(note.id)) push('warning', 'note.id.dup', `音符 id 重复：${note.id}`, index);
      ids.add(note.id);
    }
    if (note.degree !== 0 && Number.isFinite(note.startBeat)) {
      if (note.startBeat < prevEnd - EPSILON) {
        push('warning', 'note.overlap', `第 ${index + 1} 个音符与前一个音符重叠（单声部口琴无法同时发声）`, index);
      }
      prevEnd = Math.max(prevEnd, noteEnd(note));
    }
  });
  return issues;
}

/** 规范化：排序、去重 id、夹取值域，返回新的乐谱对象（不可变风格） */
export function normalizeScore(input: Score): { score: Score; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const score = cloneScore(input);
  const meta = score.meta ?? { ...DEFAULT_META };
  if (!Number.isFinite(meta.tempo)) meta.tempo = DEFAULT_META.tempo;
  meta.tempo = Math.min(320, Math.max(20, meta.tempo));
  if (!Number.isInteger(meta.keyRoot) || meta.keyRoot < 0 || meta.keyRoot > 11) meta.keyRoot = 0;
  if (!Number.isInteger(meta.baseOctave) || meta.baseOctave < 0 || meta.baseOctave > 8) meta.baseOctave = 4;
  if (!meta.meter || !Number.isInteger(meta.meter.num) || meta.meter.num < 1) meta.meter = { ...DEFAULT_META.meter };
  if (!VALID_DENS.includes(meta.meter.den)) meta.meter.den = 4;
  if (typeof meta.title !== 'string' || meta.title.trim() === '') meta.title = DEFAULT_META.title;
  score.meta = meta;

  const seen = new Set<string>();
  const notes: ScoreNote[] = [];
  for (const raw of Array.isArray(score.notes) ? score.notes : []) {
    const note = createNote({
      ...raw,
      degree: (Math.round(Number(raw?.degree ?? 1)) as Degree),
      accidental: (Math.sign(Number(raw?.accidental ?? 0)) as Accidental),
      octave: Math.round(Number(raw?.octave ?? 0)),
      startBeat: Number(raw?.startBeat ?? 0),
      duration: Number(raw?.duration ?? 1),
      tie: Boolean(raw?.tie),
    });
    if (note.degree < 0 || note.degree > 7) note.degree = 1;
    if (!Number.isInteger(note.degree)) note.degree = 1;
    if (note.accidental !== -1 && note.accidental !== 0 && note.accidental !== 1) note.accidental = 0;
    note.octave = Math.min(4, Math.max(-4, note.octave));
    note.startBeat = Math.max(0, note.startBeat);
    note.duration = Math.min(64, Math.max(0.05, note.duration));
    if (seen.has(note.id)) {
      issues.push({ severity: 'warning', code: 'note.id.dup', message: `重复音符 id 已重新生成：${note.id}` });
      note.id = createId('n');
    }
    seen.add(note.id);
    if (note.degree === 0) note.accidental = 0;
    notes.push(note);
  }
  score.notes = sortNotes(notes);
  // tie 只对同音高且紧邻的下一音符有效
  score.notes.forEach((note, index) => {
    if (!note.tie) return;
    const next = score.notes[index + 1];
    const merged =
      next &&
      next.degree === note.degree &&
      next.accidental === note.accidental &&
      next.octave === note.octave &&
      Math.abs(next.startBeat - noteEnd(note)) < 1e-3;
    if (!merged) {
      note.tie = false;
      issues.push({
        severity: 'warning',
        code: 'tie.broken',
        message: `第 ${index + 1} 个音符的连音线后面不是同音高紧邻音符，已取消`,
        noteIndex: index,
      });
    }
  });
  score.schema = SCORE_SCHEMA;
  score.updatedAt = nowIso();
  return { score, issues };
}
