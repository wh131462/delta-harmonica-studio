/**
 * 全局试听上下文：底部常驻播放条、演奏台、编辑器、导入预览共用一套试听状态。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlaybackPlan } from '@core/instrument/plan';
import type { PreviewInstrument } from '@shared/types';
import { useAppStore } from '@renderer/state/app-store';
import { preloadInstrument } from './instruments';
import { PreviewPlayer, type PreviewHandle } from './preview';

/** 页面登记的试听对象：全局播放条的「试听」按它播放，并显示它的名字 */
export interface AuditionTarget {
  plan: PlaybackPlan;
  label: string;
}

/** 正在试听的对象；播放条用它同步显示名字，空闲时为 null */
export interface NowPlaying {
  label: string;
  noteCount: number;
}

export interface PreviewPlayOptions {
  /** 从计划时间轴的哪个位置开始播放（毫秒）；用于「从此处试听」 */
  fromMs?: number;
}

interface PreviewContextValue {
  playing: boolean;
  instrument: PreviewInstrument;
  volume: number;
  elapsedMs: number;
  totalMs: number;
  nowPlaying: NowPlaying | null;
  target: AuditionTarget | null;
  setTarget(target: AuditionTarget | null): void;
  play(plan: PlaybackPlan, label?: string, options?: PreviewPlayOptions): Promise<void>;
  stop(): void;
  setInstrument(instrument: PreviewInstrument): void;
  setVolume(volume: number): void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }): JSX.Element {
  const app = useAppStore();
  const [instrument, setInstrumentState] = useState<PreviewInstrument>(app.settings.preview.instrument);
  const [volume, setVolumeState] = useState(app.settings.preview.volume);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [target, setTargetState] = useState<AuditionTarget | null>(null);
  const playerRef = useRef<PreviewPlayer | null>(null);
  const handleRef = useRef<PreviewHandle | null>(null);
  const startRef = useRef<number | null>(null);
  /** 本次试听的起始位置（毫秒），用于把进度换算回计划时间轴 */
  const offsetRef = useRef(0);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 采样体积可控（约 4.4MB），启动后空闲预解码；首次点试听就不用等 I/O。
  useEffect(() => {
    const timer = setTimeout(() => {
      void preloadInstrument('harmonica').catch(() => undefined);
      void preloadInstrument('piano').catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  // 跟随设置变化（例如设置页修改了音色/音量）
  useEffect(() => {
    setInstrumentState(app.settings.preview.instrument);
    setVolumeState(app.settings.preview.volume);
  }, [app.settings.preview.instrument, app.settings.preview.volume]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    startRef.current = null;
    offsetRef.current = 0;
    setPlaying(false);
    setElapsedMs(0);
    setTotalMs(0);
    setNowPlaying(null);
  }, []);

  const play = useCallback(async (plan: PlaybackPlan, label = '', options?: PreviewPlayOptions) => {
    if (!plan || plan.notes.length === 0) {
      app.showToast('warning', '当前没有可试听的音符');
      return;
    }
    stop();
    const fromMs = Math.max(0, Math.min(Number(options?.fromMs) || 0, plan.durationMs));
    const player = new PreviewPlayer();
    playerRef.current = player;
    try {
      const handle = await player.play(plan, {
        instrument,
        volume,
        fromMs,
        onEnd: () => {
          // 自然播完回到空闲态：进度条不残留满格，否则看起来像还在播放
          setPlaying(false);
          setElapsedMs(0);
          setTotalMs(0);
          setNowPlaying(null);
          startRef.current = null;
          offsetRef.current = 0;
          if (playerRef.current === player) {
            playerRef.current = null;
            handleRef.current = null;
          }
        },
      });
      if (playerRef.current !== player) {
        // 采样加载期间已被停止或切到别的试听，丢弃这次回放
        handle.stop();
        return;
      }
      handleRef.current = handle;
      offsetRef.current = fromMs;
      startRef.current = performance.now();
      setElapsedMs(fromMs);
      setTotalMs(plan.durationMs);
      setNowPlaying({ label, noteCount: plan.stats.noteCount });
      setPlaying(true);
    } catch (error) {
      setPlaying(false);
      setElapsedMs(0);
      setTotalMs(0);
      setNowPlaying(null);
      offsetRef.current = 0;
      app.showToast('error', `试听失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [app, instrument, volume, stop]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = () => {
      setElapsedMs(
        startRef.current !== null ? offsetRef.current + (performance.now() - startRef.current) : 0,
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const setTarget = useCallback((next: AuditionTarget | null) => {
    setTargetState(next);
  }, []);

  const setInstrument = useCallback(
    (next: PreviewInstrument) => {
      setInstrumentState(next);
      void app.updateSettings({ preview: { ...app.settings.preview, instrument: next } });
    },
    [app],
  );

  const setVolume = useCallback(
    (next: number) => {
      const clamped = Math.min(1, Math.max(0, next));
      setVolumeState(clamped);
      if (volumeTimer.current) clearTimeout(volumeTimer.current);
      volumeTimer.current = setTimeout(() => {
        volumeTimer.current = null;
        void app.updateSettings({ preview: { ...app.settings.preview, volume: clamped } });
      }, 250);
    },
    [app],
  );

  useEffect(() => {
    return () => {
      handleRef.current?.stop();
      playerRef.current?.stop();
      if (volumeTimer.current) clearTimeout(volumeTimer.current);
    };
  }, []);

  const value = useMemo<PreviewContextValue>(
    () => ({
      playing,
      instrument,
      volume,
      elapsedMs,
      totalMs,
      nowPlaying,
      target,
      setTarget,
      play,
      stop,
      setInstrument,
      setVolume,
    }),
    [
      playing,
      instrument,
      volume,
      elapsedMs,
      totalMs,
      nowPlaying,
      target,
      setTarget,
      play,
      stop,
      setInstrument,
      setVolume,
    ],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreview(): PreviewContextValue {
  const context = useContext(PreviewContext);
  if (!context) throw new Error('usePreview 必须在 PreviewProvider 内使用');
  return context;
}

/**
 * 页面把自己可试听的内容登记给全局播放条（全应用只有一个试听器）。
 * 播放条据此播放并同步显示 label；内容清空或页面卸载时自动撤销登记。
 */
export function useAuditionTarget(plan: PlaybackPlan | null | undefined, label: string): void {
  const { setTarget } = usePreview();
  useEffect(() => {
    if (!plan) return undefined;
    setTarget({ plan, label });
    return () => setTarget(null);
  }, [plan, label, setTarget]);
}
