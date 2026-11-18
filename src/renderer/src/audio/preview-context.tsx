/**
 * 全局试听上下文：底部常驻播放条、演奏台、编辑器、导入预览共用一套试听状态。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlaybackPlan } from '@core/instrument/plan';
import type { PreviewInstrument } from '@shared/types';
import { useAppStore } from '@renderer/state/app-store';
import { PreviewPlayer, type PreviewHandle } from './preview';

interface PreviewContextValue {
  playing: boolean;
  instrument: PreviewInstrument;
  volume: number;
  elapsedMs: number;
  totalMs: number;
  play(plan: PlaybackPlan): Promise<void>;
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
  const playerRef = useRef<PreviewPlayer | null>(null);
  const handleRef = useRef<PreviewHandle | null>(null);
  const startRef = useRef<number | null>(null);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setPlaying(false);
    setElapsedMs(0);
  }, []);

  const play = useCallback(async (plan: PlaybackPlan) => {
    if (!plan || plan.notes.length === 0) {
      app.showToast('warning', '当前没有可试听的音符');
      return;
    }
    stop();
    const player = new PreviewPlayer();
    playerRef.current = player;
    try {
      const handle = await player.play(plan, {
        instrument,
        volume,
        onEnd: () => {
          setPlaying(false);
          startRef.current = null;
        },
      });
      handleRef.current = handle;
      startRef.current = performance.now();
      setTotalMs(plan.durationMs);
      setElapsedMs(0);
      setPlaying(true);
    } catch (error) {
      app.showToast('error', `试听失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [app, instrument, volume, stop]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = () => {
      setElapsedMs(startRef.current !== null ? performance.now() - startRef.current : 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

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
    () => ({ playing, instrument, volume, elapsedMs, totalMs, play, stop, setInstrument, setVolume }),
    [playing, instrument, volume, elapsedMs, totalMs, play, stop, setInstrument, setVolume],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreview(): PreviewContextValue {
  const context = useContext(PreviewContext);
  if (!context) throw new Error('usePreview 必须在 PreviewProvider 内使用');
  return context;
}
