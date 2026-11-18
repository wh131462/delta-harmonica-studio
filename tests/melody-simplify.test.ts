/**
 * 音频谱面“密度精简”测试：
 * - 同音碎片合并；
 * - 每拍音符上限（宽松 1 / 标准 2 / 精细 4）；
 * - 孤立八度误判修正；
 * - 时值落在网格上、互不重叠；
 * - melodyToScore 接入 density 后的警告与统计。
 */
import { describe, expect, it } from 'vitest';

import { melodyToScore } from '@core/import/melody-to-score';
import { simplifyMelodyNotes, type SimplifyInputNote } from '@core/music/melody-simplify';

const TEMPO = 120; // 0.5s/beat

function note(midi: number, startSec: number, durSec: number, confidence = 0.8): SimplifyInputNote {
  return { midi, startSec, durSec, confidence };
}

describe('simplifyMelodyNotes：密度与网格', () => {
  it('宽松：每拍最多 1 个音，16 分音符经过音被省略', () => {
    const notes = [
      note(60, 0, 0.04),
      note(62, 0.05, 0.04),
      note(64, 0.1, 0.04),
      note(65, 0.15, 0.04),
    ];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.25, density: 'loose' });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].midi).toBe(60);
    expect(result.notes[0].startBeat).toBe(0);
    expect(result.stats.droppedNotes).toBeGreaterThanOrEqual(3);
    expect(result.stats.stepBeats).toBe(1);
  });

  it('标准：每拍最多 2 个音，1/8 网格', () => {
    const notes = [
      note(60, 0, 0.04),
      note(62, 0.05, 0.04),
      note(64, 0.1, 0.04),
      note(65, 0.15, 0.04),
    ];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.25, density: 'normal' });
    expect(result.notes.length).toBeLessThanOrEqual(2);
    expect(result.stats.stepBeats).toBe(0.25);
    for (const item of result.notes) {
      expect(item.startBeat % 0.25).toBeCloseTo(0, 6);
      expect(item.duration).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('精细：保留 1/16 网格上的多个音', () => {
    const notes = [
      note(60, 0, 0.09),
      note(62, 0.125, 0.09),
      note(64, 0.25, 0.09),
      note(65, 0.375, 0.09),
    ];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.25, density: 'fine' });
    expect(result.notes.length).toBe(4);
    expect(result.stats.stepBeats).toBe(0.25);
  });
});

describe('simplifyMelodyNotes：同音碎片与八度修正', () => {
  it('首尾相接的同音碎片合并成一个长音', () => {
    const notes = [note(64, 0, 0.2), note(64, 0.21, 0.19), note(64, 0.4, 0.2)];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.25, density: 'normal' });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].midi).toBe(64);
    expect(result.notes[0].duration).toBeGreaterThanOrEqual(1);
    expect(result.stats.mergedFragments).toBe(2);
  });

  it('孤立的高八度误判会被折回（C4 C5 C4 → C4 C4 C4）', () => {
    const notes = [note(60, 0, 0.4), note(72, 0.5, 0.4), note(62, 1.0, 0.4)];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.25, density: 'normal' });
    expect(result.stats.octaveFixes).toBeGreaterThanOrEqual(1);
    expect(result.notes.map((item) => item.midi)).toEqual([60, 60, 62]);
  });

  it('超过一个八度但前后音不接近时不做八度折叠', () => {
    const notes = [note(48, 0, 0.4), note(72, 0.5, 0.4), note(79, 1.0, 0.4)];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.25, density: 'normal' });
    expect(result.notes.map((item) => item.midi)).toEqual([48, 72, 79]);
    expect(result.stats.octaveFixes).toBe(0);
  });
});

describe('simplifyMelodyNotes：时值与单声部', () => {
  it('时值落在网格上、相邻音不重叠，并保留乐句间隙', () => {
    const notes = [
      note(60, 0, 0.3),
      note(62, 0.5, 0.3),
      note(64, 1.0, 0.3),
      // 停顿两拍后进入下一乐句
      note(67, 2.5, 0.6),
    ];
    const result = simplifyMelodyNotes(notes, { tempo: TEMPO, grid: 0.5, density: 'normal' });
    expect(result.notes.length).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < result.notes.length; index += 1) {
      const item = result.notes[index];
      expect(item.duration % 0.5).toBeCloseTo(0, 6);
      expect(item.duration).toBeGreaterThanOrEqual(0.5);
      const next = result.notes[index + 1];
      if (next) expect(item.startBeat + item.duration).toBeLessThanOrEqual(next.startBeat + 1e-6);
    }
    const last = result.notes[result.notes.length - 1];
    expect(last.startBeat).toBe(5);
  });

  it('空输入返回空结果', () => {
    const result = simplifyMelodyNotes([], { tempo: TEMPO, grid: 0.25, density: 'normal' });
    expect(result.notes).toHaveLength(0);
    expect(result.stats.outputNotes).toBe(0);
    expect(result.stats.notesPerBeat).toBe(0);
  });
});

describe('melodyToScore：audio density 接入', () => {
  const rawNotes = [
    { midi: 60, startSec: 0, durSec: 0.45, confidence: 0.9 },
    { midi: 62, startSec: 0.5, durSec: 0.45, confidence: 0.9 },
    { midi: 64, startSec: 1.0, durSec: 0.45, confidence: 0.9 },
    { midi: 65, startSec: 1.5, durSec: 0.45, confidence: 0.9 },
  ];

  it('启用 density 后输出精简后的谱面与统计', () => {
    const result = melodyToScore(rawNotes, {
      title: 'density-test',
      tempo: TEMPO,
      quantizeGrid: 0.25,
      density: 'normal',
      sourceKind: 'audio',
    });
    expect(result.simplifyStats).toBeDefined();
    expect(result.simplifyStats?.outputNotes).toBe(result.score.notes.length);
    expect(result.warnings.some((warning) => warning.includes('密度精简'))).toBe(true);
    for (const item of result.score.notes) {
      expect(item.duration).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('不传 density 时保持原 MIDI 逐音量化行为', () => {
    const result = melodyToScore(rawNotes, {
      title: 'midi-test',
      tempo: TEMPO,
      quantizeGrid: 0.25,
      sourceKind: 'midi',
    });
    expect(result.simplifyStats).toBeUndefined();
    expect(result.score.notes).toHaveLength(rawNotes.length);
  });
});
