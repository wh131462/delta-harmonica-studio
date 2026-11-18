import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildScoreFromText } from '@core/score/dsl';
import {
  canTie,
  createStep,
  durationChoice,
  insertStepAt,
  removeStepAt,
  scoreToSteps,
  stepAriaLabel,
  stepsStartBeats,
  stepsToScore,
  updateStepAt,
  DURATION_BASES,
  beatLabel,
  type ScoreStep,
} from '@core/score/sequence';
import {
  createEmptyScore,
  createId,
  meterBeats,
  nowIso,
  normalizeScore,
  type Accidental,
  type Degree,
  type MeterDen,
  type Score,
  type ScoreMeta,
} from '@core/model/score';
import { auditionStartMs, planPerformance } from '@core/instrument/plan';
import type { RecordToStepsResult } from '@core/score/record';
import { ScoreLineEditor } from '@renderer/components/score';
import { ScoreRecorder } from '@renderer/components/recorder/ScoreRecorder';
import { Icon } from '@renderer/components/Icon';
import { Notice, PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { useAuditionTarget, usePreview } from '@renderer/audio/preview-context';
import { keyLabel } from '@renderer/utils/format';
import '@renderer/styles/page-editor.css';

/** 顺序播放 / 输入用的音级键盘（0 = 休止） */
const NOTE_KEYS: Degree[] = [1, 2, 3, 4, 5, 6, 7, 0];
const SOLFEGE = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'] as const;
const DURATION_NAMES: Record<number, string> = {
  4: '全',
  2: '二分',
  1: '四分',
  0.5: '八分',
  0.25: '十六分',
};
const ACCIDENTALS: Array<{ value: Accidental; symbol: string; label: string }> = [
  { value: -1, symbol: '♭', label: '降号' },
  { value: 0, symbol: '♮', label: '本位' },
  { value: 1, symbol: '♯', label: '升号' },
];
const OCTAVE_OPTIONS = [
  { value: -4, label: '极低 -4' },
  { value: -3, label: '极低 -3' },
  { value: -2, label: '倍低 -2' },
  { value: -1, label: '低音 -1' },
  { value: 0, label: '中音' },
  { value: 1, label: '高音 +1' },
  { value: 2, label: '倍高 +2' },
  { value: 3, label: '极高 +3' },
  { value: 4, label: '极高 +4' },
];
const MEASURES_PER_ROW = 4;
const HISTORY_LIMIT = 60;

interface InputSettings {
  degree: Degree;
  accidental: Accidental;
  octave: number;
  duration: number;
}

const DEFAULT_INPUT: InputSettings = { degree: 1, accidental: 0, octave: 0, duration: 1 };

interface HistoryState {
  past: ScoreStep[][];
  future: ScoreStep[][];
}

/** 脏状态判定用的内容指纹（忽略 updatedAt / 编辑器内部字段） */
function scoreSignature(score: Score): string {
  return JSON.stringify({
    meta: score.meta,
    notes: score.notes.map((note) => [
      note.degree,
      note.accidental,
      note.octave,
      note.startBeat,
      note.duration,
      note.tie,
    ]),
  });
}

function stepToInput(step: ScoreStep): InputSettings {
  return {
    degree: step.degree,
    accidental: step.accidental,
    octave: step.octave,
    duration: step.duration,
  };
}

export function EditorPage(): JSX.Element {
  const app = useAppStore();
  const preview = usePreview();
  const [score, setScore] = useState<Score | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState<InputSettings>(DEFAULT_INPUT);
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });
  const [overlapCount, setOverlapCount] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const initializedRef = useRef(false);
  const savedSignatureRef = useRef<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const steps = useMemo(() => (score ? scoreToSteps(score).steps : []), [score]);
  const starts = useMemo(() => stepsStartBeats(steps), [steps]);
  const measureBeats = score ? meterBeats(score.meta.meter) : 4;
  const selectedIndex = selectedId ? steps.findIndex((step) => step.id === selectedId) : -1;
  const selectedStep = selectedIndex >= 0 ? steps[selectedIndex] : null;
  const selectedMeasure =
    selectedIndex >= 0 ? Math.floor((starts[selectedIndex] ?? 0) / measureBeats + 1e-6) + 1 : 0;
  const currentDuration = selectedStep?.duration ?? input.duration;
  const durationState = durationChoice(currentDuration);
  const currentDegree = selectedStep?.degree ?? input.degree;
  const currentAccidental = selectedStep?.accidental ?? input.accidental;
  const currentOctave = selectedStep?.octave ?? input.octave;
  const selectionIsRest = selectedStep?.degree === 0;
  const canTieSelected = selectedIndex >= 0 && canTie(steps, selectedIndex);
  // 常见拍号 + 当前值（导入的 5/4、7/8 等也能在原值上继续编辑，不会掉选项）
  const numeratorOptions = useMemo(() => {
    const standard = [2, 3, 4, 5, 6, 7, 8, 9, 12];
    const current = score?.meta.meter.num ?? 4;
    return Array.from(new Set([...standard, current])).sort((a, b) => a - b);
  }, [score?.meta.meter.num]);

  // 初始化：优先当前曲谱，没有则创建一份空草稿
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const initial = app.currentScore ?? createEmptyScore({ title: '新乐谱' });
    setScore(initial);
    setOverlapCount(scoreToSteps(initial).overlapCount);
    savedSignatureRef.current = app.currentScore && !app.dirty ? scoreSignature(initial) : null;
    if (!app.currentScore) app.setCurrentScore(initial, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const isDirty = useCallback((next: Score): boolean => {
    const saved = savedSignatureRef.current;
    return saved === null || scoreSignature(next) !== saved;
  }, []);

  const flashStep = useCallback((stepId: string) => {
    setFlashId(stepId);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashId(null), 650);
  }, []);

  const syncInputFromStep = useCallback((step: ScoreStep | null | undefined) => {
    if (step) setInput(stepToInput(step));
  }, []);

  /**
   * 提交一次结构性修改：写历史、更新本地曲谱、同步 store、清掉重叠提示。
   * selection：undefined = 保持当前选中；null = 取消选中；string = 选中该 id。
   */
  const commit = useCallback(
    (nextSteps: ScoreStep[], selection: string | null | undefined) => {
      if (!score) return;
      const nextScore = stepsToScore(nextSteps, score);
      setHistory((previous) => ({
        past: [...previous.past, steps].slice(-HISTORY_LIMIT),
        future: [],
      }));
      setScore(nextScore);
      setOverlapCount(0);
      setSelectedId((previous) => {
        if (selection !== undefined) return selection;
        return previous && nextSteps.some((step) => step.id === previous) ? previous : null;
      });
      app.setCurrentScore(nextScore, isDirty(nextScore));
    },
    [app, isDirty, score, steps],
  );

  const selectStep = useCallback(
    (step: ScoreStep) => {
      setSelectedId(step.id);
      syncInputFromStep(step);
    },
    [syncInputFromStep],
  );

  const handleSelectStep = useCallback(
    (stepId: string) => {
      const step = steps.find((item) => item.id === stepId);
      if (step) selectStep(step);
    },
    [selectStep, steps],
  );

  const updateSelected = useCallback(
    (patch: Partial<ScoreStep>) => {
      if (!score || selectedIndex < 0) return;
      const current = steps[selectedIndex];
      if (current) {
        const changed = (Object.keys(patch) as Array<keyof ScoreStep>).some(
          (key) => current[key] !== patch[key],
        );
        if (!changed) return;
      }
      const nextSteps = updateStepAt(steps, selectedIndex, patch);
      const nextStep = nextSteps[selectedIndex];
      commit(nextSteps, nextStep?.id ?? null);
      syncInputFromStep(nextStep);
    },
    [commit, score, selectedIndex, steps, syncInputFromStep],
  );

  /** 未选中时在末尾追加；选中时修改当前音（键盘 1-7 / 0 共用） */
  const applyDegree = useCallback(
    (degree: Degree) => {
      if (!score) return;
      if (selectedIndex >= 0) {
        updateSelected({ degree });
        return;
      }
      const step = createStep({ ...input, degree });
      const nextSteps = insertStepAt(steps, steps.length, step);
      commit(nextSteps, null);
      setInput((previous) => ({ ...previous, degree }));
      flashStep(step.id);
    },
    [commit, flashStep, input, score, selectedIndex, steps, updateSelected],
  );

  /** 显式的「添加音符」：在选中音之后插入（无选中时追加）并选中新音 */
  const addStep = useCallback(() => {
    if (!score) return;
    const step = createStep(input);
    const insertAt = selectedIndex >= 0 ? selectedIndex + 1 : steps.length;
    const nextSteps = insertStepAt(steps, insertAt, step);
    commit(nextSteps, step.id);
    syncInputFromStep(step);
  }, [commit, input, score, selectedIndex, steps, syncInputFromStep]);

  const removeSelected = useCallback(
    (focusAfter: boolean) => {
      if (!score || steps.length === 0) return;
      const index = selectedIndex >= 0 ? selectedIndex : steps.length - 1;
      const nextSteps = removeStepAt(steps, index);
      const nextSelected = nextSteps[Math.min(index, nextSteps.length - 1)] ?? null;
      commit(nextSteps, nextSelected?.id ?? null);
      syncInputFromStep(nextSelected);
      if (focusAfter && nextSelected) setFocusRequest(nextSelected.id);
    },
    [commit, score, selectedIndex, steps, syncInputFromStep],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (steps.length === 0) return;
      const nextIndex =
        selectedIndex < 0
          ? delta > 0
            ? 0
            : steps.length - 1
          : Math.min(steps.length - 1, Math.max(0, selectedIndex + delta));
      const step = steps[nextIndex];
      if (!step) return;
      selectStep(step);
      setFocusRequest(step.id);
    },
    [selectStep, selectedIndex, steps],
  );

  const applyOctave = useCallback(
    (octave: number) => {
      if (selectedStep) {
        if (selectedStep.degree !== 0) updateSelected({ octave });
        return;
      }
      setInput((previous) => ({ ...previous, octave }));
    },
    [selectedStep, updateSelected],
  );

  const shiftOctave = useCallback(
    (delta: number) => {
      if (selectionIsRest) return;
      const current = selectedStep?.octave ?? input.octave;
      applyOctave(Math.min(4, Math.max(-4, current + delta)));
    },
    [applyOctave, input.octave, selectedStep, selectionIsRest],
  );

  const applyAccidental = useCallback(
    (accidental: Accidental) => {
      if (selectedStep) {
        if (selectedStep.degree !== 0) updateSelected({ accidental });
        return;
      }
      setInput((previous) => ({ ...previous, accidental }));
    },
    [selectedStep, updateSelected],
  );

  const applyDuration = useCallback(
    (duration: number) => {
      if (selectedStep) updateSelected({ duration });
      else setInput((previous) => ({ ...previous, duration }));
    },
    [selectedStep, updateSelected],
  );

  const applyDurationBase = useCallback(
    (base: number) => applyDuration(base),
    [applyDuration],
  );

  const toggleDotted = useCallback(() => {
    const base = durationState.known ? durationState.base : 1;
    applyDuration(durationState.dotted ? base : base * 1.5);
  }, [applyDuration, durationState]);

  const toggleTie = useCallback(() => {
    if (!selectedStep || !canTieSelected) return;
    updateSelected({ tie: !selectedStep.tie });
  }, [canTieSelected, selectedStep, updateSelected]);

  const undo = useCallback(() => {
    if (!score || history.past.length === 0) return;
    const previousSteps = history.past[history.past.length - 1];
    const nextScore = stepsToScore(previousSteps, score);
    setHistory((previous) => ({
      past: previous.past.slice(0, -1),
      future: [steps, ...previous.future].slice(0, HISTORY_LIMIT),
    }));
    setScore(nextScore);
    setOverlapCount(0);
    const previousSelected = selectedId ? previousSteps.find((step) => step.id === selectedId) : null;
    setSelectedId(previousSelected?.id ?? null);
    syncInputFromStep(previousSelected);
    app.setCurrentScore(nextScore, isDirty(nextScore));
  }, [app, history, isDirty, score, selectedId, steps, syncInputFromStep]);

  const redo = useCallback(() => {
    if (!score || history.future.length === 0) return;
    const nextSteps = history.future[0];
    const nextScore = stepsToScore(nextSteps, score);
    setHistory((previous) => ({
      past: [...previous.past, steps].slice(-HISTORY_LIMIT),
      future: previous.future.slice(1),
    }));
    setScore(nextScore);
    setOverlapCount(0);
    const nextSelected = selectedId ? nextSteps.find((step) => step.id === selectedId) : null;
    setSelectedId(nextSelected?.id ?? null);
    syncInputFromStep(nextSelected);
    app.setCurrentScore(nextScore, isDirty(nextScore));
  }, [app, history, isDirty, score, selectedId, steps, syncInputFromStep]);

  const save = useCallback(async () => {
    if (!score) return;
    // 以当前顺序谱为准落盘：补齐的休止符、重叠整理与屏幕显示保持一致
    const snapshot = stepsToScore(steps, score);
    const saved = await app.saveCurrentScore(snapshot);
    if (saved) {
      savedSignatureRef.current = scoreSignature(saved);
      setScore(saved);
      setOverlapCount(0);
    }
  }, [app, score, steps]);

  // 播放计划：只在音符 / 速度 / 调号 / 拍号变化时重算，改标题不会打断试听
  const plan = useMemo(() => {
    if (!score) return null;
    try {
      return planPerformance(score, { timing: app.settings.input.timing });
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    score?.notes,
    score?.meta.tempo,
    score?.meta.keyRoot,
    score?.meta.baseOctave,
    score?.meta.meter.num,
    score?.meta.meter.den,
    app.settings.input.timing,
  ]);

  // 试听统一由底部播放条负责：登记当前草稿，播放条显示曲名并按它播放
  useAuditionTarget(plan, score?.meta.title || '当前谱面');

  /** 从序列中的某个音开始试听：休止符会顺延到下一个有音高的音 */
  const playFromIndex = useCallback(
    (index: number) => {
      if (!plan || !score) return;
      const stepStart = starts[index];
      if (stepStart === undefined) return;
      const fromMs = auditionStartMs(plan, stepStart);
      if (fromMs < 0) {
        app.showToast('info', '这个音之后没有可试听的音符');
        return;
      }
      void preview.play(plan, score.meta.title || '当前谱面', { fromMs });
    },
    [app, plan, preview, score, starts],
  );

  const handlePlayStep = useCallback(
    (stepId: string) => {
      const index = steps.findIndex((step) => step.id === stepId);
      if (index >= 0) playFromIndex(index);
    },
    [playFromIndex, steps],
  );

  const playFromSelection = useCallback(() => {
    if (selectedIndex >= 0) playFromIndex(selectedIndex);
  }, [playFromIndex, selectedIndex]);

  const selectedAuditionMs = useMemo(() => {
    if (!plan || selectedIndex < 0) return -1;
    return auditionStartMs(plan, starts[selectedIndex] ?? 0);
  }, [plan, selectedIndex, starts]);

  const activeStepId = useMemo(() => {
    if (!plan || !preview.playing) return null;
    const elapsed = preview.elapsedMs;
    let currentIndex = -1;
    for (let index = 0; index < plan.notes.length; index += 1) {
      if (plan.notes[index].startMs <= elapsed) currentIndex = index;
      else break;
    }
    if (currentIndex < 0) return null;
    const plannedNote = plan.notes[currentIndex];
    if (elapsed > plannedNote.endMs + 200) return null;
    const stepIndex = steps.findIndex(
      (step, index) => step.degree !== 0 && Math.abs((starts[index] ?? 0) - plannedNote.startBeat) < 0.01,
    );
    return stepIndex >= 0 ? steps[stepIndex].id : null;
  }, [plan, preview.elapsedMs, preview.playing, starts, steps]);

  const updateMeta = useCallback(
    (patch: Partial<ScoreMeta>) => {
      if (!score) return;
      const nextScore = { ...score, meta: { ...score.meta, ...patch }, updatedAt: nowIso() };
      setScore(nextScore);
      app.setCurrentScore(nextScore, isDirty(nextScore));
    },
    [app, isDirty, score],
  );

  const resetEditorForScore = useCallback(
    (nextScore: Score) => {
      if (preview.playing) preview.stop();
      const conversion = scoreToSteps(nextScore);
      setScore(nextScore);
      setSelectedId(null);
      setInput(DEFAULT_INPUT);
      setHistory({ past: [], future: [] });
      setOverlapCount(conversion.overlapCount);
      savedSignatureRef.current = null;
    },
    [preview],
  );

  const newScore = useCallback(() => {
    const draft = createEmptyScore({ title: '新乐谱' });
    resetEditorForScore(draft);
    app.setCurrentScore(draft, true);
    app.showToast('info', '已新建空白曲谱');
  }, [app, resetEditorForScore]);

  const importFromFile = useCallback(async () => {
    try {
      const files = await window.api.library.importScoreFile();
      if (files.length === 0) return;
      const file = files[0];
      const lowerName = file.name.toLowerCase();
      if (lowerName.endsWith('.mid') || lowerName.endsWith('.midi')) {
        app.showToast('warning', 'MIDI 文件请到「智能导入」页导入，会自动选轨并转成简谱');
        return;
      }
      const decoded = new TextDecoder('utf-8').decode(file.data);
      let nextScore: Score;
      if (lowerName.endsWith('.json') || lowerName.endsWith('.dfh') || lowerName.endsWith('.jianpu.json')) {
        const parsed = JSON.parse(decoded) as Score | null;
        if (!parsed || typeof parsed !== 'object' || !parsed.meta || !Array.isArray(parsed.notes)) {
          throw new Error('不是有效的曲谱 JSON');
        }
        const imported = normalizeScore(parsed).score;
        // 外部方案文件可能没有合法 id（保存时会被主进程拒绝），补一个
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(imported.id ?? '')) imported.id = createId('score');
        nextScore = imported;
      } else {
        const parsed = buildScoreFromText(decoded, { source: { kind: 'text' } });
        const fatal = parsed.diagnostics.find((item) => item.severity === 'error');
        if (fatal) {
          app.showToast('error', `导入失败：${fatal.message}${fatal.line ? `（第 ${fatal.line} 行）` : ''}`);
          return;
        }
        nextScore = parsed.score;
      }
      resetEditorForScore(nextScore);
      app.setCurrentScore(nextScore, true);
      app.showToast('success', `已导入 ${file.name}`);
    } catch (error) {
      app.showToast('error', `导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [app, resetEditorForScore]);

  const exportText = useCallback(async () => {
    if (!score) return;
    try {
      const snapshot = stepsToScore(steps, score);
      const path = await window.api.library.exportScore(snapshot, 'dsl');
      if (path) app.showToast('success', `简谱已导出：${path}`);
    } catch (error) {
      app.showToast('error', `导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [app, score, steps]);

  const insertionLabel =
    selectedIndex >= 0
      ? `将插入到第 ${selectedIndex + 1} 个音之后`
      : steps.length === 0
        ? '将录入到空白谱面'
        : '将追加到末尾';

  const openRecorder = useCallback(() => {
    if (preview.playing) preview.stop();
    setRecordOpen(true);
  }, [preview]);

  const handleRecordComplete = useCallback(
    (recorded: ScoreStep[], result: RecordToStepsResult) => {
      setRecordOpen(false);
      if (recorded.length === 0) return;
      const insertAt = selectedIndex >= 0 ? selectedIndex + 1 : steps.length;
      const nextSteps = [...steps.slice(0, insertAt), ...recorded, ...steps.slice(insertAt)];
      const firstSounding = recorded.find((step) => step.degree !== 0) ?? recorded[0];
      commit(nextSteps, firstSounding?.id ?? null);
      syncInputFromStep(firstSounding);
      const count = recorded.filter((step) => step.degree !== 0).length;
      if (result.outOfRangeCount > 0) {
        app.showToast('warning', `已录入 ${count} 个音；${result.outOfRangeCount} 个音超出八度范围，已就近调整`);
      } else if (result.shiftedCount > 0) {
        app.showToast('success', `已录入 ${count} 个音（${result.shiftedCount} 个音按量化网格调整）`);
      } else {
        app.showToast('success', `已录入 ${count} 个音`);
      }
    },
    [app, commit, selectedIndex, steps, syncInputFromStep],
  );

  const handleRecordCancel = useCallback(() => setRecordOpen(false), []);

  // 选中音符后，如果焦点本来就在谱面里，把焦点移到新选中的音符（键盘导航）
  useEffect(() => {
    if (!focusRequest) return;
    const escaped = focusRequest.replace(/["\\]/g, '\\$&');
    const element = document.querySelector<HTMLElement>(`[data-step-id="${escaped}"]`);
    element?.focus({ preventScroll: true });
    setFocusRequest(null);
  }, [focusRequest, steps]);

  // 全局键盘：1-7 / 0 输入，方向键导航，Delete 删除，Esc 取消，Ctrl+Z/Y 撤销重做，Ctrl+S 保存
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      // 实时录入使用悬浮录制条（不是弹窗），背后编辑器的快捷键必须让位
      if (recordOpen) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? '';
      const inForm = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if (inForm) return;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (modifier || event.altKey) return;

      if (/^[0-7]$/.test(event.key)) {
        event.preventDefault();
        applyDegree(Number(event.key) as Degree);
        return;
      }
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          moveSelection(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          moveSelection(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          shiftOctave(1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          shiftOctave(-1);
          break;
        case 'Backspace':
          // 没有选中时 Backspace 删除最后一个音，和文本输入的习惯一致
          event.preventDefault();
          removeSelected(true);
          break;
        case 'Delete':
          // Delete 只删除选中的音；没选中时不做破坏性操作
          if (selectedIndex >= 0) {
            event.preventDefault();
            removeSelected(true);
          }
          break;
        case 'Escape':
          event.preventDefault();
          setSelectedId(null);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [applyDegree, moveSelection, recordOpen, redo, removeSelected, save, selectedIndex, shiftOctave, undo]);

  const selectedDescription = selectedStep ? stepAriaLabel(selectedStep) : '';
  const beatChoices = DURATION_BASES.map((base) => ({
    base,
    name: DURATION_NAMES[base],
    beats: beatLabel(base).replace('拍', ''),
    active: durationState.known && Math.abs(durationState.base - base) < 1e-6,
  }));

  if (!score) {
    return (
      <div className="page">
        <PageHeader title="简谱编辑器" subtitle="正在准备编辑器…" />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="简谱编辑器"
        subtitle="点击音符修改，双击从该音试听；未选中时按 1-7 继续加音"
        actions={
          <>
            <button type="button" className="btn btn--sm" onClick={newScore}>
              <Icon name="plus" size={14} /> 新建
            </button>
            <button type="button" className="btn btn--sm" onClick={() => void importFromFile()}>
              <Icon name="import" size={14} /> 导入文件
            </button>
            <button type="button" className="btn btn--sm" disabled={!score} onClick={() => void exportText()}>
              <Icon name="download" size={14} /> 导出简谱
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!score}
              onClick={() => void save()}
              title="保存方案（Ctrl+S）"
            >
              <Icon name="save" size={14} /> 保存方案
            </button>
          </>
        }
      />

      <section className="card score-meta" aria-label="曲谱基本信息">
        <div className="score-meta__grid">
          <label className="field">
            <span className="field-label">标题</span>
            <input
              className="input"
              value={score.meta.title}
              onChange={(event) => updateMeta({ title: event.target.value })}
              placeholder="曲谱标题"
            />
          </label>
          <label className="field">
            <span className="field-label">速度（BPM）</span>
            <NumberInput
              value={score.meta.tempo}
              min={20}
              max={320}
              ariaLabel="速度（BPM）"
              onCommit={(value) => updateMeta({ tempo: value })}
            />          </label>
          <label className="field">
            <span className="field-label">调号（1=?）</span>
            <select
              className="select"
              value={score.meta.keyRoot}
              onChange={(event) => updateMeta({ keyRoot: Number(event.target.value) })}
            >
              {Array.from({ length: 12 }, (_, index) => (
                <option key={index} value={index}>
                  1={keyLabel(index)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field-label">拍号</span>
            <div className="field-inline">
              <select
                className="select"
                aria-label="每小节拍数"
                value={score.meta.meter.num}
                onChange={(event) =>
                  updateMeta({ meter: { ...score.meta.meter, num: Number(event.target.value) } })
                }
              >
                {numeratorOptions.map((num) => (
                  <option key={num} value={num}>
                    {num}
                  </option>
                ))}
              </select>
              <span className="muted">/</span>
              <select
                className="select"
                aria-label="拍号分母"
                value={score.meta.meter.den}
                onChange={(event) =>
                  updateMeta({
                    meter: { ...score.meta.meter, den: Number(event.target.value) as MeterDen },
                  })
                }
              >
                {[2, 4, 8, 16].map((den) => (
                  <option key={den} value={den}>
                    {den}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="field">
            <span className="field-label">基础八度</span>
            <NumberInput
              value={score.meta.baseOctave}
              min={0}
              max={8}
              integer
              ariaLabel="基础八度"
              onCommit={(value) => updateMeta({ baseOctave: value })}
            />
          </label>
        </div>
      </section>

      {overlapCount > 0 ? (
        <Notice tone="warn" title={`检测到 ${overlapCount} 处重叠音符`} icon={<Icon name="warning" size={14} />}>
          口琴同一时间只能发一个音。下一次编辑会按单声部顺序整理，后面的音会后移；保存后以整理后的顺序为准。
        </Notice>
      ) : null}

      <section className="card score-editor" aria-label="谱面编辑">
        <div className="card-title-row">
          <h2 className="card-title">谱面编辑</h2>
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn--quiet btn--icon btn--sm"
              aria-label="撤销"
              title="撤销（Ctrl+Z）"
              disabled={history.past.length === 0}
              onClick={undo}
            >
              <Icon name="undo" size={14} />
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--icon btn--sm"
              aria-label="重做"
              title="重做（Ctrl+Shift+Z）"
              disabled={history.future.length === 0}
              onClick={redo}
            >
              <Icon name="redo" size={14} />
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={openRecorder}
              title="用游戏口琴键位实时录入：Z X C V B N M , + 鼠标修饰"
            >
              <Icon name="record" size={13} /> 实时录入
            </button>
          </div>
        </div>

        <div className="score-editor__toolbar">
          <div className="tool-group">
            <span className="section-label">音级</span>
            <div className="note-pad" role="group" aria-label="音级键盘">
              {NOTE_KEYS.map((degree) => {
                const isRest = degree === 0;
                return (
                  <button
                    key={degree}
                    type="button"
                    className={`note-key${currentDegree === degree ? ' is-active' : ''}${isRest ? ' note-key--rest' : ''}`}
                    aria-pressed={currentDegree === degree}
                    aria-label={isRest ? '休止符' : `音级 ${degree}（${SOLFEGE[degree - 1]}）`}
                    title={isRest ? '休止符：未选中时在末尾添加，选中时改为休止' : `音级 ${degree}（${SOLFEGE[degree - 1]}）`}
                    onClick={() => applyDegree(degree)}
                  >
                    <span className="note-key__name">{degree}</span>
                    <span className="note-key__solfege">{isRest ? '休止' : SOLFEGE[degree - 1]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="tool-group">
            <label className="section-label" htmlFor="score-editor-octave">
              八度
            </label>
            <select
              id="score-editor-octave"
              className="select compact score-editor__octave"
              value={currentOctave}
              disabled={Boolean(selectedStep) && selectionIsRest}
              onChange={(event) => applyOctave(Number(event.target.value))}
              title={selectionIsRest ? '休止符没有八度' : '相对基础八度的偏移'}
            >
              {OCTAVE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="tool-group">
            <span className="section-label">升降</span>
            <div className="segmented score-editor__accidental" role="group" aria-label="升降号">
              {ACCIDENTALS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="segmented__item"
                  aria-pressed={currentAccidental === option.value}
                  aria-label={option.label}
                  title={option.label}
                  disabled={Boolean(selectedStep) && selectionIsRest}
                  onClick={() => applyAccidental(option.value)}
                >
                  {option.symbol}
                </button>
              ))}
            </div>
          </div>

          <div className="tool-group tool-group--grow">
            <span className="section-label">时值</span>
            <div className="duration-pad" role="group" aria-label="时值">
              {beatChoices.map((choice) => (
                <button
                  key={choice.base}
                  type="button"
                  className={`btn btn--sm duration-key${choice.active ? ' is-active' : ''}`}
                  aria-pressed={choice.active}
                  title={`${choice.name}音符（${beatLabel(choice.base)}）`}
                  onClick={() => applyDurationBase(choice.base)}
                >
                  <span className="duration-key__name">{choice.name}</span>
                  <span className="duration-key__beats">{choice.beats}</span>
                </button>
              ))}
              <button
                type="button"
                className={`btn btn--sm duration-key${durationState.known && durationState.dotted ? ' is-active' : ''}`}
                aria-pressed={durationState.known && durationState.dotted}
                title="附点：时值 ×1.5"
                onClick={toggleDotted}
              >
                <span className="duration-key__name">附点</span>
                <span className="duration-key__beats">×1.5</span>
              </button>
            </div>
          </div>
        </div>

        <div className="score-editor__selection">
          <p className="score-editor__status" aria-live="polite">
            {selectedStep ? (
              <span>
                已选中第 <b>{selectedIndex + 1}</b> 个音 · 第 <b>{selectedMeasure}</b> 小节 · {selectedDescription}
              </span>
            ) : null}
          </p>
          <div className="score-editor__actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={selectedAuditionMs < 0}
              onClick={playFromSelection}
              title={
                selectedIndex < 0
                  ? '先选中一个音符，再从该音开始试听'
                  : selectedAuditionMs < 0
                    ? '这个音之后没有可试听的音符'
                    : '从选中音符开始试听；双击谱面音符也可以'
              }
            >
              <Icon name="headphones" size={13} /> 从此处试听
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={addStep}
              title={selectedStep ? '在选中音符后插入' : '在末尾添加音符'}
            >
              <Icon name="plus" size={13} /> 添加音符
            </button>
            <button
              type="button"
              className={`btn btn--sm${selectedStep?.tie ? ' is-active' : ''}`}
              aria-pressed={selectedStep?.tie ?? false}
              disabled={!canTieSelected}
              onClick={toggleTie}
              title="把当前音连到下一个同音（需要下一个音同音高）"
            >
              连音
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={!selectedStep}
              onClick={() => removeSelected(false)}
              title="删除选中的音符（Delete）"
            >
              <Icon name="trash" size={13} /> 删除
            </button>
            {selectedStep ? (
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => setSelectedId(null)}>
                取消选中
              </button>
            ) : null}
          </div>
        </div>

        {steps.length === 0 ? (
          <div className="score-editor__empty">
            <div className="score-editor__empty-icon" aria-hidden="true">
              <Icon name="music" size={20} />
            </div>
            <div className="score-editor__empty-text">
              <strong>还没有音符</strong>
              <p>按 1-7 添加第一个音，或按 0 添加休止符；也可以点「添加音符」。</p>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => applyDegree(1)}>
              <Icon name="plus" size={13} /> 添加第一个音
            </button>
          </div>
        ) : (
          <div
            className="score-surface score-editor__paper"
            onClick={(event) => {
              // 点谱面空白处取消选中；点音符 / 小节线时保持当前选择
              if ((event.target as HTMLElement).closest('.score-note')) return;
              setSelectedId(null);
            }}
          >
            <ScoreLineEditor
              steps={steps}
              measureBeats={measureBeats}
              measuresPerRow={MEASURES_PER_ROW}
              selectedStepId={selectedId}
              activeStepId={activeStepId}
              revealStepId={selectedId ?? flashId}
              flashStepId={flashId}
              onSelectStep={handleSelectStep}
              onPlayStep={handlePlayStep}
            />
          </div>
        )}
      </section>

      {recordOpen ? (
        <ScoreRecorder
          meta={score.meta}
          instrument={preview.instrument}
          volume={preview.volume}
          insertionLabel={insertionLabel}
          onComplete={handleRecordComplete}
          onCancel={handleRecordCancel}
        />
      ) : null}
    </div>
  );
}

/** 顶部元信息里的数字输入：本地编辑、失焦/回车提交，避免边打字边把值夹到边界 */
function NumberInput({
  value,
  min,
  max,
  integer = false,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  /** 是否只接受整数（基础八度）；BPM 允许 127.9 这样的小数 */
  integer?: boolean;
  ariaLabel: string;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  const cancelRef = useRef(false);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(String(value));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const normalized = integer ? Math.round(parsed) : parsed;
    const clamped = Math.min(max, Math.max(min, normalized));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      className="input number"
      type="number"
      min={min}
      max={max}
      step={integer ? 1 : 0.1}
      value={draft}
      aria-label={ariaLabel}
      title={`${min} – ${max}`}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          cancelRef.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export default EditorPage;
