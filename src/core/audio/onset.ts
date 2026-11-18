/**
 * 起音（onset）检测：谱通量法（spectral flux）。
 *
 * 每帧加 Hann 窗做 FFT，取幅度谱相对上一帧的正向差分（半波整流）并求和，
 * 得到起音包络（onset detection function）；再做局部均值去趋势、平滑、归一化，
 * 最后用自适应阈值 + 局部极大值 + 最小间隔挑出起音时间点。
 *
 * 该包络同时供 tempo.ts 做自相关 BPM 估计。纯 TypeScript，零第三方依赖。
 */
import { fftInPlace, resampleLinear } from './dsp';

export interface OnsetResult {
  /** 起音时间点（秒，升序） */
  times: number[];
  /** 起音强度包络（0..1），索引 i 对应帧起始 = i / frameRate 秒 */
  envelope: Float32Array;
  /** 包络帧率（每秒帧数） */
  frameRate: number;
}

/** 分析帧长（样本） */
const FRAME_SIZE = 1024;
/** 帧移（样本），5.8ms @22050Hz，足够区分 120BPM 附近的击打 */
const HOP_SIZE = 128;
/** 高采样率输入的内部降采样上限（控制 3 分钟音频的耗时） */
const MAX_ANALYSIS_RATE = 24000;
const TARGET_ANALYSIS_RATE = 22050;
/** 局部均值去趋势的半窗（秒） */
const DETREND_HALF_WINDOW_SEC = 0.15;
/** 起音最小间隔（秒），避免一个起音被拆成多个 */
const MIN_ONSET_GAP_SEC = 0.03;

/** 预计算 Hann 窗（周期型，端点不为 0，避免首尾帧能量损失） */
const HANN_WINDOW: Float64Array = (() => {
  const window = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME_SIZE);
  }
  return window;
})();

/** 对谱通量做局部均值去趋势 + 半波整流 + 三点平滑 + 峰值归一化 */
function buildEnvelope(flux: Float64Array, frameRate: number): Float32Array {
  const length = flux.length;
  if (length === 0) return new Float32Array(0);

  // 前缀和用于 O(1) 滑动均值
  const prefix = new Float64Array(length + 1);
  for (let i = 0; i < length; i += 1) prefix[i + 1] = prefix[i] + flux[i];

  const halfWindow = Math.max(1, Math.round(DETREND_HALF_WINDOW_SEC * frameRate));
  const detrended = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(length - 1, i + halfWindow);
    const mean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    const value = flux[i] - mean;
    detrended[i] = value > 0 ? value : 0;
  }

  // 三点平滑，抑制单帧毛刺
  const smoothed = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const prev = i > 0 ? detrended[i - 1] : detrended[i];
    const next = i < length - 1 ? detrended[i + 1] : detrended[i];
    smoothed[i] = (prev + 2 * detrended[i] + next) * 0.25;
  }

  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    if (smoothed[i] > peak) peak = smoothed[i];
  }
  const envelope = new Float32Array(length);
  if (peak > 1e-12) {
    const gain = 1 / peak;
    for (let i = 0; i < length; i += 1) envelope[i] = smoothed[i] * gain;
  }
  return envelope;
}

/** 从起音包络中挑起音点：自适应阈值 + 局部极大值 + 最小间隔 */
function pickOnsetTimes(
  envelope: Float32Array,
  frameRate: number,
  centerOffsetFrames: number,
): number[] {
  const length = envelope.length;
  if (length < 3) return [];
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < length; i += 1) {
    const value = envelope[i];
    if (value > peak) peak = value;
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / length;
  const std = Math.sqrt(Math.max(0, sumSq / length - mean * mean));
  const threshold = Math.max(0.12 * peak, mean + 1.2 * std);

  const minGapFrames = Math.max(1, Math.round(MIN_ONSET_GAP_SEC * frameRate));
  const candidates: Array<{ index: number; value: number }> = [];
  for (let i = 1; i < length - 1; i += 1) {
    const value = envelope[i];
    if (value < threshold) continue;
    if (value < envelope[i - 1] || value < envelope[i + 1]) continue;
    candidates.push({ index: i, value });
  }
  // 按强度贪心挑选，保证起音点之间的最小间隔
  candidates.sort((a, b) => b.value - a.value);
  const chosen: number[] = [];
  for (const candidate of candidates) {
    let ok = true;
    for (const index of chosen) {
      if (Math.abs(index - candidate.index) < minGapFrames) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(candidate.index);
  }
  chosen.sort((a, b) => a - b);
  // 包络帧索引对应帧起始时间，起音更接近帧中心，做固定偏移
  return chosen.map((index) => (index + centerOffsetFrames) / frameRate);
}

/**
 * 检测起音点并返回起音包络。
 *
 * - 采样率高于约 24kHz 时先线性降采样到 22050Hz（帧长 1024 / 帧移 128 保持不变）；
 * - 返回的 frameRate 是分析后的包络帧率（Hz）；
 * - envelope[i] 对应时间 i / frameRate 秒。
 */
export function detectOnsets(pcm: Float32Array, sampleRate: number): OnsetResult {
  const safeRate = sampleRate > 0 ? sampleRate : 0;
  if (!(safeRate > 0) || pcm.length === 0) {
    return { times: [], envelope: new Float32Array(0), frameRate: safeRate / HOP_SIZE };
  }

  const analysisRate = safeRate > MAX_ANALYSIS_RATE ? TARGET_ANALYSIS_RATE : safeRate;
  const data = analysisRate === safeRate ? pcm : resampleLinear(pcm, safeRate, analysisRate);
  const frameRate = analysisRate / HOP_SIZE;
  const frameCount = data.length >= FRAME_SIZE
    ? Math.floor((data.length - FRAME_SIZE) / HOP_SIZE) + 1
    : 0;
  if (frameCount === 0) {
    return { times: [], envelope: new Float32Array(0), frameRate };
  }

  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  const binCount = FRAME_SIZE / 2 + 1;
  const magnitudes = new Float64Array(binCount);
  const previousMagnitudes = new Float64Array(binCount);
  const flux = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      re[i] = data[start + i] * HANN_WINDOW[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    let sum = 0;
    for (let bin = 1; bin < binCount; bin += 1) {
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
      magnitudes[bin] = magnitude;
      const difference = magnitude - previousMagnitudes[bin];
      if (difference > 0) sum += difference;
      previousMagnitudes[bin] = magnitude;
    }
    flux[frame] = sum;
  }

  const envelope = buildEnvelope(flux, frameRate);
  const centerOffsetFrames = FRAME_SIZE / 2 / HOP_SIZE;
  const times = pickOnsetTimes(envelope, frameRate, centerOffsetFrames);

  return { times, envelope, frameRate };
}
