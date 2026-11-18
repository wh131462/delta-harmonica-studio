/**
 * 试听播放器：用 Web Audio 合成接近口琴的音色，把演奏计划在本地播放一遍。
 * 只用于试听，不会向游戏发送任何按键。
 */
import type { PlaybackPlan } from '@core/instrument/plan';

export interface PreviewHandle {
  stop(): void;
}

function createHarmonicaWave(context: AudioContext): PeriodicWave {
  // 簧片音色：多次谐波叠加（基频最强，高次谐波快速衰减）
  const harmonics = [0, 1, 0.62, 0.4, 0.26, 0.17, 0.1, 0.06];
  const real = new Float32Array(harmonics.length);
  const imag = new Float32Array(harmonics.length);
  for (let index = 1; index < harmonics.length; index += 1) imag[index] = harmonics[index];
  return context.createPeriodicWave(real, imag, { disableNormalization: false });
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export class PreviewPlayer {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;

  async play(plan: PlaybackPlan, options: { volume?: number; onEnd?: () => void } = {}): Promise<PreviewHandle> {
    this.dispose();
    this.ended = false;
    const context = new AudioContext();
    this.context = context;
    await context.resume().catch(() => undefined);

    const master = context.createGain();
    master.gain.value = options.volume ?? 0.3;
    master.connect(context.destination);
    const wave = createHarmonicaWave(context);
    const startAt = context.currentTime + 0.12;

    for (const note of plan.notes) {
      const startTime = startAt + note.startMs / 1000;
      const holdSeconds = Math.max(0.03, note.holdMs / 1000);
      const peak = Math.min(0.9, Math.max(0.25, 0.85 - Math.abs(note.midi - 64) * 0.012));
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(peak, startTime + 0.018);
      gain.gain.setValueAtTime(peak * 0.94, startTime + holdSeconds);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + holdSeconds + 0.09);
      gain.connect(master);

      const oscillator = context.createOscillator();
      oscillator.setPeriodicWave(wave);
      oscillator.frequency.value = midiToFrequency(note.midi);
      oscillator.connect(gain);
      oscillator.start(startTime);
      oscillator.stop(startTime + holdSeconds + 0.12);
    }

    const totalMs = Math.min(20 * 60 * 1000, plan.durationMs + 400);
    this.timer = setTimeout(() => {
      this.ended = true;
      options.onEnd?.();
      this.dispose();
    }, totalMs);

    return {
      stop: () => {
        if (this.ended) return;
        this.ended = true;
        options.onEnd?.();
        this.dispose();
      },
    };
  }

  stop(): void {
    this.dispose();
  }

  private dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.context) {
      const context = this.context;
      this.context = null;
      void context.close().catch(() => undefined);
    }
  }
}
