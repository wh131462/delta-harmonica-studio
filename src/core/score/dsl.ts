/**
 * 简谱文本 DSL —— 解析 / 序列化。
 *
 * 语法（面向用户，尽量兼容社区习惯）：
 *   # 标题：小星星
 *   # 速度：100
 *   # 拍号：4/4
 *   # 调号：1=C
 *   # 基础八度：4
 *   1 1 5 5 | 6 6 5- | 4 4 3 3 | 2 2 1- |
 *
 * 音符：
 *   1-7        中音区
 *   ,1 ,5      低八度（前缀逗号，可多个）
 *   1' 5''     高八度（后缀单引号，可多个）
 *   #4 b7      升 / 降号
 *   0          休止符
 * 时值（基础为 1 拍）：
 *   5_         半拍（下划线每多一条再减半：__ = 1/4 拍）
 *   5.         附点（×1.5）
 *   5-         延长 1 拍（每多一条 - 再多 1 拍：5- = 2 拍，5-- = 3 拍）
 *   5:1.25     显式精确拍数（用于 MIDI / 音频分析结果）
 *   5_.        附点八分音符（0.75 拍）
 *   5~ 5       连音线（把前一个音与后面同音高的音连起来）
 *   |          小节线（仅用于校验与排版，解析时忽略）
 *   // 注释
 */

import {
  DEFAULT_META,
  createEmptyScore,
  createId,
  createNote,
  meterBeats,
  normalizeScore,
  nowIso,
  sortNotes,
  type Accidental,
  type Degree,
  type Meter,
  type MeterDen,
  type Score,
  type ScoreMeta,
  type ScoreNote,
  type ScoreSource,
  type ValidationIssue,
} from '../model/score';
import { isFlatKey, keyName, keyNameFlat, parseKeyRoot } from '../model/pitch';

export type ParseSeverity = 'error' | 'warning';

export interface ParseDiagnostic {
  severity: ParseSeverity;
  message: string;
  line?: number;
  column?: number;
  token?: string;
}

export interface ParsedScoreText {
  meta: Partial<ScoreMeta>;
  notes: ScoreNote[];
  diagnostics: ParseDiagnostic[];
  noteCount: number;
  sourceNote?: string;
  /** 小节线位置的拍数（用于校验拍号） */
  bars: number[];
}

const HEADER_ALIASES: Record<string, keyof HeaderTarget> = {
  标题: 'title', 歌名: 'title', 曲名: 'title', title: 'title', name: 'title',
  艺术家: 'artist', 歌手: 'artist', 作者: 'artist', artist: 'artist', composer: 'artist',
  速度: 'tempo', bpm: 'tempo', tempo: 'tempo',
  拍号: 'meter', 节拍: 'meter', meter: 'meter', time: 'meter',
  调号: 'key', 调: 'key', key: 'key',
  基础八度: 'baseOctave', 基准八度: 'baseOctave', baseoctave: 'baseOctave', octave: 'baseOctave',
  备注: 'comment', 说明: 'comment', 描述: 'comment', comment: 'comment',
  来源: 'source', source: 'source',
};

interface HeaderTarget {
  title: string;
  artist: string;
  tempo: string;
  meter: string;
  key: string;
  baseOctave: string;
  comment: string;
  source: string;
}

const FULL_WIDTH_MAP: Record<string, string> = {
  '，': ',', '＃': '#', '♯': '#', '♭': 'b', '’': "'", '′': "'", '‘': "'",
  '｜': '|', '～': '~', '：': ':', '；': ';', '　': ' ', '（': '(', '）': ')',
};

function normalizeText(input: string): string {
  return input
    .replace(/[，＃♯♭’′‘｜～：；　（）]/g, (ch) => FULL_WIDTH_MAP[ch] ?? ch)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\r\n?/g, '\n');
}

function parseMeter(text: string): Meter | null {
  const match = /^(\d+)\s*[/／]\s*(\d+)\s*$/.exec(text.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isInteger(num) || num < 1 || num > 16) return null;
  if (![2, 4, 8, 16].includes(den)) return null;
  return { num, den: den as MeterDen };
}

function parseTempo(text: string): number | null {
  const match = /(-?\d+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  const tempo = Number(match[1]);
  if (!Number.isFinite(tempo) || tempo < 20 || tempo > 320) return null;
  return tempo;
}

export interface ParsedDurationSuffix {
  underlines: number;
  dotted: boolean;
  dashes: number;
  explicit: number | null;
}

export interface ParsedNoteToken {
  degree: Degree;
  accidental: Accidental;
  octave: number;
  duration: number;
  tie: boolean;
}

export type TokenParseResult = { ok: true; note: ParsedNoteToken } | { ok: false; error: string };

/** 解析单个音符 token（不含空格与竖线） */
export function parseNoteToken(token: string): TokenParseResult {
  let i = 0;
  let lowOctave = 0;
  while (token[i] === ',') {
    lowOctave += 1;
    i += 1;
  }
  let accidental: Accidental = 0;
  if (token[i] === '#') {
    accidental = 1;
    i += 1;
  } else if (token[i] === 'b') {
    accidental = -1;
    i += 1;
  }
  const degreeChar = token[i];
  if (!degreeChar || !/[0-7]/.test(degreeChar)) {
    return { ok: false, error: `无法识别音级（应以 0-7 开头）：${token}` };
  }
  const degree = Number(degreeChar) as Degree;
  i += 1;
  let highOctave = 0;
  while (token[i] === "'") {
    highOctave += 1;
    i += 1;
  }
  let rest = token.slice(i);
  let tie = false;
  if (rest.endsWith('~')) {
    tie = true;
    rest = rest.slice(0, -1);
  }

  let underlines = 0;
  let dotted = false;
  let dashes = 0;
  let explicit: number | null = null;
  for (let j = 0; j < rest.length; j += 1) {
    const ch = rest[j];
    if (ch === '_') underlines += 1;
    else if (ch === '.') {
      if (dotted) return { ok: false, error: `附点重复：${token}` };
      dotted = true;
    } else if (ch === '-') dashes += 1;
    else if (ch === ':') {
      const tail = rest.slice(j + 1);
      if (!/^\d+(?:\.\d+)?$/.test(tail)) {
        return { ok: false, error: `显式时值应写作 :1.5 形式：${token}` };
      }
      explicit = Number(tail);
      j = rest.length;
    } else {
      return { ok: false, error: `无法识别的时值记号 “${ch}”：${token}` };
    }
  }
  if (explicit !== null && (underlines > 0 || dotted || dashes > 0)) {
    return { ok: false, error: `显式时值不能与 _ / . / - 混用：${token}` };
  }
  let duration: number;
  if (explicit !== null) duration = explicit;
  else duration = 2 ** -underlines * (dotted ? 1.5 : 1) + dashes;
  if (!Number.isFinite(duration) || duration < 0.05 || duration > 64) {
    return { ok: false, error: `时值 ${duration} 拍超出 0.05-64 范围：${token}` };
  }
  if (degree === 0) {
    if (accidental !== 0) return { ok: false, error: `休止符不能带升降号：${token}` };
    if (highOctave !== 0 || lowOctave !== 0) return { ok: false, error: `休止符不能带八度标记：${token}` };
    return { ok: true, note: { degree: 0, accidental: 0, octave: 0, duration, tie: false } };
  }
  const octave = highOctave - lowOctave;
  if (Math.abs(octave) > 4) return { ok: false, error: `八度标记过多（最多 ±4）：${token}` };
  return { ok: true, note: { degree, accidental, octave, duration, tie } };
}

function headerKeyOf(raw: string): keyof HeaderTarget | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s+/g, '');
  return HEADER_ALIASES[key] ?? null;
}

/** 解析简谱文本；不会抛异常，问题全部放在 diagnostics 中 */
export function parseScoreText(text: string): ParsedScoreText {
  const diagnostics: ParseDiagnostic[] = [];
  const notes: ScoreNote[] = [];
  const meta: Partial<ScoreMeta> = {};
  const bars: number[] = [];
  let cursor = 0;
  let sourceNote: string | undefined;

  const normalized = normalizeText(text ?? '');
  const lines = normalized.split('\n');

  const addDiagnostic = (severity: ParseSeverity, message: string, line?: number, column?: number, token?: string) =>
    diagnostics.push({ severity, message, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}), ...(token ? { token } : {}) });

  const applyHeader = (key: keyof HeaderTarget, value: string, lineNo: number) => {
    switch (key) {
      case 'title':
        if (value) meta.title = value;
        break;
      case 'artist':
        if (value) meta.artist = value;
        break;
      case 'tempo': {
        const tempo = parseTempo(value);
        if (tempo === null) addDiagnostic('warning', `速度值无效，已忽略：${value}`, lineNo);
        else meta.tempo = tempo;
        break;
      }
      case 'meter': {
        const meter = parseMeter(value);
        if (!meter) addDiagnostic('warning', `拍号无效（支持 2/4、3/4、4/4、6/8 等），已忽略：${value}`, lineNo);
        else meta.meter = meter;
        break;
      }
      case 'key': {
        const root = parseKeyRoot(value);
        if (root === null) addDiagnostic('warning', `调号无法识别，已忽略：${value}`, lineNo);
        else meta.keyRoot = root;
        break;
      }
      case 'baseOctave': {
        const octave = Number.parseInt(value.replace(/[^\d-]/g, ''), 10);
        if (!Number.isInteger(octave) || octave < 0 || octave > 8) {
          addDiagnostic('warning', `基础八度无效（0-8），已忽略：${value}`, lineNo);
        } else meta.baseOctave = octave;
        break;
      }
      case 'comment':
        meta.comment = meta.comment ? `${meta.comment}\n${value}` : value;
        break;
      case 'source':
        sourceNote = sourceNote ? `${sourceNote}；${value}` : value;
        break;
      default:
        break;
    }
  };

  const handleToken = (token: string, lineNo: number, column: number) => {
    if (token === '~') {
      const last = notes[notes.length - 1];
      if (last && last.degree !== 0) last.tie = true;
      else addDiagnostic('warning', '连音线 “~” 前面没有可连接的音符', lineNo, column, token);
      return;
    }
    const parsed = parseNoteToken(token);
    if (!parsed.ok) {
      addDiagnostic('error', parsed.error, lineNo, column, token);
      return;
    }
    notes.push(
      createNote({
        ...parsed.note,
        startBeat: cursor,
      }),
    );
    cursor += parsed.note.duration;
  };

  const parseContent = (content: string, lineNo: number) => {
    let i = 0;
    while (i < content.length) {
      const ch = content[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '|') {
        if (bars.length === 0 || Math.abs(bars[bars.length - 1] - cursor) > 1e-6) bars.push(cursor);
        i += 1;
        continue;
      }
      const start = i;
      let token = '';
      while (i < content.length && !/\s/.test(content[i]) && content[i] !== '|') {
        token += content[i];
        i += 1;
      }
      if (token) handleToken(token, lineNo, start + 1);
    }
  };

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('//') || line.startsWith(';')) return;
    let content = line;
    if (content.startsWith('#')) {
      const rest = content.slice(1).trim();
      if (rest) {
        const withColon = /^([^:：]{1,16})[:：]\s*(.*)$/.exec(rest);
        const withSpace = withColon ? null : /^(\S{1,16})\s+(.+)$/.exec(rest);
        const match = withColon ?? withSpace;
        if (match) {
          const key = headerKeyOf(match[1]);
          if (key) {
            applyHeader(key, match[2].trim(), lineNo);
            return;
          }
        }
        if (/^[0-7#b,'\s]/.test(rest)) {
          content = rest;
        } else {
          return; // 普通注释行
        }
      } else {
        return;
      }
    }
    const commentIdx = content.indexOf('//');
    if (commentIdx >= 0) content = content.slice(0, commentIdx);
    if (!content.trim()) return;
    parseContent(content, lineNo);
  });

  if (notes.length === 0) {
    addDiagnostic('error', '没有解析到任何音符（示例：1 1 5 5 | 6 6 5- |）');
  }

  // 拍号校验（仅当用户写了小节线）
  const meter = meta.meter ?? DEFAULT_META.meter;
  const measure = meterBeats(meter);
  if (bars.length > 0 && measure > 0) {
    const boundaries = [0, ...bars, cursor];
    for (let i = 1; i < boundaries.length - 1; i += 1) {
      const beats = boundaries[i] - boundaries[i - 1];
      if (Math.abs(beats - measure) > 1e-3) {
        addDiagnostic(
          'warning',
          `第 ${i} 小节为 ${Number(beats.toFixed(3))} 拍，与拍号 ${meter.num}/${meter.den}（${measure} 拍）不符`,
        );
      }
    }
  }

  return {
    meta,
    notes,
    diagnostics,
    noteCount: notes.filter((note) => note.degree !== 0).length,
    ...(sourceNote ? { sourceNote } : {}),
    bars,
  };
}

function roundBeats(value: number): number {
  return Number(value.toFixed(6));
}

/** 时值 → DSL 后缀（不含基础音级） */
export function formatDurationSuffix(duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return ':1';
  const d = roundBeats(duration);
  if (Math.abs(d - 1) < 1e-6) return '';
  if (Math.abs(d - 1.5) < 1e-6) return '.';
  if (Math.abs(d - 0.5) < 1e-6) return '_';
  if (Math.abs(d - 0.75) < 1e-6) return '_.';
  if (Math.abs(d - 0.25) < 1e-6) return '__';
  if (Math.abs(d - 0.375) < 1e-6) return '__.';
  if (Math.abs(d - 0.125) < 1e-6) return '___';
  if (Math.abs(d - 0.0625) < 1e-6) return '____';
  if (Math.abs(d - 2) < 1e-6) return '-';
  if (Math.abs(d - 3) < 1e-6) return '--';
  if (Math.abs(d - 4) < 1e-6) return '---';
  if (d >= 2 && Math.abs(d - Math.round(d)) < 1e-6) return '-'.repeat(Math.round(d) - 1);
  return `:${Number(d.toFixed(4))}`;
}

/** 单个音符 → DSL token */
export function formatNoteToken(note: Pick<ScoreNote, 'degree' | 'accidental' | 'octave' | 'duration' | 'tie'>): string {
  const low = note.octave < 0 ? ','.repeat(-note.octave) : '';
  const high = note.octave > 0 ? "'".repeat(note.octave) : '';
  const accidental = note.accidental === 1 ? '#' : note.accidental === -1 ? 'b' : '';
  const suffix = formatDurationSuffix(note.duration);
  return `${low}${accidental}${note.degree}${high}${suffix}${note.tie ? '~' : ''}`;
}

/** Score → 简谱文本（可再次解析，即 round-trip 稳定） */
export function serializeScore(score: Score): string {
  const meta = score.meta;
  const headerLines: string[] = [];
  headerLines.push(`# 标题：${meta.title || '未命名'}`);
  if (meta.artist) headerLines.push(`# 艺术家：${meta.artist}`);
  headerLines.push(`# 速度：${roundBeats(meta.tempo)}`);
  headerLines.push(`# 拍号：${meta.meter.num}/${meta.meter.den}`);
  const keyText = isFlatKey(meta.keyRoot) ? keyNameFlat(meta.keyRoot) : keyName(meta.keyRoot);
  headerLines.push(`# 调号：1=${keyText}`);
  headerLines.push(`# 基础八度：${meta.baseOctave}`);
  if (meta.comment) headerLines.push(`# 备注：${meta.comment.replace(/\n/g, ' / ')}`);
  if (score.source?.note) headerLines.push(`# 来源：${score.source.note}`);

  const measure = meterBeats(meta.meter);
  const sorted = sortNotes(score.notes ?? []);
  const parts: string[] = [];
  let cursor = 0;
  let nextBar = measure;
  /** 只在恰好落到小节边界时才输出小节线；被音符跨过的边界直接跳过，避免误导 */
  const pushBarAtBoundary = () => {
    if (!(measure > 0)) return;
    while (cursor >= nextBar - 1e-4) {
      if (Math.abs(cursor - nextBar) < 1e-3) {
        parts.push('|');
        nextBar += measure;
        return;
      }
      nextBar += measure;
    }
  };
  const pushRest = (beats: number) => {
    let remaining = roundBeats(beats);
    // 长的空档拆成可读的休止符
    while (remaining > 1e-4) {
      const take = Math.min(remaining, 4);
      parts.push(`0${formatDurationSuffix(roundBeats(take))}`);
      cursor += take;
      remaining = roundBeats(remaining - take);
      pushBarAtBoundary();
    }
  };

  for (const note of sorted) {
    if (note.startBeat > cursor + 1e-4) {
      pushRest(note.startBeat - cursor);
    }
    pushBarAtBoundary();
    const overlap = Math.max(0, cursor - note.startBeat);
    const duration = Math.max(0.05, note.duration - overlap);
    parts.push(formatNoteToken({ ...note, duration }));
    cursor = Math.max(cursor, note.startBeat) + duration;
    pushBarAtBoundary();
  }
  if (parts.length === 0) parts.push('0');
  if (measure > 0 && Math.abs(cursor / measure - Math.round(cursor / measure)) < 1e-4 && parts[parts.length - 1] !== '|') {
    parts.push('|');
  }

  const bodyLines: string[] = [];
  let current: string[] = [];
  let barsInLine = 0;
  for (const part of parts) {
    current.push(part);
    if (part === '|') {
      barsInLine += 1;
      if (barsInLine >= 4) {
        bodyLines.push(current.join(' '));
        current = [];
        barsInLine = 0;
      }
    } else if (current.join(' ').length > 90) {
      bodyLines.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) bodyLines.push(current.join(' '));

  return [...headerLines, '', ...bodyLines, ''].join('\n');
}

const EMPTY_SOURCE: Partial<ScoreSource> = {};

export function buildScoreFromText(
  text: string,
  options: { title?: string; source?: Partial<ScoreSource>; id?: string } = {},
): { score: Score; diagnostics: ParseDiagnostic[] } {
  const parsed = parseScoreText(text);
  const meta: ScoreMeta = {
    ...DEFAULT_META,
    ...parsed.meta,
    meter: { ...DEFAULT_META.meter, ...(parsed.meta.meter ?? {}) },
  };
  if (options.title) meta.title = options.title;
  const score = createEmptyScore({ meta });
  if (options.id) score.id = options.id;
  score.notes = parsed.notes;
  score.source = {
    kind: 'text',
    importedAt: nowIso(),
    ...(parsed.sourceNote ? { note: parsed.sourceNote } : {}),
    ...EMPTY_SOURCE,
    ...(options.source ?? {}),
  };
  const normalized = normalizeScore(score);
  const diagnostics: ParseDiagnostic[] = [
    ...parsed.diagnostics,
    ...normalized.issues.map((issue: ValidationIssue) => ({
      severity: issue.severity,
      message: issue.message,
    })),
  ];
  return { score: normalized.score, diagnostics };
}

/** 生成新的空白乐谱（带一个可编辑的初始音符，避免编辑器空状态） */
export function createNewScoreDraft(title = '新乐谱'): { score: Score; text: string } {
  const score = createEmptyScore({ title });
  score.notes = [createNote({ degree: 1, startBeat: 0, duration: 1 })];
  return { score, text: serializeScore(score) };
}

export { createId as createNoteId };
