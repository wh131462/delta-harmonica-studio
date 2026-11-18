/**
 * 调性检测（keydetect.ts）与「原始旋律 → 简谱 Score」（melody-to-score.ts）单元测试。
 *
 * 测试完全自包含：用 MIDI 音高 / 秒级音符数组现场构造数据，不读取音频文件或网络。
 */
import { describe, expect, it } from 'vitest';
import { detectKey, detectKeyFromNoteWeights, type PitchWeight } from '../src/core/music/keydetect';
import {
  autoBaseOctave,
  melodyToScore,
  normalizeStartBeats,
  quantizeDuration,
  type RawMelodyNote,
} from '../src/core/import/melody-to-score';
import { EPSILON } from '../src/core/model/score';

/** C 大调音阶 1-7（C4..B4） */
const C_MAJOR_SCALE: PitchWeight[] = [60, 62, 64, 65, 67, 69, 71].map((midi) => ({ midi, weight: 1 }));

/** A 自然小调音阶（A4..G5），主音 A 加权，模拟真实旋律中主音的突出地位 */
const A_MINOR_MELODY: PitchWeight[] = [69, 71, 72, 74, 76, 77, 79].map((midi) => ({
  midi,
  weight: midi === 69 ? 4 : 1,
}));

/** C 自然小调音阶（C4..Bb4），主音 C 加权 */
const C_MINOR_MELODY: PitchWeight[] = [60, 62, 63, 65, 67, 68, 70].map((midi) => ({
  midi,
  weight: midi === 60 ? 4 : 1,
}));

/** 120BPM 下每 0.5 秒一个音（即每拍一个音）的原始旋律 */
const HALF_SECOND_MELODY: RawMelodyNote[] = [60, 62, 64, 65, 67].map((midi, index) => ({
  midi,
  startSec: index * 0.5,
  durSec: 0.5,
  confidence: 0.9,
}));

describe('keydetect.detectKey', () => {
  it('C 大调音阶（1-7）检测为 C 大调：keyRoot=0、mode=major', () => {
    const detection = detectKey(C_MAJOR_SCALE);
    expect(detection.mode).toBe('major');
    expect(detection.tonic).toBe(0);
    expect(detection.keyRoot).toBe(0);
    expect(detection.confidence).toBeGreaterThan(0.3);
    expect(detection.confidence).toBeLessThanOrEqual(1);
    expect(detection.candidates).toHaveLength(6);
    expect(detection.candidates[0]).toMatchObject({ tonic: 0, mode: 'major' });
    // 候选按相关系数降序
    for (let i = 1; i < detection.candidates.length; i += 1) {
      expect(detection.candidates[i].correlation).toBeLessThanOrEqual(
        detection.candidates[i - 1].correlation,
      );
    }
  });

  it('A 小调旋律检测为 minor，keyRoot 取关系大调 C（0）', () => {
    const detection = detectKey(A_MINOR_MELODY);
    expect(detection.mode).toBe('minor');
    expect(detection.tonic).toBe(9); // A
    // 小调时 keyRoot = 关系大调主音；A 小调的关系大调是 C 大调（C=0）。
    // 注：任务描述里写“keyRoot=3”与乐理不符（3 是 C 小调的关系大调 Eb），
    //     已另行用 C 小调用例覆盖 keyRoot=3 的情形。
    expect(detection.keyRoot).toBe(0);
    expect(detection.confidence).toBeGreaterThan(0.5);
    expect(detection.candidates[0]).toMatchObject({ tonic: 9, mode: 'minor' });
  });

  it('C 小调旋律检测为 minor 且 keyRoot=3（关系大调 Eb）', () => {
    const detection = detectKey(C_MINOR_MELODY);
    expect(detection.mode).toBe('minor');
    expect(detection.tonic).toBe(0);
    expect(detection.keyRoot).toBe(3);
    expect(detection.confidence).toBeGreaterThan(0.5);
  });

  it('空输入 / 全非法权重返回零置信度的稳定结果，不抛异常', () => {
    const empty = detectKey([]);
    expect(empty.confidence).toBe(0);
    expect(empty.tonic).toBe(0);
    expect(empty.mode).toBe('major');
    expect(empty.keyRoot).toBe(0);
    expect(empty.candidates).toHaveLength(6);

    const invalid = detectKey([
      { midi: Number.NaN },
      { midi: 60, weight: 0 },
      { midi: 62, weight: -2 },
    ]);
    expect(invalid.confidence).toBe(0);
    expect(invalid.keyRoot).toBe(0);
  });

  it('音高按八度归一化加权（跨八度的同一音级累加权重）', () => {
    // C3 C4 C5 G3 G4 G5 全是 C/G 音级 → 应仍是 C 大调（主音 C）
    const detection = detectKey([
      { midi: 48, weight: 2 },
      { midi: 60, weight: 2 },
      { midi: 72, weight: 2 },
      { midi: 55, weight: 1 },
      { midi: 67, weight: 1 },
      { midi: 79, weight: 1 },
    ]);
    expect(detection.keyRoot).toBe(0);
    expect(detection.mode).toBe('major');
  });

  it('detectKeyFromNoteWeights 与 detectKey 行为一致', () => {
    expect(detectKeyFromNoteWeights(A_MINOR_MELODY)).toEqual(detectKey(A_MINOR_MELODY));
  });
});

describe('melody-to-score.autoBaseOctave / quantizeDuration', () => {
  it('autoBaseOctave 让中位音高落在简谱中音区', () => {
    expect(autoBaseOctave(60, 0)).toBe(4); // C4：1=C4
    expect(autoBaseOctave(72, 0)).toBe(5); // C5：1=C5
    expect(autoBaseOctave(48, 0)).toBe(3); // C3：1=C3
    expect(autoBaseOctave(67, 7)).toBe(4); // G4 在 G 调下是 1
  });

  it('autoBaseOctave 夹取到 1..7 八度', () => {
    expect(autoBaseOctave(12, 0)).toBe(1);
    expect(autoBaseOctave(120, 0)).toBe(7);
  });

  it('quantizeDuration 吸附到量化网格且不短于一个网格', () => {
    expect(quantizeDuration(0.9, 0.25)).toBe(1);
    expect(quantizeDuration(0.1, 0.25)).toBe(0.25);
    expect(quantizeDuration(1.3, 0.25)).toBe(1.25);
    expect(quantizeDuration(0.75, 0)).toBe(0.75); // grid=0 不量化
  });
});

describe('melody-to-score.normalizeStartBeats', () => {
  it('按节拍量化起点并保证单调不重叠', () => {
    const starts = normalizeStartBeats(HALF_SECOND_MELODY, 120, 0.25);
    expect(starts).toHaveLength(5);
    expect(starts[0]).toBeCloseTo(0, 4);
    expect(starts[1]).toBeCloseTo(1, 4);
    expect(starts[2]).toBeCloseTo(2, 4);
    expect(starts[3]).toBeCloseTo(3, 4);
    expect(starts[4]).toBeCloseTo(4, 4);
  });

  it('重叠音符的后音起点被推到前音结束之后', () => {
    const starts = normalizeStartBeats(
      [
        { midi: 60, startSec: 0, durSec: 0.5 },
        { midi: 62, startSec: 0.1, durSec: 0.5 },
      ],
      120,
      0.25,
    );
    expect(starts[1]).toBeGreaterThanOrEqual(1 - 1e-6);
  });
});

describe('melody-to-score.melodyToScore', () => {
  it('120BPM 下每 0.5 秒一个音被转换为每拍一个音', () => {
    const result = melodyToScore(HALF_SECOND_MELODY, { title: '测试旋律', tempo: 120 });
    expect(result.score.meta).toMatchObject({
      title: '测试旋律',
      tempo: 120,
      meter: { num: 4, den: 4 },
      keyRoot: 0,
      baseOctave: 4,
    });
    expect(result.score.notes).toHaveLength(5);
    expect(result.score.notes.map((note) => note.degree)).toEqual([1, 2, 3, 4, 5]);
    expect(result.score.notes.map((note) => note.accidental)).toEqual([0, 0, 0, 0, 0]);
    expect(result.score.notes.map((note) => note.octave)).toEqual([0, 0, 0, 0, 0]);
    expect(result.score.notes.map((note) => note.startBeat)).toEqual([0, 1, 2, 3, 4]);
    expect(result.score.notes.map((note) => note.duration)).toEqual([1, 1, 1, 1, 1]);
    expect(result.score.notes.every((note) => note.tie === false)).toBe(true);
    expect(result.score.source.kind).toBe('midi');
    expect(result.score.source.confidence).toBe(result.key.confidence);
    expect(result.key).toMatchObject({ tonic: 0, mode: 'major', keyRoot: 0, confidence: 1 });
    expect(result.warnings).toEqual([]);
    // rawBeats 保留量化前的秒→拍换算结果
    expect(result.rawBeats.map((beat) => beat.startBeat)).toEqual([0, 1, 2, 3, 4]);
    expect(result.rawBeats.map((beat) => beat.midi)).toEqual([60, 62, 64, 65, 67]);
  });

  it('量化后每个音的起点不早于前一个音的结束（无重叠）', () => {
    const result = melodyToScore(
      [
        { midi: 60, startSec: 0, durSec: 0.5 },
        { midi: 62, startSec: 0.1, durSec: 0.5 },
        { midi: 64, startSec: 0.25, durSec: 0.5 },
        { midi: 65, startSec: 0.6, durSec: 0.2 },
      ],
      { title: '重叠测试', tempo: 120, quantizeGrid: 0.25 },
    );
    let previousEnd = 0;
    for (const note of result.score.notes) {
      expect(note.startBeat).toBeGreaterThanOrEqual(previousEnd - EPSILON);
      expect(note.duration).toBeGreaterThan(0);
      previousEnd = note.startBeat + note.duration;
    }
    expect(result.warnings.some((warning) => warning.includes('被移动了位置'))).toBe(true);
  });

  it('自动选择基础八度：高音旋律 1=C5', () => {
    const result = melodyToScore(
      [72, 74, 76].map((midi, index) => ({ midi, startSec: index * 0.5, durSec: 0.5 })),
      { title: '高音旋律', tempo: 120, keyRoot: 0 },
    );
    expect(result.score.meta.baseOctave).toBe(5);
    expect(result.score.notes.map((note) => note.degree)).toEqual([1, 2, 3]);
    expect(result.score.notes.map((note) => note.octave)).toEqual([0, 0, 0]);
  });

  it('指定 keyRoot 时跳过调性检测并按其记谱', () => {
    const result = melodyToScore(
      [60, 62, 64].map((midi, index) => ({ midi, startSec: index * 0.5, durSec: 0.5 })),
      { title: 'G 调', tempo: 120, keyRoot: 7 },
    );
    expect(result.score.meta.keyRoot).toBe(7);
    expect(result.key).toMatchObject({ tonic: 7, mode: 'major', keyRoot: 7, confidence: 1 });
    expect(result.key.candidates).toEqual([]);
    // G 调下 C4/D4/E4 写作 4/5/6 级
    expect(result.score.meta.baseOctave).toBe(3);
    expect(result.score.notes.map((note) => note.degree)).toEqual([4, 5, 6]);
    expect(result.score.notes.map((note) => note.octave)).toEqual([0, 0, 0]);
  });

  it('没有可用音符时抛出可读错误', () => {
    expect(() => melodyToScore([], { title: '空', tempo: 120 })).toThrow(/没有可用的旋律音符/);
    expect(() =>
      melodyToScore(
        [
          { midi: 5, startSec: 0, durSec: 0.5 }, // 音高过低
          { midi: 60, startSec: 1, durSec: 0.01 }, // 时值过短
        ],
        { title: '非法', tempo: 120 },
      ),
    ).toThrow(/没有可用的旋律音符/);
  });

  it('minConfidence 过滤低置信度音符', () => {
    const result = melodyToScore(
      [
        { midi: 60, startSec: 0, durSec: 0.5, confidence: 0.9 },
        { midi: 62, startSec: 0.5, durSec: 0.5, confidence: 0.1 },
        { midi: 64, startSec: 1, durSec: 0.5, confidence: 0.8 },
      ],
      { title: '置信度', tempo: 120, minConfidence: 0.5 },
    );
    expect(result.score.notes).toHaveLength(2);
  });

  it('超过 maxNotes 时截断并给出 warning', () => {
    const rawNotes: RawMelodyNote[] = Array.from({ length: 10 }, (_, index) => ({
      midi: 60 + (index % 5),
      startSec: index * 0.5,
      durSec: 0.5,
    }));
    const result = melodyToScore(rawNotes, { title: '截断', tempo: 120, maxNotes: 5 });
    expect(result.score.notes).toHaveLength(5);
    expect(result.warnings.some((warning) => warning.includes('已截断到前 5 个'))).toBe(true);
  });

  it('title 为空时回退默认标题', () => {
    const result = melodyToScore(HALF_SECOND_MELODY, { title: '', tempo: 120 });
    expect(result.score.meta.title).toBe('导入的旋律');
  });
});
