/**
 * HPSS（Harmonic / Percussive Source Separation，谐波/打击源分离）与 STFT 工具。
 *
 * 用途：带伴奏歌曲里的鼓、拍手、打击乐在频谱上呈现“宽频带 + 时间瞬态”，
 * 而旋律/和声则是“频率上窄、时间上连续”的水平谱线。HPSS 用两个方向的中值滤波
 * 分别估计谐波成分（沿时间轴取中值）与打击成分（沿频率轴取中值），再用软掩码
 * 把幅度谱拆开；主旋律提取只依赖谐波分量，就能显著抑制鼓点造成的假音符。
 *
 * 实现要点（纯 TypeScript、零第三方依赖，仅复用 dsp.ts 的 radix-2 FFT）：
 * 1. STFT：周期 Hann 窗 1024 / hop 256（22050Hz 下约 46ms 窗、11.6ms 帧移）；
 * 2. 时间中值滤波：对每个频点维护“有序滑动缓冲”，插入/删除用二分定位，
 *    把每个频点的时间中值滤波从 O(帧数·窗长·log窗长) 降到约 O(帧数·窗长)；
 * 3. 频率中值滤波：每帧内部滑动，实现与上面同复杂度；
 * 4. 软掩码：maskH = H^p / (H^p + P^p)，谐波幅度 = 原幅度 × maskH，
 *    避免硬掩码在鼓点/旋律重叠处产生“空洞”；
 * 5. 可选的重建：用谐波掩码对原始 STFT 做逆变换 + 重叠相加，得到谐波分量时域信号，
 *    供单声部 YIN 使用（抑制打击乐对基频检测的干扰）。
 */

import { clamp, fftInPlace, ifftInPlace, prevPowerOfTwo } from './dsp';

/** STFT 参数 */
export interface StftOptions {
  /** 分析帧长（样本，内部向下取到 2 的幂），默认 1024 */
  frameSize?: number;
  /** 帧移（样本），默认 frameSize / 4（即 256） */
  hopSize?: number;
}

/** 幅度谱：magnitude[frame * binCount + bin]，按帧优先排列 */
export interface MagnitudeSpectrogram {
  magnitude: Float32Array;
  frameCount: number;
  /** 频点数 = frameSize / 2 + 1 */
  binCount: number;
  frameSize: number;
  hopSize: number;
  sampleRate: number;
  /** 每帧对应时长（秒） */
  hopSec: number;
}

/** HPSS 参数 */
export interface HpssOptions {
  /** 沿时间轴的中值滤波窗长（帧，奇数），默认 17，约 200ms @22050Hz/hop256 */
  harmonicKernelFrames?: number;
  /** 沿频率轴的中值滤波窗长（频点，奇数），默认 9，约 190Hz @22050Hz/1024 */
  percussiveKernelBins?: number;
  /** 软掩码幂次，默认 2（维纳型掩码） */
  maskExponent?: number;
}

/** HPSS 分离结果（只保留谐波幅度谱，节省长音频的内存） */
export interface HpssResult {
  /** 软掩码后的谐波幅度谱（与输入同布局） */
  harmonic: Float32Array;
  /** 每帧谐波能量占比 0..1 */
  harmonicRatio: Float32Array;
  /** 每帧打击能量占比 0..1 */
  percussiveRatio: Float32Array;
  /** 全局打击能量占比 0..1（鼓组/噪声混音的可解释指标） */
  globalPercussiveRatio: number;
}

/** 默认分析帧长（样本）：46ms @22050Hz，兼顾低频分辨率和时间定位 */
const DEFAULT_FRAME_SIZE = 1024;
/** 默认帧移（样本）：11.6ms @22050Hz，足够区分 70ms 的最短音符 */
const DEFAULT_HOP_SIZE = 256;
/** 时间中值滤波默认窗（帧） */
const DEFAULT_HARMONIC_KERNEL_FRAMES = 17;
/** 频率中值滤波默认窗（频点） */
const DEFAULT_PERCUSSIVE_KERNEL_BINS = 9;
/** 软掩码默认幂次 */
const DEFAULT_MASK_EXPONENT = 2;
/** 掩码分母保护项 */
const MASK_EPSILON = 1e-10;

/** Hann 窗缓存：同一帧长只算一次 */
const hannCache = new Map<number, Float64Array>();

/** 周期型 Hann 窗（端点不为 0，配合 hop = N/4 的平方和近似常数，重建更稳） */
function getHannWindow(size: number): Float64Array {
  const cached = hannCache.get(size);
  if (cached) return cached;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  hannCache.set(size, window);
  return window;
}

/** 把窗长夹到合法奇数（中值滤波窗必须为奇数） */
function toOddWindow(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = Number.isFinite(value) ? Math.round(value as number) : fallback;
  const clamped = clamp(raw, min, max);
  return clamped % 2 === 0 ? clamped + 1 : clamped;
}

/**
 * 计算幅度谱（STFT）。
 *
 * - 幅度已按 frameSize / 2 归一化：纯正弦（幅度 A）在峰值频点约等于 A，便于跨帧比较；
 * - 只处理完整帧；音频短于一帧时 frameCount = 0，由上层给出警告；
 * - 帧 i 覆盖样本 [i·hop, i·hop + frameSize)，帧中心时间为 (i·hop + frameSize/2) / sampleRate。
 */
export function computeMagnitudeSpectrogram(
  pcm: Float32Array,
  sampleRate: number,
  options: StftOptions = {},
): MagnitudeSpectrogram {
  const frameSize = prevPowerOfTwo(clamp(Math.floor(options.frameSize ?? DEFAULT_FRAME_SIZE), 64, 16384));
  const hopSize = clamp(Math.floor(options.hopSize ?? frameSize / 4), 1, frameSize);
  const binCount = (frameSize >>> 1) + 1;
  const empty = (): MagnitudeSpectrogram => ({
    magnitude: new Float32Array(0),
    frameCount: 0,
    binCount,
    frameSize,
    hopSize,
    sampleRate,
    hopSec: hopSize / (sampleRate > 0 ? sampleRate : 1),
  });
  if (!(sampleRate > 0) || pcm.length < frameSize) return empty();

  const frameCount = Math.floor((pcm.length - frameSize) / hopSize) + 1;
  const window = getHannWindow(frameSize);
  const magnitude = new Float32Array(frameCount * binCount);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const scale = 2 / frameSize; // 单边谱幅度归一化（纯音幅度 A → 约 A/2 → 再乘 2 还原）

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize;
    for (let i = 0; i < frameSize; i += 1) {
      re[i] = pcm[start + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const offset = frame * binCount;
    for (let bin = 0; bin < binCount; bin += 1) {
      magnitude[offset + bin] = Math.hypot(re[bin], im[bin]) * scale;
    }
  }

  return {
    magnitude,
    frameCount,
    binCount,
    frameSize,
    hopSize,
    sampleRate,
    hopSec: hopSize / sampleRate,
  };
}

/** 在升序缓冲中插入 value（buffer 长度需足够），返回新的有效长度 */
function sortedInsert(buffer: Float64Array, length: number, value: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buffer[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  for (let i = length; i > lo; i -= 1) buffer[i] = buffer[i - 1];
  buffer[lo] = value;
  return length + 1;
}

/** 在升序缓冲中删除一个 value（值必须存在），返回新的有效长度 */
function sortedRemove(buffer: Float64Array, length: number, value: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buffer[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < length - 1; i += 1) buffer[i] = buffer[i + 1];
  return length - 1;
}

/** 取有序缓冲的中值（偶数长度取平均） */
function medianOfSorted(buffer: Float64Array, length: number): number {
  const mid = length >>> 1;
  if (length % 2 === 1) return buffer[mid];
  return 0.5 * (buffer[mid - 1] + buffer[mid]);
}

/** 升序插入排序（只用于窗口夹取处的小数组） */
function insertionSortAscending(values: Float64Array, length: number): void {
  for (let i = 1; i < length; i += 1) {
    const value = values[i];
    let j = i - 1;
    while (j >= 0 && values[j] > value) {
      values[j + 1] = values[j];
      j -= 1;
    }
    values[j + 1] = value;
  }
}

/**
 * 沿时间轴做中值滤波（H 分量估计）：对每个频点，在 ±halfFrames 帧的窗口中取中值。
 * 中间帧用滑动有序缓冲，首尾少量帧直接夹取窗口排序，整体近似 O(帧数 × 频点数 × 窗长)。
 */
function medianFilterAlongTime(
  magnitude: Float32Array,
  frameCount: number,
  binCount: number,
  windowLength: number,
): Float32Array {
  const out = new Float32Array(frameCount * binCount);
  const half = (windowLength - 1) >>> 1;
  const sorted = new Float64Array(windowLength);
  const scratch = new Float64Array(windowLength);

  // 帧数不足一个窗口时，逐帧夹取窗口后取中值
  if (frameCount < windowLength) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const lo = Math.max(0, frame - half);
      const hi = Math.min(frameCount - 1, frame + half);
      const count = hi - lo + 1;
      for (let bin = 0; bin < binCount; bin += 1) {
        for (let k = 0; k < count; k += 1) scratch[k] = magnitude[(lo + k) * binCount + bin];
        insertionSortAscending(scratch, count);
        out[frame * binCount + bin] = medianOfSorted(scratch, count);
      }
    }
    return out;
  }

  for (let bin = 0; bin < binCount; bin += 1) {
    // 以帧 half 为中心初始化滑动窗口 [0, windowLength - 1]
    for (let k = 0; k < windowLength; k += 1) sorted[k] = magnitude[k * binCount + bin];
    insertionSortAscending(sorted, windowLength);
    out[half * binCount + bin] = medianOfSorted(sorted, windowLength);

    let length = windowLength;
    for (let frame = half + 1; frame <= frameCount - 1 - half; frame += 1) {
      length = sortedRemove(sorted, length, magnitude[(frame - half - 1) * binCount + bin]);
      length = sortedInsert(sorted, length, magnitude[(frame + half) * binCount + bin]);
      out[frame * binCount + bin] = medianOfSorted(sorted, length);
    }

    // 首部窗口夹取（帧 0 .. half-1）
    for (let frame = 0; frame < half; frame += 1) {
      const hi = Math.min(frameCount - 1, frame + half);
      const count = hi + 1;
      for (let k = 0; k < count; k += 1) scratch[k] = magnitude[k * binCount + bin];
      insertionSortAscending(scratch, count);
      out[frame * binCount + bin] = medianOfSorted(scratch, count);
    }
    // 尾部窗口夹取（帧 frameCount-half .. frameCount-1）
    for (let frame = frameCount - half; frame < frameCount; frame += 1) {
      const lo = Math.max(0, frame - half);
      const count = frameCount - lo;
      for (let k = 0; k < count; k += 1) scratch[k] = magnitude[(lo + k) * binCount + bin];
      insertionSortAscending(scratch, count);
      out[frame * binCount + bin] = medianOfSorted(scratch, count);
    }
  }

  return out;
}

/**
 * 对单帧幅度谱做沿频率轴的中值滤波（P 分量估计），结果写入 row。
 * 中间频点滑动有序缓冲，首尾频点夹取窗口排序。
 */
function medianFilterAlongFrequencyRow(
  magnitude: Float32Array,
  frameOffset: number,
  binCount: number,
  windowLength: number,
  row: Float64Array,
  sorted: Float64Array,
  scratch: Float64Array,
): void {
  const half = (windowLength - 1) >>> 1;
  if (binCount <= windowLength) {
    for (let bin = 0; bin < binCount; bin += 1) {
      const lo = Math.max(0, bin - half);
      const hi = Math.min(binCount - 1, bin + half);
      const count = hi - lo + 1;
      for (let k = 0; k < count; k += 1) scratch[k] = magnitude[frameOffset + lo + k];
      insertionSortAscending(scratch, count);
      row[bin] = medianOfSorted(scratch, count);
    }
    return;
  }

  // 以频点 half 为中心初始化滑动窗口
  for (let k = 0; k < windowLength; k += 1) sorted[k] = magnitude[frameOffset + k];
  insertionSortAscending(sorted, windowLength);
  row[half] = medianOfSorted(sorted, windowLength);

  let length = windowLength;
  for (let bin = half + 1; bin <= binCount - 1 - half; bin += 1) {
    length = sortedRemove(sorted, length, magnitude[frameOffset + bin - half - 1]);
    length = sortedInsert(sorted, length, magnitude[frameOffset + bin + half]);
    row[bin] = medianOfSorted(sorted, length);
  }

  for (let bin = 0; bin < half; bin += 1) {
    const hi = Math.min(binCount - 1, bin + half);
    const count = hi + 1;
    for (let k = 0; k < count; k += 1) scratch[k] = magnitude[frameOffset + k];
    insertionSortAscending(scratch, count);
    row[bin] = medianOfSorted(scratch, count);
  }
  for (let bin = binCount - half; bin < binCount; bin += 1) {
    const lo = Math.max(0, bin - half);
    const count = binCount - lo;
    for (let k = 0; k < count; k += 1) scratch[k] = magnitude[frameOffset + lo + k];
    insertionSortAscending(scratch, count);
    row[bin] = medianOfSorted(scratch, count);
  }
}

/**
 * HPSS：用时间中值滤波估计谐波成分、频率中值滤波估计打击成分，
 * 再用软掩码拆分原始幅度谱，返回“谐波幅度谱 + 逐帧能量占比”。
 *
 * 说明：软掩码作用在幅度谱上（维纳型），鼓点与旋律重叠处按能量比例保留，
 * 比硬掩码更少产生截断畸变；谐波谱可直接作为谐波显著度/谱峰检测的输入。
 */
export function separateHarmonics(
  spectrogram: MagnitudeSpectrogram,
  options: HpssOptions = {},
): HpssResult {
  const { magnitude, frameCount, binCount } = spectrogram;
  if (frameCount === 0 || binCount === 0) {
    return {
      harmonic: new Float32Array(0),
      harmonicRatio: new Float32Array(0),
      percussiveRatio: new Float32Array(0),
      globalPercussiveRatio: 0,
    };
  }

  const harmonicKernel = toOddWindow(options.harmonicKernelFrames, DEFAULT_HARMONIC_KERNEL_FRAMES, 3, 101);
  const percussiveKernel = toOddWindow(options.percussiveKernelBins, DEFAULT_PERCUSSIVE_KERNEL_BINS, 3, 51);
  const exponent = clamp(options.maskExponent ?? DEFAULT_MASK_EXPONENT, 1, 4);

  // 1) 两个方向的中值滤波分别估计 H / P（P 逐帧计算，不保留整张谱以省内存）
  const harmonicMedian = medianFilterAlongTime(magnitude, frameCount, binCount, harmonicKernel);
  const harmonic = harmonicMedian; // 复用同一块内存作为输出
  const percussiveRow = new Float64Array(binCount);
  const sortedRow = new Float64Array(percussiveKernel);
  const scratchRow = new Float64Array(percussiveKernel);

  const harmonicRatio = new Float32Array(frameCount);
  const percussiveRatio = new Float32Array(frameCount);
  let totalHarmonicEnergy = 0;
  let totalPercussiveEnergy = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * binCount;
    medianFilterAlongFrequencyRow(magnitude, offset, binCount, percussiveKernel, percussiveRow, sortedRow, scratchRow);

    let harmonicEnergy = 0;
    let percussiveEnergy = 0;
    for (let bin = 0; bin < binCount; bin += 1) {
      const raw = magnitude[offset + bin];
      const h = harmonicMedian[offset + bin];
      const p = percussiveRow[bin];
      const hPower = exponent === 2 ? h * h : h ** exponent;
      const pPower = exponent === 2 ? p * p : p ** exponent;
      const mask = hPower / (hPower + pPower + MASK_EPSILON);
      const hMag = raw * mask;
      const pMag = raw - hMag;
      harmonic[offset + bin] = hMag;
      harmonicEnergy += hMag * hMag;
      percussiveEnergy += pMag * pMag;
    }

    const total = harmonicEnergy + percussiveEnergy;
    const hRatio = total > 1e-12 ? harmonicEnergy / total : 0;
    harmonicRatio[frame] = hRatio;
    percussiveRatio[frame] = total > 1e-12 ? 1 - hRatio : 0;
    totalHarmonicEnergy += harmonicEnergy;
    totalPercussiveEnergy += percussiveEnergy;
  }

  const globalTotal = totalHarmonicEnergy + totalPercussiveEnergy;
  return {
    harmonic,
    harmonicRatio,
    percussiveRatio,
    globalPercussiveRatio: globalTotal > 1e-12 ? totalPercussiveEnergy / globalTotal : 0,
  };
}

/**
 * 用幅度比掩码重建时域信号（谐波分量）。
 *
 * 做法：重新做一次 STFT，把每一帧的复数谱乘以 mask = clipped(maskedMagnitude / originalMagnitude)，
 * 逆变换后乘 Hann 窗做重叠相加，最后按重叠窗平方和归一化（避免边缘音量起伏）。
 * 返回长度与输入 pcm 相同的 Float32Array；只处理完整帧覆盖的区间，末尾不足一帧的样本为 0。
 *
 * 调用方通常传入 separateHarmonics().harmonic 作为 maskedMagnitude，
 * 得到的波形可直接交给 YIN 做基频检测，从而在时域上抑制鼓点/打击乐的干扰。
 */
export function reconstructMaskedSignal(
  pcm: Float32Array,
  spectrogram: MagnitudeSpectrogram,
  maskedMagnitude: Float32Array,
): Float32Array {
  const { frameCount, frameSize, hopSize, binCount } = spectrogram;
  const output = new Float32Array(pcm.length);
  if (frameCount === 0 || pcm.length === 0) return output;
  if (maskedMagnitude.length !== frameCount * binCount) return output;

  const window = getHannWindow(frameSize);
  const windowSquares = new Float32Array(pcm.length);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const magnitudeScale = 2 / frameSize;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize;
    for (let i = 0; i < frameSize; i += 1) {
      re[i] = pcm[start + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    const offset = frame * binCount;
    for (let bin = 0; bin < binCount; bin += 1) {
      const originalMag = Math.hypot(re[bin], im[bin]) * magnitudeScale;
      const target = maskedMagnitude[offset + bin];
      const mask = originalMag > 1e-9 ? clamp(target / originalMag, 0, 1) : 0;
      re[bin] *= mask;
      im[bin] *= mask;
    }

    ifftInPlace(re, im);
    for (let i = 0; i < frameSize; i += 1) {
      output[start + i] += re[i] * window[i];
      windowSquares[start + i] += window[i] * window[i];
    }
  }

  for (let i = 0; i < output.length; i += 1) {
    const norm = windowSquares[i];
    if (norm > 1e-8) output[i] /= norm;
  }
  return output;
}
