/**
 * 音频转谱 DSP 统一出口。
 *
 * 对外提供：YIN 基频检测、起音检测、BPM 估计、音频→主旋律转谱。
 * 纯 TypeScript、零第三方依赖，可在 Node / Electron 渲染进程 / Worker 中运行。
 */
export {
  DEFAULT_CLARITY_THRESHOLD,
  DEFAULT_MAX_FREQ,
  DEFAULT_MIN_FREQ,
  detectPitchYin,
  extractPitchFrames,
  freqToMidi,
  midiToFreq,
} from './pitch';
export type { PitchFrame, YinOptions, YinPitchResult } from './pitch';

export { detectOnsets } from './onset';
export type { OnsetResult } from './onset';

export { estimateTempo } from './tempo';
export type { TempoOptions, TempoResult } from './tempo';

export { DEFAULT_MIN_NOTE_MS, transcribeMelody } from './transcribe';
export type { TranscribeOptions, TranscribedNote, TranscriptionResult } from './transcribe';
