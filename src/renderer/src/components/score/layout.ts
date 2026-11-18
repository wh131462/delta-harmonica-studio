/**
 * 简谱布局计算 —— 纯函数，不依赖 React / DOM / 浏览器 API，可直接在 Node 里单测。
 *
 * 设计要点：
 * - 输入 Score + 每行小节数，输出一套「绝对坐标」的绘制数据（行、小节、音符、
 *   减时线、八度点、附点、增时线、连音线、小节线、小节号），ScoreView 只负责把这些
 *   数据画成 SVG。这样排版逻辑完全可测，且编辑器 / 演奏页 / 导出图片可以复用同一份布局。
 * - 画布宽度固定（SCORE_LAYOUT_METRICS.width），组件用 viewBox + width:100% 等比缩放，
 *   因此这里的数字是「设计坐标」，与实际像素无关；zoom 只影响最终显示尺寸。
 * - 简谱规范（本文件遵循的约定）：
 *   · 音符为 1-7 的数字，休止符为 0，升降号写在数字左侧；
 *   · 高八度点画在数字上方、低八度点画在数字下方，最多画 3 个；
 *   · 减时线（八分/十六分/三十二分……）画在数字下方；
 *   · 低八度点与减时线同时出现时，八度点画在减时线下方（简谱书写规范）；
 *   · 附点画在数字右侧；时值 >= 2 拍时在数字后按拍画增时横线“—”；
 *   · 小节线按拍号自动划分，行首小节上方标小节号。
 * - 单个音符的时值只决定「水平位置 + 附加符号」，不改变字号；极密集（例如每拍 4 个
 *   十六分音符）时允许数字轻微重叠，见文件末尾的已知限制。
 */
import {
  EPSILON,
  meterBeats,
  type Accidental,
  type Degree,
  type Meter,
  type MeterDen,
  type Score,
  type ScoreMeta,
} from '@core/model/score';

/** 布局常量：改这里即可整体调整排版比例（组件与测试共用） */
export const SCORE_LAYOUT_METRICS = {
  /** 设计画布宽度（viewBox 宽度） */
  width: 1160,
  /** 左右留白；右侧留出小节线到画布边缘的呼吸空间 */
  paddingX: 36,
  /** 顶部留白：第一行上方要放小节号 */
  paddingTop: 40,
  paddingBottom: 28,
  /** 小节内部左右留白：左侧额外留出升降号的位置 */
  measurePadLeft: 28,
  measurePadRight: 20,
  /** 数字字号 / 数字墨迹宽度 */
  fontSize: 34,
  digitWidth: 21,
  /** 数字墨迹半高（约 0.36em，Segoe UI 数字的视觉高度） */
  inkHalfHeight: 12.24,
  /** 升降号：宽度、与数字的间距、字号 */
  accidentalWidth: 13,
  accidentalGap: 3,
  accidentalFontSize: 21,
  /** 升降号基线相对数字基线的抬升量（升/降号写在数字左上方） */
  accidentalRaise: 10,
  /** 八度点：半径、与数字墨迹间距、点间距 */
  octaveDotRadius: 2.7,
  octaveGap: 6,
  octaveDotSpacing: 7,
  /** 减时线：与数字墨迹间距、层间距、线宽、线长 */
  underlineGap: 6,
  underlineSpacing: 7,
  underlineThickness: 1.8,
  underlineWidth: 23,
  /** 附点 */
  dottedDotRadius: 3,
  dottedGap: 7,
  /** 增时线（延音横线） */
  dashThickness: 2.4,
  dashMaxLength: 28,
  dashMinLength: 6,
  /** 一行内增时线最少占用的横向空间，用于裁剪过密绘制 */
  dashMinSlot: 9,
  /** 行高 / 行距 / 数字中心相对行顶的偏移 */
  rowHeight: 100,
  lyricExtra: 28,
  rowGap: 30,
  rowCenterOffset: 44,
  /** 小节线相对数字中心的上下延伸 */
  barlineUp: 40,
  barlineDown: 52,
  /** 小节号：字号、位于行顶上方多少 */
  measureNumberFontSize: 12,
  measureNumberOffsetY: 12,
  /** 歌词：距行底的基线偏移 */
  lyricBottomOffset: 12,
  /** 连音线：与音符墨迹的间距、拱高范围 */
  tieGap: 5,
  tieMinHeight: 9,
  tieMaxHeight: 20,
  /** 同行内相邻音符的最小水平间距（避免升降号/附点互相压住） */
  noteMinGap: 5,
} as const;

const M = SCORE_LAYOUT_METRICS;

/** 八度点方向 */
export type OctaveDirection = 'up' | 'down' | 'none';

/** 布局点（数字中心、八度点圆心、附点圆心等） */
export interface LayoutPoint {
  x: number;
  y: number;
}

/** 布局线段（减时线、增时线） */
export interface LayoutSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 布局矩形（选中高亮背景） */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 时值对应的简谱符号数量 */
export interface DurationGlyphs {
  /** 减时线条数（0 = 四分及以上，1 = 八分，2 = 十六分，3 = 三十二分，4 = 六十四分） */
  underlines: number;
  /** 是否附点（1.5、0.75、0.375 …… 拍） */
  dotted: boolean;
  /** 增时横线条数（时值 >= 2 拍时：2 拍 1 条、3 拍 2 条 ……） */
  extensionLines: number;
}

/** 单个音符的完整布局结果 */
export interface LayoutNote {
  /** React key（在整份布局内唯一、稳定，不使用随机数） */
  key: string;
  /** 音符 id（可能为空字符串） */
  id: string;
  /** 排序后的音符序号（从 0 开始） */
  index: number;
  degree: Degree;
  accidental: Accidental;
  /** 数字文本：'0'-'7' */
  text: string;
  /** 升降号语义文本：'' | '#' | 'b' */
  accidentalText: '' | '#' | 'b';
  /** 升降号显示符号：'' | '♯' | '♭'（渲染用，比 #/b 更像正式简谱） */
  accidentalSymbol: '' | '♯' | '♭';
  /** 升降号文本锚点 x（text-anchor: middle） */
  accidentalX: number;
  /** 升降号文本基线 y（alphabetic 基线，比数字基线略高） */
  accidentalBaselineY: number;
  isRest: boolean;
  /** 原始八度偏移（-4..4） */
  octave: number;
  /** 八度点个数（0..3，规范最多 3 个） */
  octaveDotCount: number;
  octaveDirection: OctaveDirection;
  /** 八度点圆心坐标 */
  octaveDots: LayoutPoint[];
  startBeat: number;
  duration: number;
  endBeat: number;
  /** 是否与下一个同音高音符连音（连音线由 layout.ties 单独给出） */
  tie: boolean;
  measureIndex: number;
  rowIndex: number;
  /** 数字墨迹中心 x */
  x: number;
  /** 数字墨迹中心 y（同一行的数字中心 y 相同） */
  y: number;
  /** 数字文本基线 y（SVG text 的 y 属性；= y + 墨迹半高） */
  digitBaselineY: number;
  /** 减时线条数 */
  underlineCount: number;
  underlines: LayoutSegment[];
  /** 附点 */
  dotted: boolean;
  dottedPoint: LayoutPoint | null;
  /** 增时横线条数（语义数量，可能因横向空间不足而少画） */
  extensionLineCount: number;
  extensionLines: LayoutSegment[];
  /** 选中高亮背景范围（含八度点 / 减时线 / 附点，不含增时线） */
  bounds: LayoutRect;
  /** hover tooltip 文本：音名 + 时值拍数 */
  tooltip: string;
  /** 音名（如 C4）或「休止」 */
  noteName: string;
  /** 唱名（do/re/mi/fa/sol/la/si；休止符为空字符串） */
  solfege: string;
  /** 歌词（没有则为空字符串） */
  lyric: string;
  lyricX: number;
  lyricY: number;
}

/** 小节 */
export interface LayoutMeasure {
  /** 0 开始的小节下标 */
  index: number;
  /** 1 开始的小节号（用于显示） */
  number: number;
  rowIndex: number;
  /** 行内第几列（0 开始） */
  column: number;
  startBeat: number;
  /** 小节结束拍位（按拍号严格划分，可能大于全曲实际结尾） */
  endBeat: number;
  x: number;
  width: number;
}

/** 一行（system） */
export interface LayoutRow {
  index: number;
  /** 起始小节下标（含） */
  startMeasure: number;
  /** 结束小节下标（不含） */
  endMeasure: number;
  measureCount: number;
  /** 行顶 y */
  top: number;
  /** 行高 */
  height: number;
  /** 数字中心 y */
  centerY: number;
}

/** 小节线类型：行首线 / 普通小节线 / 终止线（细线 + 粗线） */
export type BarlineKind = 'start' | 'bar' | 'final-thin' | 'final-thick';

export interface LayoutBarline {
  x: number;
  y1: number;
  y2: number;
  rowIndex: number;
  /** 该线右侧所属小节的下标（行首 / 小节分界） */
  measureIndex: number;
  kind: BarlineKind;
}

/** 每行行首小节上方的小节号 */
export interface LayoutMeasureNumber {
  measureIndex: number;
  rowIndex: number;
  text: string;
  x: number;
  y: number;
}

/** 连音线（贝塞尔曲线，直接作为 path d 使用） */
export interface LayoutTie {
  fromNoteId: string;
  toNoteId: string;
  rowIndex: number;
  path: string;
}

/** 一份乐谱的完整布局（纯数据，供组件 / 测试 / 播放指示器复用） */
export interface ScoreLayout {
  /** 设计画布宽高 */
  width: number;
  height: number;
  /** 每小节拍数（四分音符为单位） */
  measureBeats: number;
  /** 每行最多小节数 */
  measuresPerRow: number;
  measureCount: number;
  rowCount: number;
  /** 全曲总拍数（最后音符的结束拍） */
  totalBeats: number;
  /** 行首是否有歌词（决定行高） */
  hasLyric: boolean;
  rows: LayoutRow[];
  measures: LayoutMeasure[];
  notes: LayoutNote[];
  barlines: LayoutBarline[];
  measureNumbers: LayoutMeasureNumber[];
  ties: LayoutTie[];
}

export interface ScoreLayoutOptions {
  /** 每行最多几小节，默认 4 */
  measuresPerRow?: number;
}

/** 与 pitch.ts 保持一致的音名 / 唱名表（这里内联一份，避免布局模块耦合更多依赖） */
const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11] as const;
const SOLFEGE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'] as const;

const DURATION_EPS = 1e-6;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把浮点坐标收敛到 2 位小数，避免 SVG path / 坐标出现长小数 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 拍数显示：1 / 1.5 / 0.75 …… */
export function formatBeatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/**
 * 时值 → 简谱符号数量（纯函数，可单独测试）。
 *
 * 支持的标准时值：1（四分）、0.5（八分）、0.25（十六分）、0.125（三十二分）、
 * 0.0625（六十四分），以及它们的附点形式（×1.5）。时值 >= 2 拍用增时横线表示
 * （2 拍 1 条、3 拍 2 条、4 拍 3 条 ……）。从 MIDI / 音频导入的非常规时值会被
 * 近似到最接近的简谱符号（例如 1.25 拍显示为 1 拍），见文件末尾的已知限制。
 */
export function describeDuration(duration: number): DurationGlyphs {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { underlines: 0, dotted: false, extensionLines: 0 };
  }
  // 二分音符及以上：增时线
  if (duration >= 2 - DURATION_EPS) {
    const whole = Math.floor(duration + DURATION_EPS);
    return { underlines: 0, dotted: false, extensionLines: Math.max(0, whole - 1) };
  }
  // 1 ~ 2 拍：四分音符，1.5 拍为附点四分
  if (duration >= 1 - DURATION_EPS) {
    return { underlines: 0, dotted: Math.abs(duration - 1.5) < 0.05, extensionLines: 0 };
  }
  // 1 拍以下：按 2 的幂次决定减时线条数，再判断是否附点
  const level = Math.max(1, Math.min(4, Math.ceil(-Math.log2(duration) - DURATION_EPS)));
  const base = 2 ** -level;
  const dotted = Math.abs(duration - base * 1.5) <= base * 0.1;
  return { underlines: level, dotted, extensionLines: 0 };
}

/** 音符的绝对音名与唱名（休止符返回「休止」） */
function pitchInfo(
  degree: Degree,
  accidental: Accidental,
  octave: number,
  meta: Pick<ScoreMeta, 'keyRoot' | 'baseOctave'>,
): { noteName: string; solfege: string } {
  if (degree === 0) return { noteName: '休止', solfege: '' };
  const keyRoot = clampInt(meta?.keyRoot, 0, 11, 0);
  const baseOctave = clampInt(meta?.baseOctave, 0, 8, 4);
  const octaveOffset = clampInt(octave, -4, 4, 0);
  const semitone = MAJOR_SCALE_SEMITONES[Math.min(6, Math.max(0, degree - 1))] ?? 0;
  const midi = 12 * (baseOctave + 1) + keyRoot + semitone + accidental + 12 * octaveOffset;
  const pitchClass = ((midi % 12) + 12) % 12;
  const octaveNumber = Math.floor(midi / 12) - 1;
  return {
    noteName: `${PITCH_CLASS_NAMES[pitchClass]}${octaveNumber}`,
    solfege: SOLFEGE_NAMES[Math.min(6, Math.max(0, degree - 1))] ?? '',
  };
}

/** 内部：初步整理后的音符（还差 x 坐标与绘制几何） */
interface PreparedNote {
  sourceIndex: number;
  id: string;
  degree: Degree;
  accidental: Accidental;
  octave: number;
  startBeat: number;
  duration: number;
  endBeat: number;
  tie: boolean;
  lyric: string;
  measureIndex: number;
  rowIndex: number;
  /** 相对小节起点的拍偏移 */
  offsetBeat: number;
  glyphs: DurationGlyphs;
  noteName: string;
  solfege: string;
  /** 左侧墨迹扩展到数字中心的宽度（含升降号） */
  leftPad: number;
  /** 右侧墨迹扩展到数字中心的宽度（含附点） */
  rightPad: number;
  /** 最终数字中心 x */
  x: number;
}

/** 取拍号对应的小节拍数；数据非法时退回 4/4 */
function resolveMeasureBeats(meta: ScoreMeta | undefined): number {
  const meter: Partial<Meter> | undefined = meta?.meter;
  const num = typeof meter?.num === 'number' && Number.isFinite(meter.num) && meter.num >= 1 ? meter.num : 4;
  const rawDen = typeof meter?.den === 'number' ? meter.den : 4;
  const den: MeterDen = rawDen === 2 || rawDen === 4 || rawDen === 8 || rawDen === 16 ? rawDen : 4;
  const beats = meterBeats({ num, den });
  return beats > 0 ? beats : 4;
}

/** 整理并过滤音符（排序、夹取非法值，避免 NaN 进入几何计算） */
function prepareNotes(
  score: Score,
  measureBeats: number,
  measureCount: number,
  measuresPerRow: number,
  meta: ScoreMeta | undefined,
): PreparedNote[] {
  const rawNotes = Array.isArray(score?.notes) ? score.notes : [];
  const prepared: PreparedNote[] = [];
  rawNotes.forEach((raw, sourceIndex) => {
    if (!raw || typeof raw !== 'object') return;
    const startBeat = Number(raw.startBeat);
    const duration = Number(raw.duration);
    if (!Number.isFinite(startBeat) || !Number.isFinite(duration) || duration <= 0) return;
    const safeStart = Math.max(0, startBeat);
    const safeDuration = Math.min(64, Math.max(0.05, duration));
    const degree = clampInt(raw.degree, 0, 7, 1) as Degree;
    const accidental = (degree === 0 ? 0 : clampInt(raw.accidental, -1, 1, 0)) as Accidental;
    const octave = clampInt(raw.octave, -4, 4, 0);
    const measureIndex = Math.min(
      measureCount - 1,
      Math.max(0, Math.floor((safeStart + EPSILON) / measureBeats)),
    );
    const offsetBeat = clampNumber(safeStart - measureIndex * measureBeats, 0, measureBeats);
    const glyphs = describeDuration(safeDuration);
    const pitch = pitchInfo(degree, accidental, octave, meta ?? { keyRoot: 0, baseOctave: 4 });
    prepared.push({
      sourceIndex,
      id: typeof raw.id === 'string' ? raw.id : '',
      degree,
      accidental,
      octave,
      startBeat: safeStart,
      duration: safeDuration,
      endBeat: safeStart + safeDuration,
      tie: raw.tie === true,
      lyric: typeof raw.lyric === 'string' ? raw.lyric : '',
      measureIndex,
      rowIndex: Math.floor(measureIndex / measuresPerRow),
      offsetBeat,
      glyphs,
      noteName: pitch.noteName,
      solfege: pitch.solfege,
      leftPad: M.digitWidth / 2 + (accidental !== 0 ? M.accidentalWidth + M.accidentalGap : 0),
      rightPad: M.digitWidth / 2 + (glyphs.dotted ? M.dottedGap + M.dottedDotRadius * 2 : 0),
      x: 0,
    });
  });
  prepared.sort((a, b) => a.startBeat - b.startBeat || a.sourceIndex - b.sourceIndex);
  return prepared;
}

/**
 * 定一个小节内各音符的数字中心 x：
 * 1. 先按拍位做时间等比分布（这是简谱最自然的横向节奏感）；
 * 2. 若音符密集到符号会互相压住，则加一个「最小水平间距」前向修正；
 *   修正后若整小节放不下，就退回纯时间等比分布（宁可轻微重叠也不越界）。
 */
function assignMeasurePositions(entries: PreparedNote[], measure: LayoutMeasure, measureBeats: number): void {
  if (entries.length === 0) return;
  const innerLeft = measure.x + M.measurePadLeft;
  const innerWidth = measure.width - M.measurePadLeft - M.measurePadRight;
  const nominal = entries.map((entry) => innerLeft + (entry.offsetBeat / measureBeats) * innerWidth);

  const enforced: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (i === 0) {
      enforced.push(nominal[0] as number);
      continue;
    }
    const prev = entries[i - 1] as PreparedNote;
    const current = entries[i] as PreparedNote;
    const minX = (enforced[i - 1] as number) + prev.rightPad + current.leftPad + M.noteMinGap;
    enforced.push(Math.max(nominal[i] as number, minX));
  }

  const lastIndex = entries.length - 1;
  const lastEntry = entries[lastIndex] as PreparedNote;
  const lastX = enforced[lastIndex] as number;
  const fits = lastX + lastEntry.rightPad <= measure.x + measure.width - 4;
  const positions = fits ? enforced : nominal;
  entries.forEach((entry, i) => {
    entry.x = round2(positions[i] as number);
  });
}

/** 计算单个音符的绘制几何（减时线 / 八度点 / 附点 / 增时线 / 高亮范围） */
function buildLayoutNote(
  entry: PreparedNote,
  index: number,
  rows: LayoutRow[],
  measures: LayoutMeasure[],
  entriesByMeasure: PreparedNote[][],
  rowHeight: number,
): LayoutNote {
  const row = rows[entry.rowIndex] as LayoutRow;
  const measure = measures[entry.measureIndex] as LayoutMeasure;
  const x = entry.x;
  const y = row.centerY;
  const isRest = entry.degree === 0;
  const underlineCount = isRest ? 0 : entry.glyphs.underlines;
  const dotted = isRest ? false : entry.glyphs.dotted;
  const extensionLineCount = entry.glyphs.extensionLines;

  // 数字墨迹上下边界
  const inkTop = y - M.inkHalfHeight;
  const inkBottom = y + M.inkHalfHeight;

  // 减时线
  const underlines: LayoutSegment[] = [];
  for (let i = 0; i < underlineCount; i += 1) {
    const lineY = round2(inkBottom + M.underlineGap + i * M.underlineSpacing);
    underlines.push({ x1: round2(x - M.underlineWidth / 2), y1: lineY, x2: round2(x + M.underlineWidth / 2), y2: lineY });
  }

  // 八度点：高八度在上，低八度在下；低音点排在减时线下面（简谱规范）；最多 3 个
  const octave = isRest ? 0 : entry.octave;
  const octaveDotCount = Math.min(3, Math.abs(octave));
  const octaveDirection: OctaveDirection = octaveDotCount === 0 ? 'none' : octave > 0 ? 'up' : 'down';
  const octaveDots: LayoutPoint[] = [];
  if (octaveDotCount > 0) {
    if (octaveDirection === 'up') {
      const firstY = inkTop - M.octaveGap - M.octaveDotRadius;
      for (let i = 0; i < octaveDotCount; i += 1) {
        octaveDots.push({ x: round2(x), y: round2(firstY - i * M.octaveDotSpacing) });
      }
    } else {
      const lastUnderlineY = underlineCount > 0 ? inkBottom + M.underlineGap + (underlineCount - 1) * M.underlineSpacing : inkBottom;
      const firstY = lastUnderlineY + M.octaveGap + M.octaveDotRadius;
      for (let i = 0; i < octaveDotCount; i += 1) {
        octaveDots.push({ x: round2(x), y: round2(firstY + i * M.octaveDotSpacing) });
      }
    }
  }

  // 附点：数字右侧、垂直居中略偏下
  const dottedPoint: LayoutPoint | null = dotted
    ? { x: round2(x + M.digitWidth / 2 + M.dottedGap), y: round2(y + 1) }
    : null;

  // 增时线：从数字（及附点）右侧画到下一个音符 / 小节末尾，按拍均分横线
  const extensionLines: LayoutSegment[] = [];
  if (extensionLineCount > 0) {
    const rightInk = x + entry.rightPad;
    const startX = rightInk + 6;
    let endX = measure.x + measure.width - M.measurePadRight;
    const group = entriesByMeasure[entry.measureIndex] ?? [];
    const positionInMeasure = group.indexOf(entry);
    const nextInMeasure = positionInMeasure >= 0 ? group[positionInMeasure + 1] : undefined;
    if (nextInMeasure) {
      endX = nextInMeasure.x - nextInMeasure.leftPad - 6;
    } else {
      // 长音跨小节：只画到本小节末尾（跨行延音不支持，见已知限制）
      endX = Math.min(endX, measure.x + measure.width - M.measurePadRight);
    }
    const available = endX - startX;
    if (available > M.dashMinSlot + M.dashMinLength) {
      const maxCount = Math.max(1, Math.floor(available / M.dashMinSlot));
      const drawCount = Math.min(extensionLineCount, maxCount);
      const segment = available / drawCount;
      for (let i = 0; i < drawCount; i += 1) {
        const dashLength = Math.min(M.dashMaxLength, Math.max(M.dashMinLength, segment * 0.55));
        const centerX = startX + segment * (i + 0.5);
        extensionLines.push({
          x1: round2(centerX - dashLength / 2),
          y1: round2(y),
          x2: round2(centerX + dashLength / 2),
          y2: round2(y),
        });
      }
    }
  }

  // 高亮背景范围：包住数字 / 升降号 / 八度点 / 减时线 / 附点，四周留 6px
  let topEdge = octaveDotCount > 0 && octaveDirection === 'up' ? (octaveDots[0]?.y ?? inkTop) - M.octaveDotRadius : inkTop;
  let bottomEdge = inkBottom;
  const lastUnderline = underlines[underlines.length - 1];
  if (lastUnderline) bottomEdge = Math.max(bottomEdge, lastUnderline.y1 + M.underlineThickness / 2);
  if (octaveDirection === 'down') {
    const lastDot = octaveDots[octaveDots.length - 1];
    if (lastDot) bottomEdge = Math.max(bottomEdge, lastDot.y + M.octaveDotRadius);
  }
  if (dottedPoint) bottomEdge = Math.max(bottomEdge, dottedPoint.y + M.dottedDotRadius);
  const leftEdge = x - entry.leftPad;
  const rightEdge = x + entry.rightPad;
  const bounds: LayoutRect = {
    x: round2(leftEdge - 6),
    y: round2(topEdge - 6),
    width: round2(rightEdge - leftEdge + 12),
    height: round2(bottomEdge - topEdge + 12),
  };

  const accidentalText: '' | '#' | 'b' = entry.accidental === 1 ? '#' : entry.accidental === -1 ? 'b' : '';
  const accidentalSymbol: '' | '♯' | '♭' = entry.accidental === 1 ? '♯' : entry.accidental === -1 ? '♭' : '';
  const digitBaselineY = round2(y + M.inkHalfHeight);
  const accidentalX = round2(x - M.digitWidth / 2 - M.accidentalGap - M.accidentalWidth / 2);
  const accidentalBaselineY = round2(digitBaselineY - M.accidentalRaise);
  const lyricY = round2(row.top + rowHeight - M.lyricBottomOffset);

  const beatsText = formatBeatCount(entry.duration);
  const tooltip = isRest
    ? `休止 · ${beatsText} 拍`
    : `${entry.noteName}（${accidentalText}${entry.solfege}）· ${beatsText} 拍`;

  return {
    key: `${entry.id || 'note'}@${index}`,
    id: entry.id,
    index,
    degree: entry.degree,
    accidental: entry.accidental,
    text: String(entry.degree),
    accidentalText,
    accidentalSymbol,
    accidentalX,
    accidentalBaselineY,
    isRest,
    octave,
    octaveDotCount,
    octaveDirection,
    octaveDots,
    startBeat: entry.startBeat,
    duration: entry.duration,
    endBeat: entry.endBeat,
    tie: entry.tie,
    measureIndex: entry.measureIndex,
    rowIndex: entry.rowIndex,
    x,
    y,
    digitBaselineY,
    underlineCount,
    underlines,
    dotted,
    dottedPoint,
    extensionLineCount,
    extensionLines,
    bounds,
    tooltip,
    noteName: entry.noteName,
    solfege: entry.solfege,
    lyric: entry.lyric,
    lyricX: round2(x),
    lyricY,
  };
}

/** 取某音符墨迹的最上沿 y（用于把连音线拱在八度点上方） */
function noteTopInk(note: LayoutNote): number {
  if (note.octaveDirection === 'up' && note.octaveDotCount > 0) {
    const firstDot = note.octaveDots[0];
    if (firstDot) return firstDot.y - M.octaveDotRadius;
  }
  return note.y - M.inkHalfHeight;
}

/** 建立同行相邻同音高音符之间的连音线（跨行的跳过） */
function buildTies(notes: LayoutNote[], rows: LayoutRow[]): LayoutTie[] {
  const ties: LayoutTie[] = [];
  for (let i = 0; i < notes.length - 1; i += 1) {
    const from = notes[i] as LayoutNote;
    const to = notes[i + 1] as LayoutNote;
    if (!from.tie || from.isRest || to.isRest) continue;
    // 必须同音高、且时间上首尾相接
    if (from.degree !== to.degree || from.accidental !== to.accidental || from.octave !== to.octave) continue;
    if (Math.abs(from.endBeat - to.startBeat) > 1e-3) continue;
    if (from.rowIndex !== to.rowIndex) continue; // 无法同行：跳过

    const leftPadTo = to.accidentalText ? M.accidentalWidth + M.accidentalGap : 0;
    const x1 = from.x + M.digitWidth / 2 + 4;
    const x2 = to.x - M.digitWidth / 2 - leftPadTo - 4;
    if (x2 - x1 < 6) continue;

    const row = rows[from.rowIndex] as LayoutRow;
    let arcY = Math.min(noteTopInk(from), noteTopInk(to)) - M.tieGap;
    arcY = Math.max(arcY, row.top + 6);
    const span = x2 - x1;
    let controlDrop = clampNumber(8 + span * 0.05, M.tieMinHeight, M.tieMaxHeight);
    controlDrop = Math.min(controlDrop, arcY - (row.top + 2));
    if (controlDrop < 4) continue;
    const controlY = round2(arcY - controlDrop);
    const path = [
      `M ${round2(x1)} ${round2(arcY)}`,
      `C ${round2(x1)} ${controlY}, ${round2(x2)} ${controlY}, ${round2(x2)} ${round2(arcY)}`,
    ].join(' ');
    ties.push({
      fromNoteId: from.id || from.key,
      toNoteId: to.id || to.key,
      rowIndex: from.rowIndex,
      path,
    });
  }
  return ties;
}

/** 计算全曲布局 */
export function layoutScore(score: Score, options: ScoreLayoutOptions = {}): ScoreLayout {
  const measuresPerRow = clampInt(options?.measuresPerRow, 1, 64, 4);
  const meta: ScoreMeta | undefined = score?.meta;
  const measureBeats = resolveMeasureBeats(meta);
  const notesInput = Array.isArray(score?.notes) ? score.notes : [];

  // 全曲总拍数（含末尾休止）；空谱也至少显示一小节
  let totalBeats = 0;
  for (const note of notesInput) {
    if (!note || typeof note !== 'object') continue;
    const start = Number(note.startBeat);
    const duration = Number(note.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue;
    totalBeats = Math.max(totalBeats, Math.max(0, start) + Math.min(64, Math.max(0.05, duration)));
  }
  const measureCount = Math.max(1, Math.ceil((totalBeats - EPSILON) / measureBeats));
  const rowCount = Math.max(1, Math.ceil(measureCount / measuresPerRow));
  const hasLyric = notesInput.some((note) => typeof note?.lyric === 'string' && note.lyric.trim() !== '');
  const rowHeight = hasLyric ? M.rowHeight + M.lyricExtra : M.rowHeight;
  const rowStride = rowHeight + M.rowGap;
  const contentWidth = M.width - M.paddingX * 2;
  const measureWidth = contentWidth / measuresPerRow;

  // 行
  const rows: LayoutRow[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const startMeasure = rowIndex * measuresPerRow;
    const endMeasure = Math.min(measureCount, startMeasure + measuresPerRow);
    const top = M.paddingTop + rowIndex * rowStride;
    rows.push({
      index: rowIndex,
      startMeasure,
      endMeasure,
      measureCount: endMeasure - startMeasure,
      top,
      height: rowHeight,
      centerY: top + M.rowCenterOffset,
    });
  }

  // 小节
  const measures: LayoutMeasure[] = [];
  for (let measureIndex = 0; measureIndex < measureCount; measureIndex += 1) {
    const rowIndex = Math.floor(measureIndex / measuresPerRow);
    const column = measureIndex - rowIndex * measuresPerRow;
    measures.push({
      index: measureIndex,
      number: measureIndex + 1,
      rowIndex,
      column,
      startBeat: measureIndex * measureBeats,
      endBeat: (measureIndex + 1) * measureBeats,
      x: round2(M.paddingX + column * measureWidth),
      width: round2(measureWidth),
    });
  }

  // 音符：先按小节分组做横向定位，再计算所有绘制几何
  const prepared = prepareNotes(score, measureBeats, measureCount, measuresPerRow, meta);
  const entriesByMeasure: PreparedNote[][] = Array.from({ length: measureCount }, () => []);
  for (const entry of prepared) {
    (entriesByMeasure[entry.measureIndex] as PreparedNote[]).push(entry);
  }
  entriesByMeasure.forEach((entries, measureIndex) => {
    assignMeasurePositions(entries, measures[measureIndex] as LayoutMeasure, measureBeats);
  });

  const notes: LayoutNote[] = prepared.map((entry, index) =>
    buildLayoutNote(entry, index, rows, measures, entriesByMeasure, rowHeight),
  );

  // 小节线 + 小节号
  const barlines: LayoutBarline[] = [];
  const measureNumbers: LayoutMeasureNumber[] = [];
  for (const row of rows) {
    const y1 = round2(row.centerY - M.barlineUp);
    const y2 = round2(row.centerY + M.barlineDown);
    const firstMeasure = measures[row.startMeasure];
    if (firstMeasure) {
      barlines.push({ x: firstMeasure.x, y1, y2, rowIndex: row.index, measureIndex: row.startMeasure, kind: 'start' });
      measureNumbers.push({
        measureIndex: row.startMeasure,
        rowIndex: row.index,
        text: String(firstMeasure.number),
        x: round2(firstMeasure.x + 2),
        y: round2(row.top - M.measureNumberOffsetY),
      });
    }
    for (let measureIndex = row.startMeasure; measureIndex < row.endMeasure; measureIndex += 1) {
      const measure = measures[measureIndex] as LayoutMeasure;
      const x = round2(measure.x + measure.width);
      if (measureIndex === measureCount - 1) {
        // 终止线：细线 + 粗线
        barlines.push({ x: round2(x - 5), y1, y2, rowIndex: row.index, measureIndex, kind: 'final-thin' });
        barlines.push({ x, y1, y2, rowIndex: row.index, measureIndex, kind: 'final-thick' });
      } else {
        barlines.push({ x, y1, y2, rowIndex: row.index, measureIndex, kind: 'bar' });
      }
    }
  }

  const ties = buildTies(notes, rows);
  const height = M.paddingTop + Math.max(0, rowCount - 1) * rowStride + rowHeight + M.paddingBottom;

  return {
    width: M.width,
    height: round2(height),
    measureBeats,
    measuresPerRow,
    measureCount,
    rowCount,
    totalBeats: round2(totalBeats),
    hasLyric,
    rows,
    measures,
    notes,
    barlines,
    measureNumbers,
    ties,
  };
}

/** 拍位 → 画布上的播放指示点（供编辑器光标 / 演奏高亮使用；越界自动夹到首尾小节） */
export function beatToPoint(
  layout: ScoreLayout,
  beat: number,
): { x: number; y: number; measureIndex: number; rowIndex: number } {
  const safeBeat = Number.isFinite(beat) ? Math.max(0, beat) : 0;
  const maxMeasure = Math.max(0, layout.measureCount - 1);
  const measureIndex = Math.min(maxMeasure, Math.max(0, Math.floor(safeBeat / layout.measureBeats + EPSILON)));
  const measure = layout.measures[measureIndex] ?? layout.measures[0];
  const row = layout.rows[measure?.rowIndex ?? 0] ?? layout.rows[0];
  const rowIndex = measure?.rowIndex ?? 0;
  const centerY = row?.centerY ?? M.paddingTop + M.rowCenterOffset;
  if (!measure) return { x: M.paddingX + M.measurePadLeft, y: centerY, measureIndex: 0, rowIndex };
  const fraction = clampNumber((safeBeat - measure.startBeat) / layout.measureBeats, 0, 1);
  const innerWidth = measure.width - M.measurePadLeft - M.measurePadRight;
  return {
    x: round2(measure.x + M.measurePadLeft + fraction * innerWidth),
    y: centerY,
    measureIndex,
    rowIndex,
  };
}
