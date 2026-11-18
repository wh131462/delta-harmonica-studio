/**
 * 顺序音符编辑核心：乐谱 ↔ 序列转换、插入/删除/改时值、连音校验。
 *
 * 这些函数是可视化编辑器唯一的数据入口，必须与模型的时间语义保持一致：
 * - 序列编辑后所有音符首尾相接，不会重叠；
 * - 时间空档会被补成休止符，保存前后听感不变；
 * - 改音高/删音后失效的连音线会被清理。
 */
import { describe, expect, it } from 'vitest';
import {
  beatLabel,
  canTie,
  clampStepDuration,
  countSoundingSteps,
  createStep,
  durationChoice,
  insertStepAt,
  removeStepAt,
  sanitizeTies,
  scoreToSteps,
  stepsStartBeats,
  stepsToScore,
  stepsTotalBeats,
  updateStepAt,
  type ScoreStep,
} from '../src/core/score/sequence';
import { createEmptyScore, createNote, type Score } from '../src/core/model/score';

function makeScore(
  entries: Array<{ degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; startBeat: number; duration: number; octave?: number }>,
): Score {
  const score = createEmptyScore({ title: '测试谱' });
  score.notes = entries.map((entry) =>
    createNote({
      degree: entry.degree,
      startBeat: entry.startBeat,
      duration: entry.duration,
      octave: entry.octave ?? 0,
    }),
  );
  return score;
}

function note(degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, duration = 1, extra: Partial<ScoreStep> = {}): ScoreStep {
  return createStep({ degree, duration, ...extra });
}

describe('scoreToSteps', () => {
  it('连续的乐谱直接转成序列，不补休止', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 2, startBeat: 1, duration: 0.5 },
      { degree: 3, startBeat: 1.5, duration: 2 },
    ]);
    const conversion = scoreToSteps(score);
    expect(conversion.steps).toHaveLength(3);
    expect(conversion.syntheticRestCount).toBe(0);
    expect(conversion.overlapCount).toBe(0);
    expect(conversion.direct).toBe(true);
    expect(conversion.steps.map((step) => step.degree)).toEqual([1, 2, 3]);
    expect(conversion.steps.map((step) => step.duration)).toEqual([1, 0.5, 2]);
  });

  it('时间空档补成休止符，总时长保持不变', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 5, startBeat: 2.5, duration: 1 },
    ]);
    const conversion = scoreToSteps(score);
    expect(conversion.steps.map((step) => step.degree)).toEqual([1, 0, 5]);
    expect(conversion.steps[1]?.duration).toBe(1.5);
    expect(conversion.syntheticRestCount).toBe(1);
    expect(conversion.direct).toBe(false);
    expect(stepsTotalBeats(conversion.steps)).toBe(3.5);
  });

  it('重叠音符按顺序后移并计数', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 2 },
      { degree: 2, startBeat: 1, duration: 1 },
    ]);
    const conversion = scoreToSteps(score);
    expect(conversion.overlapCount).toBe(1);
    expect(conversion.steps.map((step) => step.degree)).toEqual([1, 2]);
    const rebuilt = stepsToScore(conversion.steps, score);
    expect(rebuilt.notes.map((item) => item.startBeat)).toEqual([0, 2]);
    expect(rebuilt.notes.map((item) => item.duration)).toEqual([2, 1]);
  });

  it('显式休止符原样保留，不会被当成空档', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 0, startBeat: 1, duration: 1 },
      { degree: 2, startBeat: 2, duration: 1 },
    ]);
    const conversion = scoreToSteps(score);
    expect(conversion.steps.map((step) => step.degree)).toEqual([1, 0, 2]);
    expect(conversion.syntheticRestCount).toBe(0);
    expect(conversion.direct).toBe(true);
  });

  it('保留音符 id，便于选中状态在编辑后保持', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 2, startBeat: 1, duration: 1 },
    ]);
    const ids = score.notes.map((item) => item.id);
    expect(scoreToSteps(score).steps.map((step) => step.id)).toEqual(ids);
  });

  it('补出的休止符 id 稳定，改速度 / 拍号后不会丢失选中', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 5, startBeat: 2.5, duration: 1 },
    ]);
    const first = scoreToSteps(score).steps;
    const second = scoreToSteps(score).steps;
    expect(first.map((step) => step.id)).toEqual(second.map((step) => step.id));
    expect(first[1]?.id).toBe('auto-rest-1');
  });
});

describe('stepsToScore', () => {
  it('起始拍由时值累加得到，首尾相接', () => {
    const steps = [note(1, 1), note(2, 0.5), note(3, 1.5)];
    const score = stepsToScore(steps, createEmptyScore({ title: '累加' }));
    expect(score.notes.map((item) => item.startBeat)).toEqual([0, 1, 1.5]);
    expect(score.notes.map((item) => item.startBeat + item.duration)).toEqual([1, 1.5, 3]);
  });

  it('休止符不写八度与升降，长度仍计入时间轴', () => {
    const steps = [note(1, 1), note(0, 2, { octave: -2, accidental: 1 }), note(5, 1)];
    const score = stepsToScore(steps, createEmptyScore({ title: '休止' }));
    const rest = score.notes[1];
    expect(rest?.degree).toBe(0);
    expect(rest?.octave).toBe(0);
    expect(rest?.accidental).toBe(0);
    expect(score.notes[2]?.startBeat).toBe(3);
  });

  it('空序列生成空乐谱（不报错）', () => {
    const score = stepsToScore([], createEmptyScore({ title: '空谱' }));
    expect(score.notes).toEqual([]);
  });
});

describe('序列编辑操作', () => {
  const base = [note(1, 1), note(2, 1), note(3, 1)];

  it('插入音符后，后面的音整体后移', () => {
    const next = insertStepAt(base, 1, note(5, 0.5));
    expect(next.map((step) => step.degree)).toEqual([1, 5, 2, 3]);
    const score = stepsToScore(next, createEmptyScore({ title: '插入' }));
    expect(score.notes.map((item) => item.startBeat)).toEqual([0, 1, 1.5, 2.5]);
  });

  it('删除音符后，后面的音整体前移', () => {
    const next = removeStepAt(base, 0);
    expect(next.map((step) => step.degree)).toEqual([2, 3]);
    expect(stepsStartBeats(next)).toEqual([0, 1]);
  });

  it('改时值会平移后面的音', () => {
    const next = updateStepAt(base, 0, { duration: 2 });
    expect(stepsStartBeats(next)).toEqual([0, 2, 3]);
    expect(stepsToScore(next, createEmptyScore({ title: '时值' })).notes[1]?.startBeat).toBe(2);
  });

  it('插入越界下标会被夹到末尾', () => {
    const next = insertStepAt(base, 99, note(7, 1));
    expect(next.at(-1)?.degree).toBe(7);
  });

  it('把补位休止符改成音符时换成普通 id，避免将来同拍位补休止符撞 id', () => {
    const rest = createStep({ id: 'auto-rest-1', degree: 0, duration: 1 });
    const steps = [note(1, 1), rest, note(2, 1)];
    const next = updateStepAt(steps, 1, { degree: 5 });
    expect(next[1]?.degree).toBe(5);
    expect(next[1]?.id).not.toBe('auto-rest-1');
    expect(next[1]?.id.startsWith('n-')).toBe(true);
  });
});

describe('连音', () => {
  it('同音高紧邻才能连音', () => {
    const steps = [note(1, 1), note(1, 1), note(2, 1)];
    expect(canTie(steps, 0)).toBe(true);
    expect(canTie(steps, 1)).toBe(false);
    expect(canTie(steps, 2)).toBe(false);
  });

  it('改高音或删除相邻音后，失效的连音会被清理', () => {
    const tied = [note(1, 1, { tie: true }), note(1, 1), note(3, 1)];
    const changed = updateStepAt(tied, 1, { degree: 2 });
    expect(changed[0]?.tie).toBe(false);
    const removed = removeStepAt(tied, 1);
    expect(removed[0]?.tie).toBe(false);
    const stillTied = updateStepAt(tied, 1, { duration: 2 });
    expect(stillTied[0]?.tie).toBe(true);
  });

  it('sanitizeTies 只保留合法的连音', () => {
    const steps = [note(1, 1, { tie: true }), note(1, 1), note(2, 1, { tie: true }), note(5, 1)];
    expect(sanitizeTies(steps).map((step) => step.tie)).toEqual([true, false, false, false]);
  });
});

describe('时值键盘', () => {
  it('识别基准时值与附点', () => {
    expect(durationChoice(1)).toEqual({ base: 1, dotted: false, known: true });
    expect(durationChoice(1.5)).toEqual({ base: 1, dotted: true, known: true });
    expect(durationChoice(0.75)).toEqual({ base: 0.5, dotted: true, known: true });
    expect(durationChoice(3)).toEqual({ base: 2, dotted: true, known: true });
    expect(durationChoice(4)).toEqual({ base: 4, dotted: false, known: true });
  });

  it('非标准时值原样返回，键盘不高亮', () => {
    const choice = durationChoice(1.25);
    expect(choice.known).toBe(false);
    expect(choice.base).toBe(1.25);
  });

  it('拍数标签使用常用分数', () => {
    expect(beatLabel(0)).toBe('0拍');
    expect(beatLabel(1)).toBe('1拍');
    expect(beatLabel(0.5)).toBe('½拍');
    expect(beatLabel(1.5)).toBe('1½拍');
    expect(beatLabel(0.25)).toBe('¼拍');
    expect(beatLabel(4)).toBe('4拍');
    expect(beatLabel(1.25)).toBe('1¼拍');
    expect(beatLabel(0.0625)).toBe('1/16拍');
    expect(beatLabel(1.1875)).toBe('1 3/16拍');
  });

  it('时值被夹取到模型允许的范围', () => {
    expect(clampStepDuration(0)).toBe(0.05);
    expect(clampStepDuration(999)).toBe(64);
    expect(clampStepDuration(Number.NaN)).toBe(1);
  });
});

describe('统计', () => {
  it('只统计有音高的音符与总拍数', () => {
    const steps = [note(1, 1), note(0, 2), note(5, 0.5)];
    expect(countSoundingSteps(steps)).toBe(2);
    expect(stepsTotalBeats(steps)).toBe(3.5);
  });
});
