/**
 * 简谱文本 DSL 单元测试：解析、错误诊断、序列化与 round-trip。
 *
 * 覆盖：头部元信息、音符/时值/八度/升降号/休止符、连音线、错误 token 容错、
 * serializeScore → parseScoreText 的音高/时值/拍位一致性、拍号校验 warning。
 */
import { describe, expect, it } from 'vitest';
import {
  buildScoreFromText,
  createNewScoreDraft,
  formatDurationSuffix,
  formatNoteToken,
  parseNoteToken,
  parseScoreText,
  serializeScore,
  type ParsedNoteToken,
} from '../src/core/score/dsl';
import {
  createEmptyScore,
  createNote,
  type ScoreNote,
} from '../src/core/model/score';

/** 断言 token 解析结果并返回音符体（解析失败时给出可读失败信息）。 */
function expectToken(token: string): ParsedNoteToken {
  const result = parseNoteToken(token);
  expect(result.ok, `token ${token} 应解析成功，实际错误：${result.ok ? '' : result.error}`).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.note;
}

/** 断言 token 解析失败，且错误信息包含指定片段。 */
function expectBadToken(token: string, messagePart: string): void {
  const result = parseNoteToken(token);
  expect(result.ok, `token ${token} 应解析失败`).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(messagePart);
}

/** 便于比较往返结果：去掉 id / lyric 等无关字段。 */
function noteShape(note: ScoreNote) {
  return {
    degree: note.degree,
    accidental: note.accidental,
    octave: note.octave,
    startBeat: note.startBeat,
    duration: note.duration,
    tie: note.tie,
  };
}

describe('dsl.parseNoteToken 音符 token', () => {
  it('解析基础音级、升降号与八度标记', () => {
    expect(expectToken('1')).toEqual({
      degree: 1,
      accidental: 0,
      octave: 0,
      duration: 1,
      tie: false,
    });
    expect(expectToken(',1')).toMatchObject({ degree: 1, octave: -1 });
    expect(expectToken("1''")).toMatchObject({ degree: 1, octave: 2 });
    expect(expectToken('#4')).toMatchObject({ degree: 4, accidental: 1 });
    expect(expectToken('b7')).toMatchObject({ degree: 7, accidental: -1 });
    expect(expectToken(',#4')).toMatchObject({ degree: 4, accidental: 1, octave: -1 });
    expect(expectToken('0')).toMatchObject({ degree: 0, accidental: 0, octave: 0 });
  });

  it('时值后缀：_=0.5、.=1.5、-=2、:1.25 及组合', () => {
    expect(expectToken('5_').duration).toBe(0.5);
    expect(expectToken('5.').duration).toBe(1.5);
    expect(expectToken('5-').duration).toBe(2);
    expect(expectToken('5--').duration).toBe(3);
    expect(expectToken('5_.').duration).toBe(0.75);
    expect(expectToken('5__').duration).toBe(0.25);
    expect(expectToken('5:1.25').duration).toBe(1.25);
    expect(expectToken('5:0.05').duration).toBe(0.05);
  });

  it('连音线后缀 ~ 被记录，休止符忽略 ~', () => {
    expect(expectToken('5~')).toMatchObject({ degree: 5, tie: true, duration: 1 });
    expect(expectToken('5_~')).toMatchObject({ degree: 5, tie: true, duration: 0.5 });
    expect(expectToken('0~')).toMatchObject({ degree: 0, tie: false });
  });

  it('非法 token 返回可读错误，不抛异常', () => {
    expectBadToken('x', '无法识别音级');
    expectBadToken('9', '无法识别音级');
    expectBadToken('5#', '无法识别的时值记号');
    expectBadToken('5..', '附点重复');
    expectBadToken('5:abc', '显式时值应写作');
    expectBadToken('5_:1', '不能与');
    expectBadToken('#0', '休止符不能带升降号');
    expectBadToken(',0', '休止符不能带八度标记');
    expectBadToken('1,', '无法识别的时值记号');
    expectBadToken('5:0.01', '超出');
  });
});

describe('dsl.parseScoreText 头部与谱面', () => {
  it('解析标题/速度/拍号/调号/基础八度头部与音符序列', () => {
    const text = [
      '# 标题：小星星',
      '# 速度：88',
      '# 拍号：3/4',
      '# 调号：1=G',
      '# 基础八度：5',
      "1 2 3 | 5_ 6. 7- | ,1 1' #4 b7 0",
    ].join('\n');
    const parsed = parseScoreText(text);
    expect(parsed.meta).toEqual({
      title: '小星星',
      tempo: 88,
      meter: { num: 3, den: 4 },
      keyRoot: 7,
      baseOctave: 5,
    });
    expect(parsed.noteCount).toBe(10);
    expect(parsed.notes.map((note) => noteShape(note))).toEqual([
      { degree: 1, accidental: 0, octave: 0, startBeat: 0, duration: 1, tie: false },
      { degree: 2, accidental: 0, octave: 0, startBeat: 1, duration: 1, tie: false },
      { degree: 3, accidental: 0, octave: 0, startBeat: 2, duration: 1, tie: false },
      { degree: 5, accidental: 0, octave: 0, startBeat: 3, duration: 0.5, tie: false },
      { degree: 6, accidental: 0, octave: 0, startBeat: 3.5, duration: 1.5, tie: false },
      { degree: 7, accidental: 0, octave: 0, startBeat: 5, duration: 2, tie: false },
      { degree: 1, accidental: 0, octave: -1, startBeat: 7, duration: 1, tie: false },
      { degree: 1, accidental: 0, octave: 1, startBeat: 8, duration: 1, tie: false },
      { degree: 4, accidental: 1, octave: 0, startBeat: 9, duration: 1, tie: false },
      { degree: 7, accidental: -1, octave: 0, startBeat: 10, duration: 1, tie: false },
      { degree: 0, accidental: 0, octave: 0, startBeat: 11, duration: 1, tie: false },
    ]);
    expect(parsed.bars).toEqual([3, 7]);
    // 3/4 拍号下第 2 小节实际为 4 拍 → 恰好一条拍号 warning
    const warnings = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('第 2 小节');
    expect(warnings[0].message).toContain('3/4');
  });

  it('支持英文/别名头部写法', () => {
    const parsed = parseScoreText(
      ['# title: 别名测试', '# bpm: 140', '# meter: 6/8', '# key: 1=D', '# baseOctave: 3', '1 2'].join('\n'),
    );
    expect(parsed.meta).toEqual({
      title: '别名测试',
      tempo: 140,
      meter: { num: 6, den: 8 },
      keyRoot: 2,
      baseOctave: 3,
    });
    expect(parsed.notes).toHaveLength(2);
  });

  it('非法头部值只产生 warning，不抛异常且不覆盖默认值', () => {
    const parsed = parseScoreText(
      ['# 速度：abc', '# 拍号：5/7', '# 调号：H', '# 基础八度：12', '1'].join('\n'),
    );
    const warnings = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
    expect(warnings).toHaveLength(4);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.meta.tempo).toBeUndefined();
    expect(parsed.meta.meter).toBeUndefined();
    expect(parsed.meta.keyRoot).toBeUndefined();
    expect(parsed.meta.baseOctave).toBeUndefined();
  });

  it('没有音符时给出 error 诊断而不是抛异常', () => {
    const parsed = parseScoreText('// 只有注释');
    expect(parsed.notes).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('没有解析到任何音符') }),
    );
  });

  it('未知音符 token 产生 error 诊断，其余音符照常解析', () => {
    const parsed = parseScoreText('1 x 2');
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', token: 'x' }),
    );
  });

  it('拍号与小节线不符时产生 warning', () => {
    const parsed = parseScoreText(['# 拍号：4/4', '1 2 3 | 4 5 6 7'].join('\n'));
    const warnings = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('第 1 小节为 3 拍');
    expect(warnings[0].message).toContain('4/4');
  });
});

describe('dsl 连音线', () => {
  it('解析 5~ 5 后 normalize 仍保留连音', () => {
    const parsed = parseScoreText('5~ 5');
    expect(parsed.notes.map((note) => note.tie)).toEqual([true, false]);
    expect(parsed.notes.map((note) => note.startBeat)).toEqual([0, 1]);

    const built = buildScoreFromText('5~ 5');
    expect(built.score.notes).toHaveLength(2);
    expect(built.score.notes[0].tie).toBe(true);
    expect(built.score.notes[1].tie).toBe(false);
    expect(built.diagnostics.filter((diagnostic) => diagnostic.message.includes('连音线'))).toEqual([]);
  });

  it('5~ 6 的坏连音被 normalize 取消并给出 warning', () => {
    const built = buildScoreFromText('5~ 6');
    expect(built.score.notes[0].tie).toBe(false);
    expect(built.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('连音线'),
      }),
    );
  });

  it('独立的 ~ token 也可标记前一个音符，前面没有音符时给出 warning', () => {
    const standalone = parseScoreText('5 ~ 5');
    expect(standalone.notes[0].tie).toBe(true);
    const orphan = parseScoreText('~ 5');
    expect(orphan.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('连音线') }),
    );
  });
});

describe('dsl.serializeScore round-trip', () => {
  it('序列化后头部与连音/八度/附点/休止符/显式时值均可再次解析一致', () => {
    const score = createEmptyScore({
      meta: { title: '往返测试', tempo: 90, meter: { num: 4, den: 4 }, keyRoot: 10, baseOctave: 4 },
    });
    const specs: readonly Partial<ScoreNote>[] = [
      { degree: 1, accidental: 0, octave: -1, startBeat: 0, duration: 1 }, // 低八度
      { degree: 5, accidental: 1, octave: 0, startBeat: 1, duration: 1.5 }, // 附点
      { degree: 3, accidental: 0, octave: 0, startBeat: 2.5, duration: 0.5 },
      { degree: 0, accidental: 0, octave: 0, startBeat: 3, duration: 1 }, // 显式休止符
      { degree: 2, accidental: 0, octave: 1, startBeat: 4, duration: 0.75 }, // 高八度附点八分
      { degree: 7, accidental: -1, octave: 0, startBeat: 4.75, duration: 1.25 }, // 显式时值
      { degree: 1, accidental: 0, octave: 0, startBeat: 6, duration: 1 },
      { degree: 5, accidental: 0, octave: 0, startBeat: 7, duration: 1, tie: true }, // 延音
      { degree: 5, accidental: 0, octave: 0, startBeat: 8, duration: 1 },
    ];
    score.notes = specs.map((spec, index) => createNote({ id: `n-${index}`, ...spec }));

    const text = serializeScore(score);
    expect(text).toContain('# 标题：往返测试');
    expect(text).toContain('# 速度：90');
    expect(text).toContain('# 拍号：4/4');
    expect(text).toContain('# 调号：1=Bb');
    expect(text).toContain('# 基础八度：4');

    const parsed = parseScoreText(text);
    expect(parsed.meta).toEqual({
      title: '往返测试',
      tempo: 90,
      meter: { num: 4, den: 4 },
      keyRoot: 10,
      baseOctave: 4,
    });
    expect(parsed.notes.map((note) => noteShape(note))).toEqual(specs.map((spec, index) => noteShape(createNote({ id: `n-${index}`, ...spec }))));
    // 小节线落在 4/8 拍处，拍号校验不应报错
    expect(parsed.diagnostics).toEqual([]);

    // buildScoreFromText 会再走一遍 normalize，结果仍应与原谱一致
    const rebuilt = buildScoreFromText(text);
    expect(rebuilt.score.meta.keyRoot).toBe(10);
    expect(rebuilt.score.notes.map((note) => noteShape(note))).toEqual(
      specs.map((spec, index) => noteShape(createNote({ id: `n-${index}`, ...spec }))),
    );
  });

  it('简谱示例文本 → build → serialize → parse 保持音高/时值/拍位', () => {
    const source = "1 2 3 | 5_ 6. 7- | ,1 1' #4 b7 0";
    const built = buildScoreFromText(source);
    const roundTrip = parseScoreText(serializeScore(built.score));
    expect(roundTrip.notes).toHaveLength(built.score.notes.length);
    roundTrip.notes.forEach((note, index) => {
      const original = built.score.notes[index];
      expect(note.degree).toBe(original.degree);
      expect(note.accidental).toBe(original.accidental);
      expect(note.octave).toBe(original.octave);
      expect(note.duration).toBeCloseTo(original.duration, 6);
      expect(note.startBeat).toBeCloseTo(original.startBeat, 6);
      expect(note.tie).toBe(original.tie);
    });
  });

  it('空乐谱序列化为一个休止符，可被再次解析', () => {
    const text = serializeScore(createEmptyScore());
    const parsed = parseScoreText(text);
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ degree: 0, startBeat: 0, duration: 1 });
  });

  it('formatDurationSuffix / formatNoteToken 输出约定的 DSL 后缀', () => {
    const table: Array<[number, string]> = [
      [1, ''],
      [0.5, '_'],
      [1.5, '.'],
      [0.75, '_.'],
      [2, '-'],
      [3, '--'],
      [4, '---'],
      [5, '----'],
      [1.25, ':1.25'],
      [1.75, ':1.75'],
    ];
    for (const [duration, suffix] of table) {
      expect(formatDurationSuffix(duration)).toBe(suffix);
    }
    expect(formatNoteToken({ degree: 5, accidental: 0, octave: 0, duration: 1, tie: false })).toBe('5');
    expect(formatNoteToken({ degree: 4, accidental: 1, octave: 0, duration: 0.5, tie: false })).toBe('#4_');
    expect(formatNoteToken({ degree: 1, accidental: 0, octave: 2, duration: 1, tie: false })).toBe("1''");
    expect(formatNoteToken({ degree: 5, accidental: -1, octave: -1, duration: 0.75, tie: true })).toBe(',b5_.~');
    expect(formatNoteToken({ degree: 0, accidental: 0, octave: 0, duration: 2, tie: false })).toBe('0-');
  });
});

describe('dsl.buildScoreFromText / createNewScoreDraft', () => {
  it('buildScoreFromText 合并头部与默认元信息，source.kind=text', () => {
    const built = buildScoreFromText('# 标题：曲名\n# 速度：120\n1 2 3');
    expect(built.score.meta.title).toBe('曲名');
    expect(built.score.meta.tempo).toBe(120);
    expect(built.score.meta.meter).toEqual({ num: 4, den: 4 });
    expect(built.score.meta.keyRoot).toBe(0);
    expect(built.score.source.kind).toBe('text');
    expect(built.score.notes.map((note) => note.degree)).toEqual([1, 2, 3]);
    expect(built.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('options.title 覆盖谱面内标题', () => {
    const built = buildScoreFromText('1', { title: '覆盖标题' });
    expect(built.score.meta.title).toBe('覆盖标题');
  });

  it('createNewScoreDraft 生成带一个初始音符的草稿且可解析回来', () => {
    const { score, text } = createNewScoreDraft('新乐谱');
    expect(score.notes).toHaveLength(1);
    expect(score.notes[0]).toMatchObject({ degree: 1, startBeat: 0, duration: 1 });
    const parsed = parseScoreText(text);
    expect(parsed.meta.title).toBe('新乐谱');
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ degree: 1, startBeat: 0, duration: 1 });
  });
});
