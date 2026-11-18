/**
 * 主旋律提取（HPSS + 谐波显著度 + Viterbi 平滑跟踪）测试。
 *
 * 全部使用自行合成的 PCM 数据，不读取外部音频文件、不访问网络：
 * - 纯正弦音阶旋律 → 音符数/音高与 transcribeMelody 一致；
 * - 旋律 + 下方三和弦 → 跟主旋律而不是被伴奏带走；
 * - 旋律 + 打击噪声点击 → HPSS 开启后旋律正确、音符数不爆炸（关闭作对比）；
 * - pitchMin/pitchMax 音域约束 → 输出音符全部落在范围内；
 * - auto 模式 → 纯正弦判为 monophonic、旋律+和弦判为 polyphonic；
 * - 静音 / 白噪声 / 空数组 → 空音符、不抛异常、有 warning；
 * - 60 秒 44.1kHz 性能冒烟 < 6s。
 */
import { describe, expect, it } from 'vitest';

import { transcribeMelody } from '@core/audio';
import { extractMainMelody } from '@core/audio/melody';

const SAMPLE_RATE = 22050;

/** MIDI → 频率（Hz） */
function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 合成一段带 10ms 线性淡入淡出的正弦音（可叠加整数次谐波模拟乐器音色） */
function synthTone(
  midi: number,
  durationSec: number,
  sampleRate = SAMPLE_RATE,
  amplitude = 0.4,
  harmonics: number[] = [1],
  fadeSec = 0.01,
): Float32Array {
  const length = Math.round(durationSec * sampleRate);
  const fadeSamples = Math.max(1, Math.round(fadeSec * sampleRate));
  const freq = midiToFreq(midi);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const fadeIn = Math.min(1, i / fadeSamples);
    const fadeOut = Math.min(1, (length - 1 - i) / fadeSamples);
    const envelope = Math.min(fadeIn, fadeOut);
    const phase = (2 * Math.PI * freq * i) / sampleRate;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h += 1) {
      sample += harmonics[h] * Math.sin(phase * (h + 1));
    }
    out[i] = amplitude * envelope * sample;
  }
  return out;
}

/** 拼接多段 PCM */
function concat(parts: Float32Array[]): Float32Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 把 source 叠加到 target 的指定样本位置 */
function mixIn(target: Float32Array, source: Float32Array, offsetSamples: number): void {
  const start = Math.max(0, Math.round(offsetSamples));
  const count = Math.min(source.length, target.length - start);
  for (let i = 0; i < count; i += 1) target[start + i] += source[i];
}

/** 简易确定性伪随机（mulberry32），保证测试可复现 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 合成周期性的打击噪声点击（20ms 指数衰减噪声） */
function synthClicks(
  durationSec: number,
  intervalSec: number,
  sampleRate = SAMPLE_RATE,
  amplitude = 0.45,
  seed = 20261118,
): Float32Array {
  const length = Math.round(durationSec * sampleRate);
  const out = new Float32Array(length);
  const random = createRandom(seed);
  const clickLength = Math.max(1, Math.round(0.02 * sampleRate));
  const decaySamples = Math.max(1, Math.round(0.004 * sampleRate));
  for (let time = 0; time < durationSec; time += intervalSec) {
    const start = Math.round(time * sampleRate);
    for (let j = 0; j < clickLength && start + j < length; j += 1) {
      const decay = Math.exp(-j / decaySamples);
      out[start + j] += amplitude * decay * (random() * 2 - 1);
    }
  }
  return out;
}

/** 合成“旋律 + 下方三和弦伴奏”的混音（每音 0.3s，伴奏与旋律同步换和弦） */
function buildMelodyWithChords(
  melodyMidis: number[],
  chords: number[][],
  noteDurationSec = 0.3,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  const totalLength = Math.round((melodyMidis.length * noteDurationSec + 0.2) * sampleRate);
  const out = new Float32Array(totalLength);
  const toneLength = noteDurationSec * 0.92;
  for (let i = 0; i < melodyMidis.length; i += 1) {
    const offset = Math.round(i * noteDurationSec * sampleRate);
    mixIn(out, synthTone(melodyMidis[i], toneLength, sampleRate, 0.34), offset);
    for (const chordMidi of chords[i]) {
      mixIn(out, synthTone(chordMidi, toneLength, sampleRate, 0.2), offset);
    }
  }
  return out;
}

/** 统计“命中目标音高集合 ±1 半音”的音符比例 */
function matchedRatio(notes: Array<{ midi: number }>, targets: number[], tolerance = 1): number {
  if (notes.length === 0) return 0;
  let matched = 0;
  for (const note of notes) {
    if (targets.some((target) => Math.abs(note.midi - target) <= tolerance)) matched += 1;
  }
  return matched / notes.length;
}

describe('extractMainMelody：纯正弦旋律（单声部）', () => {
  it('识别出约 5 个音符，音高与 transcribeMelody 一致（±1 半音）', () => {
    const expectedMidi = [60, 62, 64, 65, 67]; // C4 D4 E4 F4 G4
    const melody = concat([
      ...expectedMidi.map((midi) => synthTone(midi, 0.25)),
      new Float32Array(Math.round(0.15 * SAMPLE_RATE)),
    ]);

    const baseline = transcribeMelody(melody, SAMPLE_RATE);
    const result = extractMainMelody(melody, SAMPLE_RATE);

    // 音符数量 ≈ 5（允许一个边界碎音误差）
    expect(result.notes.length).toBeGreaterThanOrEqual(4);
    expect(result.notes.length).toBeLessThanOrEqual(6);
    // 每个提取音符都能在期望旋律里找到 ±1 半音的对应（顺序按时间）
    expect(matchedRatio(result.notes, expectedMidi)).toBeGreaterThanOrEqual(0.8);
    for (let i = 0; i < Math.min(result.notes.length, expectedMidi.length); i += 1) {
      expect(Math.abs(result.notes[i].midi - expectedMidi[i])).toBeLessThanOrEqual(1);
    }
    // 与现有 transcribeMelody 的音符计数/音高一致
    expect(baseline.notes.length).toBeGreaterThanOrEqual(4);
    const compareCount = Math.min(result.notes.length, baseline.notes.length);
    for (let i = 0; i < compareCount; i += 1) {
      expect(Math.abs(result.notes[i].midi - baseline.notes[i].midi)).toBeLessThanOrEqual(1);
    }
    // 纯正弦输入应判定为单声部
    expect(result.method).toBe('monophonic');
    expect(result.polyphonyScore).toBeLessThan(0.45);
    expect(result.notes.every((note) => note.durSec > 0.1)).toBe(true);
    expect(result.voicedRatio).toBeGreaterThan(0.3);
  });

  it('谐波丰富的单音（泛音列）仍判定为单声部', () => {
    // 模拟口琴/人声音色：1、2、3、4 次谐波依次衰减
    const pcm = concat([
      synthTone(69, 0.4, SAMPLE_RATE, 0.5, [1, 0.6, 0.35, 0.2]),
      new Float32Array(Math.round(0.1 * SAMPLE_RATE)),
    ]);
    const result = extractMainMelody(pcm, SAMPLE_RATE);
    expect(result.notes.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(result.notes[0].midi - 69)).toBeLessThanOrEqual(1);
    expect(result.method).toBe('monophonic');
  });

  it('带颤音（±25 音分 / 5.5Hz）的持续音仍记为一个音', () => {
    const length = Math.round(0.6 * SAMPLE_RATE);
    const vibrato = new Float32Array(length);
    let phase = 0;
    for (let i = 0; i < length; i += 1) {
      const cents = 25 * Math.sin((2 * Math.PI * 5.5 * i) / SAMPLE_RATE);
      const freq = midiToFreq(69) * 2 ** (cents / 1200);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      vibrato[i] = 0.4 * Math.min(1, i / 220, (length - 1 - i) / 220) * Math.sin(phase);
    }
    const result = extractMainMelody(vibrato, SAMPLE_RATE);
    expect(result.notes.length).toBe(1);
    expect(Math.abs(result.notes[0].midi - 69)).toBeLessThanOrEqual(1);
    expect(result.notes[0].durSec).toBeGreaterThan(0.3);
  });

  it('同音重复（C4 连续 3 次）会被起音/能量谷切分成 3 个音', () => {
    // 连续 3 个 C4，每个 0.26s、间隔 40ms 静音：不能被并成一个长音
    const pcm = new Float32Array(Math.round(0.9 * SAMPLE_RATE));
    for (let k = 0; k < 3; k += 1) {
      mixIn(pcm, synthTone(60, 0.26, SAMPLE_RATE, 0.4), Math.round(k * 0.3 * SAMPLE_RATE));
    }
    const result = extractMainMelody(pcm, SAMPLE_RATE);
    expect(result.notes.length).toBe(3);
    for (const note of result.notes) {
      expect(note.midi).toBe(60);
      expect(note.durSec).toBeGreaterThanOrEqual(0.15);
    }
    // 时间上依次排列、不重叠（允许浮点/四舍五入的微小时差）
    for (let i = 1; i < result.notes.length; i += 1) {
      const previousEnd = result.notes[i - 1].startSec + result.notes[i - 1].durSec;
      expect(result.notes[i].startSec).toBeGreaterThanOrEqual(previousEnd - 1e-3);
    }
  });
});

describe('extractMainMelody：旋律 + 下方三和弦伴奏', () => {
  it('主要跟着旋律走（≥70% 音符落在旋律 ±1 半音内），而不是被伴奏带走', () => {
    // C5 D5 E5 F5 G5 上方的旋律；每段下方配一个三和弦（C3-G3-E4 等）
    const melodyMidis = [72, 74, 76, 77, 79];
    const chords = [
      [48, 55, 64], // C3 G3 E4
      [50, 57, 65], // D3 A3 F4
      [52, 59, 67], // E3 B3 G4
      [53, 60, 69], // F3 C4 A4
      [55, 62, 71], // G3 D4 B4
    ];
    const pcm = buildMelodyWithChords(melodyMidis, chords);

    const result = extractMainMelody(pcm, SAMPLE_RATE);

    expect(result.notes.length).toBeGreaterThanOrEqual(3);
    // 主旋律命中率：至少 70% 的音符落在旋律音高 ±1 半音
    expect(matchedRatio(result.notes, melodyMidis)).toBeGreaterThanOrEqual(0.7);
    // 输入是复音混音：auto 应判定为 polyphonic，复音程度较高
    expect(result.method).toBe('polyphonic');
    expect(result.polyphonyScore).toBeGreaterThan(0.45);
    // 结果音符落在默认音域 C3-C6 内
    for (const note of result.notes) {
      expect(note.midi).toBeGreaterThanOrEqual(48);
      expect(note.midi).toBeLessThanOrEqual(84);
    }
  });

  it('伴奏和弦固定不变（含与旋律同名的 E4/E5 八度重叠）时仍跟住上方的旋律', () => {
    // 固定和弦 C3-G3-E4 铺底，旋律 C5 D5 E5 F5 G5：E5 与和弦 E4 正好相差八度，
    // 用来验证“八度校正不会把主旋律整体拉低一个八度”。
    const melodyMidis = [72, 74, 76, 77, 79];
    const pcm = buildMelodyWithChords(melodyMidis, melodyMidis.map(() => [48, 55, 64]));

    const result = extractMainMelody(pcm, SAMPLE_RATE);

    expect(result.notes.length).toBeGreaterThanOrEqual(3);
    expect(matchedRatio(result.notes, melodyMidis)).toBeGreaterThanOrEqual(0.7);
    expect(result.method).toBe('polyphonic');
  });

  it('44.1kHz 混音（内部降采样到 22050Hz）仍能跟住主旋律', () => {
    const melodyMidis = [72, 74, 76, 77, 79];
    const chords = [
      [48, 55, 64],
      [50, 57, 65],
      [52, 59, 67],
      [53, 60, 69],
      [55, 62, 71],
    ];
    const pcm = buildMelodyWithChords(melodyMidis, chords, 0.3, 44100);
    const result = extractMainMelody(pcm, 44100);
    expect(result.notes.length).toBeGreaterThanOrEqual(3);
    expect(matchedRatio(result.notes, melodyMidis)).toBeGreaterThanOrEqual(0.7);
    // 输出时间以秒为单位，与输入采样率无关
    expect(result.notes[result.notes.length - 1].startSec).toBeGreaterThan(0.9);
  });
});

describe('extractMainMelody：旋律 + 打击噪声点击', () => {
  it('开启 HPSS 后旋律正确且音符数不爆炸；关闭 HPSS 仅作对比（允许更差）', () => {
    const melodyMidis = [60, 62, 64, 65, 67];
    const melody = concat([
      ...melodyMidis.map((midi) => synthTone(midi, 0.25, SAMPLE_RATE, 0.4)),
      new Float32Array(Math.round(0.1 * SAMPLE_RATE)),
    ]);
    // 每 125ms 一记鼓点，覆盖旋律分析区间
    const clicks = synthClicks(melody.length / SAMPLE_RATE, 0.125, SAMPLE_RATE, 0.45);
    const pcm = new Float32Array(melody.length);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = melody[i] + clicks[i];

    const withHpss = extractMainMelody(pcm, SAMPLE_RATE, { suppressAccompaniment: true });
    const withoutHpss = extractMainMelody(pcm, SAMPLE_RATE, { suppressAccompaniment: false });

    // 开启 HPSS：旋律音高命中率高、音符数不爆炸
    expect(matchedRatio(withHpss.notes, melodyMidis)).toBeGreaterThanOrEqual(0.7);
    expect(withHpss.notes.length).toBeGreaterThanOrEqual(4);
    expect(withHpss.notes.length).toBeLessThanOrEqual(8);
    // 关闭 HPSS：允许更差，但不应抛异常（基本正确性仍应存在）
    expect(withoutHpss.notes.length).toBeGreaterThanOrEqual(1);
    // 两者都返回合理的结构
    expect(withHpss.method).toBeTypeOf('string');
    expect(withoutHpss.polyphonyScore).toBeGreaterThanOrEqual(withHpss.polyphonyScore - 0.3);
  });
});

describe('extractMainMelody：音域约束', () => {
  it('带低音贝斯 + 旋律时，输出音符全部落在 pitchMin/pitchMax 范围内', () => {
    const sampleRate = SAMPLE_RATE;
    const noteDurationSec = 0.3;
    const melodyMidis = [62, 64, 67, 69]; // D4 E4 G4 A4
    const bassMidis = [43, 43, 45, 45]; // G2 A2，低于设定音域
    const totalLength = Math.round((melodyMidis.length * noteDurationSec + 0.15) * sampleRate);
    const pcm = new Float32Array(totalLength);
    for (let i = 0; i < melodyMidis.length; i += 1) {
      const offset = Math.round(i * noteDurationSec * sampleRate);
      mixIn(pcm, synthTone(melodyMidis[i], noteDurationSec * 0.9, sampleRate, 0.32), offset);
      // 贝斯更响，用来诱导“被低音带走”
      mixIn(pcm, synthTone(bassMidis[i], noteDurationSec * 0.9, sampleRate, 0.5), offset);
    }

    const pitchMin = 55; // G3
    const pitchMax = 79; // G5
    const result = extractMainMelody(pcm, sampleRate, { pitchMin, pitchMax });

    expect(result.notes.length).toBeGreaterThanOrEqual(1);
    for (const note of result.notes) {
      expect(note.midi).toBeGreaterThanOrEqual(pitchMin);
      expect(note.midi).toBeLessThanOrEqual(pitchMax);
    }
    // 旋律在范围内，命中率不应太差
    expect(matchedRatio(result.notes, melodyMidis)).toBeGreaterThanOrEqual(0.6);
  });
});

describe('extractMainMelody：auto 模式与强制模式', () => {
  it('auto：纯正弦 → monophonic；旋律+和弦 → polyphonic', () => {
    const pure = concat([
      synthTone(60, 0.3),
      synthTone(62, 0.3),
      new Float32Array(Math.round(0.1 * SAMPLE_RATE)),
    ]);
    const pureResult = extractMainMelody(pure, SAMPLE_RATE);
    expect(pureResult.method).toBe('monophonic');

    const mixed = buildMelodyWithChords([72, 74, 76], [[48, 55, 64], [50, 57, 65], [52, 59, 67]]);
    const mixedResult = extractMainMelody(mixed, SAMPLE_RATE);
    expect(mixedResult.method).toBe('polyphonic');
    expect(mixedResult.polyphonyScore).toBeGreaterThan(0.45);
  });

  it('mode=monophonic / polyphonic 强制模式返回对应 method', () => {
    const pcm = buildMelodyWithChords([72, 74, 76], [[48, 55, 64], [50, 57, 65], [52, 59, 67]]);
    const forcedMono = extractMainMelody(pcm, SAMPLE_RATE, { mode: 'monophonic' });
    const forcedPoly = extractMainMelody(pcm, SAMPLE_RATE, { mode: 'polyphonic' });
    expect(forcedMono.method).toBe('monophonic');
    expect(forcedPoly.method).toBe('polyphonic');
  });

  it('sensitivity 越高越容易接受弱音符（不抛异常、结构完整）', () => {
    const quiet = concat([
      synthTone(64, 0.3, SAMPLE_RATE, 0.03),
      synthTone(67, 0.3, SAMPLE_RATE, 0.03),
      new Float32Array(Math.round(0.1 * SAMPLE_RATE)),
    ]);
    const low = extractMainMelody(quiet, SAMPLE_RATE, { sensitivity: 0 });
    const high = extractMainMelody(quiet, SAMPLE_RATE, { sensitivity: 1 });
    expect(Array.isArray(low.notes)).toBe(true);
    expect(Array.isArray(high.notes)).toBe(true);
    // 低灵敏度不应比高灵敏度“多”出很多音（阈值单调性的弱断言）
    expect(high.notes.length).toBeGreaterThanOrEqual(low.notes.length);
  });
});

describe('extractMainMelody：静音 / 白噪声 / 空输入', () => {
  it('纯静音返回空音符且带 warning，不抛异常', () => {
    const silence = new Float32Array(SAMPLE_RATE);
    const result = extractMainMelody(silence, SAMPLE_RATE);
    expect(result.notes).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('白噪声返回空音符或极少音符，不抛异常且有 warning', () => {
    const random = createRandom(1234);
    const noise = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (random() * 2 - 1) * 0.3;
    const result = extractMainMelody(noise, SAMPLE_RATE);
    expect(result.notes.length).toBeLessThanOrEqual(2);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('空数组 / 非法采样率不抛异常且给出 warning', () => {
    const empty = extractMainMelody(new Float32Array(0), SAMPLE_RATE);
    expect(empty.notes).toHaveLength(0);
    expect(empty.warnings.length).toBeGreaterThan(0);

    const badRate = extractMainMelody(new Float32Array(1024), 0);
    expect(badRate.notes).toHaveLength(0);
    expect(badRate.warnings.length).toBeGreaterThan(0);
  });
});

describe('extractMainMelody：性能', () => {
  it('60 秒 44.1kHz 音频耗时 < 6s', () => {
    const sampleRate = 44100;
    const noteDurationSec = 0.25;
    const totalSeconds = 60;
    const noteCount = Math.round(totalSeconds / noteDurationSec);
    const totalSamples = totalSeconds * sampleRate;
    const pcm = new Float32Array(totalSamples);
    const scaleMidi = [60, 62, 64, 65, 67, 69, 71, 72];
    for (let note = 0; note < noteCount; note += 1) {
      const start = Math.round(note * noteDurationSec * sampleRate);
      const length = Math.round(noteDurationSec * sampleRate);
      const freq = midiToFreq(scaleMidi[note % scaleMidi.length]);
      for (let i = 0; i < length && start + i < totalSamples; i += 1) {
        pcm[start + i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
      }
    }

    const startedAt = performance.now();
    const result = extractMainMelody(pcm, sampleRate);
    const elapsedMs = performance.now() - startedAt;

    expect(result.notes.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(6000);
    // 输出便于人工核对（vitest 会打印 console 输出）
    console.log(
      `[perf] 60s 44.1kHz 主旋律提取耗时 ${(elapsedMs / 1000).toFixed(2)}s，`
        + `音符 ${result.notes.length}，method=${result.method}，polyphony=${result.polyphonyScore}`,
    );
  }, 30000);
});
