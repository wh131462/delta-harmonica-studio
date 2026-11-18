/**
 * 主旋律提取（面向“带伴奏歌曲”）。
 *
 * 目标：从混有伴奏/鼓组的歌曲音频里，提取人声/主奏乐器的主旋律音符（秒级时间 + 整数 MIDI），
 * 供上层做量化、移调、音域折叠后交给口琴演奏。纯 TypeScript、零第三方依赖，Node 可测试。
 *
 * 处理管线：
 *  1. 峰值归一化 → 线性降采样到 ~22050Hz（复用 dsp.ts）；
 *  2. STFT（Hann 1024 / hop 256）得到幅度谱；
 *  3. HPSS（hpss.ts）：谐波/打击中值滤波 + 软掩码，suppressAccompaniment 时只保留谐波分量，
 *     并重建谐波分量时域信号供单声部 YIN 使用（抑制鼓点干扰）；
 *  4. 节奏：谱通量起音包络 → estimateTempo 估计 BPM，同时得到起音点用于换音/切分；
 *  5. 谐波显著度（salience.ts）：逐帧对音域内每个 MIDI 候选累加 1~6 次谐波，得显著度矩阵；
 *     同时统计 polyphonyScore（谱峰数量/非谐波强峰/低频占比/打击占比）；
 *  6. 两种候选：
 *     - monophonic：hpss 后的时域信号 → 现有 YIN（extractPitchFrames）→ 中值/八度回填 + 迟滞切分；
 *     - polyphonic：显著度矩阵 → 八度压制 + Viterbi 连续音高跟踪（状态=音高候选 + 静音，
 *       转移代价含音高连续性、大跳/八度惩罚、起音处换音折扣）→ 起音/能量谷切分 → 八度校正；
 *  7. auto：用 polyphonyScore 选候选；若选中分支没有稳定音符而另一分支有结果，自动回退；
 *  8. 合并碎音、最短音符过滤、音域约束、最大音符数截断、置信度与 warnings 汇总。
 */

import { clamp, peakNormalizeInPlace, resampleLinear, roundTo } from './dsp';
import {
  computeMagnitudeSpectrogram,
  reconstructMaskedSignal,
  separateHarmonics,
  type HpssResult,
  type MagnitudeSpectrogram,
} from './hpss';
import { extractPitchFrames, midiToFreq, type PitchFrame } from './pitch';
import { computeSalience, estimatePolyphonyScore, type SalienceMatrix } from './salience';
import { estimateTempo } from './tempo';

// ============================ 对外固定接口 ============================

/** 主旋律提取方法（auto 模式的最终选择结果） */
export type MelodyMethod = 'monophonic' | 'polyphonic';

/** 主旋律提取参数 */
export interface MelodyOptions {
  sampleRate: number;
  /** auto = 根据 polyphonyScore 自动选择；其余为强制模式。默认 auto */
  mode?: 'auto' | 'monophonic' | 'polyphonic';
  /** 最低 MIDI 音高（含端点），默认 48（C3） */
  pitchMin?: number;
  /** 最高 MIDI 音高（含端点），默认 84（C6） */
  pitchMax?: number;
  /** 最短音符时长（毫秒），默认 70 */
  minNoteMs?: number;
  /** 逐帧音高清晰度阈值；不传时由 sensitivity 推导（默认约 0.3） */
  clarityThreshold?: number;
  /** 是否启用 HPSS 抑制伴奏/打击，默认 true */
  suppressAccompaniment?: boolean;
  /** 灵敏度 0..1，默认 0.5；越大越容易接受弱音符/低清晰度帧 */
  sensitivity?: number;
  /** 最大音符数，默认 2000 */
  maxNotes?: number;
}

/** 主旋律音符（时间为相对输入片段起点的秒数） */
export interface MelodyNote {
  /** MIDI 音高（整数） */
  midi: number;
  /** 起始时间（秒） */
  startSec: number;
  /** 持续时长（秒） */
  durSec: number;
  /** 置信度 0..1 */
  confidence: number;
}

/** 主旋律提取结果 */
export interface MelodyExtractionResult {
  notes: MelodyNote[];
  method: MelodyMethod;
  bpm: number;
  bpmConfidence: number;
  warnings: string[];
  voicedRatio: number;
  /** 0..1，越高说明输入越像复音/带伴奏 */
  polyphonyScore: number;
}

// ============================ 内部常量 ============================

/** 高采样率输入内部降采样目标（与 transcribe.ts / pitch.ts 保持一致） */
const TARGET_ANALYSIS_RATE = 22050;
/** 超过该采样率就内部降采样，控制耗时与内存 */
const MAX_ANALYSIS_RATE = 24000;
/** 分析帧长（样本） */
const FRAME_SIZE = 1024;
/** 分析帧移（样本），11.6ms @22050Hz */
const HOP_SIZE = 256;
/** 峰值低于该值视为静音 */
const SILENCE_PEAK = 1e-4;
/** 峰值低于该值给出“音量偏低”提示 */
const LOW_VOLUME_PEAK = 0.01;
/** 兜底 BPM（节拍不可靠时展示用） */
const FALLBACK_BPM = 100;
/** BPM 置信度低于该值回退 */
const LOW_BPM_CONFIDENCE = 0.3;
/** 估计节拍所需最少起音点数 */
const MIN_ONSETS_FOR_TEMPO = 4;
/** 默认最短音符时长（毫秒） */
const DEFAULT_MIN_NOTE_MS = 70;
/** 默认最大音符数 */
const DEFAULT_MAX_NOTES = 2000;
/** 默认逐帧清晰度阈值（会被 sensitivity 调整） */
const DEFAULT_CLARITY_THRESHOLD = 0.3;
/** auto 模式判定为复音的 polyphonyScore 阈值 */
const AUTO_POLYPHONY_THRESHOLD = 0.45;
/** 相邻同音高音符合并的最大间隔（秒） */
const NOTE_MERGE_GAP_SEC = 0.03;
/** 迟滞切分：偏离当前参考音高 ≤ 该值（半音）视为同音 */
const PITCH_SAME_TOLERANCE = 0.7;
/** 迟滞切分：偏离 > 该值（半音）立即切分 */
const PITCH_HOLD_TOLERANCE = 1.15;
/** 候选音高确认帧数 */
const BOUNDARY_CONFIRM_FRAMES = 2;
/** 中值滤波半径（帧） */
const MEDIAN_RADIUS = 2;
/** 长静音切分阈值（秒） */
const LONG_SILENCE_SEC = 0.03;
/** polyphonyScore 高于该值时给出复音相关提示 */
const POLYPHONY_WARNING_THRESHOLD = 0.55;
/** 复音分支中低于该置信度的音符段直接丢弃（噪声/鼓点残影） */
const MIN_POLY_NOTE_CONFIDENCE = 0.18;
/** 音符平均置信度低于该值时给出低置信度提示 */
const LOW_NOTE_CONFIDENCE = 0.35;
/** HPSS 谐波占比低于该值的分析帧在单声部候选中视为打击帧丢弃 */
const HPSS_HARMONIC_GATE = 0.35;
/** 单帧能量低于“本音符最大能量”的该比例时，认为是重新起音（用于同音重复切分） */
const ENERGY_DIP_RATIO = 0.62;
/** Viterbi 中音高高于最高活跃音时的 skyline 权重（主旋律通常是最高声部） */
const SKYLINE_BONUS_WEIGHT = 0.55;
/** Viterbi 静音状态的观测地板 */
const SILENCE_OBS_FLOOR = 0.01;
/** 起音包络去趋势半窗（秒） */
const DETREND_HALF_WINDOW_SEC = 0.15;
/** 起音最小间隔（秒） */
const MIN_ONSET_GAP_SEC = 0.03;
/** 八度校正阈值：低八度平均显著度高于当前音该倍数、且当前音绝对显著度偏低时，认为当前音是高一个八度的误判 */
const OCTAVE_CORRECTION_RATIO = 1.6;
/** 八度校正时当前音的平均显著度上限（避免把本身就很清晰的最高声部下拉） */
const OCTAVE_CORRECTION_MAX_CURRENT = 0.6;

// ============================ 内部类型 ============================

/** 内部原始音符（未四舍五入、未做最终清理） */
interface RawNote {
  startSec: number;
  endSec: number;
  midi: number;
  confidence: number;
  /** 由同音重复切分产生：最终清理时不要与相邻同音音符合并回一个音 */
  keepSeparate?: boolean;
}

/** 单声部候选结果 */
interface MonophonicCandidate {
  rawNotes: RawNote[];
  voicedRatio: number;
}

/** 复音候选结果 */
interface PolyphonicCandidate {
  rawNotes: RawNote[];
  voicedRatio: number;
}

/** 节奏分析结果 */
interface RhythmAnalysis {
  /** 起音强度包络（与 STFT 帧对齐，0..1） */
  envelope: Float32Array;
  /** 包络帧率（Hz） */
  frameRate: number;
  /** 起音点对应的 STFT 帧下标（升序） */
  onsetFrames: number[];
  bpm: number;
  bpmConfidence: number;
}

/** 最终清理参数 */
interface FinalizeOptions {
  minNoteMs: number;
  pitchMin: number;
  pitchMax: number;
  maxNotes: number;
}

/** 最终清理结果 */
interface FinalizeResult {
  notes: MelodyNote[];
  droppedOutOfRange: number;
  truncated: number;
}

// ============================ 通用小工具 ============================

/** 数值中值（会原地排序传入数组），空数组返回 0 */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const middle = values.length >>> 1;
  return values.length % 2 === 1 ? values[middle] : 0.5 * (values[middle - 1] + values[middle]);
}

/** 构造一个“空结果”，避免每个提前返回分支重复写字段 */
function emptyResult(
  warnings: string[],
  method: MelodyMethod,
  polyphonyScore = 0,
): MelodyExtractionResult {
  return {
    notes: [],
    method,
    bpm: FALLBACK_BPM,
    bpmConfidence: 0,
    warnings,
    voicedRatio: 0,
    polyphonyScore: roundTo(polyphonyScore, 3),
  };
}

// ============================ 节奏 / 起音 ============================

/**
 * 用 STFT 幅度谱计算谱通量起音包络（沿用 onset.ts 的思路：去趋势 → 半波整流 → 平滑 → 归一化），
 * 再交给 tempo.ts 估计 BPM，并从包络中挑出起音帧。
 *
 * 注意：这里用“原始幅度谱”（未做 HPSS）计算谱通量——鼓点正是节拍的信息源；
 * 主旋律跟踪用谐波分量，两者互不干扰。
 */
function analyzeRhythm(spectrogram: MagnitudeSpectrogram): RhythmAnalysis {
  const { magnitude, frameCount, binCount, hopSize, sampleRate } = spectrogram;
  const frameRate = sampleRate / hopSize;
  const empty: RhythmAnalysis = {
    envelope: new Float32Array(0),
    frameRate,
    onsetFrames: [],
    bpm: FALLBACK_BPM,
    bpmConfidence: 0,
  };
  if (frameCount < 3) return empty;

  // 1) 谱通量（只统计正向差分，抑制能量衰减段）
  const flux = new Float64Array(frameCount);
  for (let frame = 1; frame < frameCount; frame += 1) {
    const offset = frame * binCount;
    const previousOffset = offset - binCount;
    let sum = 0;
    for (let bin = 1; bin < binCount; bin += 1) {
      const difference = magnitude[offset + bin] - magnitude[previousOffset + bin];
      if (difference > 0) sum += difference;
    }
    flux[frame] = sum;
  }

  // 2) 局部均值去趋势 + 半波整流（突出起音冲击）
  const prefix = new Float64Array(frameCount + 1);
  for (let i = 0; i < frameCount; i += 1) prefix[i + 1] = prefix[i] + flux[i];
  const halfWindow = Math.max(1, Math.round(DETREND_HALF_WINDOW_SEC * frameRate));
  const detrended = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(frameCount - 1, i + halfWindow);
    const mean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    const value = flux[i] - mean;
    detrended[i] = value > 0 ? value : 0;
  }

  // 3) 三点平滑 + 峰值归一化
  const smoothed = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const previous = i > 0 ? detrended[i - 1] : detrended[i];
    const next = i < frameCount - 1 ? detrended[i + 1] : detrended[i];
    smoothed[i] = (previous + 2 * detrended[i] + next) * 0.25;
  }
  let peak = 0;
  for (let i = 0; i < frameCount; i += 1) {
    if (smoothed[i] > peak) peak = smoothed[i];
  }
  const envelope = new Float32Array(frameCount);
  if (peak > 1e-12) {
    const gain = 1 / peak;
    for (let i = 0; i < frameCount; i += 1) envelope[i] = smoothed[i] * gain;
  }

  // 4) 起音点：自适应阈值 + 局部极大值 + 最小间隔（挑强度大的优先）
  let mean = 0;
  let meanSquare = 0;
  for (let i = 0; i < frameCount; i += 1) {
    mean += envelope[i];
    meanSquare += envelope[i] * envelope[i];
  }
  mean /= frameCount;
  const std = Math.sqrt(Math.max(0, meanSquare / frameCount - mean * mean));
  const threshold = Math.max(0.12, mean + 1.2 * std);
  const minGapFrames = Math.max(1, Math.round(MIN_ONSET_GAP_SEC * frameRate));
  const candidates: Array<{ frame: number; value: number }> = [];
  for (let frame = 1; frame < frameCount - 1; frame += 1) {
    const value = envelope[frame];
    if (value < threshold) continue;
    if (value < envelope[frame - 1] || value < envelope[frame + 1]) continue;
    candidates.push({ frame, value });
  }
  candidates.sort((a, b) => b.value - a.value);
  const chosen: number[] = [];
  for (const candidate of candidates) {
    let ok = true;
    for (const frame of chosen) {
      if (Math.abs(frame - candidate.frame) < minGapFrames) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(candidate.frame);
  }
  chosen.sort((a, b) => a - b);

  const tempo = estimateTempo(envelope, frameRate);
  return {
    envelope,
    frameRate,
    onsetFrames: chosen,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
  };
}

// ============================ 复音分支：Viterbi 音高跟踪 ============================

/** 音高/静音状态转移代价（越小越容易发生） */
function transitionCost(from: number, to: number, onsetStrength: number, silenceState: number): number {
  if (from === to) return 0;
  if (from === silenceState && to === silenceState) return 0;
  if (from === silenceState) return 0.7 - 0.25 * onsetStrength;
  if (to === silenceState) return 0.6 - 0.2 * onsetStrength;
  const delta = Math.abs(to - from);
  let cost: number;
  if (delta <= 2) {
    cost = 0.28 * delta; // 级进/小跳：代价低
  } else if (delta <= 7) {
    cost = 0.75 + 0.3 * (delta - 3); // 中跳：线性加价
  } else if (delta <= 12) {
    cost = 2.1 + 0.2 * (delta - 8); // 八度以内大跳：较高代价
  } else {
    cost = 3.6; // 超过八度：极高代价（避免乱跳）
  }
  // 起音处换音代价打折：音符边界通常伴随起音
  cost += 0.5 - 0.35 * onsetStrength;
  return cost;
}

/**
 * 计算一帧的观测似然（Viterbi 发射概率）：
 * - 音高状态：谐波显著度 × 清晰度门控 × skyline 加成（主旋律通常是最高的活跃声部）；
 * - 静音状态：清晰度越低、能量越弱，静音越可能。
 */
function fillFrameObservation(
  observation: Float64Array,
  salience: SalienceMatrix,
  frame: number,
  clarityGate: number,
): void {
  const { pitchCount, values, frameClarity, frameEnergy } = salience;
  const silenceState = pitchCount;
  const clarity = frameClarity[frame];
  // 清晰度决定“静音/无音高”的可能性：噪声、鼓点等非调性帧 clarity 低，会被静音状态吸收
  let silenceLikelihood = clamp(1 - clarity * 1.8, 0, 1);
  if (frameEnergy[frame] < 0.002) silenceLikelihood = 1;
  observation[silenceState] = SILENCE_OBS_FLOOR + 0.99 * silenceLikelihood;

  const base = frame * pitchCount;
  let peak = 0;
  for (let index = 0; index < pitchCount; index += 1) {
    const value = values[base + index];
    if (value > peak) peak = value;
  }
  if (peak < 1e-6) {
    for (let index = 0; index < pitchCount; index += 1) observation[index] = 0.02;
    return;
  }

  // skyline：从高到低找“显著度局部极大值”作为本帧顶音。
  // 主旋律通常是最高声部，高于伴奏；用局部极大值（而不是简单阈值）可以避免
  // 低音区半音级抹平导致顶音判断错误。
  let highestActive = -1;
  const localThreshold = 0.4 * peak;
  for (let index = pitchCount - 1; index >= 1; index -= 1) {
    const value = values[base + index];
    if (value < localThreshold) continue;
    const left = values[base + index - 1];
    const right = index + 1 < pitchCount ? values[base + index + 1] : -1;
    if (value >= left && value >= right) {
      highestActive = index;
      break;
    }
  }
  if (highestActive < 0) {
    // 找不到明显局部峰（噪声/flat 帧）：退回“最高显著候选”
    for (let index = pitchCount - 1; index >= 0; index -= 1) {
      if (values[base + index] >= 0.6 * peak) {
        highestActive = index;
        break;
      }
    }
  }
  if (highestActive < 0) highestActive = pitchCount - 1;

  const clarityFactor = clamp(clarity / Math.max(0.05, clarityGate), 0, 1);
  for (let index = 0; index < pitchCount; index += 1) {
    const distance = Math.abs(index - highestActive);
    const skylineFactor = clamp(1 - distance / 8, 0, 1);
    const pitchLikelihood = values[base + index] * (1 + SKYLINE_BONUS_WEIGHT * skylineFactor);
    observation[index] = pitchLikelihood * clarityFactor * 0.99 + 0.01;
  }
}

/** 对音高轨迹做 3 帧中值平滑，抑制单帧抖动/毛刺 */
function smoothPitchPath(path: Int16Array): void {
  const count = path.length;
  if (count < 3) return;
  const source = path.slice();
  const window: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (source[i] < 0) continue;
    window.length = 0;
    const lo = Math.max(0, i - 1);
    const hi = Math.min(count - 1, i + 1);
    for (let j = lo; j <= hi; j += 1) {
      if (source[j] >= 0) window.push(source[j]);
    }
    if (window.length >= 2) path[i] = window[window.length >> 1];
  }
}

/**
 * 复音分支主跟踪：在谐波显著度上做 Viterbi/动态规划。
 *
 * 状态：音域内每个整数 MIDI（pitchMin..pitchMax）+ 1 个静音状态；
 * 观测：fillFrameObservation；
 * 转移：音高连续性（级进便宜、大跳贵、超八度极贵）、静音进出、起音处换音降价。
 * 复杂度 O(帧数 × 状态数²)，60 秒音频通常 < 200ms。
 */
function trackPitchPath(
  salience: SalienceMatrix,
  clarityGate: number,
  onsetEnvelope: Float32Array,
): Int16Array {
  const { frameCount, pitchCount, midis } = salience;
  const path = new Int16Array(frameCount);
  if (frameCount === 0) return path;

  const states = pitchCount + 1;
  const silenceState = pitchCount;

  const back = new Int16Array(frameCount * states);
  let previous = new Float64Array(states);
  let current = new Float64Array(states);
  const observation = new Float64Array(states);

  fillFrameObservation(observation, salience, 0, clarityGate);
  for (let state = 0; state < states; state += 1) {
    previous[state] = -Math.log(observation[state] + 1e-6);
  }

  for (let frame = 1; frame < frameCount; frame += 1) {
    fillFrameObservation(observation, salience, frame, clarityGate);
    const onsetStrength = clamp(onsetEnvelope.length > frame ? onsetEnvelope[frame] : 0, 0, 1);
    for (let state = 0; state < states; state += 1) {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestPrevious = silenceState;
      for (let from = 0; from < states; from += 1) {
        const cost = previous[from] + transitionCost(from, state, onsetStrength, silenceState);
        if (cost < bestCost) {
          bestCost = cost;
          bestPrevious = from;
        }
      }
      const emission = -Math.log(observation[state] + 1e-6);
      current[state] = bestCost + emission;
      back[frame * states + state] = bestPrevious;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  // 回溯
  let state = silenceState;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < states; candidate += 1) {
    if (previous[candidate] < bestCost) {
      bestCost = previous[candidate];
      state = candidate;
    }
  }
  for (let frame = frameCount - 1; frame >= 0; frame -= 1) {
    path[frame] = state === silenceState ? -1 : midis[state];
    if (frame > 0) state = back[frame * states + state];
  }

  smoothPitchPath(path);
  return path;
}

// ============================ 复音分支：音符切分 / 八度校正 ============================

/** 连续同音高的一段帧 */
interface PitchRun {
  startFrame: number;
  endFrame: number;
  midi: number;
}

/** 按音高轨迹切出连续段 */
function buildPitchRuns(path: Int16Array): PitchRun[] {
  const runs: PitchRun[] = [];
  let runStart = -1;
  let runMidi = -1;
  for (let frame = 0; frame < path.length; frame += 1) {
    const midi = path[frame];
    if (midi === runMidi && runStart >= 0) continue;
    if (runStart >= 0) runs.push({ startFrame: runStart, endFrame: frame - 1, midi: runMidi });
    if (midi < 0) {
      runStart = -1;
      runMidi = -1;
    } else {
      runStart = frame;
      runMidi = midi;
    }
  }
  if (runStart >= 0) runs.push({ startFrame: runStart, endFrame: path.length - 1, midi: runMidi });
  return runs;
}

/**
 * 逐段八度校正：
 * 谐波显著度可能把自己的高八度串成主旋律（尤其基频弱、2 次谐波强的音色）。
 * 这里对比同段内“当前音 / 低八度 / 高八度”的平均显著度：
 * - 低八度显著度明显更强 → 下调一个八度（可连续最多 2 次）；
 * - 当前候选很弱且高八度明显更强 → 上调一个八度（缺基频场景的保守修正）。
 */
function correctRunOctaves(
  run: PitchRun,
  salience: SalienceMatrix,
  pitchMin: number,
): number {
  const { values, pitchCount } = salience;
  const frameCountInRun = run.endFrame - run.startFrame + 1;
  if (frameCountInRun <= 0) return run.midi;

  const averageAt = (midi: number): number => {
    const index = midi - pitchMin;
    if (index < 0 || index >= pitchCount) return 0;
    let sum = 0;
    for (let frame = run.startFrame; frame <= run.endFrame; frame += 1) {
      sum += values[frame * pitchCount + index];
    }
    return sum / frameCountInRun;
  };

  let midi = run.midi;
  for (let step = 0; step < 2; step += 1) {
    const current = averageAt(midi);
    const lower = averageAt(midi - 12);
    // 只有低八度显著度“压倒性”更强、且当前音明显偏弱时才下调：
    // 如果当前音本身就是清晰的最高声部（skyline），低八度可能只是伴奏正好落在下方八度
    // （如旋律 E5 配和弦 E4），此时不应被拉低，否则会把主旋律整体带低一个八度。
    if (lower > (current + 1e-6) * OCTAVE_CORRECTION_RATIO && current < OCTAVE_CORRECTION_MAX_CURRENT) {
      midi -= 12;
      continue;
    }
    break;
  }
  const currentLow = averageAt(midi);
  const upper = averageAt(midi + 12);
  if (currentLow < 0.22 && upper > currentLow * 1.5) {
    midi += 12;
  }
  return clamp(midi, pitchMin, pitchMin + salience.pitchCount - 1);
}

/**
 * 依据起音点与能量谷切分原始音符（两条候选共用）：
 * - 只在音符内部能量出现明显下凹（< 62% 本音符最大能量）的起音处切分——
 *   这样“同音重复 / 重新起音”会被切开，而鼓点/装饰音造成的能量尖峰不会被切开；
 * - 每段至少保留 minNoteSec 时长，防止产生碎音；
 * - frameCenterOffsetSec 与 hopSec 用于把秒时间换算回 STFT 帧下标。
 */
function splitRawNotesAtEnergyDips(
  notes: RawNote[],
  onsetFrames: number[],
  frameEnergy: Float32Array,
  hopSec: number,
  frameCenterOffsetSec: number,
  minNoteSec: number,
): RawNote[] {
  if (notes.length === 0 || onsetFrames.length === 0) return notes;
  const minNoteFrames = Math.max(2, Math.round(minNoteSec / hopSec));
  const result: RawNote[] = [];

  for (const note of notes) {
    // 音符起止时间 → STFT 帧下标（帧中心时间 = frame*hop + frameCenterOffset）
    const startFrame = Math.round((note.startSec + hopSec * 0.5 - frameCenterOffsetSec) / hopSec);
    const endFrame = Math.round((note.endSec - hopSec * 0.5 - frameCenterOffsetSec) / hopSec);
    if (endFrame - startFrame + 1 < minNoteFrames * 2) {
      result.push(note);
      continue;
    }

    let maxEnergy = 0;
    for (let frame = startFrame; frame <= endFrame; frame += 1) {
      if (frame >= 0 && frame < frameEnergy.length && frameEnergy[frame] > maxEnergy) {
        maxEnergy = frameEnergy[frame];
      }
    }
    if (!(maxEnergy > 1e-6)) {
      result.push(note);
      continue;
    }

    let pieceStartSec = note.startSec;
    let pieceStartFrame = startFrame;
    let lastSplitFrame = Number.NEGATIVE_INFINITY;
    let didSplit = false;
    for (const onsetFrame of onsetFrames) {
      if (onsetFrame - pieceStartFrame < minNoteFrames) continue;
      if (endFrame - onsetFrame < minNoteFrames) continue;
      if (onsetFrame - lastSplitFrame < minNoteFrames) continue;
      // 在起音附近找能量局部极小点（重新起音前通常有明显的能量谷）
      const lo = Math.max(pieceStartFrame, onsetFrame - 1);
      const hi = Math.min(endFrame, onsetFrame + 2);
      let dipFrame = onsetFrame;
      let dipEnergy = Number.POSITIVE_INFINITY;
      for (let frame = lo; frame <= hi; frame += 1) {
        if (frame >= 0 && frame < frameEnergy.length && frameEnergy[frame] < dipEnergy) {
          dipEnergy = frameEnergy[frame];
          dipFrame = frame;
        }
      }
      if (!(dipEnergy < ENERGY_DIP_RATIO * maxEnergy)) continue;
      if (dipFrame - pieceStartFrame < minNoteFrames || endFrame - dipFrame < minNoteFrames) continue;
      const splitSec = dipFrame * hopSec + frameCenterOffsetSec - hopSec * 0.5;
      if (splitSec - pieceStartSec < minNoteSec || note.endSec - splitSec < minNoteSec) continue;
      result.push({
        startSec: pieceStartSec,
        endSec: splitSec,
        midi: note.midi,
        confidence: note.confidence,
        keepSeparate: true,
      });
      didSplit = true;
      pieceStartSec = splitSec;
      pieceStartFrame = dipFrame;
      lastSplitFrame = dipFrame;
    }
    result.push({
      startSec: pieceStartSec,
      endSec: note.endSec,
      midi: note.midi,
      confidence: note.confidence,
      ...(didSplit ? { keepSeparate: true } : {}),
    });
  }

  return result;
}

/**
 * 能量谷兜底切分（同音重复）：
 * 当起音点没能把长音切开时（例如重复音的起音与上一个音尾重叠、谱通量峰值不够突出），
 * 在音符内部寻找“能量明显下凹且随后恢复”的局部极小点切开。
 * 只处理时长 ≥ 2×minNoteSec 的音符，并要求切分后每段都不短于 minNoteSec。
 */
function splitNotesAtEnergyDipsFallback(
  notes: RawNote[],
  frameEnergy: Float32Array,
  hopSec: number,
  frameCenterOffsetSec: number,
  minNoteSec: number,
): RawNote[] {
  const minNoteFrames = Math.max(2, Math.round(minNoteSec / hopSec));
  const result: RawNote[] = [];

  for (const note of notes) {
    if (note.endSec - note.startSec < minNoteSec * 2) {
      result.push(note);
      continue;
    }
    const startFrame = Math.round((note.startSec + hopSec * 0.5 - frameCenterOffsetSec) / hopSec);
    const endFrame = Math.round((note.endSec - hopSec * 0.5 - frameCenterOffsetSec) / hopSec);
    if (endFrame - startFrame + 1 < minNoteFrames * 2) {
      result.push(note);
      continue;
    }

    let maxEnergy = 0;
    for (let frame = Math.max(0, startFrame); frame <= Math.min(endFrame, frameEnergy.length - 1); frame += 1) {
      if (frameEnergy[frame] > maxEnergy) maxEnergy = frameEnergy[frame];
    }
    if (!(maxEnergy > 1e-6)) {
      result.push(note);
      continue;
    }

    let pieceStartSec = note.startSec;
    let pieceStartFrame = startFrame;
    let lastSplitFrame = Number.NEGATIVE_INFINITY;
    let didSplit = false;
    for (let frame = startFrame + minNoteFrames; frame <= endFrame - minNoteFrames; frame += 1) {
      if (frame <= 0 || frame >= frameEnergy.length - 1) continue;
      const energy = frameEnergy[frame];
      if (!(energy < ENERGY_DIP_RATIO * 0.85 * maxEnergy)) continue;
      // 局部极小：比左右相邻帧都低
      if (!(energy <= frameEnergy[frame - 1] && energy <= frameEnergy[frame + 1])) continue;
      // 之后要能量恢复（说明是重新起音，而不是整体衰减）
      let recovered = 0;
      for (let offset = 1; offset <= 4 && frame + offset < frameEnergy.length; offset += 1) {
        if (frameEnergy[frame + offset] > recovered) recovered = frameEnergy[frame + offset];
      }
      if (!(recovered > energy * 2.2)) continue;
      if (frame - pieceStartFrame < minNoteFrames || endFrame - frame < minNoteFrames) continue;
      if (frame - lastSplitFrame < minNoteFrames) continue;
      const splitSec = frame * hopSec + frameCenterOffsetSec - hopSec * 0.5;
      if (splitSec - pieceStartSec < minNoteSec || note.endSec - splitSec < minNoteSec) continue;
      result.push({
        startSec: pieceStartSec,
        endSec: splitSec,
        midi: note.midi,
        confidence: note.confidence,
        keepSeparate: true,
      });
      didSplit = true;
      pieceStartSec = splitSec;
      pieceStartFrame = frame;
      lastSplitFrame = frame;
    }
    result.push({
      startSec: pieceStartSec,
      endSec: note.endSec,
      midi: note.midi,
      confidence: note.confidence,
      ...(didSplit ? { keepSeparate: true } : {}),
    });
  }

  return result;
}

/**
 * 复音候选：Viterbi 路径 → 连续段 → 八度校正 → 原始音符（含置信度与 voicedRatio）。
 */
function extractPolyphonicCandidate(
  salience: SalienceMatrix,
  rhythm: RhythmAnalysis,
  clarityGate: number,
  hopSec: number,
  frameCenterOffsetSec: number,
  totalSec: number,
  pitchMin: number,
): PolyphonicCandidate {
  const { frameCount, pitchCount, values, frameClarity } = salience;
  if (frameCount === 0) return { rawNotes: [], voicedRatio: 0 };

  const path = trackPitchPath(salience, clarityGate, rhythm.envelope);
  const runs = buildPitchRuns(path);

  const joinedNotes: RawNote[] = [];
  let voicedFrames = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (path[frame] >= 0) voicedFrames += 1;
  }

  for (const run of runs) {
    const midi = correctRunOctaves(run, salience, pitchMin);
    const startSec = Math.max(0, run.startFrame * hopSec + frameCenterOffsetSec - hopSec * 0.5);
    const endSec = Math.min(totalSec, run.endFrame * hopSec + frameCenterOffsetSec + hopSec * 0.5);
    if (!(endSec > startSec)) continue;

    // 置信度：段内平均清晰度 + 该音高的平均归一化显著度
    let claritySum = 0;
    let salienceSum = 0;
    let frames = 0;
    const pitchIndex = midi - pitchMin;
    for (let frame = run.startFrame; frame <= run.endFrame; frame += 1) {
      claritySum += frameClarity[frame];
      if (pitchIndex >= 0 && pitchIndex < pitchCount) {
        salienceSum += values[frame * pitchCount + pitchIndex];
      }
      frames += 1;
    }
    const clarityAverage = frames > 0 ? claritySum / frames : 0;
    const salienceAverage = frames > 0 ? salienceSum / frames : 0;
    // 置信度以“逐帧清晰度”为主：噪声帧的归一化显著度也可能接近 1，不能直接当置信度用
    const confidence = clamp(0.08 + 0.92 * clarityAverage * (0.55 + 0.45 * salienceAverage), 0, 1);
    if (confidence < MIN_POLY_NOTE_CONFIDENCE) continue;

    joinedNotes.push({ startSec, endSec, midi, confidence });
  }

  return { rawNotes: joinedNotes, voicedRatio: frameCount > 0 ? voicedFrames / frameCount : 0 };
}

// ============================ 单声部分支：YIN + 迟滞切分 ============================

/**
 * 单声部候选的音符切分（参照 transcribe.ts 的成熟做法）：
 * 1. 短暂无声帧回填；2. 5 帧中值滤波抑制震音/抖动；
 * 3. 八度离群回填；4. 迟滞状态机切分（0.7 半音容差 + 2 帧确认 + 1.15 半音强跳变）；
 * 5. 输出原始音符（置信度取段内 clarity 中值）。
 */
function segmentMonophonicFrames(
  frames: PitchFrame[],
  hopSec: number,
  minNoteMs: number,
  clarityThreshold: number,
  minMidi: number,
  maxMidi: number,
  totalSec: number,
): RawNote[] {
  const count = frames.length;
  if (count === 0) return [];

  const voiced = new Uint8Array(count);
  const midiTrack = new Float64Array(count);
  const clarityTrack = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const frame = frames[i];
    clarityTrack[i] = frame.clarity;
    if (
      frame.freq > 0
      && frame.clarity >= clarityThreshold
      && frame.midi >= minMidi - 0.5
      && frame.midi <= maxMidi + 0.5
    ) {
      voiced[i] = 1;
      midiTrack[i] = frame.midi;
    }
  }

  // 1) 单帧离群回填：两侧都有声且音高接近时补回中间帧
  for (let i = 1; i < count - 1; i += 1) {
    if (voiced[i] || !voiced[i - 1] || !voiced[i + 1]) continue;
    if (Math.abs(midiTrack[i - 1] - midiTrack[i + 1]) > 1.5) continue;
    voiced[i] = 1;
    midiTrack[i] = 0.5 * (midiTrack[i - 1] + midiTrack[i + 1]);
    clarityTrack[i] = Math.min(clarityTrack[i - 1], clarityTrack[i + 1]);
  }

  // 2) 中值滤波（只统计有声帧）
  const smoothed = new Float64Array(count);
  const windowBuffer: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (!voiced[i]) continue;
    windowBuffer.length = 0;
    const lo = Math.max(0, i - MEDIAN_RADIUS);
    const hi = Math.min(count - 1, i + MEDIAN_RADIUS);
    for (let j = lo; j <= hi; j += 1) {
      if (voiced[j]) windowBuffer.push(midiTrack[j]);
    }
    smoothed[i] = medianOf(windowBuffer);
  }

  // 3) 八度离群回填：比两侧都高/低超过 7 个半音、而两侧彼此接近时用两侧均值替换
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (let i = 1; i < count - 1; i += 1) {
      if (!voiced[i] || !voiced[i - 1] || !voiced[i + 1]) continue;
      const left = smoothed[i - 1];
      const right = smoothed[i + 1];
      if (Math.abs(smoothed[i] - left) > 7 && Math.abs(left - right) < 2) {
        smoothed[i] = 0.5 * (left + right);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 4) 迟滞状态机切分
  const maxGapFrames = Math.max(1, Math.round(LONG_SILENCE_SEC / hopSec));
  const rawNotes: RawNote[] = [];

  let noteStart = -1;
  let noteEnd = -1;
  let notePitches: number[] = [];
  let noteClarities: number[] = [];
  let referencePitch = 0;
  let unvoicedRun = 0;
  let candidateStart = -1;
  let candidatePitches: number[] = [];
  let candidateClarities: number[] = [];

  const resetCandidate = (): void => {
    candidateStart = -1;
    candidatePitches = [];
    candidateClarities = [];
  };

  const startNote = (startIndex: number, pitches: number[], clarities: number[]): void => {
    noteStart = startIndex;
    noteEnd = startIndex + pitches.length - 1;
    notePitches = pitches.slice();
    noteClarities = clarities.slice();
    referencePitch = medianOf(pitches.slice(-5));
    resetCandidate();
  };

  const appendToNote = (index: number): void => {
    notePitches.push(smoothed[index]);
    noteClarities.push(clarityTrack[index]);
    noteEnd = index;
    referencePitch = medianOf(notePitches.slice(Math.max(0, notePitches.length - 5)));
  };

  const flushNote = (): void => {
    if (noteStart >= 0 && noteEnd >= noteStart && notePitches.length > 0) {
      const midi = Math.round(medianOf(notePitches.slice()));
      if (midi >= minMidi && midi <= maxMidi) {
        const startSec = Math.max(0, noteStart * hopSec + (frames[noteStart].timeSec - noteStart * hopSec) - hopSec * 0.5);
        const endSec = Math.min(totalSec, noteEnd * hopSec + (frames[noteEnd].timeSec - noteEnd * hopSec) + hopSec * 0.5);
        if (endSec > startSec) {
          rawNotes.push({
            startSec,
            endSec,
            midi,
            confidence: medianOf(noteClarities.slice()),
          });
        }
      }
    }
    noteStart = -1;
    noteEnd = -1;
    notePitches = [];
    noteClarities = [];
  };

  for (let i = 0; i < count; i += 1) {
    if (!voiced[i]) {
      if (candidateStart >= 0) {
        for (const pitch of candidatePitches) notePitches.push(pitch);
        for (const clarity of candidateClarities) noteClarities.push(clarity);
        if (candidatePitches.length > 0 && i > 0) noteEnd = i - 1;
        resetCandidate();
      }
      unvoicedRun += 1;
      if (noteStart >= 0 && unvoicedRun > maxGapFrames) flushNote();
      continue;
    }
    unvoicedRun = 0;

    if (noteStart < 0) {
      startNote(i, [smoothed[i]], [clarityTrack[i]]);
      continue;
    }

    const deviation = Math.abs(smoothed[i] - referencePitch);
    if (candidateStart >= 0) {
      const candidateReference = medianOf(candidatePitches.slice(-5));
      if (Math.abs(smoothed[i] - candidateReference) > PITCH_SAME_TOLERANCE) {
        // 候选未持续：并回原音符后重新评估当前帧
        for (const pitch of candidatePitches) notePitches.push(pitch);
        for (const clarity of candidateClarities) noteClarities.push(clarity);
        if (candidatePitches.length > 0 && i > 0) noteEnd = i - 1;
        referencePitch = medianOf(notePitches.slice(Math.max(0, notePitches.length - 5)));
        resetCandidate();
        const retryDeviation = Math.abs(smoothed[i] - referencePitch);
        if (retryDeviation <= PITCH_SAME_TOLERANCE) {
          appendToNote(i);
        } else {
          candidateStart = i;
          candidatePitches = [smoothed[i]];
          candidateClarities = [clarityTrack[i]];
          if (retryDeviation > PITCH_HOLD_TOLERANCE) {
            flushNote();
            startNote(i, candidatePitches, candidateClarities);
          }
        }
        continue;
      }
      candidatePitches.push(smoothed[i]);
      candidateClarities.push(clarityTrack[i]);
      const candidateMedian = medianOf(candidatePitches.slice(-5));
      const shift = Math.abs(candidateMedian - referencePitch);
      if (candidatePitches.length >= BOUNDARY_CONFIRM_FRAMES && shift > PITCH_SAME_TOLERANCE) {
        // 确认切换：旧音符在候选起点前结束，新音符从候选起点开始
        flushNote();
        startNote(candidateStart, candidatePitches, candidateClarities);
      }
      continue;
    }

    if (deviation <= PITCH_SAME_TOLERANCE) {
      appendToNote(i);
    } else {
      candidateStart = i;
      candidatePitches = [smoothed[i]];
      candidateClarities = [clarityTrack[i]];
      if (deviation > PITCH_HOLD_TOLERANCE) {
        flushNote();
        startNote(i, candidatePitches, candidateClarities);
      }
    }
  }
  flushNote();

  return rawNotes;
}

/**
 * 单声部候选：YIN 基频帧 → 打击帧门控 → 迟滞切分。
 *
 * 若开启了 HPSS，传入的 pcm 是谐波分量重建信号，鼓点已被大幅抑制；
 * 再用逐帧谐波能量占比做二次门控，避免残余打击帧产生假音符。
 */
function extractMonophonicCandidate(
  pcm: Float32Array,
  analysisRate: number,
  totalSec: number,
  minMidi: number,
  maxMidi: number,
  minNoteMs: number,
  clarityThreshold: number,
  hpss: HpssResult | null,
): MonophonicCandidate {
  const hopSec = HOP_SIZE / analysisRate;
  const frames = extractPitchFrames(pcm, analysisRate, {
    frameSize: FRAME_SIZE,
    hopSize: HOP_SIZE,
    minFreq: midiToFreq(minMidi - 0.6),
    maxFreq: midiToFreq(maxMidi + 0.6),
    threshold: 0.12,
  });
  if (frames.length === 0) return { rawNotes: [], voicedRatio: 0 };

  // 打击帧门控：HPSS 谐波能量占比太低的帧不参与音高切分
  if (hpss && hpss.harmonicRatio.length > 0) {
    const limit = Math.min(frames.length, hpss.harmonicRatio.length);
    for (let i = 0; i < limit; i += 1) {
      if (hpss.harmonicRatio[i] < HPSS_HARMONIC_GATE) {
        frames[i] = { timeSec: frames[i].timeSec, freq: 0, midi: 0, clarity: 0 };
      }
    }
  }

  const effectiveClarity = clamp(clarityThreshold, 0.05, 0.95);
  const rawNotes = segmentMonophonicFrames(
    frames,
    hopSec,
    minNoteMs,
    effectiveClarity,
    minMidi,
    maxMidi,
    totalSec,
  );

  let voicedFrames = 0;
  for (const frame of frames) {
    if (frame.freq > 0 && frame.clarity >= effectiveClarity) voicedFrames += 1;
  }
  return { rawNotes, voicedRatio: frames.length > 0 ? voicedFrames / frames.length : 0 };
}

// ============================ 音符清理 ============================

/**
 * 最终清理（两条候选共用）：
 * 1. 按起点排序；2. 合并间隔 ≤30ms 的同音高音符；3. 修掉重叠；
 * 4. 消除 ≤30ms 小间隙；5. 过滤过短音符（优先并入相邻同音高音符）；
 * 6. 音域约束（防御性丢弃）；7. 最大音符数截断与四舍五入。
 */
function finalizeRawNotes(rawNotes: RawNote[], options: FinalizeOptions): FinalizeResult {
  const sorted = rawNotes
    .filter((note) => Number.isFinite(note.startSec) && Number.isFinite(note.endSec) && note.endSec > note.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);

  // 1) 合并间隔很小的同音高音符：
  //    - 同音重复切分产生的小段（keepSeparate）保持独立；
  //    - 完全首尾相接（gap≈0）的同音高段来自切分边界，也保持独立，否则重复音会被并回一个长音；
  //    - 只有存在正间隔且 ≤30ms 的碎音才合并（多半是检测抖动产生的重复片段）。
  const merged: RawNote[] = [];
  for (const note of sorted) {
    const last = merged.length > 0 ? merged[merged.length - 1] : null;
    if (last && last.midi === note.midi && !last.keepSeparate && !note.keepSeparate) {
      const gap = note.startSec - last.endSec;
      if (gap > 1e-6 && gap <= NOTE_MERGE_GAP_SEC) {
        last.endSec = Math.max(last.endSec, note.endSec);
        last.confidence = Math.max(last.confidence, note.confidence);
        continue;
      }
    }
    merged.push({ ...note });
  }

  // 2) 修掉重叠 + 消除小间隙
  for (let i = 1; i < merged.length; i += 1) {
    const previous = merged[i - 1];
    const current = merged[i];
    if (current.startSec < previous.endSec) {
      const midpoint = 0.5 * (current.startSec + previous.endSec);
      previous.endSec = midpoint;
      current.startSec = midpoint;
    } else {
      const gap = current.startSec - previous.endSec;
      if (gap > 0 && gap <= NOTE_MERGE_GAP_SEC) previous.endSec = current.startSec;
    }
  }

  // 3) 过滤过短音符：优先并入相邻同音高音符，否则丢弃
  const minDurSec = options.minNoteMs / 1000;
  const cleaned: RawNote[] = [];
  for (const note of merged) {
    const duration = note.endSec - note.startSec;
    if (duration >= minDurSec) {
      cleaned.push({ ...note });
      continue;
    }
    const previous = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
    if (previous && previous.midi === note.midi) {
      previous.endSec = Math.max(previous.endSec, note.endSec);
      continue;
    }
  }

  // 4) 音域约束 + 截断 + 四舍五入
  let droppedOutOfRange = 0;
  let truncated = 0;
  const notes: MelodyNote[] = [];
  for (const note of cleaned) {
    if (note.midi < options.pitchMin || note.midi > options.pitchMax) {
      droppedOutOfRange += 1;
      continue;
    }
    if (notes.length >= options.maxNotes) {
      truncated += 1;
      continue;
    }
    notes.push({
      midi: note.midi,
      startSec: roundTo(note.startSec, 4),
      durSec: roundTo(note.endSec - note.startSec, 4),
      confidence: roundTo(clamp(note.confidence, 0, 1), 3),
    });
  }

  return { notes, droppedOutOfRange, truncated };
}

// ============================ 主入口 ============================

/**
 * 从单声道 PCM 中提取主旋律。
 *
 * @param pcm      单声道 Float32 样本（约 -1..1，可含任意峰值，内部会复制并归一化）
 * @param sampleRate 输入采样率（Hz）；若无效则尝试使用 options.sampleRate
 * @param options  主旋律提取参数；第三参数按 Partial 接收，调用方只需传关心的字段
 *                 （sampleRate 入参优先于 options.sampleRate）
 *
 * 说明：
 * - 输出音符时间为相对输入片段起点的秒数；
 * - 默认音域 C3-C6（MIDI 48-84），所有候选/输出都被约束在该范围内；
 * - 静音/白噪声/空输入返回空 notes + warnings，不抛异常；
 * - 复音/强混响场景是传统 DSP 的难点：结果可能仍有跳八度或漏音，warnings 会给出提示。
 */
export function extractMainMelody(
  pcm: Float32Array,
  sampleRate: number,
  options: Partial<MelodyOptions> = {},
): MelodyExtractionResult {
  const warnings: string[] = [];

  // ---------- 0. 参数校验与归一化 ----------
  const inputRate =
    Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : (options.sampleRate ?? 0);
  if (!(Number.isFinite(inputRate) && inputRate > 0)) {
    warnings.push('采样率无效，无法进行音频分析');
    return emptyResult(warnings, 'monophonic');
  }
  if (pcm.length === 0) {
    warnings.push('输入音频为空');
    return emptyResult(warnings, 'monophonic');
  }

  const requestedMode = options.mode ?? 'auto';
  let pitchMin = clamp(Math.round(options.pitchMin ?? 48), 12, 120);
  let pitchMax = Math.round(options.pitchMax ?? 84);
  // 容错：调用方把上下限传反/传成同一值时，自动修正为一个可用的音域
  if (!(pitchMax > pitchMin)) pitchMax = pitchMin + 12;
  pitchMax = clamp(pitchMax, pitchMin + 1, 127);
  const minNoteMs = clamp(Math.round(options.minNoteMs ?? DEFAULT_MIN_NOTE_MS), 5, 5000);
  const sensitivity = clamp(options.sensitivity ?? 0.5, 0, 1);
  const clarityGate = clamp(
    (options.clarityThreshold ?? DEFAULT_CLARITY_THRESHOLD) * (1.25 - 0.5 * sensitivity),
    0.03,
    0.95,
  );
  const suppressAccompaniment = options.suppressAccompaniment ?? true;
  const maxNotes = clamp(Math.floor(options.maxNotes ?? DEFAULT_MAX_NOTES), 1, 100000);

  // ---------- 1. 峰值归一化 + 降采样 ----------
  const normalized = pcm.slice(); // 不修改调用方数组
  const peak = peakNormalizeInPlace(normalized);
  if (!(peak > SILENCE_PEAK)) {
    warnings.push('输入音频能量过低（疑似静音），未检测到可用的旋律');
    return emptyResult(warnings, requestedMode === 'polyphonic' ? 'polyphonic' : 'monophonic');
  }
  if (peak < LOW_VOLUME_PEAK) {
    warnings.push(`输入音量偏低（峰值 ${roundTo(peak, 4)}），已自动归一化`);
  }

  const analysisRate = inputRate > MAX_ANALYSIS_RATE ? TARGET_ANALYSIS_RATE : inputRate;
  const analysisPcm = analysisRate === inputRate
    ? normalized
    : resampleLinear(normalized, inputRate, analysisRate);
  if (analysisRate < 11025) {
    warnings.push(`分析采样率较低（${analysisRate}Hz），高频谐波不足，音高精度可能下降`);
  }
  const totalSec = analysisPcm.length / analysisRate;

  // ---------- 2. STFT ----------
  const spectrogram = computeMagnitudeSpectrogram(analysisPcm, analysisRate, {
    frameSize: FRAME_SIZE,
    hopSize: HOP_SIZE,
  });
  if (spectrogram.frameCount === 0) {
    warnings.push('音频过短（不足一个分析帧），无法提取旋律');
    return emptyResult(warnings, requestedMode === 'polyphonic' ? 'polyphonic' : 'monophonic');
  }

  // ---------- 3. HPSS（谐波/打击分离） ----------
  const hpss = suppressAccompaniment ? separateHarmonics(spectrogram) : null;
  const effectiveSpectrogram: MagnitudeSpectrogram = hpss
    ? { ...spectrogram, magnitude: hpss.harmonic }
    : spectrogram;

  // ---------- 4. 节奏（BPM / 起音） ----------
  const rhythm = analyzeRhythm(spectrogram);
  let bpm = rhythm.bpm;
  let bpmConfidence = rhythm.bpmConfidence;
  const onsetCount = rhythm.onsetFrames.length;
  if (onsetCount < MIN_ONSETS_FOR_TEMPO) {
    bpm = FALLBACK_BPM;
    bpmConfidence = Math.min(bpmConfidence, 0.2);
    warnings.push(
      `起音点过少（${onsetCount} 个），无法可靠估计节拍，BPM 已回退为 ${FALLBACK_BPM}；量化交由上层处理`,
    );
  } else if (rhythm.bpmConfidence < LOW_BPM_CONFIDENCE) {
    bpm = FALLBACK_BPM;
    warnings.push(
      `节拍置信度较低（${roundTo(rhythm.bpmConfidence, 2)}），BPM 已回退为 ${FALLBACK_BPM}；量化交由上层处理`,
    );
  }

  // ---------- 5. 谐波显著度 + 复音程度 ----------
  const salience = computeSalience(effectiveSpectrogram, {
    sampleRate: analysisRate,
    pitchMin,
    pitchMax,
  });
  const polyphonyScore = roundTo(
    estimatePolyphonyScore(spectrogram, salience, hpss ? hpss.percussiveRatio : null),
    3,
  );

  // ---------- 6. 方法选择 ----------
  let method: MelodyMethod;
  if (requestedMode === 'auto') {
    method = polyphonyScore >= AUTO_POLYPHONY_THRESHOLD ? 'polyphonic' : 'monophonic';
  } else {
    method = requestedMode;
  }

  const hopSec = HOP_SIZE / analysisRate;
  const frameCenterOffsetSec = FRAME_SIZE / (2 * analysisRate);
  let monophonic: MonophonicCandidate | null = null;
  let polyphonic: PolyphonicCandidate | null = null;

  // 单声部候选：开启伴奏抑制时用 HPSS 谐波分量重建的时域信号做 YIN
  if (requestedMode === 'auto' || method === 'monophonic') {
    const monophonicPcm = hpss
      ? reconstructMaskedSignal(analysisPcm, spectrogram, hpss.harmonic)
      : analysisPcm;
    monophonic = extractMonophonicCandidate(
      monophonicPcm,
      analysisRate,
      totalSec,
      pitchMin,
      pitchMax,
      minNoteMs,
      clarityGate,
      hpss,
    );
  }

  // 复音候选：显著度矩阵 + Viterbi
  if (requestedMode === 'auto' || method === 'polyphonic') {
    polyphonic = extractPolyphonicCandidate(
      salience,
      rhythm,
      clarityGate,
      hopSec,
      frameCenterOffsetSec,
      totalSec,
      pitchMin,
    );
  }

  // auto 回退：选中分支没有稳定音符而另一分支有结果时，自动改用另一分支
  if (requestedMode === 'auto') {
    if (method === 'monophonic' && (monophonic?.rawNotes.length ?? 0) === 0 && (polyphonic?.rawNotes.length ?? 0) > 0) {
      method = 'polyphonic';
      warnings.push('单声部候选未检测到稳定音符，已自动回退到复音跟踪结果');
    } else if (method === 'polyphonic' && (polyphonic?.rawNotes.length ?? 0) === 0 && (monophonic?.rawNotes.length ?? 0) > 0) {
      method = 'monophonic';
      warnings.push('复音候选未检测到稳定音符，已自动回退到单声部结果');
    }
  }

  const chosen = method === 'monophonic' ? monophonic : polyphonic;
  let rawNotes = chosen?.rawNotes ?? [];
  const voicedRatio = chosen?.voicedRatio ?? 0;

  // ---------- 7. 同音重复切分（起音 + 能量谷两遍） ----------
  if (rawNotes.length > 0) {
    const splitNotes = splitRawNotesAtEnergyDips(
      rawNotes,
      rhythm.onsetFrames,
      salience.frameEnergy,
      hopSec,
      frameCenterOffsetSec,
      minNoteMs / 1000,
    );
    rawNotes = splitNotesAtEnergyDipsFallback(
      splitNotes,
      salience.frameEnergy,
      hopSec,
      frameCenterOffsetSec,
      minNoteMs / 1000,
    );
  }

  // ---------- 8. 清理与结果 ----------
  const finalized = finalizeRawNotes(rawNotes, { minNoteMs, pitchMin, pitchMax, maxNotes });
  if (finalized.droppedOutOfRange > 0) {
    warnings.push(`有 ${finalized.droppedOutOfRange} 个音符超出设定音域（MIDI ${pitchMin}-${pitchMax}），已丢弃`);
  }
  if (finalized.truncated > 0) {
    warnings.push(`音符数量超过上限（${maxNotes}），已截断`);
  }
  if (finalized.notes.length === 0) {
    warnings.push('未检测到稳定的旋律音符（可能是噪声、静音、强混响或复音混合）');
  } else {
    if (polyphonyScore >= POLYPHONY_WARNING_THRESHOLD) {
      if (method === 'monophonic') {
        warnings.push(
          `输入疑似复音/带伴奏（复音程度 ${polyphonyScore.toFixed(2)}），单声部模式可能被伴奏带偏，建议改用 auto 或复音模式`,
        );
      } else {
        warnings.push(
          `检测到复音/伴奏成分（复音程度 ${polyphonyScore.toFixed(2)}），已用谐波显著度+连续性跟踪主旋律；混响过重时可能出现跳八度`,
        );
      }
    }
    // 低置信度提示：置信度普遍偏低时提醒用户录音/换模式
    let confidenceSum = 0;
    for (const note of finalized.notes) confidenceSum += note.confidence;
    const confidenceAverage = confidenceSum / finalized.notes.length;
    if (confidenceAverage < LOW_NOTE_CONFIDENCE) {
      warnings.push(
        `音符平均置信度较低（${roundTo(confidenceAverage, 2)}），建议使用更干净的录音或开启伴奏抑制后重试`,
      );
    }
  }

  return {
    notes: finalized.notes,
    method,
    bpm: roundTo(bpm, 1),
    bpmConfidence: roundTo(bpmConfidence, 3),
    warnings,
    voicedRatio: roundTo(voicedRatio, 3),
    polyphonyScore,
  };
}
