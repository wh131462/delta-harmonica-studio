/**
 * MIDI 导入模块单测：现场用 @tonejs/midi 构造多轨 MIDI，再走一遍
 * MIDI → 选轨 → 单音化 → 量化 → 简谱 Score 的完整流程。
 */
import { describe, expect, it } from 'vitest';
import { Midi, type Track } from '@tonejs/midi';
import { importMidiFile, summarizeMidiTracks } from '../src/core/import/midi';
import { noteToMidi } from '../src/core/model/pitch';
import { validateScore, type Score, type ScoreNote } from '../src/core/model/score';

// ---------------- 测试工具 ----------------

/** 在指定拍位添加一个音符（用 ticks 表达，避免受速度换算的浮点误差影响） */
function addNoteAtBeat(track: Track, midi: number, startBeat: number, durationBeats: number, ppq: number): void {
  track.addNote({
    midi,
    ticks: Math.round(startBeat * ppq),
    durationTicks: Math.max(1, Math.round(durationBeats * ppq)),
  });
}

/** 新建 MIDI（可选设置速度），返回 ppq 方便计算 tick */
function createMidi(bpm?: number): { midi: Midi; ppq: number } {
  const midi = new Midi();
  if (bpm !== undefined) midi.header.setTempo(bpm);
  return { midi, ppq: midi.header.ppq };
}

/** 取出 Score 中每个音符的绝对 MIDI 音高 */
function scorePitches(score: Score): number[] {
  const pitches: number[] = [];
  for (const note of score.notes) {
    const midi = noteToMidi(note, score.meta);
    if (midi !== null) pitches.push(midi);
  }
  return pitches;
}

/** 断言乐谱为单声部：任意后一个音的起点不早于前一个音的结束 */
function expectMonophonic(notes: readonly ScoreNote[]): void {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] as ScoreNote;
    const current = sorted[i] as ScoreNote;
    expect(current.startBeat).toBeGreaterThanOrEqual(prev.startBeat + prev.duration - 1e-6);
  }
}

/** Uint8Array → 独立 ArrayBuffer（用于验证两种入参类型都支持） */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------- 固定测试数据 ----------------

/** 高音旋律轨：C 大调音阶上下行，16 个音，平均音高 78.25 */
const MELODY_PITCHES = [72, 74, 76, 77, 79, 81, 83, 84, 84, 83, 81, 79, 77, 76, 74, 72];
/** 低音轨：8 个音，平均音高 54.25 */
const BASS_PITCHES = [48, 50, 52, 53, 55, 57, 59, 60];
/** 鼓轨（channel 9） */
const DRUM_PITCHES = [36, 38, 42, 42, 36, 38, 42, 42];

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 构造「旋律轨 + 低音轨 + 鼓轨」的多轨 MIDI */
function buildMultiTrackMidi(bpm = 120): Uint8Array {
  const { midi, ppq } = createMidi(bpm);
  const melody = midi.addTrack();
  melody.name = 'Melody';
  melody.channel = 0;
  MELODY_PITCHES.forEach((pitch, index) => addNoteAtBeat(melody, pitch, index * 0.5, 0.45, ppq));

  const bass = midi.addTrack();
  bass.name = 'Bass';
  bass.channel = 1;
  BASS_PITCHES.forEach((pitch, index) => addNoteAtBeat(bass, pitch, index * 0.5, 0.45, ppq));

  const drums = midi.addTrack();
  drums.name = 'Drums';
  drums.channel = 9;
  DRUM_PITCHES.forEach((pitch, index) => addNoteAtBeat(drums, pitch, index * 0.5, 0.1, ppq));

  return midi.toArray();
}

/** 旋律轨（单音）+ 和弦轨（双音同时发声，平均音高更高）：验证选轨优先单音比例 */
function buildMelodyVsChordsMidi(): Uint8Array {
  const { midi, ppq } = createMidi(120);
  const melody = midi.addTrack();
  melody.name = 'Melody';
  melody.channel = 0;
  MELODY_PITCHES.forEach((pitch, index) => addNoteAtBeat(melody, pitch, index * 0.5, 0.45, ppq));

  const chords = midi.addTrack();
  chords.name = 'Piano Chords';
  chords.channel = 1;
  for (let bar = 0; bar < 8; bar += 1) {
    addNoteAtBeat(chords, 84, bar, 1, ppq);
    addNoteAtBeat(chords, 88, bar, 1, ppq);
  }
  return midi.toArray();
}

/** 重叠音：72 先响，76 在 0.5 拍进入（更高），74 在 1 拍进入但与 76 重叠（更低） */
function buildOverlapMidi(): Uint8Array {
  const { midi, ppq } = createMidi(120);
  const track = midi.addTrack();
  track.name = 'Overlap';
  track.channel = 0;
  addNoteAtBeat(track, 72, 0, 1, ppq);
  addNoteAtBeat(track, 76, 0.5, 1, ppq);
  addNoteAtBeat(track, 74, 1, 1, ppq);
  return midi.toArray();
}

/** 完全同音高的重叠：72 在 0 拍与 0.5 拍各起一次，应合并为一个长音 */
function buildRepeatedPitchMidi(): Uint8Array {
  const { midi, ppq } = createMidi(120);
  const track = midi.addTrack();
  track.name = 'Repeated';
  track.channel = 0;
  addNoteAtBeat(track, 72, 0, 1, ppq);
  addNoteAtBeat(track, 72, 0.5, 1, ppq);
  return midi.toArray();
}

/** 同一起点同时发声的两个音：只应保留较高的那个 */
function buildChordMidi(): Uint8Array {
  const { midi, ppq } = createMidi(120);
  const track = midi.addTrack();
  track.name = 'Chord';
  track.channel = 0;
  addNoteAtBeat(track, 60, 0, 1, ppq);
  addNoteAtBeat(track, 64, 0, 1, ppq);
  addNoteAtBeat(track, 62, 1, 1, ppq);
  return midi.toArray();
}

/** 没有速度事件的 MIDI（应回落到 120 BPM） */
function buildNoTempoMidi(): Uint8Array {
  const { midi, ppq } = createMidi();
  const track = midi.addTrack();
  track.name = 'NoTempo';
  track.channel = 0;
  MELODY_PITCHES.forEach((pitch, index) => addNoteAtBeat(track, pitch, index * 0.5, 0.45, ppq));
  return midi.toArray();
}

/** 包含两个速度事件（100 → 120）的 MIDI */
function buildMultiTempoMidi(): Uint8Array {
  const { midi, ppq } = createMidi(100);
  midi.header.tempos.push({ ticks: 2 * ppq, bpm: 120 });
  midi.header.update();
  const track = midi.addTrack();
  track.name = 'MultiTempo';
  track.channel = 0;
  MELODY_PITCHES.forEach((pitch, index) => addNoteAtBeat(track, pitch, index * 0.5, 0.45, ppq));
  return midi.toArray();
}

/** 第一个音不在量化网格上：0.1 拍应被量化到 0 */
function buildOffGridMidi(): Uint8Array {
  const { midi, ppq } = createMidi(120);
  const track = midi.addTrack();
  track.name = 'OffGrid';
  track.channel = 0;
  addNoteAtBeat(track, 72, 0.1, 0.4, ppq);
  addNoteAtBeat(track, 74, 1, 0.4, ppq);
  return midi.toArray();
}

/** 含一条空轨（无音符）的 MIDI：指定该轨导入应报错 */
function buildWithEmptyTrackMidi(): Uint8Array {
  const { midi, ppq } = createMidi(120);
  const empty = midi.addTrack();
  empty.name = 'Empty';
  const melody = midi.addTrack();
  melody.name = 'Melody';
  melody.channel = 0;
  MELODY_PITCHES.forEach((pitch, index) => addNoteAtBeat(melody, pitch, index * 0.5, 0.45, ppq));
  return midi.toArray();
}

// ---------------- 测试 ----------------

describe('summarizeMidiTracks 逐轨统计', () => {
  it('统计旋律 / 低音 / 鼓轨的音域、平均音高、单音比例与鼓轨标记', () => {
    const bytes = buildMultiTrackMidi(120);
    const tracks = summarizeMidiTracks(bytes);

    expect(tracks).toHaveLength(3);
    const [melody, bass, drums] = tracks as [typeof tracks[0], typeof tracks[0], typeof tracks[0]];

    expect(melody.index).toBe(0);
    expect(melody.name).toBe('Melody');
    expect(melody.noteCount).toBe(16);
    expect(melody.pitchMin).toBe(72);
    expect(melody.pitchMax).toBe(84);
    expect(melody.averagePitch).toBeCloseTo(78.25, 5);
    expect(melody.monophonicRatio).toBe(1);
    expect(melody.isDrum).toBe(false);
    expect(melody.durationSec).toBeCloseTo(3.975, 3);

    expect(bass.noteCount).toBe(8);
    expect(bass.pitchMin).toBe(48);
    expect(bass.pitchMax).toBe(60);
    expect(bass.averagePitch).toBeCloseTo(54.25, 5);
    expect(bass.isDrum).toBe(false);

    expect(drums.noteCount).toBe(8);
    expect(drums.isDrum).toBe(true);
  });

  it('复音轨道的单音比例小于 1', () => {
    const tracks = summarizeMidiTracks(buildMelodyVsChordsMidi());
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.monophonicRatio).toBe(1);
    expect(tracks[1]?.name).toBe('Piano Chords');
    expect(tracks[1]?.monophonicRatio).toBeLessThan(0.5);
  });
});

describe('importMidiFile 选轨与乐谱生成', () => {
  it('默认排除鼓轨并自动选中高音旋律轨', () => {
    const result = importMidiFile(buildMultiTrackMidi(120), { fileName: 'demo.mid' });

    expect(result.tracks).toHaveLength(3);
    expect(result.selectedTrack).toBe(0);
    expect(result.tempo).toBe(120);
    expect(result.score.meta.tempo).toBe(120);

    // 标题来自文件名去扩展名，来源标记为 MIDI
    expect(result.score.meta.title).toBe('demo');
    expect(result.score.source.kind).toBe('midi');
    expect(result.score.source.fileName).toBe('demo.mid');

    // 音高集合应等于旋律轨（不含低音 / 鼓），顺序也与原 MIDI 一致
    expect(scorePitches(result.score)).toEqual(MELODY_PITCHES);
    expect(uniqueSorted(scorePitches(result.score))).toEqual(uniqueSorted(MELODY_PITCHES));
    expect(result.score.notes).toHaveLength(MELODY_PITCHES.length);
    expectMonophonic(result.score.notes);
    expect(validateScore(result.score).filter((issue) => issue.severity === 'error')).toEqual([]);

    // warnings 汇总：选轨 + 鼓轨
    expect(result.warnings.some((warning) => warning.includes('自动选择'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('鼓轨'))).toBe(true);
    expect(result.key.keyRoot).toBeGreaterThanOrEqual(0);
    expect(result.key.keyRoot).toBeLessThanOrEqual(11);
  });

  it('支持 ArrayBuffer 入参且结果与 Uint8Array 一致', () => {
    const bytes = buildMultiTrackMidi(120);
    const fromBytes = importMidiFile(bytes, { fileName: 'demo.mid' });
    const fromBuffer = importMidiFile(toArrayBuffer(bytes), { fileName: 'demo.mid' });
    expect(fromBuffer.selectedTrack).toBe(fromBytes.selectedTrack);
    expect(scorePitches(fromBuffer.score)).toEqual(scorePitches(fromBytes.score));
    expect(fromBuffer.score.meta.tempo).toBe(fromBytes.score.meta.tempo);
  });

  it('指定 trackIndex 可选中低音轨，并透传 keyRoot', () => {
    const result = importMidiFile(buildMultiTrackMidi(120), { trackIndex: 1, keyRoot: 2, fileName: 'bass.mid' });
    expect(result.selectedTrack).toBe(1);
    expect(result.score.meta.keyRoot).toBe(2);
    expect(result.key.keyRoot).toBe(2);
    expect(scorePitches(result.score)).toEqual(uniqueSorted(BASS_PITCHES));
    expect(result.warnings.some((warning) => warning.includes('指定轨道'))).toBe(true);
  });

  it('默认选轨优先单音比例，而不是平均音高', () => {
    const result = importMidiFile(buildMelodyVsChordsMidi());
    expect(result.selectedTrack).toBe(0);
    expect(uniqueSorted(scorePitches(result.score))).toEqual(uniqueSorted(MELODY_PITCHES));
  });

  it('指定不存在的轨道序号会抛出可读错误', () => {
    const bytes = buildMultiTrackMidi(120);
    expect(() => importMidiFile(bytes, { trackIndex: 9 })).toThrow(/轨道.*无效/);
    expect(() => importMidiFile(bytes, { trackIndex: -1 })).toThrow(/轨道.*无效/);
  });

  it('指定没有音符的轨道会抛出可读错误', () => {
    const bytes = buildWithEmptyTrackMidi();
    expect(summarizeMidiTracks(bytes)[0]?.noteCount).toBe(0);
    expect(() => importMidiFile(bytes, { trackIndex: 0 })).toThrow(/没有音符/);
    // 不指定时仍能自动选到后面有音符的旋律轨
    expect(importMidiFile(bytes).selectedTrack).toBe(1);
  });
});

describe('importMidiFile 单音化（口琴单声部）', () => {
  it('重叠时保留较高音，前一个音在下一个音起点截断', () => {
    const result = importMidiFile(buildOverlapMidi(), { fileName: 'overlap.mid' });
    expectMonophonic(result.score.notes);

    // 72 被 76 截断，74 因更低被丢弃
    const sorted = [...result.score.notes].sort((a, b) => a.startBeat - b.startBeat);
    expect(sorted).toHaveLength(2);
    expect(scorePitches(result.score)).toEqual([72, 76]);
    expect(sorted[0]?.startBeat).toBeCloseTo(0, 6);
    expect(sorted[0]?.duration).toBeCloseTo(0.5, 6);
    expect(sorted[1]?.startBeat).toBeCloseTo(0.5, 6);
    expect(sorted[1]?.duration).toBeCloseTo(1, 6);
    expect(result.warnings.some((warning) => warning.includes('单音化'))).toBe(true);
  });

  it('完全同音高的重叠合并为一个长音', () => {
    const result = importMidiFile(buildRepeatedPitchMidi());
    expect(scorePitches(result.score)).toEqual([72]);
    expect(result.score.notes).toHaveLength(1);
    expect(result.score.notes[0]?.duration).toBeCloseTo(1.5, 6);
    expect(result.warnings.some((warning) => warning.includes('合并'))).toBe(true);
  });

  it('同一起点的和弦只保留最高音', () => {
    const result = importMidiFile(buildChordMidi());
    expectMonophonic(result.score.notes);
    expect(scorePitches(result.score)[0]).toBe(64);
    expect(result.score.notes).toHaveLength(2);
  });
});

describe('importMidiFile 速度处理', () => {
  it('无速度事件时回落到 120 BPM 并提示', () => {
    const result = importMidiFile(buildNoTempoMidi());
    expect(result.tempo).toBe(120);
    expect(result.score.meta.tempo).toBe(120);
    expect(result.warnings.some((warning) => warning.includes('120'))).toBe(true);
  });

  it('tempoOverride 优先于文件速度', () => {
    const result = importMidiFile(buildMultiTrackMidi(140), { tempoOverride: 90 });
    expect(result.tempo).toBe(90);
    expect(result.score.meta.tempo).toBe(90);
  });

  it('文件中 140 BPM 能正确回读（消除微秒取整误差）', () => {
    const result = importMidiFile(buildMultiTrackMidi(140));
    expect(result.tempo).toBe(140);
    expect(result.score.meta.tempo).toBe(140);
  });

  it('存在多个速度事件时取第一个并写 warning', () => {
    const result = importMidiFile(buildMultiTempoMidi());
    expect(result.tempo).toBe(100);
    expect(result.score.meta.tempo).toBe(100);
    expect(result.warnings.some((warning) => warning.includes('变速'))).toBe(true);
  });
});

describe('importMidiFile 选项透传与警告', () => {
  it('量化会移动非网格起点并产生警告', () => {
    const result = importMidiFile(buildOffGridMidi(), { quantizeGrid: 0.25 });
    expect(result.warnings.some((warning) => warning.includes('量化'))).toBe(true);
    const first = [...result.score.notes].sort((a, b) => a.startBeat - b.startBeat)[0];
    expect(first?.startBeat).toBeCloseTo(0, 6);
  });

  it('maxNotes 透传给 melodyToScore 并截断', () => {
    const result = importMidiFile(buildMultiTrackMidi(120), { maxNotes: 4 });
    expect(result.score.notes.length).toBe(4);
    expect(result.warnings.some((warning) => warning.includes('截断'))).toBe(true);
  });

  it('未提供文件名时标题回落到「MIDI 导入」', () => {
    const result = importMidiFile(buildMultiTrackMidi(120));
    expect(result.score.meta.title).toBe('MIDI 导入');
  });

  it('options.title 优先于文件名', () => {
    const result = importMidiFile(buildMultiTrackMidi(120), { fileName: 'demo.mid', title: '自定义标题' });
    expect(result.score.meta.title).toBe('自定义标题');
  });
});

describe('importMidiFile 容错', () => {
  it('空数据抛出可读错误', () => {
    expect(() => importMidiFile(new Uint8Array(0))).toThrow(/MIDI 数据为空/);
    expect(() => importMidiFile(new Uint8Array(0))).toThrow(Error);
  });

  it('损坏数据抛出可读错误', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => importMidiFile(garbage)).toThrow(/解析失败/);
    expect(() => summarizeMidiTracks(garbage)).toThrow(/解析失败/);
  });

  it('有效但没有任何音符的 MIDI 抛出可读错误', () => {
    const emptyMidi = new Midi().toArray();
    expect(summarizeMidiTracks(emptyMidi)).toEqual([]);
    expect(() => importMidiFile(emptyMidi)).toThrow(/没有包含音符的轨道/);
  });
});
