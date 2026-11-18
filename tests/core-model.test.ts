/**
 * 核心模型单元测试：乐谱模型（score.ts）、音高换算（pitch.ts）、口琴键位（instrument.ts）。
 *
 * 测试完全自包含：所有数据在文件内构造，不读取游戏进程、网络或磁盘资源。
 * 断言值为项目内的固定约定（1=C4=60，口琴音域 C3..C#6）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_META,
  EPSILON,
  SCORE_SCHEMA,
  cloneScore,
  createEmptyScore,
  createId,
  createNote,
  meterBeats,
  normalizeScore,
  noteEnd,
  scoreEndBeat,
  sortNotes,
  validateScore,
  type MeterDen,
  type Score,
  type ScoreMeta,
  type ScoreNote,
} from '../src/core/model/score';
import {
  MAJOR_SCALE_SEMITONES,
  clampPitchClass,
  degreeSemitone,
  formatWrittenNote,
  isFlatKey,
  keyBaseMidi,
  keyName,
  keyNameFlat,
  midiToName,
  midiToWritten,
  noteToMidi,
  parseKeyRoot,
  pitchClassOf,
} from '../src/core/model/pitch';
import {
  DEFAULT_HARMONICA,
  MAX_OCTAVE_SHIFT,
  allCombos,
  bestCombo,
  comboKeyOf,
  comboModsLabel,
  combosForMidi,
  foldIntoRange,
  formatCombo,
  instrumentRange,
  isChromatic,
  modsOf,
  type HarmonicaInstrument,
} from '../src/core/model/instrument';

/** 构造测试乐谱：音符默认带稳定 id，便于断言顺序。 */
function makeScore(notes: readonly Partial<ScoreNote>[] = [], meta: Partial<ScoreMeta> = {}): Score {
  const score = createEmptyScore({ meta });
  score.notes = notes.map((note, index) => createNote({ id: `n-${index}`, ...note }));
  return score;
}

describe('score.meterBeats', () => {
  it('按拍号换算每小节拍数（以四分音符为一拍）', () => {
    expect(meterBeats({ num: 4, den: 4 })).toBe(4);
    expect(meterBeats({ num: 3, den: 4 })).toBe(3);
    expect(meterBeats({ num: 6, den: 8 })).toBe(3);
    expect(meterBeats({ num: 2, den: 2 })).toBe(4);
    expect(meterBeats({ num: 3, den: 8 })).toBe(1.5);
    expect(meterBeats({ num: 7, den: 16 })).toBe(1.75);
  });

  it('EPSILON 是用于浮点比较的小正数', () => {
    expect(EPSILON).toBeGreaterThan(0);
    expect(EPSILON).toBeLessThan(0.001);
  });
});

describe('score.createNote / createEmptyScore 默认值', () => {
  it('createNote 不传参数时使用中音区 1 拍本位音', () => {
    const note = createNote();
    expect(note.degree).toBe(1);
    expect(note.accidental).toBe(0);
    expect(note.octave).toBe(0);
    expect(note.startBeat).toBe(0);
    expect(note.duration).toBe(1);
    expect(note.tie).toBe(false);
    expect(note.id).toMatch(/^n-/);
    // lyric 是可选字段：未提供时不应出现该属性（而不是 null/undefined 占位）
    expect('lyric' in note).toBe(false);
  });

  it('createNote 保留显式传入的字段，且 id 唯一', () => {
    const note = createNote({
      degree: 5,
      accidental: -1,
      octave: 2,
      startBeat: 3.5,
      duration: 0.5,
      tie: true,
      lyric: 'la',
    });
    expect(note).toMatchObject({
      degree: 5,
      accidental: -1,
      octave: 2,
      startBeat: 3.5,
      duration: 0.5,
      tie: true,
      lyric: 'la',
    });
    const explicitId = createNote({ id: 'fixed-id' });
    expect(explicitId.id).toBe('fixed-id');
    expect(createNote().id).not.toBe(createNote().id);
  });

  it('createId 支持自定义前缀且每次不同', () => {
    const a = createId('score');
    const b = createId('score');
    expect(a.startsWith('score-')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('createEmptyScore 使用默认元信息并生成可序列化时间戳', () => {
    const score = createEmptyScore();
    expect(score.schema).toBe(SCORE_SCHEMA);
    expect(score.id.startsWith('score-')).toBe(true);
    expect(score.meta).toEqual(DEFAULT_META);
    expect(score.notes).toEqual([]);
    expect(score.source.kind).toBe('manual');
    expect(Number.isNaN(Date.parse(score.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(score.updatedAt))).toBe(false);
  });

  it('createEmptyScore 支持 title 与局部 meta 覆盖，拍号按字段合并', () => {
    const score = createEmptyScore({
      title: '测试曲',
      meta: { tempo: 88, meter: { num: 6, den: 8 } },
    });
    expect(score.meta.title).toBe('测试曲');
    expect(score.meta.tempo).toBe(88);
    expect(score.meta.meter).toEqual({ num: 6, den: 8 });
    // 未覆盖的字段保持默认
    expect(score.meta.keyRoot).toBe(DEFAULT_META.keyRoot);
    expect(score.meta.baseOctave).toBe(DEFAULT_META.baseOctave);
  });

  it('cloneScore 生成深拷贝', () => {
    const original = makeScore([{ degree: 3, startBeat: 1, duration: 2 }]);
    const copy = cloneScore(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    copy.notes[0].degree = 7;
    expect(original.notes[0].degree).toBe(3);
  });
});

describe('score.noteEnd / scoreEndBeat', () => {
  it('noteEnd 返回起点加时值', () => {
    expect(noteEnd({ startBeat: 2, duration: 1.5 })).toBe(3.5);
  });

  it('scoreEndBeat 取所有音符结束位置的最大值', () => {
    const score = makeScore([
      { startBeat: 4, duration: 1 },
      { startBeat: 0, duration: 2 },
      { startBeat: 1, duration: 5 },
    ]);
    expect(scoreEndBeat(score)).toBe(6);
    expect(scoreEndBeat(createEmptyScore())).toBe(0);
  });
});

describe('score.sortNotes', () => {
  it('按 startBeat 稳定排序：同拍位保持输入顺序，且不修改原数组', () => {
    const first = createNote({ id: 'a', startBeat: 2 });
    const second = createNote({ id: 'b', startBeat: 1 });
    const third = createNote({ id: 'c', startBeat: 2 });
    const input = [first, second, third];
    const sorted = sortNotes(input);
    expect(sorted.map((note) => note.id)).toEqual(['b', 'a', 'c']);
    expect(sorted).not.toBe(input);
    expect(input.map((note) => note.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('score.validateScore', () => {
  it('合法单声部乐谱没有诊断', () => {
    const score = makeScore([
      { degree: 1, startBeat: 0, duration: 1 },
      { degree: 2, startBeat: 1, duration: 1 },
      { degree: 0, startBeat: 2, duration: 1 },
    ]);
    expect(validateScore(score)).toEqual([]);
  });

  it('捕获非法 tempo', () => {
    const slow = validateScore(makeScore([{ startBeat: 0 }], { tempo: 10 }));
    expect(slow).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'meta.tempo' }),
    );
    const fast = validateScore(makeScore([{ startBeat: 0 }], { tempo: 400 }));
    expect(fast).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'meta.tempo' }),
    );
  });

  it('捕获音符重叠（单声部无法同时发声）', () => {
    const score = makeScore([
      { id: 'a', degree: 1, startBeat: 0, duration: 2 },
      { id: 'b', degree: 2, startBeat: 1, duration: 1 },
    ]);
    const issues = validateScore(score);
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'note.overlap', noteIndex: 1 }),
    );
  });

  it('捕获 tie 字段类型非法', () => {
    const score = makeScore([{ degree: 5, tie: 'yes' as unknown as boolean }]);
    const issues = validateScore(score);
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'note.tie', noteIndex: 0 }),
    );
  });

  it('捕获级数/八度/起点/时值/升降号等结构性错误', () => {
    const score = makeScore([
      { id: 'a', degree: 9 as unknown as ScoreNote['degree'] },
      { id: 'b', octave: 5 },
      { id: 'c', startBeat: -1 },
      { id: 'd', duration: 0.01 },
      { id: 'e', accidental: 2 as unknown as ScoreNote['accidental'] },
    ]);
    const codes = validateScore(score).map((issue) => issue.code);
    expect(codes).toContain('note.degree');
    expect(codes).toContain('note.octave');
    expect(codes).toContain('note.start');
    expect(codes).toContain('note.duration');
    expect(codes).toContain('note.accidental');
  });

  it('休止符带升降号时给出 warning，重复 id 给出 warning', () => {
    const score = makeScore([
      { id: 'same', degree: 0, accidental: 1 },
      { id: 'same', degree: 1, startBeat: 1 },
    ]);
    const issues = validateScore(score);
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'rest.accidental' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'note.id.dup', noteIndex: 1 }),
    );
  });

  it('空乐谱给出 notes.empty warning，schema 不匹配给出 warning', () => {
    const score = createEmptyScore();
    expect(validateScore(score)).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'notes.empty' }),
    );
    const wrongSchema = createEmptyScore();
    (wrongSchema as { schema: string }).schema = 'dfh.score/0';
    expect(validateScore(wrongSchema)).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'schema.version' }),
    );
  });
});

describe('score.normalizeScore', () => {
  it('修复非法 tie：后面不是同音高紧邻音符时取消并报告 tie.broken', () => {
    const score = makeScore([
      { id: 'a', degree: 5, startBeat: 0, duration: 1, tie: true },
      { id: 'b', degree: 6, startBeat: 1, duration: 1 },
    ]);
    const { score: normalized, issues } = normalizeScore(score);
    expect(normalized.notes[0].tie).toBe(false);
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'tie.broken', noteIndex: 0 }),
    );
  });

  it('合法的连音线在 normalize 后保留', () => {
    const score = makeScore([
      { id: 'a', degree: 5, startBeat: 0, duration: 1, tie: true },
      { id: 'b', degree: 5, startBeat: 1, duration: 1 },
    ]);
    const { score: normalized, issues } = normalizeScore(score);
    expect(normalized.notes[0].tie).toBe(true);
    expect(issues.filter((issue) => issue.code === 'tie.broken')).toEqual([]);
  });

  it('夹取元信息到合法范围并补全空标题', () => {
    const score = createEmptyScore({
      meta: { tempo: 10, keyRoot: 12, baseOctave: 9, meter: { num: 0, den: 4 }, title: '   ' },
    });
    const { score: normalized } = normalizeScore(score);
    expect(normalized.meta.tempo).toBe(20);
    expect(normalized.meta.keyRoot).toBe(0);
    expect(normalized.meta.baseOctave).toBe(4);
    // 分子非法 → 整个拍号回退默认 4/4
    expect(normalized.meta.meter).toEqual({ num: 4, den: 4 });
    expect(normalized.meta.title).toBe(DEFAULT_META.title);
    // 分母非法但分子合法 → 仅分母回退为 4
    const badDen = createEmptyScore({
      meta: { meter: { num: 3, den: 3 as unknown as MeterDen } },
    });
    expect(normalizeScore(badDen).score.meta.meter).toEqual({ num: 3, den: 4 });
  });

  it('夹取音符字段并修正重复 id，返回新对象不修改输入', () => {
    const score = makeScore([
      {
        id: 'dup',
        degree: 9 as unknown as ScoreNote['degree'],
        accidental: 5 as unknown as ScoreNote['accidental'],
        octave: 9,
        startBeat: -5,
        duration: 0.001,
        tie: 'yes' as unknown as boolean,
      },
      { id: 'dup', degree: 0, accidental: 1, startBeat: 1 },
    ]);
    const snapshot = cloneScore(score);
    const { score: normalized, issues } = normalizeScore(score);
    expect(score).toEqual(snapshot);
    expect(normalized.notes).toHaveLength(2);
    expect(normalized.notes[0].octave).toBe(4);
    expect(normalized.notes[0].startBeat).toBe(0);
    expect(normalized.notes[0].duration).toBe(0.05);
    expect(normalized.notes[0].degree).toBe(1);
    expect(normalized.notes[0].accidental).toBe(1);
    expect(normalized.notes[1].degree).toBe(0);
    expect(normalized.notes[1].accidental).toBe(0);
    expect(normalized.notes[0].id).not.toBe(normalized.notes[1].id);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'note.id.dup' }));
  });
});

describe('pitch 基础换算', () => {
  it('大调音阶半音表与级数半音', () => {
    expect([...MAJOR_SCALE_SEMITONES]).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(degreeSemitone(1)).toBe(0);
    expect(degreeSemitone(4)).toBe(5);
    expect(degreeSemitone(7)).toBe(11);
  });

  it('keyBaseMidi：1=C4 对应 MIDI 60', () => {
    expect(keyBaseMidi({ keyRoot: 0, baseOctave: 4 })).toBe(60);
    expect(keyBaseMidi({ keyRoot: 7, baseOctave: 4 })).toBe(67);
    expect(keyBaseMidi({ keyRoot: 0, baseOctave: 5 })).toBe(72);
  });

  it('noteToMidi：自然音、升降号、低/高八度与休止符', () => {
    const meta = { keyRoot: 0, baseOctave: 4 };
    expect(noteToMidi({ degree: 1, accidental: 0, octave: 0 }, meta)).toBe(60);
    expect(noteToMidi({ degree: 4, accidental: 1, octave: 0 }, meta)).toBe(66); // #4
    expect(noteToMidi({ degree: 5, accidental: 0, octave: -1 }, meta)).toBe(55); // ,5
    expect(noteToMidi({ degree: 7, accidental: -1, octave: 0 }, meta)).toBe(70); // b7
    expect(noteToMidi({ degree: 1, accidental: 0, octave: 1 }, meta)).toBe(72); // 1'
    expect(noteToMidi({ degree: 0, accidental: 0, octave: 0 }, meta)).toBeNull();
    // G 调下同样的写法整体上移纯五度
    expect(noteToMidi({ degree: 1, accidental: 0, octave: 0 }, { keyRoot: 7, baseOctave: 4 })).toBe(67);
    expect(noteToMidi({ degree: 4, accidental: 1, octave: 0 }, { keyRoot: 7, baseOctave: 4 })).toBe(73);
  });

  it('midiToName 使用科学音高记法', () => {
    expect(midiToName(60)).toBe('C4');
    expect(midiToName(69)).toBe('A4');
    expect(midiToName(73)).toBe('C#5');
    expect(midiToName(61)).toBe('C#4');
    expect(midiToName(48)).toBe('C3');
    expect(midiToName(85)).toBe('C#6');
  });

  it('pitchClassOf / clampPitchClass 归一化到 0-11', () => {
    expect(pitchClassOf(73)).toBe(1);
    expect(clampPitchClass(12)).toBe(0);
    expect(clampPitchClass(13)).toBe(1);
    expect(clampPitchClass(-1)).toBe(11);
    expect(clampPitchClass(-13)).toBe(11);
  });

  it('midiToWritten：C4/A4/C#5 的具体写法', () => {
    const meta = { keyRoot: 0, baseOctave: 4 };
    expect(midiToWritten(60, meta)).toEqual({ degree: 1, accidental: 0, octave: 0 });
    expect(midiToWritten(69, meta)).toEqual({ degree: 6, accidental: 0, octave: 0 });
    expect(midiToWritten(73, meta)).toEqual({ degree: 1, accidental: 1, octave: 1 });
    expect(midiToWritten(66, meta)).toEqual({ degree: 4, accidental: 1, octave: 0 });
    // 降号调优先使用降号写法：F 调中 MIDI 75 写作 b7
    expect(midiToWritten(75, { keyRoot: 5, baseOctave: 4 })).toEqual({
      degree: 7,
      accidental: -1,
      octave: 0,
    });
  });

  it('written→midi→written 在所有调上的往返一致', () => {
    for (let keyRoot = 0; keyRoot <= 11; keyRoot += 1) {
      const meta = { keyRoot, baseOctave: 4 };
      for (let degree = 1; degree <= 7; degree += 1) {
        for (const accidental of [-1, 0, 1] as const) {
          for (let octave = -1; octave <= 1; octave += 1) {
            const midi = noteToMidi(
              { degree: degree as ScoreNote['degree'], accidental, octave },
              meta,
            );
            expect(midi).not.toBeNull();
            const written = midiToWritten(midi as number, meta);
            expect(noteToMidi(written, meta)).toBe(midi);
          }
        }
      }
    }
  });

  it('大调音级在任意调号下都能写成本位级数（无升降号）', () => {
    for (let keyRoot = 0; keyRoot <= 11; keyRoot += 1) {
      const meta = { keyRoot, baseOctave: 4 };
      for (let degree = 1; degree <= 7; degree += 1) {
        for (let octave = -1; octave <= 1; octave += 1) {
          const midi = noteToMidi(
            { degree: degree as ScoreNote['degree'], accidental: 0, octave },
            meta,
          ) as number;
          expect(midiToWritten(midi, meta)).toEqual({ degree, accidental: 0, octave });
        }
      }
    }
  });

  it('isFlatKey / keyName / keyNameFlat', () => {
    for (const flatKey of [1, 3, 5, 6, 8, 10]) expect(isFlatKey(flatKey)).toBe(true);
    for (const sharpKey of [0, 2, 4, 7, 9, 11]) expect(isFlatKey(sharpKey)).toBe(false);
    expect(keyName(10)).toBe('A#');
    expect(keyNameFlat(10)).toBe('Bb');
    expect(keyNameFlat(3)).toBe('Eb');
  });

  it('parseKeyRoot 支持常见调号写法', () => {
    expect(parseKeyRoot('C')).toBe(0);
    expect(parseKeyRoot('C#')).toBe(1);
    expect(parseKeyRoot('bB')).toBe(10);
    expect(parseKeyRoot('1=bB')).toBe(10);
    expect(parseKeyRoot('1 = bB')).toBe(10);
    expect(parseKeyRoot('Bb')).toBe(10);
    expect(parseKeyRoot('Eb')).toBe(3);
    expect(parseKeyRoot('F#大调')).toBe(6);
    expect(parseKeyRoot('C大调')).toBe(0);
    expect(parseKeyRoot('')).toBeNull();
    expect(parseKeyRoot('H')).toBeNull();
  });

  it('formatWrittenNote 输出升降号/八度记号', () => {
    expect(formatWrittenNote({ degree: 1, accidental: 0, octave: 0 })).toBe('1');
    expect(formatWrittenNote({ degree: 1, accidental: 1, octave: 1 })).toBe("#1'");
    expect(formatWrittenNote({ degree: 5, accidental: 0, octave: -1 })).toBe('5,');
    expect(formatWrittenNote({ degree: 5, accidental: -1, octave: -2 })).toBe('b5,,');
  });
});

describe('instrument.DEFAULT_HARMONICA 键位覆盖', () => {
  it('8 个音键与鼠标修饰配置符合游戏约定', () => {
    expect(DEFAULT_HARMONICA.noteKeys).toHaveLength(8);
    expect(DEFAULT_HARMONICA.noteKeys.map((key) => key.label)).toEqual([
      'Z',
      'X',
      'C',
      'V',
      'B',
      'N',
      'M',
      ',',
    ]);
    expect(DEFAULT_HARMONICA.noteKeys.map((key) => key.baseMidi)).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72,
    ]);
    expect(DEFAULT_HARMONICA.octaveButtons).toEqual({ down: 'left', up: 'right' });
    expect(DEFAULT_HARMONICA.semitoneButton).toBe('middle');
    expect(DEFAULT_HARMONICA.allowModifierCombos).toBe(true);
    expect(MAX_OCTAVE_SHIFT).toBe(1);
  });

  it('音域覆盖 C3(48)..C#6(85) 全部 38 个连续半音', () => {
    expect(instrumentRange()).toEqual({ min: 48, max: 85 });
    expect(midiToName(48)).toBe('C3');
    expect(midiToName(85)).toBe('C#6');
    expect(isChromatic()).toBe(true);
    for (let midi = 48; midi <= 85; midi += 1) {
      expect(combosForMidi(midi).length).toBeGreaterThan(0);
    }
    expect(combosForMidi(47)).toEqual([]);
    expect(combosForMidi(86)).toEqual([]);
  });

  it('枚举 48 个合法物理组合，midi 与 comboKey 自洽', () => {
    const combos = allCombos();
    expect(combos).toHaveLength(8 * 3 * 2);
    const keys = new Set<string>();
    for (const combo of combos) {
      const binding = DEFAULT_HARMONICA.noteKeys.find((key) => key.id === combo.keyId);
      expect(binding).toBeDefined();
      expect(combo.midi).toBe((binding as { baseMidi: number }).baseMidi + 12 * combo.octaveShift + combo.semitone);
      expect(combo.modCount).toBe(combo.mods.length);
      expect(combo.comboKey).toBe(comboKeyOf(combo));
      keys.add(combo.comboKey);
    }
    expect(keys.size).toBe(48);
  });

  it('C5(72) 可演奏，且最佳组合是无修饰的逗号键', () => {
    const combo = bestCombo(72);
    expect(combo).toBeDefined();
    expect(combo?.keyId).toBe('k8');
    expect(combo?.keyLabel).toBe(',');
    expect(combo?.midi).toBe(72);
    expect(combo?.modCount).toBe(0);
    expect(combo?.mods).toEqual([]);
    expect(formatCombo(combo)).toBe(',');
  });

  it('同一 MIDI 的候选组合按修饰键数量升序排列', () => {
    for (let midi = 48; midi <= 85; midi += 1) {
      const combos = combosForMidi(midi);
      expect(combos.length).toBeGreaterThan(0);
      for (let i = 1; i < combos.length; i += 1) {
        expect(combos[i].modCount).toBeGreaterThanOrEqual(combos[i - 1].modCount);
      }
    }
    // C#5(73)：',' + 中键（1 个修饰）优于 Z + 右键 + 中键（2 个修饰）
    const combos73 = combosForMidi(73);
    expect(combos73[0].keyId).toBe('k8');
    expect(combos73[0].mods).toEqual(['middle']);
    expect(combos73[0].modCount).toBe(1);
    expect(combos73[1].modCount).toBe(2);
    expect(formatCombo(combos73[0])).toBe('#,');
  });

  it('foldIntoRange 把音域外的音折回最近可演奏八度', () => {
    expect(foldIntoRange(72)).toEqual({ midi: 72, octaves: 0 });
    expect(foldIntoRange(86)).toEqual({ midi: 74, octaves: -1 });
    expect(foldIntoRange(96)).toEqual({ midi: 84, octaves: -1 });
    expect(foldIntoRange(36)).toEqual({ midi: 48, octaves: 1 });
    expect(foldIntoRange(12)).toEqual({ midi: 48, octaves: 3 });
    // 距离超过 3 个八度时返回 null（11 + 36 = 47 < 48）
    expect(foldIntoRange(11)).toBeNull();
  });

  it('modsOf / comboModsLabel / formatCombo 的输出符合阅读习惯', () => {
    expect(modsOf(DEFAULT_HARMONICA, 0, 0)).toEqual([]);
    expect(modsOf(DEFAULT_HARMONICA, 1, 0)).toEqual(['right']);
    expect(modsOf(DEFAULT_HARMONICA, -1, 1)).toEqual(['left', 'middle']);
    const upCombo = allCombos().find(
      (combo) => combo.keyId === 'k1' && combo.octaveShift === 1 && combo.semitone === 0,
    );
    expect(formatCombo(upCombo)).toBe('↑Z');
    const downSharp = allCombos().find(
      (combo) => combo.keyId === 'k1' && combo.octaveShift === -1 && combo.semitone === 1,
    )!;
    expect(formatCombo(downSharp)).toBe('↓#Z');
    expect(comboModsLabel(downSharp)).toBe('按住左键+中键');
    expect(comboModsLabel(bestCombo(72)!)).toBe('');
    expect(formatCombo(undefined)).toBe('—');
  });

  it('allowModifierCombos=false 时不再有“八度+半音”组合，半音只出现在本位音键', () => {
    const compat: HarmonicaInstrument = { ...DEFAULT_HARMONICA, allowModifierCombos: false };
    const combos = allCombos(compat);
    expect(combos).toHaveLength(8 * (3 + 1)); // 每键 3 个八度移位 + 1 个本位升半音
    const semitoneCombos = combos.filter((combo) => combo.semitone === 1);
    expect(semitoneCombos).toHaveLength(8);
    for (const combo of semitoneCombos) expect(combo.octaveShift).toBe(0);
    expect(semitoneCombos.map((combo) => combo.midi).sort((a, b) => a - b)).toEqual([
      61, 63, 65, 66, 68, 70, 72, 73,
    ]);
    // 失去“八度+半音”后音域缩小且不再连续半音
    expect(instrumentRange(compat)).toEqual({ min: 48, max: 84 });
    expect(isChromatic(compat)).toBe(false);
    expect(combosForMidi(85, compat)).toEqual([]);
  });
});
