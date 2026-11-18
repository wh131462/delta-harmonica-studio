/**
 * 试听播放器：把演奏计划用内置音源（口琴/钢琴）在本地播放，不向游戏发送任何按键。
 */
import type { PlaybackPlan } from '@core/instrument/plan';
import type { PreviewInstrument } from '@shared/types';
import { scheduleInstrumentNote } from './instruments';

export interface PreviewHandle {
  stop(): void;
}

export interface PlayPreviewOptions {
  instrument: PreviewInstrument;
  /** 0..1 */
  volume: number;
  onEnd?: () => void;
}

export class PreviewPlayer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;

  async play(plan: PlaybackPlan, options: PlayPreviewOptions): Promise<PreviewHandle> {
    this.dispose();
    this.ended = false;
    const context = new AudioContext();
    this.context = context;
    await context.resume().catch(() => undefined);

    const master = context.createGain();
    master.gain.value = Math.min(1, Math.max(0, options.volume)) * 0.9;
    master.connect(context.destination);
    this.master = master;

    const startAt = context.currentTime + 0.14;
    for (const note of plan.notes) {
      scheduleInstrumentNote({
        context,
        destination: master,
        instrument: options.instrument,
        midi: note.midi,
        when: startAt + note.startMs / 1000,
        duration: Math.max(0.05, note.holdMs / 1000),
      });
    }

    const totalMs = Math.min(20 * 60 * 1000, plan.durationMs + 700);
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
    if (this.master) {
      try {
        this.master.disconnect();
      } catch {
        /* 忽略 */
      }
      this.master = null;
    }
    if (this.context) {
      const context = this.context;
      this.context = null;
      void context.close().catch(() => undefined);
    }
  }
}
