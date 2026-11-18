/**
 * 调性检测：Krumhansl-Schmuckler 音级分布相关法（简化版）。
 * 返回大调 / 小调判定；简谱按大调记写，小调时给出关系大调的 keyRoot。
 */
import { clampPitchClass } from '../model/pitch';

export type KeyMode = 'major' | 'minor';

export interface PitchWeight {
  midi: number;
  /** 权重（例如持续时值），默认 1 */
  weight?: number;
}

export interface KeyCandidate {
  /** 主音音高类（0=C … 11=B） */
  tonic: number;
  mode: KeyMode;
  correlation: number;
}

export interface KeyDetection {
  /** 主音 */
  tonic: number;
  mode: KeyMode;
  /** 简谱的 keyRoot（大调=主音；小调=关系大调主音） */
  keyRoot: number;
  confidence: number;
  candidates: KeyCandidate[];
}

// Krumhansl-Kessler 大调 / 小调 音级画像
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function rotate(profile: readonly number[], tonic: number): number[] {
  const out = new Array<number>(12);
  for (let i = 0; i < 12; i += 1) out[(i + tonic) % 12] = profile[i];
  return out;
}

export function detectKey(pitches: readonly PitchWeight[]): KeyDetection {
  const histogram = new Array<number>(12).fill(0);
  for (const pitch of pitches) {
    if (!Number.isFinite(pitch.midi)) continue;
    const weight = pitch.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    histogram[clampPitchClass(Math.round(pitch.midi))] += weight;
  }

  const candidates: KeyCandidate[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    candidates.push({ tonic, mode: 'major', correlation: pearson(histogram, rotate(MAJOR_PROFILE, tonic)) });
    candidates.push({ tonic, mode: 'minor', correlation: pearson(histogram, rotate(MINOR_PROFILE, tonic)) });
  }
  candidates.sort((a, b) => b.correlation - a.correlation);
  const best = candidates[0];
  const second = candidates[1] ?? best;
  const spread = Math.max(0, best.correlation - second.correlation);
  const confidence = Math.max(0, Math.min(1, spread * 12));
  const keyRoot = best.mode === 'major' ? best.tonic : (best.tonic + 3) % 12;

  return {
    tonic: best.tonic,
    mode: best.mode,
    keyRoot,
    confidence,
    candidates: candidates.slice(0, 6),
  };
}

/** 用已有时值的音符做加权调性检测 */
export function detectKeyFromNoteWeights(notes: readonly { midi: number; weight?: number }[]): KeyDetection {
  return detectKey(notes);
}
