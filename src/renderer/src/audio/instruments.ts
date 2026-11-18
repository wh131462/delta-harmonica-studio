/**
 * 真实采样音源：口琴（VCSL Hohner Special 20，CC0）与
 * 钢琴（Salamander Grand Piano，CC BY 3.0）。
 *
 * 所有采样随应用离线分发，首次试听前异步解码；播放时只做选层、轻微变速、
 * 包络与颤音，不改变原始录音的频谱，避免又回到“电子合成器”的听感。
 */
import type { PreviewInstrument } from '@shared/types';
import { SAMPLE_ZONES, selectZone } from './sample-manifest';

export interface InstrumentMeta {
  id: PreviewInstrument;
  name: string;
  tagline: string;
}

export const INSTRUMENTS: readonly InstrumentMeta[] = [
  { id: 'harmonica', name: '口琴', tagline: '真实簧片采样 · 呼吸起音 · 自然延音' },
  { id: 'piano', name: '钢琴', tagline: 'Salamander 三角钢琴采样 · 自然衰减' },
];

export function instrumentName(instrument: PreviewInstrument): string {
  return INSTRUMENTS.find((item) => item.id === instrument)?.name ?? '口琴';
}

/** 每个音的目标峰值（再乘以 master 音量）；不同力度层的采样响度已在此归一化。 */
const TARGET_PEAK: Record<PreviewInstrument, number> = {
  harmonica: 0.36,
  piano: 0.48,
};

const RELEASE_SEC: Record<PreviewInstrument, number> = {
  harmonica: 0.12,
  piano: 0.2,
};

interface LoadedSample {
  buffer: AudioBuffer;
  /** 原始采样峰值，用于逐层归一化 */
  peak: number;
  /** 循环区间（秒，相对 AudioBuffer 时间轴）；仅口琴使用 */
  loopStart: number;
  loopEnd: number;
}

let sharedContext: AudioContext | null = null;
const sampleCache = new Map<string, LoadedSample>();
const sampleLoads = new Map<string, Promise<LoadedSample>>();
const instrumentLoads = new Map<PreviewInstrument, Promise<void>>();

/** 全局复用一个 AudioContext：解码好的采样可以跨多次试听复用，切音色不中断。 */
export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext({ latencyHint: 'interactive' });
  }
  return sharedContext;
}

/**
 * 预解码某个音色的全部采样。重复调用会复用同一个 Promise；
 * 失败后清除缓存，下一次试听可以重试（例如文件被占用/安装不完整）。
 */
export function preloadInstrument(instrument: PreviewInstrument): Promise<void> {
  const cached = instrumentLoads.get(instrument);
  if (cached) return cached;
  const pending = (async () => {
    const context = getAudioContext();
    await Promise.all(SAMPLE_ZONES[instrument].map((zone) => loadSample(context, zone.file)));
  })().catch((error: unknown) => {
    instrumentLoads.delete(instrument);
    throw error;
  });
  instrumentLoads.set(instrument, pending);
  return pending;
}

function loadSample(context: AudioContext, file: string): Promise<LoadedSample> {
  const cached = sampleCache.get(file);
  if (cached) return Promise.resolve(cached);
  const pending = sampleLoads.get(file);
  if (pending) return pending;

  const load = (async () => {
    if (!window.api?.samples?.read) throw new Error('音源接口不可用');
    const data = await window.api.samples.read(file);
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const buffer = await context.decodeAudioData(bytes);
    const sample = prepareSample(buffer, file);
    sampleCache.set(file, sample);
    return sample;
  })().finally(() => sampleLoads.delete(file));

  sampleLoads.set(file, load);
  return load;
}

function prepareSample(buffer: AudioBuffer, file: string): LoadedSample {
  const peak = samplePeak(buffer);
  if (!file.startsWith('harmonica/')) {
    return { buffer, peak, loopStart: 0, loopEnd: buffer.duration };
  }

  // 口琴是持续音：在 1.15s~2.10s 之间做一段 120ms 的尾首交叉淡化，
  // 让长音可以无缝循环，同时避开采样末尾的收尾淡出。
  const loopStart = Math.min(buffer.duration * 0.48, 1.15);
  const loopEnd = Math.min(buffer.duration - 0.08, loopStart + 0.95);
  if (loopEnd - loopStart > 0.3) {
    crossfadeLoopSeam(buffer, loopStart, loopEnd, 0.12);
  }
  return { buffer, peak, loopStart, loopEnd };
}

/** 把 loopEnd 前的尾音渐变到 loopStart 前的波形，循环回到 loopStart 时相位连续。 */
function crossfadeLoopSeam(buffer: AudioBuffer, loopStart: number, loopEnd: number, fadeSec: number): void {
  const sampleRate = buffer.sampleRate;
  const fadeSamples = Math.min(
    Math.floor(fadeSec * sampleRate),
    Math.floor((loopEnd - loopStart) * sampleRate * 0.45),
  );
  const sourceStart = Math.floor((loopStart - fadeSec) * sampleRate);
  const targetEnd = Math.floor(loopEnd * sampleRate);
  if (fadeSamples <= 0 || sourceStart < 0) return;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < fadeSamples; index += 1) {
      const mix = (index + 1) / fadeSamples;
      const target = targetEnd - fadeSamples + index;
      if (target < 0 || target >= data.length) break;
      data[target] = data[target] * (1 - mix) + data[sourceStart + index] * mix;
    }
  }
}

function samplePeak(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      const value = Math.abs(data[index]);
      if (value > peak) peak = value;
    }
  }
  return Math.max(peak, 0.01);
}

function levelFor(instrument: PreviewInstrument, midi: number, peak: number): number {
  const register = 0.94 + (1 - Math.min(1, Math.max(0, (midi - 48) / 36))) * 0.06;
  return (TARGET_PEAK[instrument] / peak) * register;
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

/**
 * 在指定 AudioContext 时间点安排一个真实采样音符。
 * 返回需要由调用方停止的源节点（采样源 + 可选的颤音 LFO）。
 */
export function scheduleInstrumentNote(options: ScheduleNoteOptions): AudioScheduledSourceNode[] {
  const { context, destination, instrument, midi, when, duration } = options;
  const zone = selectZone(SAMPLE_ZONES[instrument], midi);
  const sample = sampleCache.get(zone.file);
  if (!sample) throw new Error(`音源尚未加载：${zone.file}`);

  const hold = Math.max(0.04, duration);
  const attack = instrument === 'piano' ? 0.003 : Math.min(0.016, Math.max(0.004, hold * 0.25));
  const release = Math.min(RELEASE_SEC[instrument], Math.max(0.045, hold * 0.5));
  const end = when + hold;
  const stopAt = end + release + 0.02;

  const source = context.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = 2 ** ((midi - zone.root) / 12);
  source.detune.value = instrument === 'harmonica' ? -1.5 : -0.5;

  if (instrument === 'harmonica' && hold + release > sample.loopStart + 0.1) {
    source.loop = true;
    source.loopStart = sample.loopStart;
    source.loopEnd = sample.loopEnd;
  }

  const gain = context.createGain();
  const level = levelFor(instrument, midi, sample.peak);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(level, when + attack);
  gain.gain.setValueAtTime(level, end);
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
  source.connect(gain);

  if (instrument === 'piano') {
    // 真实钢琴的每根弦在声场里有固定位置；单声道采样用轻量声像补一点键盘宽度。
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-0.22, Math.min(0.22, (midi - 60) * 0.012));
    gain.connect(panner).connect(destination);
  } else {
    gain.connect(destination);
  }

  // 从采样起音之后一点点进入，短音也能立刻听清，同时不削掉簧片的呼吸感。
  const offset = instrument === 'harmonica' ? Math.min(0.035, sample.buffer.duration * 0.02) : 0;
  source.start(when, offset);
  source.stop(stopAt);

  const sources: AudioScheduledSourceNode[] = [source];
  if (instrument === 'harmonica' && hold > 0.55) {
    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.8;
    const depth = context.createGain();
    depth.gain.setValueAtTime(0, when);
    depth.gain.linearRampToValueAtTime(4.2, when + Math.min(0.7, hold * 0.5));
    lfo.connect(depth).connect(source.detune);
    lfo.start(when);
    lfo.stop(stopAt);
    sources.push(lfo);
  }

  return sources;
}

