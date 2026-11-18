/**
 * 练习模式音效：节拍器 + 按键发声 + 失误提示。
 *
 * 与试听共用同一个 AudioContext 与真实采样（口琴 / 钢琴），
 * 按下音键就按实际音高发声；节拍器用轻量振荡器合成，不占采样。
 */
import type { PreviewInstrument } from '@shared/types';
import { getAudioContext, preloadInstrument, scheduleInstrumentNote } from '@renderer/audio/instruments';

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0.55;
  return Math.min(1, Math.max(0, volume));
}

export class PracticeAudio {
  private readonly context: AudioContext;
  private readonly output: GainNode;
  private readonly metronome: GainNode;
  private volume: number;
  private metronomeOn = true;
  private hitSoundOn = true;
  private paused = false;
  private samplesReady = false;
  private disposed = false;

  constructor(volume: number) {
    this.context = getAudioContext();
    this.volume = clampVolume(volume);
    this.output = this.context.createGain();
    this.output.gain.value = this.volume;
    this.output.connect(this.context.destination);
    this.metronome = this.context.createGain();
    this.metronome.gain.value = 1;
    this.metronome.connect(this.output);
  }

  get now(): number {
    return this.context.currentTime;
  }

  async resume(): Promise<void> {
    if (this.disposed) return;
    if (this.context.state === 'suspended') {
      await this.context.resume().catch(() => undefined);
    }
  }

  async prepareSamples(instrument: PreviewInstrument): Promise<void> {
    try {
      await preloadInstrument(instrument);
      this.samplesReady = true;
    } catch {
      this.samplesReady = false;
    }
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    if (this.disposed || this.paused) return;
    this.output.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
  }

  setMetronomeEnabled(enabled: boolean): void {
    if (this.disposed || this.metronomeOn === enabled) return;
    this.metronomeOn = enabled;
    this.metronome.gain.setTargetAtTime(enabled ? 1 : 0.0001, this.context.currentTime, 0.01);
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    const target = paused ? 0.0001 : this.volume;
    this.output.gain.cancelScheduledValues(this.context.currentTime);
    this.output.gain.setTargetAtTime(target, this.context.currentTime, 0.01);
  }

  setHitSoundEnabled(enabled: boolean): void {
    this.hitSoundOn = enabled;
  }

  /** 在 AudioContext 时间轴的 when 处安排一次节拍器点击。 */
  click(when: number, accent: boolean): void {
    if (this.disposed || !this.metronomeOn || this.paused) return;
    const start = Math.max(when, this.context.currentTime + 0.001);
    if (!Number.isFinite(start)) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(accent ? 1760 : 1174, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.12 : 0.07, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.055);
    oscillator.connect(gain).connect(this.metronome);
    oscillator.start(start);
    oscillator.stop(start + 0.07);
  }

  /** 按下一个音键就发声：用当前试听音色回放实际按下的音高（不再只在命中时响）。 */
  playNote(midi: number, instrument: PreviewInstrument): void {
    if (this.disposed || !this.samplesReady || this.paused || !this.hitSoundOn) return;
    try {
      scheduleInstrumentNote({
        context: this.context,
        destination: this.output,
        instrument,
        midi,
        when: this.context.currentTime + 0.005,
        duration: 0.38,
      });
    } catch {
      // 采样尚未解码完成时静默跳过，不打断练习
    }
  }

  /** 错音 / 失误的低声提示，和按键发声共用开关。 */
  playError(): void {
    if (this.disposed || this.paused || !this.hitSoundOn) return;
    const start = this.context.currentTime + 0.002;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(196, start);
    oscillator.frequency.exponentialRampToValueAtTime(146, start + 0.09);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.045, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    oscillator.connect(gain).connect(this.output);
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.output.disconnect();
    } catch {
      /* 已断开 */
    }
  }
}
