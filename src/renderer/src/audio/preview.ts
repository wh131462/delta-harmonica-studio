/**
 * 试听播放器：把演奏计划用真实采样音源（口琴/钢琴）在本地播放，
 * 不向游戏发送任何按键。
 */
import type { PlaybackPlan } from '@core/instrument/plan';
import type { PreviewInstrument } from '@shared/types';
import { getAudioContext, preloadInstrument, scheduleInstrumentNote } from './instruments';

export interface PreviewHandle {
  stop(): void;
}

export interface PlayPreviewOptions {
  instrument: PreviewInstrument;
  /** 0..1 */
  volume: number;
  /** 从计划时间轴的哪个位置开始播放（毫秒）；用于「从此处试听」 */
  fromMs?: number;
  onEnd?: () => void;
}

export class PreviewPlayer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private ended = false;
  private playToken = 0;

  async play(plan: PlaybackPlan, options: PlayPreviewOptions): Promise<PreviewHandle> {
    this.dispose(false);
    const token = ++this.playToken;
    this.ended = false;

    const context = getAudioContext();
    this.context = context;
    await context.resume().catch(() => undefined);
    // 采样第一次播放前解码；之后再切音色/重播都直接命中缓存。
    await preloadInstrument(options.instrument);
    if (token !== this.playToken) return { stop: () => undefined };

    const master = context.createGain();
    master.gain.value = Math.min(1, Math.max(0, options.volume)) * 0.9;
    master.connect(context.destination);
    this.master = master;

    const fromMs = Math.max(0, Math.min(Number(options.fromMs) || 0, plan.durationMs));
    const startAt = context.currentTime + 0.16;
    for (const note of plan.notes) {
      // 已经结束的音不再排程；跨过起点的长音从起点处接着响完剩余时值。
      if (note.endMs <= fromMs) continue;
      const offsetMs = Math.max(0, note.startMs - fromMs);
      const remainingMs = note.endMs - Math.max(note.startMs, fromMs);
      this.sources.push(
        ...scheduleInstrumentNote({
          context,
          destination: master,
          instrument: options.instrument,
          midi: note.midi,
          when: startAt + offsetMs / 1000,
          duration: Math.max(0.05, remainingMs / 1000),
        }),
      );
    }

    const totalMs = Math.min(20 * 60 * 1000, Math.max(0, plan.durationMs - fromMs) + 700);
    this.timer = setTimeout(() => {
      this.timer = null;
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

  private dispose(fade = true): void {
    this.playToken += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const context = this.context;
    const now = context?.currentTime ?? 0;
    if (this.master) {
      const master = this.master;
      this.master = null;
      if (fade && context) {
        try {
          master.gain.cancelScheduledValues(now);
          master.gain.setValueAtTime(master.gain.value, now);
          master.gain.linearRampToValueAtTime(0.0001, now + 0.035);
          // 让尾音自然淡出后再断开；定时器只持有这个 master，不需要随播放器清理。
          setTimeout(() => {
            try {
              master.disconnect();
            } catch {
              /* 忽略 */
            }
          }, 70);
        } catch {
          try {
            master.disconnect();
          } catch {
            /* 忽略 */
          }
        }
      } else {
        try {
          master.disconnect();
        } catch {
          /* 忽略 */
        }
      }
    }

    for (const source of this.sources) {
      try {
        source.stop(now + 0.045);
      } catch {
        /* 已自然结束或已停止 */
      }
    }
    this.sources = [];
    this.context = null;
  }
}
