/**
 * 音频主旋律分析适配层：
 * 统一把「音频设置」映射到主旋律提取算法（HPSS + 谐波显著度 + Viterbi 平滑跟踪），
 * 并在异常时回退到单声部 YIN 分析。
 */
import { transcribeMelody } from '@core/audio';
import { extractMainMelody } from '@core/audio/melody';
import type { AudioAnalysisSettings } from '@shared/types';

export interface AnalyzedMelodyNote {
  midi: number;
  startSec: number;
  durSec: number;
  confidence: number;
}

export interface MelodyAnalysisResult {
  notes: AnalyzedMelodyNote[];
  bpm: number;
  bpmConfidence: number;
  warnings: string[];
  method: 'monophonic' | 'polyphonic';
  voicedRatio: number;
  polyphonyScore: number;
}

function fallbackAnalyze(
  pcm: Float32Array,
  sampleRate: number,
  settings: AudioAnalysisSettings,
  reason: string,
): MelodyAnalysisResult {
  const result = transcribeMelody(pcm, sampleRate, {
    minMidi: settings.pitchMin,
    maxMidi: settings.pitchMax,
    minNoteMs: settings.minNoteMs,
  });
  return {
    notes: result.notes
      .filter((note) => note.midi >= settings.pitchMin && note.midi <= settings.pitchMax)
      .map((note) => ({ midi: note.midi, startSec: note.startSec, durSec: note.durSec, confidence: note.confidence })),
    bpm: result.bpm,
    bpmConfidence: result.bpmConfidence,
    warnings: [...result.warnings, reason],
    method: 'monophonic',
    voicedRatio: result.voicedRatio,
    polyphonyScore: 0,
  };
}

/**
 * @param pcm 单声道 PCM（-1..1）
 * @param sampleRate 采样率
 * @param settings 用户在设置页/导入页配置的音频分析参数
 */
export function analyzeMelody(
  pcm: Float32Array,
  sampleRate: number,
  settings: AudioAnalysisSettings,
): MelodyAnalysisResult {
  try {
    const result = extractMainMelody(pcm, sampleRate, {
      mode: settings.melodyMode,
      pitchMin: settings.pitchMin,
      pitchMax: settings.pitchMax,
      minNoteMs: settings.minNoteMs,
      suppressAccompaniment: settings.suppressAccompaniment,
      sensitivity: 0.5,
      maxNotes: 2000,
    });
    return {
      notes: result.notes,
      bpm: result.bpm,
      bpmConfidence: result.bpmConfidence,
      warnings: result.warnings,
      method: result.method,
      voicedRatio: result.voicedRatio,
      polyphonyScore: result.polyphonyScore,
    };
  } catch (error) {
    return fallbackAnalyze(
      pcm,
      sampleRate,
      settings,
      `主旋律模式分析失败，已回退单声部分析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
