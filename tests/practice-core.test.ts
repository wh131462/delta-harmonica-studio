/**
 * 练习功能核心回归：会话切片/变速/移调/折返 + 判定窗口/连击/准确率。
 * 这些逻辑不依赖界面，是练习模式「按对音、踩准拍」的唯一依据。
 */
import { describe, expect, it } from 'vitest';
import {
  SCORE_SCHEMA,
  createNote,
  meterBeats,
  type Meter,
  type Score,
  type ScoreMeta,
  type ScoreNote,
} from '@core/model/score';
import {
  DEFAULT_PRACTICE_WINDOWS,
  PRACTICE_SPEED_DEFAULT,
  advanceJudge,
  buildPracticeSession,
  createJudgeState,
  gradeForDelta,
  judgePress,
  nextPendingIndex,
  scoreBarCount,
  summarizePractice,
  transposedWrittenMeta,
  type JudgeState,
  type PracticeSession,
} from '@core/practice';

function scoreOf(notes: ScoreNote[], meta: Partial<ScoreMeta> = {}): Score {
  const merged: ScoreMeta = {
    title: '练习测试',
    tempo: 120,
    meter: { num: 4, den: 4 },
    keyRoot: 0,
    baseOctave: 4,
    ...meta,
  };
  merged.meter = { ...(meta.meter ?? merged.meter) } as Meter;
  return {
    schema: SCORE_SCHEMA,
    id: 'score-practice-test',
    meta: merged,
    notes,
    source: { kind: 'manual' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function n(
  degree: ScoreNote['degree'],
  startBeat: number,
  duration = 1,
  id = `n-${degree}-${startBeat}`,
  extra: Partial<ScoreNote> = {},
): ScoreNote {
  return createNote({ id, degree, startBeat, duration, ...extra });
}

/** 4 个音、120 BPM、原速：拍长 500ms，预备 4 拍 = 2000ms */
function basicScore(): Score {
  return scoreOf([n(1, 0, 1, 'c4'), n(2, 1, 1, 'd4'), n(3, 2, 1, 'e4'), n(5, 3, 1, 'g4')]);
}

function basicSession(): PracticeSession {
  return buildPracticeSession(basicScore(), { speed: 1 });
}

describe('练习会话 buildPracticeSession', () => {
  it('按拍号生成毫秒时间轴与预备拍', () => {
    const session = basicSession();
    expect(session.beatMs).toBe(500);
    expect(session.countInBeats).toBe(4);
    expect(session.leadInMs).toBe(2000);
    expect(session.steps.map((step) => step.timeMs)).toEqual([2000, 2500, 3000, 3500]);
    expect(session.steps.map((step) => step.noteName)).toEqual(['C4', 'D4', 'E4', 'G4']);
    expect(session.steps.map((step) => step.keys)).toEqual(['Z', 'X', 'C', 'B']);
    expect(session.steps.map((step) => step.degree)).toEqual([1, 2, 3, 5]);
    expect(session.steps[0].bar).toBe(1);
    expect(session.durationMs).toBe(4000);
    expect(session.tempo).toBe(120);
    expect(session.warnings).toEqual([]);
  });

  it('节拍器点击与目标音共用同一时间轴，小节重拍加重音', () => {
    const session = basicSession();
    expect(session.clicks.map((click) => click.t)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    expect(session.clicks.map((click) => click.accent)).toEqual([true, false, false, false, true, false, false, false]);
  });

  it('速度倍率同时改变拍长、预备拍与判定时间', () => {
    const session = buildPracticeSession(basicScore(), { speed: 0.5 });
    expect(session.tempo).toBe(60);
    expect(session.beatMs).toBe(1000);
    // 拍子变慢后预备拍缩短到 3 拍，避免等太久
    expect(session.countInBeats).toBe(3);
    expect(session.leadInMs).toBe(3000);
    expect(session.steps.map((step) => step.timeMs)).toEqual([3000, 4000, 5000, 6000]);
  });

  it('按小节切片，并把小节号换算成绝对位置', () => {
    const score = scoreOf([
      n(1, 0, 1, 'b1'),
      n(2, 4, 1, 'b2-1'),
      n(3, 5, 1, 'b2-2'),
      n(5, 8, 1, 'b3'),
    ]);
    expect(scoreBarCount(score)).toBe(3);

    const session = buildPracticeSession(score, { speed: 1, startBar: 2, endBar: 2 });
    expect(session.startBar).toBe(2);
    expect(session.endBar).toBe(2);
    expect(session.segmentBars).toBe(1);
    expect(session.steps.map((step) => step.id)).toEqual(['b2-1', 'b2-2']);
    expect(session.steps.map((step) => step.bar)).toEqual([2, 2]);
    expect(session.steps.map((step) => step.startBeat)).toEqual([0, 1]);
    expect(session.steps[0].timeMs).toBe(session.leadInMs);
    expect(session.durationMs).toBe(session.leadInMs + 4 * 500);
  });

  it('结束小节缺省为曲末，越界会被夹取', () => {
    const score = scoreOf([n(1, 0, 1, 'a'), n(2, 8, 1, 'b')]);
    const toEnd = buildPracticeSession(score, { startBar: 2 });
    expect(toEnd.startBar).toBe(2);
    expect(toEnd.endBar).toBe(3);
    const clamped = buildPracticeSession(score, { startBar: 99, endBar: 99 });
    expect(clamped.startBar).toBe(3);
    expect(clamped.endBar).toBe(3);
    expect(clamped.steps.map((step) => step.id)).toEqual(['b']);

    const empty = buildPracticeSession(score, { startBar: 2, endBar: 2 });
    expect(empty.steps).toHaveLength(0);
    expect(empty.warnings.some((warning) => warning.includes('没有可练习的音符'))).toBe(true);
  });

  it('移调后音高、按法与轨道简谱一起变化', () => {
    const score = scoreOf([n(1, 0, 1, 'c4')]);
    const up = buildPracticeSession(score, { speed: 1, transpose: 2 });
    expect(up.transpose).toBe(2);
    expect(up.steps[0].midi).toBe(62);
    expect(up.steps[0].noteName).toBe('D4');
    expect(up.steps[0].keys).toBe('X');
    expect(up.steps[0].degree).toBe(1);

    const down = buildPracticeSession(score, { speed: 1, transpose: -1 });
    expect(down.steps[0].midi).toBe(59);
    expect(down.steps[0].noteName).toBe('B3');
    expect(down.steps[0].keys).toBe('↓M');
    expect(down.steps[0].octave).toBe(0);
    expect(transposedWrittenMeta({ keyRoot: 0, baseOctave: 4 }, -1)).toEqual({ keyRoot: 11, baseOctave: 3 });
  });

  it('超音域自动折返八度，并保留目标音高', () => {
    const score = scoreOf([n(1, 0, 1, 'high', { octave: 3 })]);
    const session = buildPracticeSession(score, { speed: 1 });
    expect(session.steps).toHaveLength(1);
    const step = session.steps[0];
    expect(step.targetMidi).toBe(96);
    expect(step.outOfRange).toBe(true);
    expect(step.folded).toBe(true);
    expect(step.midi).toBe(84);
    expect(step.keys).toBe('↑,');
    expect(session.warnings.some((warning) => warning.includes('折返'))).toBe(true);
  });

  it('连音在练习目标里合并成一个长音', () => {
    const score = scoreOf([n(1, 0, 1, 'tie-a', { tie: true }), n(1, 1, 1, 'tie-b')]);
    const session = buildPracticeSession(score, { speed: 1 });
    expect(session.steps).toHaveLength(1);
    expect(session.steps[0].durationBeats).toBe(2);
    expect(session.steps[0].tied).toBe(true);
    expect(session.steps[0].holdMs).toBe(1000);
  });

  it('半音音级使用中键修饰并按实际音高换算简谱', () => {
    const score = scoreOf([n(1, 0, 1, 'csharp', { accidental: 1 })]);
    const session = buildPracticeSession(score, { speed: 1 });
    expect(session.steps[0].midi).toBe(61);
    expect(session.steps[0].accidental).toBe(1);
    expect(session.steps[0].keys).toBe('#Z');
  });

  it('3/4 拍的预备拍与小节重音对齐', () => {
    const score = scoreOf(
      [n(1, 0, 1, 'a'), n(2, 1, 1, 'b'), n(3, 2, 1, 'c'), n(5, 3, 1, 'd'), n(6, 4, 1, 'e'), n(7, 5, 1, 'f')],
      { meter: { num: 3, den: 4 } },
    );
    expect(meterBeats(score.meta.meter)).toBe(3);
    const session = buildPracticeSession(score, { speed: 1 });
    expect(session.countInBeats).toBe(3);
    expect(session.leadInMs).toBe(1500);
    const accents = session.clicks.filter((click) => click.accent).map((click) => click.t);
    expect(accents).toEqual([0, 1500, 3000]);
  });

  it('速度倍率会被夹到安全范围', () => {
    expect(buildPracticeSession(basicScore(), { speed: 99 }).speed).toBe(2);
    expect(buildPracticeSession(basicScore(), { speed: -3 }).speed).toBe(0.25);
    expect(buildPracticeSession(basicScore()).speed).toBe(PRACTICE_SPEED_DEFAULT);
    expect(buildPracticeSession(basicScore(), { speed: Number.NaN }).speed).toBe(PRACTICE_SPEED_DEFAULT);
  });

  it('空曲谱仍能生成可渲染的空会话', () => {
    const session = buildPracticeSession(scoreOf([]), { speed: 1 });
    expect(session.steps).toEqual([]);
    expect(session.barCount).toBe(1);
    expect(session.segmentBars).toBe(1);
    expect(session.durationMs).toBeGreaterThan(0);
    expect(session.clicks.length).toBeGreaterThan(0);
  });

  it('段落起点在音符中间时丢弃跨段音符', () => {
    const score = scoreOf([n(1, 0, 3, 'long'), n(2, 4, 1, 'next')]);
    const session = buildPracticeSession(score, { startBar: 2, endBar: 2 });
    expect(session.steps.map((step) => step.id)).toEqual(['next']);
    expect(session.steps[0].startBeat).toBe(0);
  });

  it('练习时间轴按音符起点排序（输入音符乱序也稳定）', () => {
    const score = scoreOf([n(3, 2, 1, 'later'), n(1, 0, 1, 'early'), n(2, 1, 1, 'middle')]);
    const session = buildPracticeSession(score, { speed: 1 });
    expect(session.steps.map((step) => step.id)).toEqual(['early', 'middle', 'later']);
  });
});

describe('练习判定 judge', () => {
  const session = basicSession();

  function fresh(): JudgeState {
    return createJudgeState(session);
  }

  function press(state: JudgeState, midi: number, atMs: number) {
    return judgePress(state, session, { midi, atMs });
  }

  it('判定窗口边界：完美 ±55ms / 优秀 ±100ms / 良好 ±150ms', () => {
    expect(gradeForDelta(0)).toBe('perfect');
    expect(gradeForDelta(-55)).toBe('perfect');
    expect(gradeForDelta(55)).toBe('perfect');
    expect(gradeForDelta(56)).toBe('great');
    expect(gradeForDelta(-100)).toBe('great');
    expect(gradeForDelta(101)).toBe('good');
    expect(gradeForDelta(-150)).toBe('good');
    expect(gradeForDelta(151)).toBe('miss');
    expect(gradeForDelta(35, { perfectMs: 20, greatMs: 40, goodMs: 60 })).toBe('great');
    expect(gradeForDelta(55, { perfectMs: 20, greatMs: 40, goodMs: 60 })).toBe('good');
  });

  it('命中最近的同音高目标，正负偏差都记录', () => {
    const exact = press(fresh(), 60, 2000);
    expect(exact.grade).toBe('perfect');
    expect(exact.noteIndex).toBe(0);
    expect(exact.deltaMs).toBe(0);
    expect(exact.state.combo).toBe(1);
    expect(exact.state.maxCombo).toBe(1);

    const early = press(fresh(), 60, 1944);
    expect(early.grade).toBe('great');
    expect(early.deltaMs).toBe(-56);

    const late = press(fresh(), 60, 2140);
    expect(late.grade).toBe('good');
    expect(late.deltaMs).toBe(140);
  });

  it('超出判定窗口的按键记为错音，不消耗目标音', () => {
    const tooLate = press(fresh(), 60, 2160);
    expect(tooLate.grade).toBe('wrong');
    expect(tooLate.noteIndex).toBeNull();
    expect(tooLate.state.wrong).toBe(1);
    expect(tooLate.state.counts.wrong).toBe(1);
    expect(tooLate.state.grades[0]).toBeNull();

    const wrongPitch = press(tooLate.state, 64, 2000);
    expect(wrongPitch.grade).toBe('wrong');
    expect(wrongPitch.state.wrong).toBe(2);
    expect(wrongPitch.state.combo).toBe(0);

    const recovered = press(wrongPitch.state, 60, 2000);
    expect(recovered.grade).toBe('perfect');
    expect(recovered.state.hits).toBe(1);
  });

  it('同音高相邻音之间选距离最近的一个', () => {
    const repeated = scoreOf([n(1, 0, 0.1, 'rep-a'), n(1, 0.2, 0.1, 'rep-b')]);
    const repeatedSession = buildPracticeSession(repeated, { speed: 1 });
    const state = createJudgeState(repeatedSession);
    const result = judgePress(state, repeatedSession, { midi: 60, atMs: 2060 });
    expect(result.noteIndex).toBe(1);
    expect(Math.round(result.deltaMs)).toBe(-40);
    expect(result.grade).toBe('perfect');
  });

  it('推进时间只把已经过窗的音记为失误，返回原对象表示无变化', () => {
    const state = fresh();
    expect(advanceJudge(state, session, 2150)).toBe(state);
    const missed = advanceJudge(state, session, 2151);
    expect(missed.counts.miss).toBe(1);
    expect(missed.grades[0]).toBe('miss');
    expect(missed.judged).toBe(1);
    expect(missed.combo).toBe(0);
    expect(missed.last?.grade).toBe('miss');
    expect(advanceJudge(missed, session, 2151)).toBe(missed);

    const two = advanceJudge(missed, session, 2701);
    expect(two.counts.miss).toBe(2);
    expect(two.judged).toBe(2);
  });

  it('连击在命中时累加、在失误/错音时清零，最高连击保留', () => {
    let state = fresh();
    state = press(state, 60, 2000).state;
    state = press(state, 62, 2500).state;
    expect(state.combo).toBe(2);
    state = advanceJudge(state, session, 3700);
    expect(state.combo).toBe(0);
    expect(state.maxCombo).toBe(2);
    expect(state.counts.miss).toBe(2);
    state = press(state, 71, 2000).state;
    expect(state.combo).toBe(0);
  });

  it('同一个目标音不能被按中两次', () => {
    const first = press(fresh(), 60, 2000);
    const second = press(first.state, 60, 2001);
    expect(second.grade).toBe('wrong');
    expect(second.state.hits).toBe(1);
    expect(second.state.wrong).toBe(1);
  });

  it('准确率 = 命中权重 / (已判定目标音 + 错音)', () => {
    let state = fresh();
    expect(summarizePractice(state).accuracy).toBeNull();
    state = press(state, 60, 2000).state; // perfect 1.0
    state = press(state, 62, 2560).state; // great 0.8
    state = press(state, 64, 2600).state; // wrong（E4 在 3000ms，超出窗口）
    const summary = summarizePractice(state);
    expect(summary.hits).toBe(2);
    expect(summary.wrong).toBe(1);
    expect(summary.judged).toBe(2);
    expect(summary.accuracy).toBeCloseTo((1.8 / 3) * 100, 5);
    expect(summary.meanDeltaMs).toBeCloseTo(30, 5);
    expect(summary.maxCombo).toBe(2);
    expect(summary.complete).toBe(false);
  });

  it('全部目标音有结果后标记完成', () => {
    let state = fresh();
    state = press(state, 60, 2000).state;
    state = press(state, 62, 2500).state;
    state = press(state, 64, 3000).state;
    state = press(state, 67, 3500).state;
    expect(nextPendingIndex(state)).toBe(-1);
    const summary = summarizePractice(state);
    expect(summary.complete).toBe(true);
    expect(summary.accuracy).toBe(100);
    expect(summary.meanDeltaMs).toBe(0);
  });

  it('未命中的音保持待判定，nextPendingIndex 指向它', () => {
    const state = advanceJudge(fresh(), session, 2151);
    expect(nextPendingIndex(state)).toBe(1);
    expect(state.grades[0]).toBe('miss');
  });

  it('判定状态与会话不匹配时抛错，避免串谱', () => {
    const other = buildPracticeSession(scoreOf([n(1, 0, 1, 'only')]), { speed: 1 });
    const state = createJudgeState(other);
    expect(() => judgePress(state, session, { midi: 60, atMs: 2000 })).toThrow(/不匹配/);
  });

  it('默认判定窗口足够宽松', () => {
    expect(DEFAULT_PRACTICE_WINDOWS.goodMs).toBeGreaterThanOrEqual(DEFAULT_PRACTICE_WINDOWS.greatMs);
    expect(DEFAULT_PRACTICE_WINDOWS.greatMs).toBeGreaterThanOrEqual(DEFAULT_PRACTICE_WINDOWS.perfectMs);
  });
});
