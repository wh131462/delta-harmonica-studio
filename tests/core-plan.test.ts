/**
 * 演奏编排单元测试：时间线（timeline.ts）与演奏计划（plan.ts）。
 *
 * 覆盖：连音合并、重叠截断、休止符、小节边界；planPerformance 生成的
 * 输入事件序列（时间排序、单声部无和弦、结束释放全部按键、修饰键状态与组合一致）、
 * 自动移调、超音域折返 warning、tempoOverride、空乐谱、连音排程与 validatePlan 负例。
 *
 * 说明：标记 [BUG] 的 2 个用例对应 src/core/music/timeline.ts 的连音合并缺陷：
 * 实现检查的是「当前音符」的 tie，而数据模型约定 tie 标在「前一个音符」上，
 * 导致 `5~ 5`、`5~ 6` 等写法既不合并、也不报告音高不一致（详见最终测试报告）。
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyScore,
  createNote,
  type Score,
  type ScoreMeta,
  type ScoreNote,
} from '../src/core/model/score';
import {
  barBoundaries,
  crossesBarline,
  repackNotesSequentially,
  toTimedNotes,
} from '../src/core/music/timeline';
import {
  evaluateTranspositions,
  modifierDiff,
  planPerformance,
  validatePlan,
  type PlaybackPlan,
} from '../src/core/instrument/plan';
import { DEFAULT_HARMONICA, allCombos, instrumentRange } from '../src/core/model/instrument';
import { buildScoreFromText } from '../src/core/score/dsl';

/** 构造测试乐谱：音符默认带稳定 id。 */
function makeScore(notes: readonly Partial<ScoreNote>[] = [], meta: Partial<ScoreMeta> = {}): Score {
  const score = createEmptyScore({ meta });
  score.notes = notes.map((note, index) => createNote({ id: `n-${index}`, ...note }));
  return score;
}

/** 1..7 级音阶（四分音符，默认中音区）。 */
function makeScale(octave = 0, tempo = 120): Score {
  const score = createEmptyScore({ meta: { tempo } });
  score.notes = [1, 2, 3, 4, 5, 6, 7].map((degree, index) =>
    createNote({
      id: `scale-${index}`,
      degree: degree as ScoreNote['degree'],
      octave,
      startBeat: index,
      duration: 1,
    }),
  );
  return score;
}

/** 深拷贝计划，用于构造非法计划测试。 */
function clonePlan(plan: PlaybackPlan): PlaybackPlan {
  return JSON.parse(JSON.stringify(plan)) as PlaybackPlan;
}

/** 在计划某时刻扫描鼠标按键状态（与 validatePlan 的判定方式一致）。 */
function mouseButtonsAt(plan: PlaybackPlan, time: number): string[] {
  const buttons = new Set<string>();
  for (const event of plan.events) {
    if (event.t > time) break;
    if (event.kind === 'mousedown' && event.button) buttons.add(event.button);
    else if (event.kind === 'mouseup' && event.button) buttons.delete(event.button);
  }
  return [...buttons].sort();
}

/** 断言计划在物理上可行：时间有序、单声部无和弦、按下/释放配对、结束无残留、validatePlan 为空。 */
function expectPlanPhysicallyValid(plan: PlaybackPlan): void {
  let previousT = -1;
  const pressedKeys = new Set<string>();
  const pressedButtons = new Set<string>();
  for (const event of plan.events) {
    expect(event.t).toBeGreaterThanOrEqual(0);
    expect(event.t).toBeGreaterThanOrEqual(previousT);
    previousT = event.t;
    if (event.kind === 'keydown') {
      expect(event.keyId, `keydown 事件缺少 keyId：${event.label}`).toBeDefined();
      // 单声部：按下新音键时不应已有其它音键处于按下状态（即不允许和弦）
      expect(pressedKeys.size, `出现和弦：${event.label}`).toBe(0);
      pressedKeys.add(event.keyId as string);
    } else if (event.kind === 'keyup') {
      expect(pressedKeys.has(event.keyId as string), `释放了未按下的音键：${event.label}`).toBe(true);
      pressedKeys.delete(event.keyId as string);
    } else if (event.kind === 'mousedown') {
      expect(event.button, `mousedown 事件缺少 button：${event.label}`).toBeDefined();
      pressedButtons.add(event.button as string);
    } else {
      expect(pressedButtons.has(event.button as string), `释放了未按下的鼠标键：${event.label}`).toBe(true);
      pressedButtons.delete(event.button as string);
    }
  }
  expect(pressedKeys.size).toBe(0);
  expect(pressedButtons.size).toBe(0);
  expect(validatePlan(plan)).toEqual([]);
}

describe('timeline.toTimedNotes', () => {
  it('[BUG] 连音线 5~ 5 应合并为一个长音（当前实现未合并）', () => {
    const score = makeScore([
      { degree: 5, startBeat: 0, duration: 1, tie: true },
      { degree: 5, startBeat: 1, duration: 1 },
    ]);
    const timed = toTimedNotes(score);
    // 数据模型约定：tie 表示“与紧随其后的同音高音符连音（演奏时合并为一个长音）”
    expect(timed.notes).toHaveLength(1);
    expect(timed.notes[0]).toMatchObject({
      midi: 67,
      startBeat: 0,
      duration: 2,
      tied: true,
      sourceIndices: [0, 1],
    });
    expect(timed.totalBeats).toBe(2);
    // 同一处缺陷的另一个症状：连音线两侧音高不一致时应给出 warning（当前也检测不到）
    const mismatch = toTimedNotes(
      makeScore([
        { degree: 5, startBeat: 0, duration: 1, tie: true },
        { degree: 6, startBeat: 1, duration: 1 },
      ]),
    );
    expect(mismatch.warnings.length).toBeGreaterThan(0);
  });

  it('连续两个 ~ 标记的长连音链（5~ 5~ 5）合并为 3 拍长音', () => {
    const timed = toTimedNotes(
      makeScore([
        { degree: 5, startBeat: 0, duration: 1, tie: true },
        { degree: 5, startBeat: 1, duration: 1, tie: true },
        { degree: 5, startBeat: 2, duration: 1 },
      ]),
    );
    expect(timed.notes).toHaveLength(1);
    expect(timed.notes[0]).toMatchObject({ midi: 67, startBeat: 0, duration: 3, tied: true });
    expect(timed.notes[0].sourceIndices).toEqual([0, 1, 2]);
  });

  it('连音线后没有紧邻的同音高音符时不合并', () => {
    const timed = toTimedNotes(
      makeScore([
        { degree: 5, startBeat: 0, duration: 1, tie: true },
        { degree: 5, startBeat: 2, duration: 1 },
      ]),
    );
    expect(timed.notes).toHaveLength(2);
    expect(timed.notes[0].duration).toBe(1);
  });

  it('单声部重叠：后音截断前音并给出 warning', () => {
    const timed = toTimedNotes(
      makeScore([
        { degree: 1, startBeat: 0, duration: 2 },
        { degree: 2, startBeat: 1, duration: 1 },
      ]),
    );
    expect(timed.notes).toHaveLength(2);
    expect(timed.notes[0]).toMatchObject({ midi: 60, startBeat: 0, duration: 1 });
    expect(timed.notes[1]).toMatchObject({ midi: 62, startBeat: 1, duration: 1 });
    expect(timed.warnings.some((warning) => warning.includes('重叠'))).toBe(true);
    expect(timed.totalBeats).toBe(2);
  });

  it('休止符默认不进入音符序列，includeRests=true 时以 midi=-1 返回', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 0, startBeat: 1, duration: 1 },
      { degree: 2, startBeat: 2, duration: 1 },
    ]);
    const withoutRests = toTimedNotes(score);
    expect(withoutRests.notes.map((note) => note.midi)).toEqual([60, 62]);
    expect(withoutRests.totalBeats).toBe(3);

    const withRests = toTimedNotes(score, true);
    expect(withRests.notes.map((note) => note.midi)).toEqual([60, -1, 62]);
    expect(withRests.notes[1]).toMatchObject({ startBeat: 1, duration: 1 });
  });

  it('totalBeats 为全曲长度（包含末尾休止符）', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 0, startBeat: 3, duration: 1 },
    ]);
    // 全曲长度应包含末尾休止符：0..4 拍
    expect(toTimedNotes(score).totalBeats).toBe(4);
    const withRests = toTimedNotes(score, true);
    expect(withRests.notes).toHaveLength(2);
    expect(withRests.totalBeats).toBe(4);
  });

  it('非法时值（<=0 / 非有限数）的音符被跳过', () => {
    const timed = toTimedNotes(
      makeScore([
        { degree: 1, startBeat: 0, duration: 0 },
        { degree: 2, startBeat: 1, duration: Number.NaN },
        { degree: 3, startBeat: 2, duration: 1 },
      ]),
    );
    expect(timed.notes.map((note) => note.midi)).toEqual([64]);
  });
});

describe('timeline 辅助函数', () => {
  it('repackNotesSequentially 顺序紧排并返回新数组', () => {
    const notes = [
      createNote({ degree: 1, startBeat: 5, duration: 1 }),
      createNote({ degree: 2, startBeat: 0, duration: 0.5 }),
      createNote({ degree: 3, startBeat: 9, duration: 2 }),
    ];
    const packed = repackNotesSequentially(notes);
    expect(packed.map((note) => note.startBeat)).toEqual([0, 1, 1.5]);
    expect(notes.map((note) => note.startBeat)).toEqual([5, 0, 9]);
  });

  it('barBoundaries 计算小节起点', () => {
    expect(barBoundaries(8, 4)).toEqual([0, 4]);
    expect(barBoundaries(9, 4)).toEqual([0, 4, 8]);
    // 恰好落在小节线结尾时不额外补边界
    expect(barBoundaries(4, 4)).toEqual([0]);
    expect(barBoundaries(5, 0)).toEqual([0]);
  });

  it('crossesBarline 判断音符是否跨过小节线（正好收在小节线不算跨）', () => {
    expect(crossesBarline({ startBeat: 3, duration: 2 }, 4)).toBe(true);
    expect(crossesBarline({ startBeat: 3.5, duration: 1 }, 4)).toBe(true);
    expect(crossesBarline({ startBeat: 0, duration: 4 }, 4)).toBe(false);
    expect(crossesBarline({ startBeat: 3, duration: 1 }, 4)).toBe(false);
    expect(crossesBarline({ startBeat: 4.5, duration: 0.5 }, 4)).toBe(false);
    expect(crossesBarline({ startBeat: 3, duration: 2 }, 0)).toBe(false);
  });
});

describe('plan.modifierDiff', () => {
  it('计算两个组合之间需要释放/按下的鼠标键', () => {
    const all = allCombos();
    const plain = all.find(
      (combo) => combo.keyId === 'k1' && combo.octaveShift === 0 && combo.semitone === 0,
    )!;
    const up = all.find(
      (combo) => combo.keyId === 'k1' && combo.octaveShift === 1 && combo.semitone === 0,
    )!;
    const upSharp = all.find(
      (combo) => combo.keyId === 'k1' && combo.octaveShift === 1 && combo.semitone === 1,
    )!;
    expect(modifierDiff(plain, up)).toEqual({ releases: [], presses: ['right'] });
    expect(modifierDiff(up, upSharp)).toEqual({ releases: [], presses: ['middle'] });
    expect(modifierDiff(upSharp, plain)).toEqual({
      releases: ['right', 'middle'],
      presses: [],
    });
  });
});

describe('plan.planPerformance 基础音阶', () => {
  const scale = makeScale();
  const plan = planPerformance(scale, { transpose: 0 });

  it('1..7 音阶生成 7 个计划音符与 14 个按键事件', () => {
    expect(plan.notes).toHaveLength(7);
    expect(plan.events).toHaveLength(14);
    expect(plan.notes.map((note) => note.midi)).toEqual([60, 62, 64, 65, 67, 69, 71]);
    expect(plan.notes.map((note) => note.keys)).toEqual(['Z', 'X', 'C', 'V', 'B', 'N', 'M']);
    expect(plan.events.every((event) => event.kind === 'keydown' || event.kind === 'keyup')).toBe(true);
  });

  it('节拍与保持时长按 tempo=120 换算（leadIn=90ms，1 拍=500ms）', () => {
    expect(plan.tempo).toBe(120);
    expect(plan.beatMs).toBe(500);
    expect(plan.leadInMs).toBe(90);
    expect(plan.notes.map((note) => note.startMs)).toEqual([90, 590, 1090, 1590, 2090, 2590, 3090]);
    expect(plan.notes.map((note) => note.endMs)).toEqual([578, 1078, 1578, 2078, 2578, 3078, 3578]);
    expect(plan.notes.map((note) => note.holdMs)).toEqual(new Array(7).fill(488));
    expect(plan.durationMs).toBe(3732);
  });

  it('计划物理可行：时间有序、无和弦、结束无残留键', () => {
    expectPlanPhysicallyValid(plan);
  });

  it('每个音符起始时刻的鼠标按键状态与组合 mods 一致', () => {
    for (const note of plan.notes) {
      expect(mouseButtonsAt(plan, note.startMs)).toEqual([...note.combo.mods].sort());
      expect(note.combo.midi).toBe(note.midi);
    }
  });

  it('统计信息与音域符合谱面', () => {
    expect(plan.transpose).toBe(0);
    expect(plan.instrumentId).toBe(DEFAULT_HARMONICA.id);
    expect(plan.warnings).toEqual([]);
    expect(plan.stats).toMatchObject({
      noteCount: 7,
      modifierSwitchCount: 0,
      initialModifierCount: 0,
      finalModifierCount: 0,
      foldedCount: 0,
      outOfRangeCount: 0,
      fastTransitionCount: 0,
      minHoldMsUsed: 488,
      maxHoldMsUsed: 488,
      meanHoldMs: 488,
      transpose: 0,
      rangeMin: 60,
      rangeMax: 71,
    });
  });
});

describe('plan.planPerformance 带修饰键的音符', () => {
  const score = makeScore(
    [
      { degree: 1, octave: 0, startBeat: 0, duration: 1 }, // 60 → Z
      { degree: 4, accidental: 1, startBeat: 2, duration: 1 }, // 66 → #V（中键）
      { degree: 5, startBeat: 4, duration: 1 }, // 67 → B
      { degree: 1, octave: -1, startBeat: 6, duration: 1 }, // 48 → ↓Z（左键）
      { degree: 1, octave: 1, startBeat: 8, duration: 1 }, // 72 → ,（无修饰）
    ],
    { tempo: 120 },
  );
  const plan = planPerformance(score);

  it('为中键/左键等修饰组合生成 mousedown/mouseup 事件', () => {
    expect(plan.notes.map((note) => note.midi)).toEqual([60, 66, 67, 48, 72]);
    expect(plan.notes.map((note) => note.keys)).toEqual(['Z', '#V', 'B', '↓Z', ',']);
    expect(plan.notes[1].combo.mods).toEqual(['middle']);
    expect(plan.notes[3].combo.mods).toEqual(['left']);
    const downButtons = plan.events
      .filter((event) => event.kind === 'mousedown')
      .map((event) => event.button);
    const upButtons = plan.events
      .filter((event) => event.kind === 'mouseup')
      .map((event) => event.button);
    expect(downButtons).toEqual(['middle', 'left']);
    expect(upButtons).toEqual(['middle', 'left']);
    expect(plan.events).toHaveLength(14);
    expect(plan.stats.modifierSwitchCount).toBe(4);
  });

  it('每个音符按下时鼠标状态与组合一致，且计划物理可行', () => {
    for (const note of plan.notes) {
      expect(mouseButtonsAt(plan, note.startMs)).toEqual([...note.combo.mods].sort());
    }
    expectPlanPhysicallyValid(plan);
  });
});

describe('plan.planPerformance 自动移调', () => {
  it('高音旋律 transpose=auto 选到可演奏移调且全部音符在音域内', () => {
    const high = makeScale(2);
    const plan = planPerformance(high, { transpose: 'auto' });
    expect(plan.transpose).toBe(-10);
    expect(plan.stats.transpose).toBe(-10);
    expect(plan.warnings.some((warning) => warning.includes('已移调 -10 个半音'))).toBe(true);
    expect(plan.notes.map((note) => note.targetMidi)).toEqual([74, 76, 78, 79, 81, 83, 85]);
    expect(plan.notes.map((note) => note.midi)).toEqual([74, 76, 78, 79, 81, 83, 85]);
    expect(plan.notes.map((note) => note.keys)).toEqual(['↑X', '↑C', '↑#V', '↑B', '↑N', '↑M', '↑#,']);
    expect(plan.notes.every((note) => note.outOfRange === false && note.folded === false)).toBe(true);
    expect(plan.stats.foldedCount).toBe(0);
    expect(plan.stats.outOfRangeCount).toBe(0);
    const range = instrumentRange();
    for (const note of plan.notes) {
      expect(note.midi).toBeGreaterThanOrEqual(range.min);
      expect(note.midi).toBeLessThanOrEqual(range.max);
    }
    expectPlanPhysicallyValid(plan);
  });

  it('evaluateTranspositions 扫描 -11..+11 半音', () => {
    const evaluations = evaluateTranspositions(makeScale(2));
    expect(evaluations).toHaveLength(23);
    expect(evaluations[0].transpose).toBe(-11);
    expect(evaluations[evaluations.length - 1].transpose).toBe(11);
    const best = evaluations.find((evaluation) => evaluation.transpose === -10);
    expect(best).toMatchObject({ playableCount: 7, foldedCount: 0, outOfRangeCount: 0 });
  });
});

describe('plan.planPerformance 超音域折返', () => {
  it('默认自动折返：高 3 个八度的 1 折回 C#6 并给出 warning', () => {
    const outOfRange = makeScore([{ degree: 1, octave: 3, startBeat: 0, duration: 1 }], { tempo: 120 });
    const plan = planPerformance(outOfRange);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].targetMidi).toBe(96);
    expect(plan.notes[0].midi).toBe(84);
    expect(plan.notes[0].folded).toBe(true);
    expect(plan.notes[0].outOfRange).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('超出可演奏音域'))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('已自动折返'))).toBe(true);
    expect(plan.stats.foldedCount).toBe(1);
    expectPlanPhysicallyValid(plan);
  });

  it('allowOctaveFold=false 时不折返：超音域音符被跳过并给出提示', () => {
    const outOfRange = makeScore([{ degree: 1, octave: 3, startBeat: 0, duration: 1 }], { tempo: 120 });
    const plan = planPerformance(outOfRange, { allowOctaveFold: false });
    expect(plan.notes).toHaveLength(0);
    expect(plan.warnings.some((warning) => warning.includes('八度折返'))).toBe(true);
    expect(plan.stats.droppedCount).toBe(1);
    expectPlanPhysicallyValid(plan);
  });
});

describe('plan.planPerformance tempoOverride', () => {
  it('覆盖谱面速度并据此换算 beatMs 与各音起点', () => {
    const score = makeScore(
      [
        { degree: 1, startBeat: 0, duration: 1 },
        { degree: 2, startBeat: 1, duration: 1 },
      ],
      { tempo: 100 },
    );
    const plan = planPerformance(score, { tempoOverride: 60 });
    expect(plan.tempo).toBe(60);
    expect(plan.beatMs).toBe(1000);
    expect(plan.notes.map((note) => note.startMs)).toEqual([90, 1090]);
    expect(plan.notes.map((note) => note.holdMs)).toEqual([988, 988]);
  });

  it('tempoOverride 被夹取到 20-320 BPM', () => {
    const score = makeScore([{ degree: 1, startBeat: 0, duration: 1 }], { tempo: 100 });
    const slow = planPerformance(score, { tempoOverride: 10 });
    expect(slow.tempo).toBe(20);
    expect(slow.beatMs).toBe(3000);
    const fast = planPerformance(score, { tempoOverride: 999 });
    expect(fast.tempo).toBe(320);
    expect(fast.beatMs).toBeCloseTo(187.5, 6);
  });
});

describe('plan.planPerformance 空乐谱与连音', () => {
  it('空乐谱返回空计划且不崩溃', () => {
    const plan = planPerformance(createEmptyScore());
    expect(plan.events).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.durationMs).toBe(0);
    expect(plan.leadInMs).toBe(90);
    expect(plan.tempo).toBe(100);
    expect(plan.beatMs).toBe(600);
    expect(plan.transpose).toBe(0);
    expect(plan.warnings).toContain('乐谱没有可演奏的音符');
    expect(validatePlan(plan)).toEqual([]);
  });

  it('只有休止符的乐谱同样返回空计划', () => {
    const restsOnly = makeScore([{ degree: 0, startBeat: 0, duration: 2 }], { tempo: 120 });
    const plan = planPerformance(restsOnly);
    expect(plan.notes).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(plan.warnings).toContain('乐谱没有可演奏的音符');
  });

  it('[BUG] 含连音的谱面应按合并后的时值排程（当前实现按两个独立音排程）', () => {
    const { score } = buildScoreFromText('5~ 5');
    expect(score.notes[0].tie).toBe(true);
    const plan = planPerformance(score, { tempoOverride: 120 });
    // 5~ 5 在 120BPM 下应是一个 2 拍长音：保持 988ms、结束于 1078ms
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({ midi: 67, startBeat: 0, durationBeats: 2, holdMs: 988 });
    expect(plan.notes[0].startMs).toBe(90);
    expect(plan.notes[0].endMs).toBe(1078);
    expect(validatePlan(plan)).toEqual([]);
  });
});

describe('plan.validatePlan 负例（自检器本身）', () => {
  it('缺少收尾 keyup 时报告“结束时仍有音键处于按下状态”', () => {
    const plan = clonePlan(planPerformance(makeScore([{ degree: 1, startBeat: 0, duration: 1 }], { tempo: 120 })));
    const last = plan.events[plan.events.length - 1];
    expect(last.kind).toBe('keyup');
    plan.events = plan.events.filter((event) => event !== last);
    expect(validatePlan(plan)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('结束时仍有音键处于按下状态') }),
    );
  });

  it('重复按下同一音键时报告和弦/重复按下', () => {
    const plan = clonePlan(planPerformance(makeScore([{ degree: 1, startBeat: 0, duration: 1 }], { tempo: 120 })));
    const first = plan.events[0];
    expect(first.kind).toBe('keydown');
    plan.events = [first, { ...first, label: 'duplicate down' }, ...plan.events.slice(1)];
    const messages = validatePlan(plan).map((issue) => issue.message);
    expect(messages.some((message) => message.includes('同一音键重复按下'))).toBe(true);
    expect(messages.some((message) => message.includes('出现和弦'))).toBe(true);
  });

  it('缺少修饰键 mousedown 时报告按下瞬间的修饰键状态不对', () => {
    const score = makeScore([{ degree: 4, accidental: 1, startBeat: 0, duration: 1 }], { tempo: 120 }); // 66 需中键
    const plan = clonePlan(planPerformance(score));
    const mousedown = plan.events.find((event) => event.kind === 'mousedown');
    expect(mousedown).toBeDefined();
    plan.events = plan.events.filter((event) => event !== mousedown);
    expect(validatePlan(plan)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('修饰键状态不对') }),
    );
  });
});
