/**
 * 全局演奏上下文：任何页面都能通过底部常驻播放条/全局热键控制当前曲谱的演奏。
 * 负责：演奏计划计算、移调/速度、安全确认、开始/停止、进度与当前音符高亮、F9 处理。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { planPerformance, type PlaybackPlan } from '@core/instrument/plan';
import type { PlaybackStatus } from '@shared/types';
import { useAppStore } from '@renderer/state/app-store';
import { usePreview } from '@renderer/audio/preview-context';

export type TransposeValue = number | 'auto';

interface PerformanceContextValue {
  plan: PlaybackPlan | null;
  planError: string | null;
  transpose: TransposeValue;
  setTranspose(value: TransposeValue): void;
  tempoOverride: number | null;
  setTempoOverride(value: number | null): void;
  confirmSafety: boolean;
  setConfirmSafety(value: boolean): void;
  requiresMouseFire: boolean;
  starting: boolean;
  playbackStatus: PlaybackStatus;
  activeNoteId: string | null;
  elapsedMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const PerformanceContext = createContext<PerformanceContextValue | null>(null);

const STOPPED_STATES = ['finished', 'stopped', 'error', 'focus-lost', 'idle'];

export function PerformanceProvider({ children }: { children: ReactNode }): JSX.Element {
  const app = useAppStore();
  const preview = usePreview();
  const score = app.currentScore;
  const [transpose, setTranspose] = useState<TransposeValue>(0);
  const [tempoOverride, setTempoOverride] = useState<number | null>(null);
  const [confirmSafety, setConfirmSafety] = useState(false);
  const [starting, setStarting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const playStartRef = useRef<number | null>(null);
  const autoStartedRef = useRef(false);

  const planState = useMemo(() => {
    if (!score) return { plan: null as PlaybackPlan | null, error: null as string | null };
    try {
      return {
        plan: planPerformance(score, {
          transpose,
          ...(tempoOverride !== null ? { tempoOverride } : {}),
          timing: app.settings.input.timing,
        }),
        error: null,
      };
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [score, transpose, tempoOverride, app.settings.input.timing]);
  const plan = planState.plan;

  const playbackStatus = app.playbackStatus;
  const injectionActive = playbackStatus.state === 'playing';

  useEffect(() => {
    setTranspose(0);
    setTempoOverride(null);
    setConfirmSafety(false);
    autoStartedRef.current = false;
  }, [score?.id]);

  const requiresMouseFire = useMemo(
    () => plan?.notes.some((note) => note.combo.mods.some((mod) => mod === 'left' || mod === 'right')) ?? false,
    [plan],
  );

  useEffect(() => {
    if (playbackStatus.state === 'playing') {
      playStartRef.current = performance.now() - (playbackStatus.elapsedMs ?? 0);
    } else if (STOPPED_STATES.includes(playbackStatus.state)) {
      playStartRef.current = null;
    }
  }, [playbackStatus.state, playbackStatus.elapsedMs]);

  useEffect(() => {
    if (playbackStatus.state !== 'playing') {
      setElapsedMs(0);
      return undefined;
    }
    let frame = 0;
    const tick = () => {
      setElapsedMs(playStartRef.current !== null ? performance.now() - playStartRef.current : 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playbackStatus.state]);

  const activeNoteId = useMemo(() => {
    if (!plan || !score) return null;
    let currentIndex = -1;
    for (let index = 0; index < plan.notes.length; index += 1) {
      if (plan.notes[index].startMs <= elapsedMs) currentIndex = index;
      else break;
    }
    if (currentIndex < 0) return null;
    const plannedNote = plan.notes[currentIndex];
    if (elapsedMs > plannedNote.endMs + 200) return null;
    const sourceNote = score.notes.find(
      (item) => item.degree !== 0 && Math.abs(item.startBeat - plannedNote.startBeat) < 0.01,
    );
    return sourceNote?.id ?? null;
  }, [plan, score, elapsedMs]);

  const start = useCallback(async () => {
    if (!plan || plan.notes.length === 0) {
      app.showToast('warning', '当前乐谱没有可演奏的音符');
      return;
    }
    // macOS / Linux 没有 Win32 注入链路：不拦截开始，而是自动以排练模式走完时间轴。
    const canInject = app.appInfo?.capabilities.gameInjection ?? true;
    const backend = app.settings.input.backend === 'software' && !canInject ? 'dry-run' : app.settings.input.backend;
    const forcedRehearsal = backend === 'dry-run' && app.settings.input.backend === 'software';
    if (backend === 'software' && !app.settings.input.targetWindowHandle) {
      app.showToast('warning', '请先选择「三角洲行动」游戏窗口，再开始演奏');
      return;
    }
    if (backend === 'software' && app.appInfo && !app.appInfo.elevated) {
      app.showToast('warning', '未以管理员权限运行：游戏会静默丢弃注入的按键。请点击「以管理员重启」。');
      return;
    }
    if (requiresMouseFire && !confirmSafety && !app.appInfo?.gameAutoplay) {
      app.showToast('warning', '本谱需要按下鼠标左/右键（游戏中为开火/开镜），请先勾选安全确认');
      return;
    }
    if (forcedRehearsal) {
      app.showToast('info', '当前平台不支持游戏注入：本次以排练模式走时间轴，不会发送任何按键');
    }
    preview.stop();
    setStarting(true);
    try {
      const result = await window.api.playback.start({
        events: plan.events,
        durationMs: plan.durationMs,
        countdownSeconds: app.settings.input.countdownSeconds,
        focusGuard: app.settings.input.focusGuard,
        autoFocusTarget: app.settings.input.autoFocusTarget,
        targetWindowHandle: backend === 'software' ? app.settings.input.targetWindowHandle : null,
        backend,
        title: score?.meta.title ?? '未命名',
      });
      if (!result.ok) app.showToast('warning', result.message ?? '未能开始演奏');
    } finally {
      setStarting(false);
    }
  }, [app, plan, preview, requiresMouseFire, confirmSafety, score?.meta.title]);

  const stop = useCallback(async () => {
    await window.api.playback.stop();
  }, []);

  const startRef = useRef(start);
  startRef.current = start;
  const stopRef = useRef(stop);
  stopRef.current = stop;

  // 全局快捷键 F9（可配置）/ 悬浮窗按钮 → 开始或停止
  useEffect(() => {
    if (!app.lastGlobalCommand) return;
    if (app.lastGlobalCommand.command !== 'toggle-play') return;
    if (app.playbackStatus.state === 'playing' || app.playbackStatus.state === 'countdown') {
      void stopRef.current();
    } else {
      void startRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lastGlobalCommand?.nonce]);

  // 实机自动化测试：DFH_GAME_AUTOPLAY=1 时自动开始
  useEffect(() => {
    if (!app.appInfo?.gameAutoplay || autoStartedRef.current) return undefined;
    if (!plan || !score || plan.notes.length === 0) return undefined;
    if (!app.settings.input.targetWindowHandle) return undefined;
    const timer = setTimeout(() => {
      if (autoStartedRef.current) return;
      autoStartedRef.current = true;
      setConfirmSafety(true);
      app.showToast('info', '自动测试模式：即将开始演奏，请留在游戏窗口');
      void startRef.current();
    }, 2200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.appInfo?.gameAutoplay, plan, score, app.settings.input.targetWindowHandle]);

  const value = useMemo<PerformanceContextValue>(
    () => ({
      plan,
      planError: planState.error,
      transpose,
      setTranspose,
      tempoOverride,
      setTempoOverride,
      confirmSafety,
      setConfirmSafety,
      requiresMouseFire,
      starting,
      playbackStatus,
      activeNoteId,
      elapsedMs,
      start,
      stop,
    }),
    [
      plan,
      planState.error,
      transpose,
      tempoOverride,
      confirmSafety,
      requiresMouseFire,
      starting,
      playbackStatus,
      activeNoteId,
      elapsedMs,
      start,
      stop,
    ],
  );

  void injectionActive;
  return <PerformanceContext.Provider value={value}>{children}</PerformanceContext.Provider>;
}

export function usePerformance(): PerformanceContextValue {
  const context = useContext(PerformanceContext);
  if (!context) throw new Error('usePerformance 必须在 PerformanceProvider 内使用');
  return context;
}
