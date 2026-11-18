/**
 * 谐波显著度（harmonic salience）与谱峰分析。
 *
 * 主旋律提取需要回答两个问题：
 * 1. “这一帧可能是什么音高？”——对音域内的每个 MIDI 候选，累加其 1~6 次谐波处的
 *    压缩谱幅度（harmonic summation / HPS），得到谐波显著度；
 * 2. “输入到底是单声部还是复音？”——统计谱峰数量、非谐波关系的强谱峰占比、
 *    低频（贝斯）能量占比与打击能量占比，汇总成 0..1 的 polyphonyScore。
 *
 * 为提高“伴奏很响时仍能跟住主旋律”的鲁棒性，这里做了三件事：
 * - 对数压缩：压缩谱动态范围，避免响度大的伴奏把弱旋律完全压住；
 * - 背景扣除：减去本帧压缩谱的中值（噪声底），让“没有谐波”的候选自然归零；
 * - 音域先验：越靠近音域中心权重越高，同时给中高音区轻微 prefer（主旋律通常偏高）。
 *
 * 纯 TypeScript、零第三方依赖。
 */

import { clamp } from './dsp';
import type { MagnitudeSpectrogram } from './hpss';
import { midiToFreq } from './pitch';

/** 谐波显著度参数 */
export interface SalienceOptions {
  sampleRate: number;
  /** 最低 MIDI 音高（整数，含端点） */
  pitchMin: number;
  /** 最高 MIDI 音高（整数，含端点） */
  pitchMax: number;
  /** 参与累加的谐波次数，默认 6（1..8） */
  harmonicCount?: number;
  /** 静音门限：帧能量低于全局最大帧能量的该比例视为静音，默认 1e-4 */
  energyGate?: number;
}

/** 谐波显著度矩阵（按帧优先排列） */
export interface SalienceMatrix {
  /** values[frame * pitchCount + index] ∈ 0..1（已扣背景、乘先验、逐帧峰值归一化） */
  values: Float32Array;
  frameCount: number;
  pitchCount: number;
  /** 候选音高对应的整数 MIDI（升序） */
  midis: Int16Array;
  /** 每帧归一化能量 0..1（相对全局最大帧能量） */
  frameEnergy: Float32Array;
  /** 每帧音高清晰度 0..1（谱峰尖锐度 × 显著度突出度；噪声帧接近 0） */
  frameClarity: Float32Array;
  /** 每帧最可能的候选下标（无清晰音高时为 -1） */
  frameBest: Int16Array;
  /** 帧移对应时长（秒） */
  hopSec: number;
}

/** 谐波显著度默认参数 */
const DEFAULT_HARMONIC_COUNT = 6;
/** 静音能量门限默认值 */
const DEFAULT_ENERGY_GATE = 1e-4;
/** 谐波幅度权重指数：w_h = 1 / h^0.7，稍强调基频与低次谐波 */
const HARMONIC_WEIGHT_EXPONENT = 0.7;
/** 压缩谱的参考幅度：帧 RMS 幅度的该倍数 */
const COMPRESSION_REFERENCE_RATIO = 0.1;
/** 扣除背景时取中值的比例（保留一半噪声底，避免过度削峰） */
const NOISE_FLOOR_SUBTRACT_RATIO = 0.6;
/** 判定“有清晰音高”的 clarity 下限（只影响 frameBest，便于调试） */
const CLEAR_PITCH_CLARITY = 0.15;
/** 谱峰检测门限：低于本帧最大幅度的该比例不算谱峰 */
const PEAK_RELATIVE_FLOOR = 0.1;
/** 判定“非谐波强谱峰”的相对幅度门限（相对最强峰） */
const SECONDARY_PEAK_RELATIVE = 0.28;
/** 判定第二个显著度峰为“并列主音”的相对门限 */
const SECONDARY_SALIENCE_RELATIVE = 0.55;
/** 低频（贝斯/底鼓）统计上限（Hz） */
const LOW_FREQ_LIMIT = 180;
/** 复音统计参与门限：clarity 低于该值的帧不参与谱峰统计 */
const VOICED_CLARITY_FOR_POLYPHONY = 0.2;
/** 单帧最多收集的谱峰数 */
const MAX_PEAKS_PER_FRAME = 48;

/** 预计算每个候选音高的先验权重（音域先验 + 中高音区偏好） */
function buildPitchPrior(pitchMin: number, pitchMax: number): Float64Array {
  const count = pitchMax - pitchMin + 1;
  const center = (pitchMin + pitchMax) / 2;
  const halfSpan = Math.max(1, (pitchMax - pitchMin) / 2);
  const span = Math.max(1, pitchMax - pitchMin);
  const prior = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const midi = pitchMin + i;
    // 音域先验：越靠近音域中心权重越高（抑制极端音区的错误候选）
    const rangePrior = 1 - 0.18 * (Math.abs(midi - center) / halfSpan) ** 2;
    // 中高音区偏好：主旋律通常落在中高音区，给一条缓坡（不是硬性 skyline）
    const registerPrior = 0.82 + 0.4 * ((midi - pitchMin) / span);
    prior[i] = rangePrior * registerPrior;
  }
  return prior;
}

/** 线性插值读取压缩谱在 position（频点，浮点）处的值 */
function interpolateValue(
  compressed: Float64Array,
  binCount: number,
  position: number,
): number {
  if (position <= 0) return compressed[0];
  if (position >= binCount - 1) return compressed[binCount - 1];
  const index = Math.floor(position);
  const frac = position - index;
  return compressed[index] + (compressed[index + 1] - compressed[index]) * frac;
}

/** 中位数（会原地排序传入的数组） */
function medianInPlace(values: Float64Array, length: number): number {
  const sorted = values.subarray(0, length);
  sorted.sort();
  const middle = length >>> 1;
  if (length % 2 === 1) return sorted[middle];
  return 0.5 * (sorted[middle - 1] + sorted[middle]);
}

/** 两个频率是否成整数倍谐波关系（含同音/八度/五度泛音列），用于区分“单一乐器泛音”和“多声部” */
function isHarmonicallyRelated(freqA: number, freqB: number): boolean {
  if (!(freqA > 0) || !(freqB > 0)) return false;
  const ratio = freqB >= freqA ? freqB / freqA : freqA / freqB;
  if (Math.abs(ratio - 1) < 0.03) return true; // 同音（含轻微 detune）
  const harmonic = Math.round(ratio);
  if (harmonic >= 2 && harmonic <= 8) {
    // 允许约 ±3% 的频偏（临时的滑音/颤音不会把谐波判成独立声部）
    return Math.abs(ratio - harmonic) <= 0.03 * harmonic + 0.01;
  }
  return false;
}

/**
 * 计算逐帧谐波显著度矩阵。
 *
 * 特点：
 * - 先对每帧压缩谱做中值背景扣除，再按 1~6 次谐波加权累加，最后乘音域先验并逐帧峰值归一化；
 * - 同时输出 frameClarity（谱峰尖锐度 × 显著度突出度），用于噪声/静音帧的排除；
 * - 复杂度 O(帧数 × 候选数 × 谐波数)，60 秒音频通常 < 100ms。
 */
export function computeSalience(
  spectrogram: MagnitudeSpectrogram,
  options: SalienceOptions,
): SalienceMatrix {
  const { magnitude, frameCount, binCount, frameSize, hopSec } = spectrogram;
  const pitchMin = Math.round(options.pitchMin);
  const pitchMax = Math.max(pitchMin + 1, Math.round(options.pitchMax));
  const pitchCount = pitchMax - pitchMin + 1;
  const harmonicCount = clamp(Math.round(options.harmonicCount ?? DEFAULT_HARMONIC_COUNT), 1, 8);
  const energyGate = clamp(options.energyGate ?? DEFAULT_ENERGY_GATE, 1e-9, 0.1);
  const sampleRate = options.sampleRate;
  const binWidth = sampleRate / frameSize;

  const midis = new Int16Array(pitchCount);
  const midiFreqs = new Float64Array(pitchCount);
  for (let i = 0; i < pitchCount; i += 1) {
    midis[i] = pitchMin + i;
    midiFreqs[i] = midiToFreq(pitchMin + i);
  }
  const prior = buildPitchPrior(pitchMin, pitchMax);
  const harmonicWeights = new Float64Array(harmonicCount);
  for (let h = 1; h <= harmonicCount; h += 1) {
    harmonicWeights[h - 1] = 1 / h ** HARMONIC_WEIGHT_EXPONENT;
  }

  const out: SalienceMatrix = {
    values: new Float32Array(frameCount * pitchCount),
    frameCount,
    pitchCount,
    midis,
    frameEnergy: new Float32Array(frameCount),
    frameClarity: new Float32Array(frameCount),
    frameBest: new Int16Array(frameCount),
    hopSec,
  };
  if (frameCount === 0 || binCount === 0) {
    out.frameBest.fill(-1);
    return out;
  }

  // 1) 逐帧能量 + 全局峰值（用于静音门限与归一化）
  const frameEnergyRaw = new Float64Array(frameCount);
  let globalMaxEnergy = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * binCount;
    let energy = 0;
    for (let bin = 0; bin < binCount; bin += 1) {
      const value = magnitude[offset + bin];
      energy += value * value;
    }
    frameEnergyRaw[frame] = energy;
    if (energy > globalMaxEnergy) globalMaxEnergy = energy;
  }
  const silenceThreshold = globalMaxEnergy * energyGate;

  const compressed = new Float64Array(binCount);
  const sortScratch = new Float64Array(binCount);
  const rawSalience = new Float64Array(pitchCount);
  const valueScratch = new Float64Array(pitchCount);
  // 每帧归一化值缓存在 values 中，frameBest 在归一化后选取
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * binCount;
    const energy = frameEnergyRaw[frame];
    out.frameEnergy[frame] = globalMaxEnergy > 1e-12 ? clamp(energy / globalMaxEnergy, 0, 1) : 0;

    if (!(energy > silenceThreshold) || energy < 1e-14) {
      out.frameClarity[frame] = 0;
      out.frameBest[frame] = -1;
      continue;
    }

    // 2) 对数压缩：参考幅度取帧 RMS 幅度，压缩后响/弱成分差距变小
    const reference = Math.sqrt(energy / binCount) * COMPRESSION_REFERENCE_RATIO + 1e-12;
    let compressedPeak = 0;
    let compressedSum = 0;
    for (let bin = 0; bin < binCount; bin += 1) {
      const value = Math.log1p(magnitude[offset + bin] / reference);
      compressed[bin] = value;
      compressedSum += value;
      if (value > compressedPeak) compressedPeak = value;
    }
    const compressedMean = compressedSum / binCount;

    // 3) 背景（噪声底）：本帧压缩谱中值；噪声帧的“峰”只比中值高一点
    sortScratch.set(compressed);
    const noiseFloor = medianInPlace(sortScratch, binCount);

    // 4) 谐波显著度：累加 1..H 次谐波处的压缩谱（扣除背景后）
    //    额外加入“基频支撑度”加权：只靠某个高次谐波幸存的候选（低八度/低十二度幽灵）
    //    会得到较强显著度，但其基频处几乎没有能量，这里按基频强度把这类候选压下去。
    const fundamentalReference = Math.max(1e-9, compressedPeak - noiseFloor);
    let rawPeak = 0;
    for (let index = 0; index < pitchCount; index += 1) {
      const f0 = midiFreqs[index];
      let acc = 0;
      let weightSum = 0;
      let fundamentalStrength = 0;
      for (let h = 1; h <= harmonicCount; h += 1) {
        const position = (f0 * h) / binWidth;
        if (position > binCount - 1) break;
        const value = Math.max(0, interpolateValue(compressed, binCount, position) - noiseFloor);
        if (h === 1) fundamentalStrength = clamp(value / fundamentalReference, 0, 1);
        const weight = harmonicWeights[h - 1];
        acc += value * weight;
        weightSum += weight;
      }
      const harmonicity = 0.35 + 0.65 * fundamentalStrength;
      const salience = (weightSum > 0 ? acc / weightSum : 0) * harmonicity;
      rawSalience[index] = salience;
      if (salience > rawPeak) rawPeak = salience;
    }

    // 5) 音高清晰度：谱峰尖锐程度（tonality）× 显著度突出度
    valueScratch.set(rawSalience);
    const rawMedian = medianInPlace(valueScratch, pitchCount);
    const tonality = clamp((compressedPeak / (compressedMean + 1e-9) - 1.2) / 2.5, 0, 1);
    const prominence = clamp((rawPeak - rawMedian) / (rawPeak + 0.05), 0, 1);
    const clarity = clamp(tonality * (0.55 + 0.45 * prominence), 0, 1);
    out.frameClarity[frame] = clarity;

    // 6) 扣背景 + 音域先验 + 逐帧峰值归一化
    const valueOffset = frame * pitchCount;
    const subtract = rawMedian * NOISE_FLOOR_SUBTRACT_RATIO;
    let normalizedPeak = 0;
    for (let index = 0; index < pitchCount; index += 1) {
      const value = Math.max(0, rawSalience[index] - subtract) * prior[index];
      out.values[valueOffset + index] = value;
      if (value > normalizedPeak) normalizedPeak = value;
    }
    if (normalizedPeak > 1e-9) {
      const gain = 1 / normalizedPeak;
      for (let index = 0; index < pitchCount; index += 1) {
        out.values[valueOffset + index] *= gain;
      }
    }

    // 7) 帧内最强候选（clarity 太低时不记录，便于调试/回退）
    if (clarity >= CLEAR_PITCH_CLARITY && normalizedPeak > 1e-9) {
      let bestIndex = 0;
      let bestValue = -1;
      for (let index = 0; index < pitchCount; index += 1) {
        const value = out.values[valueOffset + index];
        if (value > bestValue) {
          bestValue = value;
          bestIndex = index;
        }
      }
      out.frameBest[frame] = bestIndex;
    } else {
      out.frameBest[frame] = -1;
    }
  }

  return out;
}

/**
 * 估计输入的“复音程度”（0..1，越高越像带伴奏/多声部）。
 *
 * 统计口径（只统计有清晰音高的帧）：
 * - 谱峰法：最强峰之外是否存在非整数倍谐波关系的强谱峰（0.28×最强峰以上）；
 * - 显著度法：同一帧显式出现两个间隔 >2 个半音、强度接近的主音候选；
 * - 低频能量占比：贝斯/底鼓等低频伴奏能量；
 * - 打击能量占比：HPSS 给出的 percussiveRatio（没开 HPSS 时为 0）。
 *
 * auto 模式用该分数在单声部/复音两条候选之间选择。
 */
export function estimatePolyphonyScore(
  spectrogram: MagnitudeSpectrogram,
  salience: SalienceMatrix,
  percussiveRatio?: Float32Array | null,
): number {
  const { magnitude, frameCount, binCount, frameSize, sampleRate } = spectrogram;
  if (frameCount === 0 || salience.frameCount === 0) return 0;

  const binWidth = sampleRate / frameSize;
  const lowBin = Math.min(binCount - 1, Math.max(1, Math.floor(LOW_FREQ_LIMIT / binWidth)));
  const peakBins = new Int32Array(MAX_PEAKS_PER_FRAME);
  const peakMags = new Float64Array(MAX_PEAKS_PER_FRAME);

  let voicedFrames = 0;
  let multiVoiceFrames = 0;
  let secondarySalienceFrames = 0;
  let lowEnergy = 0;
  let totalEnergy = 0;
  let percussiveSum = 0;
  let percussiveFrames = 0;

  const pitchCount = salience.pitchCount;
  const offsetValues = (frame: number): number => frame * pitchCount;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const clarity = salience.frameClarity[frame];
    const energyRatio = salience.frameEnergy[frame];
    if (clarity < VOICED_CLARITY_FOR_POLYPHONY || energyRatio <= 0) continue;
    voicedFrames += 1;
    const offset = frame * binCount;

    // 帧能量与低频能量
    let energy = 0;
    let low = 0;
    for (let bin = 0; bin < binCount; bin += 1) {
      const value = magnitude[offset + bin];
      const power = value * value;
      energy += power;
      if (bin <= lowBin) low += power;
    }
    totalEnergy += energy;
    lowEnergy += low;

    if (percussiveRatio && percussiveRatio.length > frame) {
      percussiveSum += percussiveRatio[frame];
      percussiveFrames += 1;
    }

    // 显著度法：最强候选与“间隔 >2 半音”的次强候选是否接近
    const base = offsetValues(frame);
    let bestIndex = 0;
    let bestValue = -1;
    for (let index = 0; index < pitchCount; index += 1) {
      const value = salience.values[base + index];
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (bestValue > 1e-6) {
      let secondValue = 0;
      for (let index = 0; index < pitchCount; index += 1) {
        if (Math.abs(index - bestIndex) <= 2) continue;
        const value = salience.values[base + index];
        if (value > secondValue) secondValue = value;
      }
      if (secondValue >= SECONDARY_SALIENCE_RELATIVE * bestValue) secondarySalienceFrames += 1;
    }

    // 谱峰法：检测本帧局部极大值，判断除最强峰外是否还有非谐波强峰
    let frameMax = 0;
    for (let bin = 1; bin < binCount - 1; bin += 1) {
      const value = magnitude[offset + bin];
      if (value > frameMax) frameMax = value;
    }
    if (frameMax <= 1e-9) continue;
    let peakCount = 0;
    for (let bin = 1; bin < binCount - 1 && peakCount < MAX_PEAKS_PER_FRAME; bin += 1) {
      const value = magnitude[offset + bin];
      if (value < PEAK_RELATIVE_FLOOR * frameMax) continue;
      if (value < magnitude[offset + bin - 1] || value < magnitude[offset + bin + 1]) continue;
      peakBins[peakCount] = bin;
      peakMags[peakCount] = value;
      peakCount += 1;
    }
    if (peakCount < 2) continue;

    let strongestIndex = 0;
    for (let i = 1; i < peakCount; i += 1) {
      if (peakMags[i] > peakMags[strongestIndex]) strongestIndex = i;
    }
    const strongestFreq = peakBins[strongestIndex] * binWidth;
    const strongestMag = peakMags[strongestIndex];
    for (let i = 0; i < peakCount; i += 1) {
      if (i === strongestIndex) continue;
      if (peakMags[i] < SECONDARY_PEAK_RELATIVE * strongestMag) continue;
      const freq = peakBins[i] * binWidth;
      if (!isHarmonicallyRelated(strongestFreq, freq)) {
        multiVoiceFrames += 1;
        break;
      }
    }
  }

  if (voicedFrames === 0) return 0;

  const multiVoiceRatio = multiVoiceFrames / voicedFrames;
  const secondaryRatio = secondarySalienceFrames / voicedFrames;
  const lowFreqRatio = totalEnergy > 1e-12 ? lowEnergy / totalEnergy : 0;
  const percussiveMean = percussiveFrames > 0 ? percussiveSum / percussiveFrames : 0;

  const score =
    0.5 * multiVoiceRatio +
    0.3 * secondaryRatio +
    0.12 * clamp(lowFreqRatio * 2.5, 0, 1) +
    0.08 * clamp(percussiveMean * 2.5, 0, 1);
  return clamp(score, 0, 1);
}
