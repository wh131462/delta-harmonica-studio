/**
 * 练习判定引擎：把「按下的音高 + 时间」转换成判定结果、连击与准确率。
 *
 * 设计取舍：
 * - 按音高判定，不要求完全相同的物理按法——同音高的不同组合（如 ↑C 与 ,）都算对，
 *   因为游戏里听感相同，练习的目标是「吹对音、踩准拍」；
 * - 每个目标音最多被命中一次，最近的同音高目标优先；
 * - 错音不消耗目标音，只打断连击并计入判定总数，避免「按错一次就跳过一个音」。
 *
 * 纯函数 + 不可变状态：可以在 React 中直接用 useState 承载，也便于单测。
 */
import type { PracticeSession } from './session';

export type PracticeGrade = 'perfect' | 'great' | 'good' | 'miss' | 'wrong';

export interface PracticeWindows {
  perfectMs: number;
  greatMs: number;
  goodMs: number;
}

export const DEFAULT_PRACTICE_WINDOWS: PracticeWindows = {
  perfectMs: 55,
  greatMs: 100,
  goodMs: 150,
};

/** 判定对准确率的贡献权重 */
export const PRACTICE_GRADE_SCORE: Record<PracticeGrade, number> = {
  perfect: 1,
  great: 0.8,
  good: 0.5,
  miss: 0,
  wrong: 0,
};

export const PRACTICE_GRADE_LABEL: Record<PracticeGrade, string> = {
  perfect: '完美',
  great: '优秀',
  good: '良好',
  miss: '失误',
  wrong: '错音',
};

export interface JudgeEvent {
  grade: PracticeGrade;
  /** 被判定 / 漏掉的目标音下标；错音为 null */
  noteIndex: number | null;
  /** 按下时刻 - 目标时刻（毫秒，负数 = 早） */
  deltaMs: number;
  /** 判定发生的练习时间（毫秒） */
  atMs: number;
}

export interface JudgeState {
  total: number;
  grades: ReadonlyArray<PracticeGrade | null>;
  deltas: ReadonlyArray<number | null>;
  counts: Record<PracticeGrade, number>;
  /** 已判定（命中 + 漏掉）的目标音数 */
  judged: number;
  hits: number;
  wrong: number;
  combo: number;
  maxCombo: number;
  /** 命中权重之和（perfect 1 / great 0.8 / good 0.5） */
  weighted: number;
  /** 命中偏差之和（毫秒），用于平均偏差 */
  deltaSum: number;
  last: JudgeEvent | null;
}

export interface JudgePress {
  midi: number;
  /** 练习时间轴上的按下时刻（毫秒） */
  atMs: number;
}

export interface JudgePressResult {
  state: JudgeState;
  grade: PracticeGrade;
  noteIndex: number | null;
  deltaMs: number;
}

export interface PracticeSummary {
  totalNotes: number;
  judged: number;
  hits: number;
  wrong: number;
  counts: Record<PracticeGrade, number>;
  /** 0–100；还没有任何判定时为 null */
  accuracy: number | null;
  combo: number;
  maxCombo: number;
  meanDeltaMs: number | null;
  /** 所有目标音都已有结果 */
  complete: boolean;
}

function emptyCounts(): Record<PracticeGrade, number> {
  return { perfect: 0, great: 0, good: 0, miss: 0, wrong: 0 };
}

export function createJudgeState(session: PracticeSession): JudgeState {
  const total = session.steps.length;
  return {
    total,
    grades: new Array<PracticeGrade | null>(total).fill(null),
    deltas: new Array<number | null>(total).fill(null),
    counts: emptyCounts(),
    judged: 0,
    hits: 0,
    wrong: 0,
    combo: 0,
    maxCombo: 0,
    weighted: 0,
    deltaSum: 0,
    last: null,
  };
}

export function gradeForDelta(deltaMs: number, windows: PracticeWindows = DEFAULT_PRACTICE_WINDOWS): PracticeGrade {
  const abs = Math.abs(deltaMs);
  if (abs <= windows.perfectMs) return 'perfect';
  if (abs <= windows.greatMs) return 'great';
  if (abs <= windows.goodMs) return 'good';
  return 'miss';
}

/** 最近的、尚未判定的目标音；同距离时取更早的音 */
function findTarget(
  state: JudgeState,
  session: PracticeSession,
  press: JudgePress,
  windows: PracticeWindows,
): { index: number; deltaMs: number } | null {
  let bestIndex = -1;
  let bestAbs = Number.POSITIVE_INFINITY;
  let bestDelta = 0;
  const midi = Math.round(press.midi);
  for (let index = 0; index < session.steps.length; index += 1) {
    if (state.grades[index] !== null) continue;
    const step = session.steps[index];
    if (step.midi !== midi) continue;
    const delta = press.atMs - step.timeMs;
    const abs = Math.abs(delta);
    if (abs > windows.goodMs) continue;
    if (abs < bestAbs || (abs === bestAbs && bestIndex >= 0 && step.timeMs < session.steps[bestIndex].timeMs)) {
      bestIndex = index;
      bestAbs = abs;
      bestDelta = delta;
    }
  }
  return bestIndex >= 0 ? { index: bestIndex, deltaMs: bestDelta } : null;
}

function registerWrong(state: JudgeState, atMs: number): JudgeState {
  return {
    ...state,
    counts: { ...state.counts, wrong: state.counts.wrong + 1 },
    wrong: state.wrong + 1,
    combo: 0,
    last: { grade: 'wrong', noteIndex: null, deltaMs: 0, atMs },
  };
}

/** 一次按键：命中最近的同音高目标，或记为错音。 */
export function judgePress(
  state: JudgeState,
  session: PracticeSession,
  press: JudgePress,
  windows: PracticeWindows = DEFAULT_PRACTICE_WINDOWS,
): JudgePressResult {
  if (state.total !== session.steps.length) {
    throw new Error('判定状态与练习会话不匹配：请重置练习后再试');
  }
  const target = findTarget(state, session, press, windows);
  if (!target) {
    return { state: registerWrong(state, press.atMs), grade: 'wrong', noteIndex: null, deltaMs: 0 };
  }

  const grade = gradeForDelta(target.deltaMs, windows);
  const grades = state.grades.slice();
  const deltas = state.deltas.slice();
  grades[target.index] = grade;
  deltas[target.index] = target.deltaMs;
  const combo = state.combo + 1;
  return {
    state: {
      ...state,
      grades,
      deltas,
      counts: { ...state.counts, [grade]: state.counts[grade] + 1 },
      judged: state.judged + 1,
      hits: state.hits + 1,
      combo,
      maxCombo: Math.max(state.maxCombo, combo),
      weighted: state.weighted + PRACTICE_GRADE_SCORE[grade],
      deltaSum: state.deltaSum + target.deltaMs,
      last: { grade, noteIndex: target.index, deltaMs: target.deltaMs, atMs: press.atMs },
    },
    grade,
    noteIndex: target.index,
    deltaMs: target.deltaMs,
  };
}

/**
 * 推进时间：把已经超过判定窗口仍未按下的目标音记为失误。
 * 目标音按时间升序，遇到第一个还没过窗的音就可以停止扫描。
 * 没有任何新失误时返回原对象（React 可据此跳过重渲染）。
 */
export function advanceJudge(
  state: JudgeState,
  session: PracticeSession,
  nowMs: number,
  windows: PracticeWindows = DEFAULT_PRACTICE_WINDOWS,
): JudgeState {
  let missed = 0;
  let lastIndex = -1;
  const grades = state.grades.slice();
  const deltas = state.deltas.slice();
  for (let index = 0; index < session.steps.length; index += 1) {
    if (grades[index] !== null) continue;
    const step = session.steps[index];
    if (step.timeMs + windows.goodMs >= nowMs) break;
    grades[index] = 'miss';
    deltas[index] = nowMs - step.timeMs;
    missed += 1;
    lastIndex = index;
  }
  if (missed === 0) return state;
  const lastStep = session.steps[lastIndex];
  return {
    ...state,
    grades,
    deltas,
    counts: { ...state.counts, miss: state.counts.miss + missed },
    judged: state.judged + missed,
    combo: 0,
    last: {
      grade: 'miss',
      noteIndex: lastIndex,
      deltaMs: Math.max(0, nowMs - lastStep.timeMs),
      atMs: nowMs,
    },
  };
}

/** 下一个还没判定的目标音；全部判定完返回 -1。 */
export function nextPendingIndex(state: JudgeState): number {
  for (let index = 0; index < state.grades.length; index += 1) {
    if (state.grades[index] === null) return index;
  }
  return -1;
}

export function summarizePractice(state: JudgeState): PracticeSummary {
  const denominator = state.judged + state.wrong;
  return {
    totalNotes: state.total,
    judged: state.judged,
    hits: state.hits,
    wrong: state.wrong,
    counts: { ...state.counts },
    accuracy: denominator > 0 ? (state.weighted / denominator) * 100 : null,
    combo: state.combo,
    maxCombo: state.maxCombo,
    meanDeltaMs: state.hits > 0 ? state.deltaSum / state.hits : null,
    complete: state.total > 0 && state.judged >= state.total,
  };
}
