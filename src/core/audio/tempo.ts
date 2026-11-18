/**
 * BPM（速度）估计：对起音包络做归一化自相关 + 谐波加权 + 抛物线插值。
 *
 * 关键点：
 * - 峰值搜索范围默认 60–200 BPM；
 * - 速度倍/半速（倍周期）是自相关法的主要歧义来源，这里同时参考
 *   bpm×2（半周期）与 bpm÷2（倍周期）处的自相关做加权；
 * - 再乘一个以 120 BPM 为中心的宽高斯先验（log2 域，σ=1 个八度），
 *   在“60/120 都合理”的歧义中偏向常见的中速，避免把 120BPM 判成 60BPM；
 * - 最终对得分峰值做抛物线插值，返回一位小数的 BPM 与置信度。
 *
 * 纯 TypeScript，零第三方依赖。
 */
import { clamp, roundTo } from './dsp';

export interface TempoResult {
  /** 估计的 BPM（60–200 范围内，保留 1 位小数） */
  bpm: number;
  /** 置信度 0..1（起音自相关强度 + 与次优候选的区分度） */
  confidence: number;
  /** 得分最高的若干候选（降序），便于 UI 展示/调试 */
  candidates: Array<{ bpm: number; score: number }>;
}

export interface TempoOptions {
  /** 最低 BPM，默认 60 */
  minBpm?: number;
  /** 最高 BPM，默认 200 */
  maxBpm?: number;
}

/** 无有效结果时的兜底 BPM（上层视为低置信度） */
const FALLBACK_BPM = 100;
/** 谐波加权系数：基准周期 / bpm÷2（倍周期）/ bpm×2（半周期） */
const WEIGHT_BASE = 1;
const WEIGHT_SLOW_HARMONIC = 0.5;
const WEIGHT_FAST_HARMONIC = 0.25;
/** 速度先验中心与宽度（log2 八度） */
const PRIOR_CENTER_BPM = 120;
const PRIOR_SIGMA_OCTAVES = 1;

/** 枚举自相关得分中的局部极大值 */
function collectCandidates(
  score: Float64Array,
  frameRate: number,
  lagMin: number,
  lagMax: number,
): Array<{ bpm: number; score: number }> {
  const raw: Array<{ bpm: number; score: number }> = [];
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    const value = score[lag];
    if (!(value > 0)) continue;
    const prev = lag > lagMin ? score[lag - 1] : Number.NEGATIVE_INFINITY;
    const next = lag < lagMax ? score[lag + 1] : Number.NEGATIVE_INFINITY;
    if (value < prev || value < next) continue;
    raw.push({ bpm: roundTo((60 * frameRate) / lag, 1), score: roundTo(value, 4) });
  }
  raw.sort((a, b) => b.score - a.score);
  return raw.slice(0, 5);
}

/**
 * 根据起音包络估计 BPM。
 * @param envelope 起音包络（detectOnsets().envelope，可为任意幅度，内部会去均值归一化）
 * @param frameRate 包络帧率（Hz，detectOnsets().frameRate）
 * @param options 可选 BPM 搜索范围
 */
export function estimateTempo(
  envelope: Float32Array,
  frameRate: number,
  options: TempoOptions = {},
): TempoResult {
  const noResult: TempoResult = { bpm: FALLBACK_BPM, confidence: 0, candidates: [] };
  if (!(frameRate > 0) || envelope.length < 16) return noResult;

  const minBpm = clamp(options.minBpm ?? 60, 20, 400);
  const maxBpm = clamp(Math.max(options.maxBpm ?? 200, minBpm * 1.1), minBpm * 1.1, 600);
  const length = envelope.length;

  // 去均值并归一化到单位能量（自相关系数不随包络整体幅度变化）
  let mean = 0;
  for (let i = 0; i < length; i += 1) mean += envelope[i];
  mean /= length;
  const centered = new Float64Array(length);
  let energy = 0;
  for (let i = 0; i < length; i += 1) {
    const value = envelope[i] - mean;
    centered[i] = value;
    energy += value * value;
  }
  if (energy < 1e-12) return noResult;
  const invNorm = 1 / Math.sqrt(energy);
  for (let i = 0; i < length; i += 1) centered[i] *= invNorm;

  // 前缀平方和：用于按重叠区间能量归一化，得到有界（≤1）的相关系数
  const prefixSq = new Float64Array(length + 1);
  for (let i = 0; i < length; i += 1) {
    prefixSq[i + 1] = prefixSq[i] + centered[i] * centered[i];
  }
  const totalEnergy = prefixSq[length];

  const lagMin = Math.max(2, Math.ceil((60 * frameRate) / maxBpm));
  const lagMax = Math.min(length - 2, Math.floor((60 * frameRate) / minBpm));
  if (lagMax < lagMin + 2) return noResult;

  // 归一化自相关 r(lag)：分子取重叠区间内积，分母取两侧重叠能量几何平均
  const corr = new Float64Array(lagMax + 1);
  corr[0] = 1;
  for (let lag = 1; lag <= lagMax; lag += 1) {
    const overlap = length - lag;
    let sum = 0;
    for (let i = 0; i < overlap; i += 1) sum += centered[i] * centered[i + lag];
    const energyA = prefixSq[overlap];
    const energyB = totalEnergy - prefixSq[lag];
    const denom = Math.sqrt(energyA * energyB);
    corr[lag] = denom > 1e-12 ? clamp(sum / denom, -1, 1) : 0;
  }

  // 谐波加权得分（含速度先验）
  const score = new Float64Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    let value = WEIGHT_BASE * corr[lag];

    // bpm÷2 的倍周期（lag×2）自相关
    const doubleLag = lag * 2;
    if (doubleLag <= lagMax) value += WEIGHT_SLOW_HARMONIC * corr[doubleLag];

    // bpm×2 的半周期（lag/2）自相关，取线性插值
    const halfLag = lag / 2;
    if (halfLag >= 2) {
      const lo = Math.floor(halfLag);
      const hi = Math.min(lagMax, Math.ceil(halfLag));
      const frac = halfLag - lo;
      value += WEIGHT_FAST_HARMONIC * ((1 - frac) * corr[lo] + frac * corr[hi]);
    }

    // 中速先验：抑制 60/240 这类倍/半速歧义
    const bpmCandidate = (60 * frameRate) / lag;
    const octaves = Math.log2(bpmCandidate / PRIOR_CENTER_BPM);
    const prior = Math.exp(-0.5 * (octaves / PRIOR_SIGMA_OCTAVES) ** 2);
    score[lag] = value * prior;
  }

  let bestLag = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    if (score[lag] > bestScore) {
      bestScore = score[lag];
      bestLag = lag;
    }
  }
  if (bestLag < 0 || !(bestScore > 0)) return noResult;

  // 抛物线插值，细化到亚帧精度
  let delta = 0;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = score[bestLag - 1];
    const y1 = bestScore;
    const y2 = score[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      delta = clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5);
    }
  }
  const refinedLag = bestLag + delta;
  if (!(refinedLag > 0)) return noResult;
  const bpm = clamp(roundTo((60 * frameRate) / refinedLag, 1), minBpm, maxBpm);

  const candidates = collectCandidates(score, frameRate, lagMin, lagMax);
  const secondScore = candidates.length > 1 ? candidates[1].score : 0;
  const separation = clamp((bestScore - secondScore) / (bestScore + 1e-9), 0, 1);
  const correlation = clamp(corr[bestLag], 0, 1);
  const confidence = clamp(0.6 * correlation + 0.4 * separation, 0, 1);

  return { bpm, confidence: roundTo(confidence, 3), candidates };
}
