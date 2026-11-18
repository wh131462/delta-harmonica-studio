/**
 * 实时录入转换：时间戳 → 简谱顺序序列。
 *
 * 覆盖：BPM 换算、量化、空档补休止、重叠整理、简谱音高映射、八度越界提示、
 * 多次录入的 id 前缀、总拍数统计。
 */
import { describe, expect, it } from 'vitest';
import {
  recordedNotesToSteps,
  recordedNotesTotalBeats,
  type TimedRecordedNote,
} from '../src/core/score/record';

const C_MAJOR = { keyRoot: 0, baseOctave: 4 };

function note(midi: number, startMs: number, endMs: number): TimedRecordedNote {
  return { midi, startMs, endMs };
}

describe('recordedNotesToSteps', () => {
  it('按 100 BPM 把两个 600ms 的音写成两个 1 拍音符', () => {
    const result = recordedNotesToSteps([note(60, 0, 600), note(62, 600, 1200)], {
      meta: C_MAJOR,
      tempo: 100,
    });
    expect(result.steps.map((step) => step.degree)).toEqual([1, 2]);
    expect(result.steps.map((step) => step.duration)).toEqual([1, 1]);
    expect(result.shiftedCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('音与音之间的空档补成休止符', () => {
    const result = recordedNotesToSteps([note(60, 0, 300), note(64, 900, 1500)], {
      meta: C_MAJOR,
      tempo: 100,
    });
    expect(result.steps.map((step) => step.degree)).toEqual([1, 0, 3]);
    expect(result.steps.map((step) => step.duration)).toEqual([0.5, 1, 1]);
  });

  it('量化到 1/4 拍网格', () => {
    const result = recordedNotesToSteps([note(60, 0, 530)], {
      meta: C_MAJOR,
      tempo: 100,
      grid: 0.25,
    });
    expect(result.steps).toHaveLength(1);
    // 530ms @100BPM = 0.883 拍 → 1 拍
    expect(result.steps[0]?.duration).toBe(1);
  });

  it('录音不从 0 开始时补前导休止', () => {
    const result = recordedNotesToSteps([note(60, 320, 850)], {
      meta: C_MAJOR,
      tempo: 100,
      grid: 0.25,
    });
    expect(result.steps.map((step) => step.degree)).toEqual([0, 1]);
    expect(result.steps.map((step) => step.duration)).toEqual([0.5, 1]);
  });

  it('网格越小时值更贴近原始演奏', () => {
    const result = recordedNotesToSteps([note(60, 0, 260)], {
      meta: C_MAJOR,
      tempo: 100,
      grid: 0.125,
    });
    // 260ms @100BPM = 0.433 拍 → 0.375 拍
    expect(result.steps[0]?.duration).toBe(0.375);
  });

  it('按当前曲谱的 1=? 与基础八度写音高（G 调下 C4 记为 4）', () => {
    const result = recordedNotesToSteps([note(60, 0, 600)], {
      meta: { keyRoot: 7, baseOctave: 2 },
      tempo: 100,
    });
    expect(result.steps[0]?.degree).toBe(4);
    expect(result.steps[0]?.accidental).toBe(0);
    expect(result.steps[0]?.octave).toBe(1);
  });

  it('半音写成升号', () => {
    const result = recordedNotesToSteps([note(61, 0, 600)], {
      meta: C_MAJOR,
      tempo: 100,
    });
    expect(result.steps[0]?.degree).toBe(1);
    expect(result.steps[0]?.accidental).toBe(1);
  });

  it('重叠的录音会被顺序整理，并报告调整数量', () => {
    const result = recordedNotesToSteps([note(60, 0, 900), note(64, 300, 600)], {
      meta: C_MAJOR,
      tempo: 100,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.shiftedCount).toBeGreaterThan(0);
    // 前一个音不能盖住后一个音的起点：900ms 被截短到 300ms 附近
    expect(result.steps[0]?.duration).toBe(0.5);
    expect(result.steps[1]?.duration).toBe(0.5);
  });

  it('超出简谱 ±4 八度的音会计数并夹取', () => {
    const result = recordedNotesToSteps([note(120, 0, 600)], {
      meta: C_MAJOR,
      tempo: 100,
    });
    expect(result.outOfRangeCount).toBe(1);
    expect(result.steps[0]?.octave).toBe(4);
    expect(result.warnings.some((warning) => warning.includes('八度'))).toBe(true);
  });

  it('多次录入使用不同 id 前缀，不会撞 id', () => {
    const first = recordedNotesToSteps([note(60, 0, 600)], {
      meta: C_MAJOR,
      tempo: 100,
      idPrefix: 'take-a',
    });
    const second = recordedNotesToSteps([note(62, 0, 600)], {
      meta: C_MAJOR,
      tempo: 100,
      idPrefix: 'take-b',
    });
    expect(first.steps[0]?.id).toBe('take-a-0');
    expect(second.steps[0]?.id).toBe('take-b-0');
  });

  it('空录音返回空序列，不抛异常', () => {
    const result = recordedNotesToSteps([], { meta: C_MAJOR, tempo: 100 });
    expect(result.steps).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('支持小数 BPM', () => {
    const result = recordedNotesToSteps([note(60, 0, 60000 / 127.9)], {
      meta: C_MAJOR,
      tempo: 127.9,
    });
    expect(result.steps[0]?.duration).toBe(1);
  });
});

describe('recordedNotesTotalBeats', () => {
  it('取最后一个音的结束时间换算成拍', () => {
    expect(recordedNotesTotalBeats([{ startMs: 0, endMs: 1200 }], 100)).toBe(2);
    expect(recordedNotesTotalBeats([], 100)).toBe(0);
  });
});
