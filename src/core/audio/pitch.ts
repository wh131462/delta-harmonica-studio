/**
 * YIN 基频检测（纯 TypeScript，零第三方依赖，Node 环境可运行）。
 *
 * 算法要点：
 * 1. 标准 YIN 差分函数 d(τ) = Σ_{j<W} (x_j - x_{j+τ})²，固定积分窗 W = 帧长/2；
 * 2. 利用 FFT 计算互相关 c(τ) = Σ_{j<W} x_j·x_{j+τ}，再配合前缀平方和还原 d(τ)，
 *    把每帧的 O(W²) 降到 2 次 O(N log N) FFT，避免大数组上的二次复杂度；
 * 3. 累积均值归一化差分函数（CMNDF），优先挑选“第一个清晰下潜”的局部极小，
 *    抑制倍周期（低八度）误判；
 * 4. 抛物线插值细化周期，输出频率、MIDI 与 clarity（= 1 - CMNDF 最小值）。
 *
 * 约定：输入为单声道 Float32 PCM（约 -1..1）。无声帧的 freq/midi/clarity 均为 0。
 */
import {
  clamp,
  fftInPlace,
  ifftInPlace,
  prevPowerOfTwo,
  resampleLinear,
} from './dsp';

export interface YinOptions {
  /** clarity 阈值（1 - CMNDF 最小值），低于该值视为无音高。默认 0.12 */
  threshold?: number;
  /** 最低基频（Hz），默认 55 */
  minFreq?: number;
  /** 最高基频（Hz），默认 2000 */
  maxFreq?: number;
  /** 分析帧长（样本），默认 1024；内部会向下取到 2 的幂 */
  frameSize?: number;
  /** 帧移（样本），默认 frameSize / 4 */
  hopSize?: number;
}

export interface PitchFrame {
  /** 帧中心对应的音频时间（秒） */
  timeSec: number;
  /** 基频（Hz）；无音高帧为 0 */
  freq: number;
  /** 对应的 MIDI 音高（浮点）；无音高帧为 0 */
  midi: number;
  /** 周期清晰度 0..1（1 - CMNDF 最小值）；无音高帧为 0 */
  clarity: number;
}

/** 默认 clarity 阈值（1 - CMNDF 最小值） */
export const DEFAULT_CLARITY_THRESHOLD = 0.12;
/** 默认最低基频（Hz），约 C1 */
export const DEFAULT_MIN_FREQ = 55;
/** 默认最高基频（Hz），约 B6 */
export const DEFAULT_MAX_FREQ = 2000;

/** 绝对抗噪下限：即使调用方把 threshold 调低，clarity 低于该值也判为无音高（白噪声 clarity≈0.1） */
const MIN_CLARITY_ABSOLUTE = 0.3;
/** 帧 RMS 低于该值视为静音 */
const SILENCE_RMS = 1e-6;
/** 首次下潜判定阈值：CMNDF 低于该值的局部极小才认为存在清晰周期 */
const FIRST_DIP_CMNDF = 0.25;
/** 高采样率输入的内部降采样上限（控制 3 分钟音频的耗时） */
const MAX_ANALYSIS_RATE = 24000;
const TARGET_ANALYSIS_RATE = 22050;

/** 频率（Hz）→ MIDI 音高（浮点，A4 = 69） */
export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/** MIDI 音高（可浮点）→ 频率（Hz，A4 = 69） */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 一帧音高分析结果 */
export interface YinPitchResult {
  freq: number;
  clarity: number;
}

/**
 * 预分配缓冲的 YIN 检测器：批量提取音高帧时复用同一组数组，
 * 避免逐帧分配 ~3 个 1024 长度的 Float64Array 造成 GC 抖动。
 */
interface YinDetector {
  analyze(frame: Float32Array): YinPitchResult | null;
}

function createYinDetector(
  sampleRate: number,
  frameLength: number,
  options: YinOptions,
): YinDetector {
  // FFT 长度取不超过帧长的最大 2 的幂；积分窗 W = size/2
  const size = prevPowerOfTwo(Math.max(128, Math.floor(frameLength)));
  const half = size >>> 1;

  const rawMinFreq = options.minFreq ?? DEFAULT_MIN_FREQ;
  const rawMaxFreq = options.maxFreq ?? DEFAULT_MAX_FREQ;
  const minFreq = clamp(rawMinFreq, 8, sampleRate * 0.45);
  const maxFreq = clamp(Math.max(rawMaxFreq, minFreq * 1.05), minFreq * 1.05, sampleRate * 0.48);
  // 可搜索的周期（样本）范围；τ 不能超过积分窗 W
  const lagMax = Math.max(2, Math.min(half, Math.floor(sampleRate / minFreq)));
  const lagMin = Math.max(2, Math.min(Math.ceil(sampleRate / maxFreq), lagMax - 1));
  const clarityThreshold = clamp(options.threshold ?? DEFAULT_CLARITY_THRESHOLD, 0, 1);
  // 有效门限同时考虑调用方阈值与内部抗噪下限
  const clarityGate = Math.max(clarityThreshold, MIN_CLARITY_ABSOLUTE);

  // 复用缓冲
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const diff = new Float64Array(lagMax + 1);
  const cmndf = new Float64Array(lagMax + 1);
  const prefixSq = new Float64Array(size + 1);

  const analyze = (frame: Float32Array): YinPitchResult | null => {
    if (frame.length < size) return null;

    // 1) 能量门限：静音/直流帧直接返回 null
    let energy = 0;
    for (let i = 0; i < size; i += 1) {
      const value = frame[i];
      energy += value * value;
    }
    if (!(energy > 0)) return null;
    if (Math.sqrt(energy / size) < SILENCE_RMS) return null;

    // 2) 把固定窗 a（前 W 个样本）与整帧 b 打包进一次复数 FFT：
    //    z = a + i·b，随后从 Z[k] 拆出 A[k]、B[k]，求 P = conj(A)·B。
    //    这样一次 FFT + 一次 IFFT 即可得到互相关 c(τ)。
    for (let i = 0; i < size; i += 1) {
      const value = frame[i];
      re[i] = i < half ? value : 0;
      im[i] = value;
    }
    fftInPlace(re, im);

    // 拆谱并计算互相关频域乘积（成对处理 k 与 size-k，避免额外数组）
    for (let k = 0; k <= half; k += 1) {
      const mirror = (size - k) % size;
      const zkRe = re[k];
      const zkIm = im[k];
      const zmRe = re[mirror];
      const zmIm = im[mirror];

      // A[k] = (Z[k] + conj(Z[-k])) / 2
      const akRe = (zkRe + zmRe) * 0.5;
      const akIm = (zkIm - zmIm) * 0.5;
      // B[k] = (Z[k] - conj(Z[-k])) / (2i)
      const bkRe = (zkIm + zmIm) * 0.5;
      const bkIm = (zmRe - zkRe) * 0.5;
      const pkRe = akRe * bkRe + akIm * bkIm;
      const pkIm = akRe * bkIm - akIm * bkRe;

      if (mirror === k) {
        re[k] = pkRe;
        im[k] = pkIm;
        continue;
      }

      // A[-k] / B[-k] / P[-k]
      const amRe = (zmRe + zkRe) * 0.5;
      const amIm = (zmIm - zkIm) * 0.5;
      const bmRe = (zmIm + zkIm) * 0.5;
      const bmIm = (zkRe - zmRe) * 0.5;
      const pmRe = amRe * bmRe + amIm * bmIm;
      const pmIm = amRe * bmIm - amIm * bmRe;

      re[k] = pkRe;
      im[k] = pkIm;
      re[mirror] = pmRe;
      im[mirror] = pmIm;
    }

    ifftInPlace(re, im);
    // 现在 re[τ] = c(τ) = Σ_{j<W} x_j·x_{j+τ}

    // 3) 前缀平方和 → 固定窗差分函数
    prefixSq[0] = 0;
    for (let i = 0; i < size; i += 1) {
      const value = frame[i];
      prefixSq[i + 1] = prefixSq[i] + value * value;
    }
    const energyA = prefixSq[half];
    diff[0] = 0;
    for (let tau = 1; tau <= lagMax; tau += 1) {
      const energyB = prefixSq[tau + half] - prefixSq[tau];
      let value = energyA + energyB - 2 * re[tau];
      if (value < 0) value = 0; // 数值误差保护
      diff[tau] = value;
    }

    // 4) 累积均值归一化差分函数（CMNDF）
    cmndf[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= lagMax; tau += 1) {
      running += diff[tau];
      cmndf[tau] = running > 1e-12 ? (diff[tau] * tau) / running : 1;
    }

    // 5) 候选周期：优先“第一个清晰下潜”的局部极小，避免选到 2 倍周期
    let selected = -1;
    let selectedValue = Number.POSITIVE_INFINITY;
    for (let tau = lagMin; tau <= lagMax; tau += 1) {
      const value = cmndf[tau];
      if (value < FIRST_DIP_CMNDF) {
        let refined = tau;
        while (refined + 1 <= lagMax && cmndf[refined + 1] < cmndf[refined]) refined += 1;
        selected = refined;
        selectedValue = cmndf[refined];
        break;
      }
      if (value < selectedValue) {
        selectedValue = value;
        selected = tau;
      }
    }
    if (selected < 0) return null;

    const clarity = 1 - selectedValue;
    if (clarity < clarityGate) return null;

    // 6) 抛物线插值细化周期
    let delta = 0;
    if (selected > 1 && selected < lagMax) {
      const y0 = cmndf[selected - 1];
      const y1 = selectedValue;
      const y2 = cmndf[selected + 1];
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-12) {
        delta = clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5);
      }
    }
    const period = selected + delta;
    if (!(period > 0)) return null;
    const freq = sampleRate / period;
    if (!Number.isFinite(freq)) return null;
    // 插值后越界通常是不稳定帧，直接丢弃
    if (freq < minFreq * 0.94 || freq > maxFreq * 1.06) return null;

    return { freq, clarity: clamp(clarity, 0, 1) };
  };

  return { analyze };
}

/**
 * 对单帧 PCM 做 YIN 基频检测。
 * @param frame 单帧单声道样本（建议长度 ≥ 128，推荐 2 的幂如 1024）
 * @returns 有音高时返回 { freq, clarity }，否则 null
 */
export function detectPitchYin(
  frame: Float32Array,
  sampleRate: number,
  options: YinOptions = {},
): YinPitchResult | null {
  if (!(sampleRate > 0) || frame.length < 128) return null;
  const detector = createYinDetector(sampleRate, frame.length, options);
  return detector.analyze(frame);
}

/**
 * 对整段 PCM 分帧提取音高轨迹。
 *
 * - 采样率高于约 24kHz 时内部先线性降采样到 22050Hz（耗时可控，频率范围足够）；
 * - 返回的 timeSec 是帧中心时间（秒），无音高帧 freq/midi/clarity 均为 0；
 * - frameSize/hopSize 以“分析采样率”的样本数计。
 */
export function extractPitchFrames(
  pcm: Float32Array,
  sampleRate: number,
  options: YinOptions = {},
): PitchFrame[] {
  if (!(sampleRate > 0) || pcm.length === 0) return [];

  const analysisRate = sampleRate > MAX_ANALYSIS_RATE ? TARGET_ANALYSIS_RATE : sampleRate;
  const data = analysisRate === sampleRate ? pcm : resampleLinear(pcm, sampleRate, analysisRate);

  const frameSize = Math.max(64, Math.floor(options.frameSize ?? 1024));
  const hopSize = Math.max(1, Math.floor(options.hopSize ?? (frameSize >> 2)));
  if (data.length < frameSize) return [];

  const detector = createYinDetector(analysisRate, frameSize, options);
  const frameCount = Math.floor((data.length - frameSize) / hopSize) + 1;
  const frames: PitchFrame[] = new Array(frameCount);

  for (let index = 0; index < frameCount; index += 1) {
    const start = index * hopSize;
    const result = detector.analyze(data.subarray(start, start + frameSize));
    const timeSec = (start + frameSize / 2) / analysisRate;
    if (result && result.clarity > 0) {
      frames[index] = {
        timeSec,
        freq: result.freq,
        midi: freqToMidi(result.freq),
        clarity: result.clarity,
      };
    } else {
      frames[index] = { timeSec, freq: 0, midi: 0, clarity: 0 };
    }
  }

  return frames;
}
