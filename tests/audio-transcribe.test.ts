/**
 * 音频转谱 DSP 测试（vitest，node 环境）。
 *
 * 全部使用自行合成的 PCM 数据，不读取外部音频文件、不访问网络：
 * - 正弦音阶旋律 → 音符数量/音高/顺序；
 * - 静音 / 白噪声 → 空音符且不抛异常；
 * - 120BPM 点击轨 → BPM 115–125；
 * - C4→C5 八度跳变 → 不被粘成一个音；
 * - 3 分钟 44.1kHz 性能烟测（设置 AUDIO_PERF=1 时启用）。
 */
import { describe, expect, it } from 'vitest';

import {
  detectOnsets,
  detectPitchYin,
  estimateTempo,
  transcribeMelody,
} from '@core/audio';

const SAMPLE_RATE = 22050;

/** MIDI → 频率（Hz） */
function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 合成一段带 10ms 线性淡入淡出的正弦音 */
function synthSine(
  midi: number,
  durationSec: number,
  sampleRate = SAMPLE_RATE,
  amplitude = 0.4,
  fadeSec = 0.01,
): Float32Array {
  const length = Math.round(durationSec * sampleRate);
  const fadeSamples = Math.max(1, Math.round(fadeSec * sampleRate));
  const freq = midiToFreq(midi);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const fadeIn = Math.min(1, i / fadeSamples);
    const fadeOut = Math.min(1, (length - 1 - i) / fadeSamples);
    out[i] = amplitude * Math.min(fadeIn, fadeOut) * Math.sin((2 * Math.PI * freq * i) / sampleRate);
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

/** 合成 120BPM 点击轨：每拍一个指数衰减噪声脉冲 */
function synthClickTrack(bpm: number, durationSec: number, sampleRate = SAMPLE_RATE): Float32Array {
  const length = Math.round(durationSec * sampleRate);
  const out = new Float32Array(length);
  const random = createRandom(20261118);
  const periodSec = 60 / bpm;
  const clickLength = Math.max(1, Math.round(0.02 * sampleRate));
  const decaySamples = Math.max(1, Math.round(0.004 * sampleRate));
  for (let beat = 0; beat * periodSec < durationSec; beat += 1) {
    const start = Math.round(beat * periodSec * sampleRate);
    for (let j = 0; j < clickLength && start + j < length; j += 1) {
      const decay = Math.exp(-j / decaySamples);
      out[start + j] += 0.5 * decay * (random() * 2 - 1);
    }
  }
  return out;
}

describe('transcribeMelody：合成正弦音阶旋律', () => {
  it('检测到约 5 个音符，音高误差 ≤1 半音且顺序正确', () => {
    const expectedMidi = [60, 62, 64, 65, 67]; // C4 D4 E4 F4 G4
    const melody = concat([
      ...expectedMidi.map((midi) => synthSine(midi, 0.25)),
      new Float32Array(Math.round(0.15 * SAMPLE_RATE)), // 尾部留一点静音
    ]);

    const result = transcribeMelody(melody, SAMPLE_RATE);

    // 音符数量 ≈ 5（允许一个边界碎音误差）
    expect(result.notes.length).toBeGreaterThanOrEqual(4);
    expect(result.notes.length).toBeLessThanOrEqual(6);
    // 顺序正确：每个音符依次对应 expectedMidi，误差 ≤1 半音
    for (let i = 0; i < expectedMidi.length; i += 1) {
      expect(Math.abs(result.notes[i].midi - expectedMidi[i])).toBeLessThanOrEqual(1);
    }
    // 音高单调上行
    const midis = result.notes.map((note) => note.midi);
    for (let i = 1; i < midis.length; i += 1) {
      expect(midis[i]).toBeGreaterThan(midis[i - 1]);
    }
    // 每个音符时长大致 250ms（≥150ms 排除碎音）
    for (const note of result.notes) {
      expect(note.durSec).toBeGreaterThanOrEqual(0.15);
      expect(note.startSec).toBeGreaterThanOrEqual(0);
    }
    expect(result.voicedRatio).toBeGreaterThan(0.5);
    expect(result.frameCount).toBeGreaterThan(50);
  });

  it('detectPitchYin 对纯音基频估计准确', () => {
    const frame = synthSine(69, 0.1); // A4 = 440Hz，只取前 1024 点
    const result = detectPitchYin(frame.subarray(0, 1024), SAMPLE_RATE);
    expect(result).not.toBeNull();
    if (result) {
      expect(Math.abs(result.freq - 440)).toBeLessThan(4);
      expect(result.clarity).toBeGreaterThan(0.8);
    }
  });
  it('44.1kHz 输入经内部降采样后仍能正确转谱', () => {
    const highRate = 44100;
    const pcm = concat([60, 62, 64].map((midi) => synthSine(midi, 0.25, highRate)));
    const result = transcribeMelody(pcm, highRate);
    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    expect(result.notes.length).toBeLessThanOrEqual(4);
    expect(Math.abs(result.notes[0].midi - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.notes[1].midi - 62)).toBeLessThanOrEqual(1);
  });
});

describe('transcribeMelody：静音与噪声', () => {
  it('纯静音返回空音符且带 warning，不抛异常', () => {
    const silence = new Float32Array(SAMPLE_RATE);
    const result = transcribeMelody(silence, SAMPLE_RATE);
    expect(result.notes).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.frameCount).toBe(0);
  });

  it('白噪声返回空音符且不抛异常', () => {
    const random = createRandom(1234);
    const noise = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (random() * 2 - 1) * 0.3;
    const result = transcribeMelody(noise, SAMPLE_RATE);
    expect(result.notes).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('空数组不抛异常', () => {
    const result = transcribeMelody(new Float32Array(0), SAMPLE_RATE);
    expect(result.notes).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('节拍估计：120BPM 点击轨', () => {
  it('detectOnsets + estimateTempo 估计 BPM 在 115–125 内', () => {
    const clickTrack = synthClickTrack(120, 4);
    const onset = detectOnsets(clickTrack, SAMPLE_RATE);
    expect(onset.frameRate).toBeGreaterThan(0);
    expect(onset.envelope.length).toBeGreaterThan(100);
    expect(onset.times.length).toBeGreaterThanOrEqual(6);

    const tempo = estimateTempo(onset.envelope, onset.frameRate);
    expect(tempo.bpm).toBeGreaterThanOrEqual(115);
    expect(tempo.bpm).toBeLessThanOrEqual(125);
    expect(tempo.confidence).toBeGreaterThan(0.25);
    expect(tempo.candidates.length).toBeGreaterThan(0);
  });

  it('转谱主流程也能给出 115–125 的 BPM', () => {
    const clickTrack = synthClickTrack(120, 4);
    const result = transcribeMelody(clickTrack, SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThanOrEqual(115);
    expect(result.bpm).toBeLessThanOrEqual(125);
  });

  it('缺少节拍信息时 BPM 回退为 100 并给出 warning', () => {
    // 持续纯音没有起音冲击，起音点过少 → 节拍不可靠，BPM 回退
    const steadyTone = synthSine(69, 1);
    const result = transcribeMelody(steadyTone, SAMPLE_RATE);
    expect(result.bpm).toBe(100);
    expect(result.warnings.some((warning) => warning.includes('BPM'))).toBe(true);
    // 旋律仍应被识别出来，只是不做节拍量化
    expect(result.notes.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(result.notes[0].midi - 69)).toBeLessThanOrEqual(1);
  });
});

describe('音符切分：半音/八度跳变', () => {
  it('C4→C#4 半音跳变会被切成两个音', () => {
    const pcm = concat([
      synthSine(60, 0.25),
      synthSine(61, 0.25),
      new Float32Array(Math.round(0.1 * SAMPLE_RATE)),
    ]);
    const result = transcribeMelody(pcm, SAMPLE_RATE);
    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(result.notes[0].midi - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.notes[1].midi - 61)).toBeLessThanOrEqual(1);
    expect(result.notes[1].midi).toBeGreaterThan(result.notes[0].midi);
  });

  it('C4→C5 八度跳变不会被粘成一个音', () => {
    const pcm = concat([
      synthSine(60, 0.25),
      synthSine(72, 0.25),
      new Float32Array(Math.round(0.1 * SAMPLE_RATE)),
    ]);
    const result = transcribeMelody(pcm, SAMPLE_RATE);
    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    const first = result.notes[0];
    const second = result.notes[1];
    expect(Math.abs(first.midi - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(second.midi - 72)).toBeLessThanOrEqual(1);
    expect(second.midi - first.midi).toBeGreaterThanOrEqual(10);
  });
});

// 性能烟测：仅当显式设置 AUDIO_PERF=1 时运行，避免常规单测耗时。
const perfEnabled = process.env.AUDIO_PERF === '1';
describe('性能：3 分钟 44.1kHz 音频', () => {
  it.skipIf(!perfEnabled)(
    '转谱耗时 < 8s（降采样 + 分帧）',
    () => {
      const sampleRate = 44100;
      // 3 分钟、每 0.25s 换一次音高的正弦旋律（720 个音）
      const noteDurationSec = 0.25;
      const totalSeconds = 180;
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
      const result = transcribeMelody(pcm, sampleRate);
      const elapsedMs = performance.now() - startedAt;

      expect(result.notes.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(8000);
      // 打印便于人工核对（vitest 会显示 console 输出）
      console.log(`[perf] 3 分钟 44.1kHz 转谱耗时 ${(elapsedMs / 1000).toFixed(2)}s，帧数 ${result.frameCount}，音符 ${result.notes.length}`);
    },
    60000,
  );
});
