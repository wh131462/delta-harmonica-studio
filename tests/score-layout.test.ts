/**
 * 简谱布局（layout.ts）单元测试。
 *
 * 布局函数是纯函数，这里只构造 Score 数据并断言输出的绘制数据：
 * - 小节划分 / 每行小节数 / 自动换行；
 * - 音符横向坐标递增、小节线位置；
 * - 减时线、附点、八度点、增时线等简谱符号的数量与几何；
 * - 连音线的生成与「跨行跳过」；
 * - 空谱 / 1000 音符等边界与性能；
 * - 顺带做 ScoreView 的服务端渲染冒烟测试（不依赖 DOM）。
 */
import { describe, expect, it } from 'vitest';
import {
  beatToPoint,
  describeDuration,
  formatBeatCount,
  layoutScore,
  SCORE_LAYOUT_METRICS,
  type LayoutNote,
  type ScoreLayout,
} from '../src/renderer/src/components/score/layout';
import {
  createEmptyScore,
  createNote,
  type Meter,
  type Score,
  type ScoreNote,
} from '../src/core/model/score';

const M = SCORE_LAYOUT_METRICS;

/** 测试用音符描述：startBeat / duration 必填，其余可省略 */
type NoteSpec = Partial<Omit<ScoreNote, 'id'>> & { startBeat: number; duration: number };

function makeScore(notes: NoteSpec[], meter: Meter = { num: 4, den: 4 }): Score {
  const score = createEmptyScore({ meta: { meter } });
  score.notes = notes.map((spec, index) => createNote({ id: `n${index}`, degree: 1, ...spec }));
  return score;
}

/** 连续 count 个四分音符（从第 0 拍开始） */
function quarters(count: number, overrides: Partial<Omit<ScoreNote, 'id'>> = {}): NoteSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    startBeat: index,
    duration: 1,
    ...overrides,
  }));
}

/** 单音符乐谱，方便逐项检查时值符号 */
function singleNote(spec: NoteSpec): ScoreLayout {
  return layoutScore(makeScore([spec]));
}

/** 每行内按时间顺序排列的音符 */
function notesOfRow(layout: ScoreLayout, rowIndex: number): LayoutNote[] {
  return layout.notes.filter((note) => note.rowIndex === rowIndex);
}

function measureWidth(measuresPerRow: number): number {
  return (M.width - M.paddingX * 2) / measuresPerRow;
}

/** 小节内第 offset 拍对应的数字中心 x */
function expectedNoteX(layout: ScoreLayout, measureIndex: number, offsetBeat: number): number {
  const measure = layout.measures[measureIndex] as ScoreLayout['measures'][number];
  const inner = measure.width - M.measurePadLeft - M.measurePadRight;
  return measure.x + M.measurePadLeft + (offsetBeat / layout.measureBeats) * inner;
}

describe('小节划分与换行', () => {
  it('4/4 拍 4 小节 → 1 行 4 小节', () => {
    const layout = layoutScore(makeScore(quarters(16)));
    expect(layout.measureBeats).toBe(4);
    expect(layout.measureCount).toBe(4);
    expect(layout.rowCount).toBe(1);
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]?.measureCount).toBe(4);
    expect(layout.measures).toHaveLength(4);
    expect(layout.notes).toHaveLength(16);
    expect(layout.width).toBe(M.width);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('4/4 拍 5 小节 → 2 行（4 + 1）', () => {
    const layout = layoutScore(makeScore(quarters(20)));
    expect(layout.measureCount).toBe(5);
    expect(layout.rowCount).toBe(2);
    expect(layout.rows[0]?.measureCount).toBe(4);
    expect(layout.rows[1]?.measureCount).toBe(1);
    expect(layout.rows[1]?.startMeasure).toBe(4);
  });

  it('measuresPerRow 选项控制换行（5 小节、每行 2 小节 → 3 行）', () => {
    const layout = layoutScore(makeScore(quarters(20)), { measuresPerRow: 2 });
    expect(layout.measuresPerRow).toBe(2);
    expect(layout.rowCount).toBe(3);
    expect(layout.rows.map((row) => row.measureCount)).toEqual([2, 2, 1]);
  });

  it('3/4 拍：每小节 3 拍', () => {
    const layout = layoutScore(makeScore(quarters(6), { num: 3, den: 4 }));
    expect(layout.measureBeats).toBe(3);
    expect(layout.measureCount).toBe(2);
  });

  it('6/8 拍：每小节 3 拍（以四分音符为一拍）', () => {
    const layout = layoutScore(makeScore(quarters(6), { num: 6, den: 8 }));
    expect(layout.measureBeats).toBe(3);
    expect(layout.measureCount).toBe(2);
  });

  it('不足一小节也至少显示一小节；空谱不崩溃', () => {
    const shortLayout = layoutScore(makeScore([{ startBeat: 0, duration: 1 }]));
    expect(shortLayout.measureCount).toBe(1);
    expect(shortLayout.rowCount).toBe(1);

    const emptyLayout = layoutScore(makeScore([]));
    expect(emptyLayout.measureCount).toBe(1);
    expect(emptyLayout.notes).toHaveLength(0);
    expect(emptyLayout.measures).toHaveLength(1);
    expect(emptyLayout.barlines.length).toBeGreaterThan(0);
    expect(emptyLayout.width).toBe(M.width);
    expect(emptyLayout.height).toBeGreaterThan(0);
  });

  it('总拍数恰好整小节时不会多算一小节，多出半拍则补一小节', () => {
    expect(layoutScore(makeScore(quarters(16))).measureCount).toBe(4);
    expect(layoutScore(makeScore([...quarters(16), { startBeat: 16, duration: 0.5 }])).measureCount).toBe(5);
  });
});

describe('横向坐标与小节线', () => {
  it('小节宽度均分且首尾对齐画布留白', () => {
    const layout = layoutScore(makeScore(quarters(16)));
    const width = measureWidth(4);
    layout.measures.forEach((measure, index) => {
      expect(measure.width).toBeCloseTo(width, 3);
      expect(measure.x).toBeCloseTo(M.paddingX + index * width, 3);
    });
    const last = layout.measures[3];
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(M.width - M.paddingX, 3);
  });

  it('每行内音符 x 坐标严格递增，且第一行首音从行首内边距开始', () => {
    const layout = layoutScore(makeScore(quarters(20)));
    for (let rowIndex = 0; rowIndex < layout.rowCount; rowIndex += 1) {
      const notes = notesOfRow(layout, rowIndex);
      expect(notes.length).toBeGreaterThan(0);
      for (let i = 1; i < notes.length; i += 1) {
        expect(notes[i]?.x ?? 0).toBeGreaterThan(notes[i - 1]?.x ?? 0);
      }
    }
    expect(layout.notes[0]?.x).toBeCloseTo(M.paddingX + M.measurePadLeft, 3);
  });

  it('音符 x 按拍位在小节内等比分布', () => {
    const layout = layoutScore(makeScore(quarters(4)));
    const expected = expectedNoteX(layout, 0, 1);
    expect(layout.notes[1]?.x).toBeCloseTo(expected, 3);
    // 第一拍起点的音符应落在小节内边距处
    const halfLayout = singleNote({ startBeat: 0, duration: 0.5 });
    const halfNote = halfLayout.notes[0] as LayoutNote;
    expect(halfNote.x).toBeCloseTo(M.paddingX + M.measurePadLeft, 3);
  });

  it('小节线位置正确（行首线 + 各小节右边界 + 终止线）', () => {
    const layout = layoutScore(makeScore(quarters(16)));
    const width = measureWidth(4);
    const rowBarlines = layout.barlines.filter((line) => line.rowIndex === 0);
    const plainXs = rowBarlines
      .filter((line) => line.kind === 'start' || line.kind === 'bar')
      .map((line) => line.x)
      .sort((a, b) => a - b);
    expect(plainXs).toHaveLength(4); // 行首线 + 前 3 小节的右边界（最后一小节右边界由终止线代替）
    expect(plainXs[0]).toBeCloseTo(M.paddingX, 3);
    expect(plainXs[1]).toBeCloseTo(M.paddingX + width, 3);
    expect(plainXs[2]).toBeCloseTo(M.paddingX + width * 2, 3);
    expect(plainXs[3]).toBeCloseTo(M.paddingX + width * 3, 3);

    const finalThin = rowBarlines.find((line) => line.kind === 'final-thin');
    const finalThick = rowBarlines.find((line) => line.kind === 'final-thick');
    expect(finalThin).toBeDefined();
    expect(finalThick).toBeDefined();
    expect(finalThick?.x).toBeCloseTo(M.width - M.paddingX, 3);
    expect(finalThin?.x ?? 0).toBeLessThan(finalThick?.x ?? 0);
    expect(finalThick?.y2 ?? 0).toBeGreaterThan(finalThick?.y1 ?? 0);
  });

  it('每个音符都落在自己小节的水平范围内', () => {
    const layout = layoutScore(makeScore(quarters(20)));
    for (const note of layout.notes) {
      const measure = layout.measures[note.measureIndex] as ScoreLayout['measures'][number];
      expect(note.x).toBeGreaterThan(measure.x);
      expect(note.x).toBeLessThan(measure.x + measure.width);
    }
  });

  it('小节号显示在每行行首小节上方', () => {
    const layout = layoutScore(makeScore(quarters(20)));
    expect(layout.measureNumbers).toHaveLength(layout.rowCount);
    expect(layout.measureNumbers[0]?.text).toBe('1');
    expect(layout.measureNumbers[1]?.text).toBe('5');
    for (const label of layout.measureNumbers) {
      const row = layout.rows[label.rowIndex] as ScoreLayout['rows'][number];
      expect(label.y).toBeLessThan(row.top);
      expect(label.y).toBeGreaterThan(row.top - 40);
    }
  });
});

describe('时值符号（减时线 / 附点 / 增时线）', () => {
  it('describeDuration：常用时值映射正确', () => {
    expect(describeDuration(1)).toEqual({ underlines: 0, dotted: false, extensionLines: 0 });
    expect(describeDuration(0.5)).toEqual({ underlines: 1, dotted: false, extensionLines: 0 });
    expect(describeDuration(0.25)).toEqual({ underlines: 2, dotted: false, extensionLines: 0 });
    expect(describeDuration(0.125)).toEqual({ underlines: 3, dotted: false, extensionLines: 0 });
    expect(describeDuration(0.0625)).toEqual({ underlines: 4, dotted: false, extensionLines: 0 });
    expect(describeDuration(1.5)).toEqual({ underlines: 0, dotted: true, extensionLines: 0 });
    expect(describeDuration(0.75)).toEqual({ underlines: 1, dotted: true, extensionLines: 0 });
    expect(describeDuration(0.375)).toEqual({ underlines: 2, dotted: true, extensionLines: 0 });
    expect(describeDuration(2)).toEqual({ underlines: 0, dotted: false, extensionLines: 1 });
    expect(describeDuration(3)).toEqual({ underlines: 0, dotted: false, extensionLines: 2 });
    expect(describeDuration(4)).toEqual({ underlines: 0, dotted: false, extensionLines: 3 });
    expect(describeDuration(0)).toEqual({ underlines: 0, dotted: false, extensionLines: 0 });
    expect(describeDuration(Number.NaN)).toEqual({ underlines: 0, dotted: false, extensionLines: 0 });
  });

  it('0.5 / 0.25 拍的减时线数量分别为 1 / 2 并画在数字下方', () => {
    const eighth = singleNote({ startBeat: 0, duration: 0.5 }).notes[0] as LayoutNote;
    expect(eighth.underlineCount).toBe(1);
    expect(eighth.underlines).toHaveLength(1);
    expect(eighth.underlines[0]?.y1 ?? 0).toBeGreaterThan(eighth.y);
    expect(eighth.underlines[0]?.x1 ?? 0).toBeLessThan(eighth.x);
    expect(eighth.underlines[0]?.x2 ?? 0).toBeGreaterThan(eighth.x);

    const sixteenth = singleNote({ startBeat: 0, duration: 0.25 }).notes[0] as LayoutNote;
    expect(sixteenth.underlineCount).toBe(2);
    expect(sixteenth.underlines).toHaveLength(2);
    expect(sixteenth.underlines[1]?.y1 ?? 0).toBeGreaterThan(sixteenth.underlines[0]?.y1 ?? 0);

    const plain = singleNote({ startBeat: 0, duration: 1 }).notes[0] as LayoutNote;
    expect(plain.underlineCount).toBe(0);
    expect(plain.underlines).toHaveLength(0);
  });

  it('附点时值（1.5 拍）生成右侧小圆点', () => {
    const layout = singleNote({ startBeat: 0, duration: 1.5 });
    const note = layout.notes[0] as LayoutNote;
    expect(note.dotted).toBe(true);
    expect(note.dottedPoint).not.toBeNull();
    expect(note.dottedPoint?.x ?? 0).toBeGreaterThan(note.x + M.digitWidth / 2);
    // 附点八分音符：1 条减时线 + 附点
    const dottedEighth = singleNote({ startBeat: 0, duration: 0.75 }).notes[0] as LayoutNote;
    expect(dottedEighth.underlineCount).toBe(1);
    expect(dottedEighth.dotted).toBe(true);
    // 普通四分音符没有附点
    const plain = singleNote({ startBeat: 0, duration: 1 }).notes[0] as LayoutNote;
    expect(plain.dotted).toBe(false);
    expect(plain.dottedPoint).toBeNull();
  });

  it('时值 >= 2 拍生成增时横线（2/3/4 拍 → 1/2/3 条）', () => {
    const two = singleNote({ startBeat: 0, duration: 2 }).notes[0] as LayoutNote;
    expect(two.extensionLineCount).toBe(1);
    expect(two.extensionLines).toHaveLength(1);
    expect(two.extensionLines[0]?.y1 ?? 0).toBeCloseTo(two.y, 3);
    expect(two.extensionLines[0]?.x1 ?? 0).toBeGreaterThan(two.x);

    const three = singleNote({ startBeat: 0, duration: 3 }).notes[0] as LayoutNote;
    expect(three.extensionLineCount).toBe(2);
    expect(three.extensionLines).toHaveLength(2);

    const four = singleNote({ startBeat: 0, duration: 4 }).notes[0] as LayoutNote;
    expect(four.extensionLineCount).toBe(3);
    expect(four.extensionLines.length).toBeGreaterThan(0);
    for (const line of four.extensionLines) {
      expect(line.x2).toBeGreaterThan(line.x1);
      expect(line.x2).toBeLessThanOrEqual(four.x + 400);
    }
  });

  it('增时线不会越过小节线', () => {
    const layout = layoutScore(makeScore([{ startBeat: 0, duration: 4 }]));
    const note = layout.notes[0] as LayoutNote;
    const measure = layout.measures[0] as ScoreLayout['measures'][number];
    for (const line of note.extensionLines) {
      expect(line.x2).toBeLessThanOrEqual(measure.x + measure.width);
    }
  });

  it('跨小节长音只在本小节内绘制增时线（已知限制）', () => {
    const layout = layoutScore(makeScore([{ startBeat: 0, duration: 8 }]));
    expect(layout.measureCount).toBe(2);
    const note = layout.notes[0] as LayoutNote;
    const measure = layout.measures[0] as ScoreLayout['measures'][number];
    for (const line of note.extensionLines) {
      expect(line.x2).toBeLessThanOrEqual(measure.x + measure.width);
    }
  });
});

describe('休止符与八度点', () => {
  it('休止符：degree 0、数字文本 0、无八度点、有音名「休止」', () => {
    const layout = singleNote({ degree: 0, startBeat: 0, duration: 1 });
    const note = layout.notes[0] as LayoutNote;
    expect(note.isRest).toBe(true);
    expect(note.text).toBe('0');
    expect(note.octaveDotCount).toBe(0);
    expect(note.octaveDirection).toBe('none');
    expect(note.octaveDots).toHaveLength(0);
    expect(note.noteName).toBe('休止');
    expect(note.tooltip).toContain('休止');
    expect(note.tooltip).toContain('拍');
  });

  it('休止符的增时横线：2 拍的休止渲染 1 条增时线', () => {
    const note = singleNote({ degree: 0, startBeat: 0, duration: 2 }).notes[0] as LayoutNote;
    expect(note.extensionLineCount).toBe(1);
  });

  it('高八度点在数字上方，低八度点在数字下方', () => {
    const high = singleNote({ startBeat: 0, duration: 1, octave: 1 }).notes[0] as LayoutNote;
    expect(high.octaveDirection).toBe('up');
    expect(high.octaveDotCount).toBe(1);
    expect(high.octaveDots[0]?.y ?? 0).toBeLessThan(high.y);

    const low = singleNote({ startBeat: 0, duration: 1, octave: -1 }).notes[0] as LayoutNote;
    expect(low.octaveDirection).toBe('down');
    expect(low.octaveDots[0]?.y ?? 0).toBeGreaterThan(low.y);

    const twoUp = singleNote({ startBeat: 0, duration: 1, octave: 2 }).notes[0] as LayoutNote;
    expect(twoUp.octaveDotCount).toBe(2);
    expect(twoUp.octaveDots[1]?.y ?? 0).toBeLessThan(twoUp.octaveDots[0]?.y ?? 0);
  });

  it('八度点最多显示 3 个（octave = 4 也只画 3 个）', () => {
    const note = singleNote({ startBeat: 0, duration: 1, octave: 4 }).notes[0] as LayoutNote;
    expect(note.octave).toBe(4);
    expect(note.octaveDotCount).toBe(3);
    expect(note.octaveDots).toHaveLength(3);
  });

  it('低八度点画在减时线下方（简谱规范）', () => {
    const note = singleNote({ startBeat: 0, duration: 0.5, octave: -1 }).notes[0] as LayoutNote;
    expect(note.underlineCount).toBe(1);
    expect(note.octaveDots[0]?.y ?? 0).toBeGreaterThan(note.underlines[0]?.y1 ?? 0);
  });

  it('音名 / 唱名 / tooltip 正确（1=C4、#5=G#4）', () => {
    const c4 = singleNote({ degree: 1, startBeat: 0, duration: 1 }).notes[0] as LayoutNote;
    expect(c4.noteName).toBe('C4');
    expect(c4.solfege).toBe('do');
    expect(c4.tooltip).toBe('C4（do）· 1 拍');

    const gSharp4 = singleNote({ degree: 5, accidental: 1, startBeat: 0, duration: 0.5 }).notes[0] as LayoutNote;
    expect(gSharp4.noteName).toBe('G#4');
    expect(gSharp4.accidentalText).toBe('#');
    expect(gSharp4.accidentalSymbol).toBe('♯');
    expect(gSharp4.tooltip).toContain('G#4');

    const flat = singleNote({ degree: 7, accidental: -1, startBeat: 0, duration: 1 }).notes[0] as LayoutNote;
    expect(flat.accidentalText).toBe('b');
    expect(flat.accidentalSymbol).toBe('♭');
    expect(flat.noteName).toBe('A#4');
    // 高八度：音名加一个八度
    const high = singleNote({ degree: 1, startBeat: 0, duration: 1, octave: 1 }).notes[0] as LayoutNote;
    expect(high.noteName).toBe('C5');
  });

  it('formatBeatCount 输出简洁拍数', () => {
    expect(formatBeatCount(1)).toBe('1');
    expect(formatBeatCount(1.5)).toBe('1.5');
    expect(formatBeatCount(0.75)).toBe('0.75');
  });
});

describe('连音线（tie）', () => {
  it('相邻同音高且 tie=true 的音符之间生成弧线', () => {
    const score = makeScore([
      { startBeat: 0, duration: 1, tie: true },
      { startBeat: 1, duration: 1 },
    ]);
    const layout = layoutScore(score);
    expect(layout.ties).toHaveLength(1);
    const tie = layout.ties[0];
    expect(tie?.fromNoteId).toBe('n0');
    expect(tie?.toNoteId).toBe('n1');
    expect(tie?.path.startsWith('M ')).toBe(true);
    expect(tie?.path).toContain('C');
  });

  it('不同音高 / 不紧邻 / 无 tie 标记时不画连音线', () => {
    const differentPitch = layoutScore(
      makeScore([
        { startBeat: 0, duration: 1, tie: true },
        { startBeat: 1, duration: 1, degree: 3 },
      ]),
    );
    expect(differentPitch.ties).toHaveLength(0);

    const withGap = layoutScore(
      makeScore([
        { startBeat: 0, duration: 1, tie: true },
        { startBeat: 3, duration: 1 },
      ]),
    );
    expect(withGap.ties).toHaveLength(0);

    const noFlag = layoutScore(
      makeScore([
        { startBeat: 0, duration: 1 },
        { startBeat: 1, duration: 1 },
      ]),
    );
    expect(noFlag.ties).toHaveLength(0);
  });

  it('同一行内跨小节的同音高连音线可以绘制', () => {
    const layout = layoutScore(
      makeScore([
        { startBeat: 0, duration: 1 },
        { startBeat: 1, duration: 1 },
        { startBeat: 2, duration: 1 },
        { startBeat: 3, duration: 1, tie: true },
        { startBeat: 4, duration: 1 },
      ]),
      { measuresPerRow: 4 },
    );
    expect(layout.rows).toHaveLength(1);
    expect(layout.ties).toHaveLength(1);
  });

  it('无法同行的连音线跳过（每行 2 小节时，第 7 拍 → 第 8 拍跨行）', () => {
    const notes: NoteSpec[] = Array.from({ length: 9 }, (_, index) => ({
      startBeat: index,
      duration: 1,
      ...(index === 7 ? { tie: true } : {}),
    }));
    const layout = layoutScore(makeScore(notes), { measuresPerRow: 2 });
    expect(layout.rowCount).toBe(2);
    const from = layout.notes[7] as LayoutNote;
    const to = layout.notes[8] as LayoutNote;
    expect(from.rowIndex).not.toBe(to.rowIndex);
    expect(layout.ties).toHaveLength(0);
  });
});

describe('播放指示点 beatToPoint', () => {
  it('拍位映射到对应小节的横向位置与行中心', () => {
    const layout = layoutScore(makeScore(quarters(8)));
    const start = beatToPoint(layout, 0);
    expect(start.measureIndex).toBe(0);
    expect(start.x).toBeCloseTo(M.paddingX + M.measurePadLeft, 3);
    expect(start.y).toBe(layout.rows[0]?.centerY);

    const secondMeasure = beatToPoint(layout, 4);
    expect(secondMeasure.measureIndex).toBe(1);
    expect(secondMeasure.x).toBeCloseTo(expectedNoteX(layout, 1, 0), 3);

    const middle = beatToPoint(layout, 5);
    expect(middle.x).toBeCloseTo(expectedNoteX(layout, 1, 1), 3);

    // 越界夹到首尾小节
    const negative = beatToPoint(layout, -2);
    expect(negative.measureIndex).toBe(0);
    const beyond = beatToPoint(layout, 99);
    expect(beyond.measureIndex).toBe(layout.measureCount - 1);
  });
});

describe('边界与性能', () => {
  it('非法音符数据不会产生 NaN 坐标', () => {
    const score = createEmptyScore();
    score.notes = [
      createNote({ id: 'good', startBeat: 0, duration: 1 }),
      // 故意塞入异常值（模拟被外部修改过的数据）
      createNote({ id: 'bad', startBeat: Number.NaN, duration: 1 }),
      createNote({ id: 'bad2', startBeat: 2, duration: Number.NaN }),
    ];
    const layout = layoutScore(score);
    expect(layout.notes).toHaveLength(1);
    for (const note of layout.notes) {
      expect(Number.isFinite(note.x)).toBe(true);
      expect(Number.isFinite(note.y)).toBe(true);
    }
    expect(Number.isFinite(layout.height)).toBe(true);
  });

  it('1000 个音符可正常完成布局（性能冒烟）', () => {
    const notes: NoteSpec[] = Array.from({ length: 1000 }, (_, index) => ({
      startBeat: index,
      duration: 1,
      degree: ((index % 7) + 1) as ScoreNote['degree'],
    }));
    const startedAt = performance.now();
    const layout = layoutScore(makeScore(notes));
    const elapsed = performance.now() - startedAt;
    expect(layout.notes).toHaveLength(1000);
    expect(layout.measureCount).toBe(250);
    expect(elapsed).toBeLessThan(1500);
    for (const note of layout.notes) {
      expect(Number.isFinite(note.x)).toBe(true);
      expect(Number.isFinite(note.y)).toBe(true);
    }
  });

  it('歌词会加高行高并写入歌词坐标', () => {
    const withLyric = layoutScore(makeScore([{ startBeat: 0, duration: 1, lyric: '啊' }]));
    expect(withLyric.hasLyric).toBe(true);
    const note = withLyric.notes[0] as LayoutNote;
    expect(note.lyric).toBe('啊');
    expect(note.lyricY).toBeGreaterThan(note.y + 30);
    expect(note.lyricX).toBeCloseTo(note.x, 3);
    expect(withLyric.rows[0]?.height ?? 0).toBeGreaterThan(M.rowHeight);

    const noLyric = layoutScore(makeScore([{ startBeat: 0, duration: 1 }]));
    expect(noLyric.hasLyric).toBe(false);
    expect(noLyric.rows[0]?.height).toBe(M.rowHeight);
  });
});

describe('ScoreView 渲染冒烟测试（服务端渲染，无需 DOM）', () => {
  it('渲染出 SVG、小节线、tooltip，并给选中/播放音符加高亮 class', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ScoreView } = await import('../src/renderer/src/components/score/ScoreView');
    const score = makeScore(quarters(8));
    const markup = renderToStaticMarkup(
      createElement(ScoreView, {
        score,
        selectedNoteId: 'n2',
        activeNoteId: 'n5',
        measuresPerRow: 4,
        zoom: 1.5,
        onSelectNote: () => {},
      }),
    );
    expect(markup).toContain('class="sv-score"');
    expect(markup).toContain('sv-canvas');
    expect(markup).toContain('sv-digit');
    expect(markup).toContain('sv-barline');
    expect(markup).toContain('sv-measure-number');
    expect(markup).toContain('sv-note--selected');
    expect(markup).toContain('sv-note--active');
    expect(markup).toContain('width:150%');
    expect((markup.match(/data-note-id="/g) ?? []).length).toBe(8);
    expect((markup.match(/<title>/g) ?? []).length).toBe(8);
    expect(markup).toContain('C4（do）· 1 拍');
  });

  it('showMeasureNumbers=false 时不渲染小节号；无回调时不挂点击语义', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ScoreView } = await import('../src/renderer/src/components/score/ScoreView');
    const score = makeScore(quarters(4), { num: 4, den: 4 });
    const markup = renderToStaticMarkup(
      createElement(ScoreView, { score, showMeasureNumbers: false }),
    );
    expect(markup).toContain('sv-score');
    expect(markup).not.toContain('sv-measure-number');
    expect(markup).not.toContain('sv-note--clickable');
    expect(markup).not.toContain('sv-note--selected');
  });
});
