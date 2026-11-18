/**
 * 内置音源合成：口琴（贴近游戏内簧片音色）与钢琴（干净、便于核对音高）。
 * 纯 Web Audio 合成，无需外部采样，离线可用。
 */
import type { PreviewInstrument } from '@shared/types';

export interface InstrumentMeta {
  id: PreviewInstrument;
  name: string;
  tagline: string;
}

export const INSTRUMENTS: readonly InstrumentMeta[] = [
  { id: 'harmonica', name: '口琴', tagline: '簧片泛音 · 渐强 · 轻颤音' },
  { id: 'piano', name: '钢琴', tagline: '击弦瞬态 · 自然衰减' },
];

export function instrumentName(instrument: PreviewInstrument): string {
  return INSTRUMENTS.find((item) => item.id === instrument)?.name ?? '口琴';
}

// 每个 AudioContext 复用 PeriodicWave，避免每次发声重复构造
const waveCache = new WeakMap<AudioContext, Map<string, PeriodicWave>>();
const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

function getWave(context: AudioContext, key: string, harmonics: readonly number[]): PeriodicWave {
  let perContext = waveCache.get(context);
  if (!perContext) {
    perContext = new Map();
    waveCache.set(context, perContext);
  }
  const cached = perContext.get(key);
  if (cached) return cached;
  const real = new Float32Array(harmonics.length + 1);
  const imag = new Float32Array(harmonics.length + 1);
  for (let index = 0; index < harmonics.length; index += 1) imag[index + 1] = harmonics[index];
  const wave = context.createPeriodicWave(real, imag, { disableNormalization: false });
  perContext.set(key, wave);
  return wave;
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  const cached = noiseCache.get(context);
  if (cached) return cached;
  const length = Math.floor(context.sampleRate * 0.12);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    const envelope = Math.pow(1 - index / length, 2);
    data[index] = (Math.random() * 2 - 1) * envelope;
  }
  noiseCache.set(context, buffer);
  return buffer;
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 口琴：富含奇偶次泛音的簧片音色，慢起音 + 渐强 + 轻颤音 + 起音气流声 */
function scheduleHarmonica(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  when: number,
  duration: number,
): void {
  const hold = Math.max(0.12, duration);
  const wave = getWave(context, 'harmonica', [1, 0.62, 0.46, 0.34, 0.25, 0.18, 0.12, 0.08]);

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(5200, when);
  filter.frequency.linearRampToValueAtTime(3600, when + Math.min(0.6, hold));
  filter.Q.value = 0.9;

  const gain = context.createGain();
  const peak = 0.16 * (0.82 + Math.min(0.25, frequency / 2400));
  const swellTime = Math.min(0.5, Math.max(0.06, hold * 0.55));
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(peak * 0.5, when + 0.022);
  gain.gain.linearRampToValueAtTime(peak, when + swellTime);
  gain.gain.setValueAtTime(peak, when + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + hold + 0.12);
  filter.connect(gain).connect(destination);

  const osc = context.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = frequency;
  osc.detune.value = -2;
  osc.connect(filter);

  const osc2 = context.createOscillator();
  osc2.setPeriodicWave(wave);
  osc2.frequency.value = frequency;
  osc2.detune.value = 4;
  const bodyGain = context.createGain();
  bodyGain.gain.value = 0.32;
  osc2.connect(bodyGain).connect(filter);

  // 颤音（稍晚进入，更接近口琴/口风琴的自然听感）
  let lfo: OscillatorNode | null = null;
  if (hold > 0.28) {
    lfo = context.createOscillator();
    lfo.frequency.value = 5.3;
    const lfoGain = context.createGain();
    const depth = 7 + Math.min(6, frequency / 220);
    lfoGain.gain.setValueAtTime(0, when);
    lfoGain.gain.linearRampToValueAtTime(depth, when + 0.35);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);
    lfoGain.connect(osc2.detune);
    lfo.start(when);
    lfo.stop(when + hold + 0.25);
  }

  // 起音气流声
  const noise = context.createBufferSource();
  noise.buffer = getNoiseBuffer(context);
  const noiseFilter = context.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = Math.min(3600, 900 + frequency * 1.4);
  noiseFilter.Q.value = 0.8;
  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(0.02, when);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
  noise.connect(noiseFilter).connect(noiseGain).connect(destination);

  osc.start(when);
  osc.stop(when + hold + 0.16);
  osc2.start(when);
  osc2.stop(when + hold + 0.16);
  noise.start(when);
  noise.stop(when + 0.1);
}

/** 钢琴：击弦瞬态 + 泛音列 + 指数衰减 + 轻微琴弦失谐 */
function schedulePiano(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  when: number,
  duration: number,
): void {
  const wave = getWave(context, 'piano', [1, 0.52, 0.34, 0.22, 0.14, 0.09, 0.06, 0.04, 0.025]);
  const gain = context.createGain();
  const peak = 0.24;
  const body = Math.max(0.35, Math.min(2.8, duration + 0.35));

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(6800, when);
  filter.frequency.exponentialRampToValueAtTime(1400, when + Math.min(1.6, body));
  filter.Q.value = 0.4;

  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.006);
  gain.gain.exponentialRampToValueAtTime(peak * 0.32, when + 0.32);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + body);
  filter.connect(gain).connect(destination);

  const osc = context.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = frequency;
  osc.detune.value = -1;
  osc.connect(filter);

  const osc2 = context.createOscillator();
  osc2.setPeriodicWave(wave);
  osc2.frequency.value = frequency;
  osc2.detune.value = 5;
  const overtoneGain = context.createGain();
  overtoneGain.gain.value = 0.22;
  osc2.connect(overtoneGain).connect(filter);

  // 击弦噪声
  const noise = context.createBufferSource();
  noise.buffer = getNoiseBuffer(context);
  const noiseFilter = context.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 1200;
  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(0.03, when);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
  noise.connect(noiseFilter).connect(noiseGain).connect(destination);

  osc.start(when);
  osc.stop(when + body + 0.05);
  osc2.start(when);
  osc2.stop(when + body + 0.05);
  noise.start(when);
  noise.stop(when + 0.05);
}

export interface ScheduleNoteOptions {
  context: AudioContext;
  destination: AudioNode;
  instrument: PreviewInstrument;
  midi: number;
  /** AudioContext 时间轴上的开始时间 */
  when: number;
  /** 秒 */
  duration: number;
}

/** 在指定 AudioContext 时间点安排一个音符 */
export function scheduleInstrumentNote(options: ScheduleNoteOptions): void {
  const frequency = midiToFrequency(options.midi);
  if (options.instrument === 'piano') {
    schedulePiano(options.context, options.destination, frequency, options.when, options.duration);
  } else {
    scheduleHarmonica(options.context, options.destination, frequency, options.when, options.duration);
  }
}
