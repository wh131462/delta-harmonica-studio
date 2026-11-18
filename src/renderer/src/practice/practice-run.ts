/**
 * 练习运行器（React hook）：时间轴、判定、输入捕获、节拍器与循环。
 *
 * 时钟口径：
 * - 所有时间以「练习时间轴毫秒」为准，0 = 按下开始后预备拍的第一拍；
 * - performance.now() 只用于推进，暂停/恢复通过重设 epoch 保持连续；
 * - 节拍器与判定共用同一份 session.clicks / session.steps 时间轴。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  DEFAULT_PRACTICE_WINDOWS,
  advanceJudge,
  createJudgeState,
  judgePress,
  nextPendingIndex,
  summarizePractice,
  type JudgeState,
  type PracticeGrade,
  type PracticeMode,
  type PracticeSession,
  type PracticeSummary,
} from '@core/practice';
import { DEFAULT_HARMONICA, type KeyId } from '@core/model/instrument';
import type { PracticeNoteStyle, PreviewInstrument } from '@shared/types';
import { preloadInstrument } from '@renderer/audio/instruments';
import { PracticeAudio } from './practice-audio';

const NOTE_CODES: Record<string, KeyId> = {
  KeyZ: 'k1',
  KeyX: 'k2',
  KeyC: 'k3',
  KeyV: 'k4',
  KeyB: 'k5',
  KeyN: 'k6',
  KeyM: 'k7',
  Comma: 'k8',
};

const BASE_MIDI: Record<KeyId, number> = Object.fromEntries(
  DEFAULT_HARMONICA.noteKeys.map((key) => [key.id, key.baseMidi]),
) as Record<KeyId, number>;

/** 开始后留一点预滚，让第一拍节拍器与画面同时到位 */
const START_DELAY_MS = 140;
/** 最后一个音过后额外等一个判定窗口，再结束 */
const END_GRACE_MS = 280;
/** HUD 时钟刷新间隔（不需要每帧重渲染） */
const UI_CLOCK_INTERVAL_MS = 60;
/** 节拍器提前安排的时间 */
const CLICK_LOOKAHEAD_MS = 280;

export type PracticePhase = 'idle' | 'running' | 'waiting' | 'paused' | 'finished';

export interface PracticeFeedback {
  grade: PracticeGrade;
  deltaMs: number;
  noteIndex: number | null;
  nonce: number;
}

export interface LaneMetrics {
  width: number;
  height: number;
  /** 横向滚动的判定线（左侧竖线） */
  hitX: number;
  /** 下落式的判定线（下方横线） */
  hitY: number;
  pxPerBeat: number;
  pxPerMs: number;
  /** 下落式音键列宽 / 谱面左右留白 */
  columnWidth: number;
  boardLeft: number;
}

export interface PracticeRunOptions {
  session: PracticeSession;
  mode: PracticeMode;
  noteStyle: PracticeNoteStyle;
  loop: boolean;
  metronome: boolean;
  hitSound: boolean;
  volume: number;
  instrument: PreviewInstrument;
  allowModifierCombos: boolean;
}

export interface PracticeRun {
  phase: PracticePhase;
  clockMs: number;
  judge: JudgeState;
  summary: PracticeSummary;
  loopCount: number;
  feedback: PracticeFeedback | null;
  metrics: LaneMetrics;
  /** 等待模式下当前停住的目标音 */
  waitTargetIndex: number | null;
  /** 下一个尚未判定的目标音（用于「应为 …」提示） */
  nextStepIndex: number;
  laneRef: RefObject<HTMLDivElement | null>;
  trackRef: RefObject<HTMLDivElement | null>;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export function usePracticeRun(options: PracticeRunOptions): PracticeRun {
  const { session } = options;
  const [phase, setPhase] = useState<PracticePhase>('idle');
  const [clockMs, setClockMs] = useState(0);
  const [judge, setJudge] = useState<JudgeState>(() => createJudgeState(session));
  const [loopCount, setLoopCount] = useState(1);
  const [feedback, setFeedback] = useState<PracticeFeedback | null>(null);
  const [laneSize, setLaneSize] = useState({ width: 0, height: 0 });

  const phaseRef = useRef<PracticePhase>('idle');
  const judgeRef = useRef(judge);
  const clockRef = useRef(0);
  const epochRef = useRef(0);
  const loopCountRef = useRef(1);
  const clickIndexRef = useRef(0);
  const lastUiClockRef = useRef(Number.NEGATIVE_INFINITY);
  const feedbackNonceRef = useRef(0);
  const audioRef = useRef<PracticeAudio | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const modsRef = useRef({ left: false, right: false, middle: false });

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 轨道比例：横向提前约 6.8 拍；下落式提前约 4.2 拍，音键列固定 8 列
  const metrics = useMemo<LaneMetrics>(() => {
    const width = laneSize.width > 0 ? laneSize.width : 720;
    const height = laneSize.height > 0 ? laneSize.height : 320;
    const hitX = Math.max(84, Math.min(190, Math.round(width * 0.18)));
    const hitY = Math.max(112, height - 64);
    const pxPerBeat =
      options.noteStyle === 'fall'
        ? Math.max(56, Math.min(120, (hitY - 16) / 4.2))
        : Math.max(52, Math.min(96, (width - hitX) / 6.8));
    const columnWidth = Math.max(52, Math.min(116, (width - 32) / 8));
    const boardLeft = Math.max(32, Math.round((width - columnWidth * 8) / 2));
    return {
      width,
      height,
      hitX,
      hitY,
      pxPerBeat,
      pxPerMs: pxPerBeat / session.beatMs,
      columnWidth,
      boardLeft,
    };
  }, [laneSize, session.beatMs, options.noteStyle]);

  const metricsRef = useRef({
    hitX: metrics.hitX,
    hitY: metrics.hitY,
    pxPerMs: metrics.pxPerMs,
    noteStyle: options.noteStyle,
  });
  metricsRef.current = {
    hitX: metrics.hitX,
    hitY: metrics.hitY,
    pxPerMs: metrics.pxPerMs,
    noteStyle: options.noteStyle,
  };

  const applyTrack = useCallback((timeMs: number) => {
    const track = trackRef.current;
    if (!track) return;
    const { hitX, hitY, pxPerMs, noteStyle } = metricsRef.current;
    track.style.transform =
      noteStyle === 'fall'
        ? `translate3d(0, ${(hitY + timeMs * pxPerMs).toFixed(2)}px, 0)`
        : `translate3d(${(hitX - timeMs * pxPerMs).toFixed(2)}px, 0, 0)`;
  }, []);

  const pushFeedback = useCallback(
    (grade: PracticeGrade, deltaMs: number, noteIndex: number | null) => {
      feedbackNonceRef.current += 1;
      setFeedback({ grade, deltaMs, noteIndex, nonce: feedbackNonceRef.current });
    },
    [],
  );

  const resetJudge = useCallback(() => {
    const fresh = createJudgeState(session);
    judgeRef.current = fresh;
    setJudge(fresh);
  }, [session]);

  const scheduleClicks = useCallback(
    (timeMs: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const { clicks } = session;
      while (clickIndexRef.current < clicks.length) {
        const click = clicks[clickIndexRef.current];
        if (click.t > timeMs + CLICK_LOOKAHEAD_MS) break;
        if (optionsRef.current.metronome) {
          audio.click(audio.now + Math.max(0, (click.t - timeMs) / 1000), click.accent);
        }
        clickIndexRef.current += 1;
      }
    },
    [session],
  );

  /** 暂停/恢复后把节拍器指针对齐回当前时间，避免漏掉或补播一截拍子 */
  const seekClickIndex = useCallback(
    (timeMs: number) => {
      let index = clickIndexRef.current;
      while (index > 0 && session.clicks[index - 1].t >= timeMs - 1) index -= 1;
      while (index < session.clicks.length && session.clicks[index].t < timeMs - 1) index += 1;
      clickIndexRef.current = index;
    },
    [session],
  );

  const finish = useCallback(() => {
    const endClock =
      optionsRef.current.mode === 'wait' ? session.durationMs : Math.min(clockRef.current, session.durationMs);
    clockRef.current = endClock;
    setClockMs(endClock);
    applyTrack(endClock);
    phaseRef.current = 'finished';
    setPhase('finished');
  }, [session, applyTrack]);

  const restartLoop = useCallback(() => {
    resetJudge();
    setFeedback(null);
    clockRef.current = 0;
    setClockMs(0);
    lastUiClockRef.current = Number.NEGATIVE_INFINITY;
    clickIndexRef.current = 0;
    epochRef.current = performance.now() + START_DELAY_MS;
    loopCountRef.current += 1;
    setLoopCount(loopCountRef.current);
    phaseRef.current = 'running';
    setPhase('running');
    applyTrack(0);
    audioRef.current?.setPaused(false);
  }, [resetJudge, applyTrack]);

  const start = useCallback(() => {
    if (session.steps.length === 0) return;
    const opts = optionsRef.current;
    let audio = audioRef.current;
    if (!audio) {
      try {
        audio = new PracticeAudio(opts.volume);
        audioRef.current = audio;
      } catch {
        // 音频设备不可用时仍然允许练习，只是没有节拍器与提示音
        audio = null;
      }
    }
    if (audio) {
      audio.setVolume(opts.volume);
      audio.setMetronomeEnabled(opts.metronome);
      audio.setHitSoundEnabled(opts.hitSound);
      audio.setPaused(false);
      void audio.resume();
      if (opts.hitSound) void audio.prepareSamples(opts.instrument);
    }
    resetJudge();
    setFeedback(null);
    clockRef.current = 0;
    setClockMs(0);
    lastUiClockRef.current = Number.NEGATIVE_INFINITY;
    clickIndexRef.current = 0;
    loopCountRef.current = 1;
    setLoopCount(1);
    epochRef.current = performance.now() + START_DELAY_MS;
    modsRef.current = { left: false, right: false, middle: false };
    phaseRef.current = 'running';
    setPhase('running');
    applyTrack(0);
  }, [session, resetJudge, applyTrack]);

  const stop = useCallback(() => {
    resetJudge();
    setFeedback(null);
    clockRef.current = 0;
    setClockMs(0);
    lastUiClockRef.current = Number.NEGATIVE_INFINITY;
    clickIndexRef.current = 0;
    loopCountRef.current = 1;
    setLoopCount(1);
    phaseRef.current = 'idle';
    setPhase('idle');
    audioRef.current?.setPaused(true);
    applyTrack(0);
  }, [resetJudge, applyTrack]);

  const pause = useCallback(() => {
    const current = phaseRef.current;
    if (current !== 'running' && current !== 'waiting') return;
    if (current === 'running') {
      clockRef.current = Math.max(0, performance.now() - epochRef.current);
    }
    setClockMs(clockRef.current);
    phaseRef.current = 'paused';
    setPhase('paused');
    modsRef.current = { left: false, right: false, middle: false };
    audioRef.current?.setPaused(true);
  }, []);

  const resume = useCallback(() => {
    if (phaseRef.current !== 'paused') return;
    epochRef.current = performance.now() - clockRef.current;
    seekClickIndex(clockRef.current);
    const next = nextPendingIndex(judgeRef.current);
    const waiting =
      optionsRef.current.mode === 'wait' && next >= 0 && clockRef.current >= session.steps[next].timeMs - 2;
    phaseRef.current = waiting ? 'waiting' : 'running';
    setPhase(waiting ? 'waiting' : 'running');
    audioRef.current?.setPaused(false);
  }, [session, seekClickIndex]);

  const handlePress = useCallback(
    (keyId: KeyId) => {
      const currentPhase = phaseRef.current;
      if (currentPhase !== 'running' && currentPhase !== 'waiting') return;
      const opts = optionsRef.current;
      const now =
        currentPhase === 'waiting' ? clockRef.current : Math.max(0, performance.now() - epochRef.current);

      const mods = modsRef.current;
      const octave = (mods.right ? 1 : 0) - (mods.left ? 1 : 0);
      const semitone = mods.middle ? 1 : 0;
      const invalidCombo = !opts.allowModifierCombos && octave !== 0 && semitone === 1;
      const midi = invalidCombo ? -1 : BASE_MIDI[keyId] + octave * 12 + semitone;

      // 按下即发声：先用实际按下的音高给即时反馈（预备拍里也可以试音）
      if (midi >= 0 && opts.hitSound) audioRef.current?.playNote(midi, opts.instrument);

      // 预备拍里的试按不算错音，避免一开始就扣准确率
      const firstStep = session.steps[0];
      if (firstStep && now < firstStep.timeMs - DEFAULT_PRACTICE_WINDOWS.goodMs) return;

      let current = judgeRef.current;
      if (opts.mode === 'timing') {
        const advanced = advanceJudge(current, session, now, DEFAULT_PRACTICE_WINDOWS);
        if (advanced !== current) {
          current = advanced;
          judgeRef.current = advanced;
          setJudge(advanced);
          if (advanced.last) {
            pushFeedback(advanced.last.grade, advanced.last.deltaMs, advanced.last.noteIndex);
            if (opts.hitSound) audioRef.current?.playError();
          }
        }
      }

      const result = judgePress(current, session, { midi, atMs: now }, DEFAULT_PRACTICE_WINDOWS);
      judgeRef.current = result.state;
      setJudge(result.state);
      pushFeedback(result.grade, result.deltaMs, result.noteIndex);

      // 错音已经由按下的音高本身提示；失误没有按键，补一声低声提示
      if (result.grade === 'miss' && opts.hitSound) audioRef.current?.playError();

      if (currentPhase === 'waiting' && result.grade !== 'wrong') {
        // 等待模式：按对后从停住的时刻继续走
        epochRef.current = performance.now() - clockRef.current;
        phaseRef.current = 'running';
        setPhase('running');
      }
    },
    [session, pushFeedback],
  );

  // 主循环：只在 running 时推进；waiting 时冻结，命中后由输入处理恢复
  useEffect(() => {
    if (phase !== 'running') return undefined;
    let frame = 0;
    const tick = () => {
      if (phaseRef.current !== 'running') return;
      const opts = optionsRef.current;
      const rawTime = performance.now() - epochRef.current;
      const time = Math.max(0, rawTime);

      if (opts.mode === 'wait') {
        const next = nextPendingIndex(judgeRef.current);
        if (next < 0) {
          if (opts.loop) {
            restartLoop();
            frame = requestAnimationFrame(tick);
          } else {
            finish();
          }
          return;
        }
        const target = session.steps[next].timeMs;
        if (time >= target) {
          clockRef.current = target;
          setClockMs(target);
          applyTrack(target);
          phaseRef.current = 'waiting';
          setPhase('waiting');
          return;
        }
      }

      clockRef.current = time;
      if (opts.mode === 'timing') {
        const advanced = advanceJudge(judgeRef.current, session, time, DEFAULT_PRACTICE_WINDOWS);
        if (advanced !== judgeRef.current) {
          judgeRef.current = advanced;
          setJudge(advanced);
          if (advanced.last) {
            pushFeedback(advanced.last.grade, advanced.last.deltaMs, advanced.last.noteIndex);
            if (opts.hitSound) audioRef.current?.playError();
          }
        }
      }

      if (time >= session.durationMs + END_GRACE_MS) {
        if (opts.loop) {
          restartLoop();
          frame = requestAnimationFrame(tick);
        } else {
          finish();
        }
        return;
      }

      applyTrack(time);
      if (time - lastUiClockRef.current >= UI_CLOCK_INTERVAL_MS) {
        lastUiClockRef.current = time;
        setClockMs(time);
      }
      scheduleClicks(rawTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, session, applyTrack, finish, pushFeedback, restartLoop, scheduleClicks]);

  // 键盘 / 鼠标：练习键 + 鼠标修饰键（与游戏内按法一致）
  const listening = phase !== 'idle';
  useEffect(() => {
    if (!listening) return undefined;

    const syncMouse = (event: MouseEvent) => {
      modsRef.current = {
        left: (event.buttons & 1) !== 0,
        right: (event.buttons & 2) !== 0,
        middle: (event.buttons & 4) !== 0,
      };
    };

    const resetMods = () => {
      modsRef.current = { left: false, right: false, middle: false };
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        event.stopPropagation();
        const current = phaseRef.current;
        if (current === 'paused') resume();
        else if (current === 'finished') start();
        else if (current === 'running' || current === 'waiting') pause();
        return;
      }
      if (event.code === 'Escape') {
        event.preventDefault();
        if (phaseRef.current !== 'finished') stop();
        return;
      }
      const keyId = NOTE_CODES[event.code];
      if (!keyId) return;
      if (phaseRef.current === 'finished') return;
      event.preventDefault();
      handlePress(keyId);
    };

    const onMouseDown = (event: MouseEvent) => {
      // 阻止中键自动滚动，避免练习时指针变成滚动状态
      if (event.button === 1) event.preventDefault();
      syncMouse(event);
    };

    const onContextMenu = (event: MouseEvent) => {
      const current = phaseRef.current;
      if (current === 'running' || current === 'waiting' || current === 'paused') event.preventDefault();
    };

    const onBlur = () => {
      resetMods();
      pause();
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        resetMods();
        pause();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', syncMouse, true);
    window.addEventListener('mousemove', syncMouse, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('mouseleave', resetMods);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', syncMouse, true);
      window.removeEventListener('mousemove', syncMouse, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mouseleave', resetMods);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [listening, handlePress, pause, resume, start, stop]);

  // 会话变化（换曲 / 改段落 / 改速度）→ 回到待开始
  useEffect(() => {
    resetJudge();
    setFeedback(null);
    clockRef.current = 0;
    setClockMs(0);
    clickIndexRef.current = 0;
    loopCountRef.current = 1;
    setLoopCount(1);
    phaseRef.current = 'idle';
    setPhase('idle');
    audioRef.current?.setPaused(true);
    applyTrack(0);
  }, [session, resetJudge, applyTrack]);

  // 浅色设置跟随（音量 / 节拍器 / 命中音）
  useEffect(() => {
    audioRef.current?.setVolume(options.volume);
  }, [options.volume]);

  useEffect(() => {
    audioRef.current?.setMetronomeEnabled(options.metronome);
  }, [options.metronome]);

  useEffect(() => {
    audioRef.current?.setHitSoundEnabled(options.hitSound);
  }, [options.hitSound]);

  // 页面打开就预解码音色；练习中再打开「按键发声」也能立即出声
  useEffect(() => {
    if (!options.hitSound) return;
    void preloadInstrument(options.instrument).catch(() => undefined);
    void audioRef.current?.prepareSamples(options.instrument);
  }, [options.hitSound, options.instrument]);

  // 轨道尺寸测量（窄窗口 / 侧栏收起 / 全屏练习都能自适应）
  useEffect(() => {
    const element = laneRef.current;
    if (!element) return undefined;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setLaneSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 尺寸或谱面方向变化后立刻把轨道对齐到当前时钟，避免切换时闪一帧
  useLayoutEffect(() => {
    applyTrack(clockRef.current);
  }, [metrics, applyTrack]);

  useEffect(() => {
    return () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);

  const summary = useMemo(() => summarizePractice(judge), [judge]);
  const waitTargetIndex = phase === 'waiting' ? nextPendingIndex(judge) : null;

  return {
    phase,
    clockMs,
    judge,
    summary,
    loopCount,
    feedback,
    metrics,
    waitTargetIndex,
    nextStepIndex: nextPendingIndex(judge),
    laneRef,
    trackRef,
    start,
    pause,
    resume,
    stop,
  };
}
