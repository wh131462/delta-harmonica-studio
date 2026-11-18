/**
 * ScoreLineEditor —— 可视化编辑用的简谱音符行。
 *
 * - 输入一条连续的「音符 / 休止」序列，按拍号自动插入小节线、每行固定小节数换行；
 * - 每个音符是一个真实按钮：可点击、可 Tab 聚焦、有 aria-label 与选中态；
 * - 只负责呈现与选中，插入/删除/改属性由页面处理；
 * - 视觉沿用简谱规范：八度点、减时线、附点、增时线、连音标记。
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  beatLabel,
  stepAriaLabel,
  stepsStartBeats,
  type ScoreStep,
} from '@core/score/sequence';
import { describeDuration } from './layout';
import './ScoreLineEditor.css';

export interface ScoreLineEditorProps {
  steps: readonly ScoreStep[];
  /** 每小节拍数（四分音符 = 1 拍） */
  measureBeats: number;
  /** 每行最多几小节 */
  measuresPerRow?: number;
  selectedStepId?: string | null;
  /** 正在试听的音符 */
  activeStepId?: string | null;
  /** 需要滚动到视野内的音符（选中 / 刚添加） */
  revealStepId?: string | null;
  /** 刚添加的音符：短暂高亮 */
  flashStepId?: string | null;
  /** 只读预览（实时录入等）：音符不可点击、不可聚焦 */
  readOnly?: boolean;
  onSelectStep: (stepId: string) => void;
  /** 双击音符：从该音开始试听（不传则没有这个交互） */
  onPlayStep?: (stepId: string) => void;
  className?: string;
}

interface NoteItem {
  kind: 'note';
  key: string;
  step: ScoreStep;
  index: number;
}

interface BarItem {
  kind: 'bar';
  key: string;
  strong: boolean;
  final: boolean;
  breakAfter: boolean;
}

type LineItem = NoteItem | BarItem;

const EPS = 1e-6;
/** 超过这个音符数就隐藏每个音的拍数标签（hover / 选中时仍显示），避免密集谱变成一片“½拍” */
const DENSE_NOTE_THRESHOLD = 48;

/* ============================ 音符块 ============================ */

interface NoteChipProps {
  step: ScoreStep;
  index: number;
  isSelected: boolean;
  isActive: boolean;
  isFlash: boolean;
  readOnly: boolean;
  onSelect: (stepId: string) => void;
  onPlay?: (stepId: string) => void;
}

const NoteChip = memo(function NoteChip({
  step,
  index,
  isSelected,
  isActive,
  isFlash,
  readOnly,
  onSelect,
  onPlay,
}: NoteChipProps): JSX.Element {
  const isRest = step.degree === 0;
  const glyphs = describeDuration(step.duration);
  const octaveDots = isRest ? 0 : Math.min(3, Math.abs(step.octave));
  const dots = Array.from({ length: octaveDots }, (_, dotIndex) => <i key={dotIndex} />);
  const underlines = Array.from({ length: glyphs.underlines }, (_, lineIndex) => (
    <i key={lineIndex} />
  ));
  const dashes = glyphs.extensionLines > 0 ? '—'.repeat(glyphs.extensionLines) : '';
  const accidental = step.accidental === 1 ? '♯' : step.accidental === -1 ? '♭' : '';
  const classes = ['score-note'];
  if (isRest) classes.push('score-note--rest');
  if (isSelected) classes.push('is-selected');
  if (isActive) classes.push('is-active');
  if (isFlash) classes.push('is-flash');

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    onSelect(step.id);
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    onPlay?.(step.id);
  };

  return (
    <button
      type="button"
      className={classes.join(' ')}
      data-step-id={step.id}
      disabled={readOnly}
      aria-pressed={isSelected}
      aria-label={`第 ${index + 1} 个音：${stepAriaLabel(step)}`}
      title={`第 ${index + 1} 个音 · ${stepAriaLabel(step)}${
        onPlay && !readOnly ? ' · 双击从此处试听' : ''
      }`}
      onClick={readOnly ? undefined : handleClick}
      onDoubleClick={readOnly || !onPlay ? undefined : handleDoubleClick}
    >
      <span className="score-note__glyph" aria-hidden="true">
        {octaveDots > 0 && step.octave > 0 ? (
          <span className="score-note__dots score-note__dots--up">{dots}</span>
        ) : null}
        <span className="score-note__body">
          {accidental ? <span className="score-note__accidental">{accidental}</span> : null}
          <span className="score-note__digit">{step.degree}</span>
          {glyphs.dotted ? <span className="score-note__dot" /> : null}
          {dashes ? <span className="score-note__dash">{dashes}</span> : null}
        </span>
        {underlines.length > 0 ? <span className="score-note__underlines">{underlines}</span> : null}
        {octaveDots > 0 && step.octave < 0 ? (
          <span className="score-note__dots score-note__dots--down">{dots}</span>
        ) : null}
      </span>
      <span className="score-note__beats">{beatLabel(step.duration)}</span>
      {step.tie ? (
        <span className="score-note__tie" title="连到下一个同音">
          连
        </span>
      ) : null}
    </button>
  );
});

/* ============================ 行布局 ============================ */

function buildItems(
  steps: readonly ScoreStep[],
  starts: readonly number[],
  measureBeats: number,
  measuresPerRow: number,
): { totalBeats: number; rows: LineItem[][] } {
  if (steps.length === 0) return { totalBeats: 0, rows: [] };

  const safeMeasure = Number.isFinite(measureBeats) && measureBeats > 0 ? measureBeats : 4;
  const perRow = Math.max(1, Math.min(8, Math.round(measuresPerRow) || 4));
  const items: LineItem[] = [
    { kind: 'bar', key: 'bar-start', strong: true, final: false, breakAfter: false },
  ];

  let nextBoundary = safeMeasure;
  let boundaryCount = 0;

  steps.forEach((step, index) => {
    const startBeat = starts[index] ?? 0;
    const endBeat = startBeat + step.duration;
    items.push({
      kind: 'note',
      key: step.id || `note-${index}`,
      step,
      index,
    });
    while (nextBoundary <= endBeat + EPS) {
      boundaryCount += 1;
      const bar: BarItem = {
        kind: 'bar',
        key: `bar-${boundaryCount}`,
        strong: false,
        final: false,
        breakAfter: false,
      };
      items.push(bar);
      nextBoundary = Number((nextBoundary + safeMeasure).toFixed(6));
      // 防止极端拍号（如 1/16）下无限循环
      if (boundaryCount > 4096) break;
    }
  });

  const lastStep = steps[steps.length - 1];
  const lastStart = starts[starts.length - 1] ?? 0;
  const totalBeats = Number((lastStart + (lastStep?.duration ?? 0)).toFixed(6));

  // 终止线：若最后一个元素正好落在结尾边界，直接把它标成终止线；否则在结尾补一条
  const lastItem = items[items.length - 1];
  const endingOnBoundary = lastItem?.kind === 'bar' && Math.abs(nextBoundary - safeMeasure - totalBeats) < EPS;
  if (endingOnBoundary && lastItem.kind === 'bar') {
    lastItem.final = true;
  } else {
    items.push({ kind: 'bar', key: 'bar-final', strong: false, final: true, breakAfter: false });
  }

  // 每行 measuresPerRow 个小节：在对应小节的收尾小节线后换行
  // （长音跨小节会连续出现多条小节线，等这一组画完、下一条是音符时再换行）
  let boundarySeen = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'bar' || item.strong || item.final) continue;
    boundarySeen += 1;
    if (boundarySeen % perRow !== 0) continue;
    const next = items[index + 1];
    if (next?.kind === 'note') item.breakAfter = true;
  }

  const rows: LineItem[][] = [];
  let current: LineItem[] = [];
  for (const item of items) {
    current.push(item);
    if (item.kind === 'bar' && item.breakAfter) {
      rows.push(current);
      current = [];
    }
  }
  if (current.length > 0) rows.push(current);

  return { totalBeats, rows };
}

/* ============================ 组件 ============================ */

export function ScoreLineEditor({
  steps,
  measureBeats,
  measuresPerRow = 4,
  selectedStepId = null,
  activeStepId = null,
  revealStepId = null,
  flashStepId = null,
  readOnly = false,
  onSelectStep,
  onPlayStep,
  className,
}: ScoreLineEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const starts = useMemo(() => stepsStartBeats(steps), [steps]);
  const layout = useMemo(
    () => buildItems(steps, starts, measureBeats, measuresPerRow),
    [steps, starts, measureBeats, measuresPerRow],
  );

  // 选中 / 新加音符时滚动到可见区域。
  // 只滚动谱面自己的父容器（纸面），不用 scrollIntoView —— 后者会连带
  // 滚动 document，导致顶栏和侧栏被卷出视口。
  useEffect(() => {
    const targetId = revealStepId ?? selectedStepId;
    const container = containerRef.current;
    if (!targetId || !container) return;
    const escaped = targetId.replace(/["\\]/g, '\\$&');
    const element = container.querySelector<HTMLElement>(`[data-step-id="${escaped}"]`);
    if (!element) return;
    const scroller = container.parentElement;
    if (!scroller) return;
    const elementRect = element.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const margin = 12;
    if (elementRect.top < scrollerRect.top + margin) {
      scroller.scrollTop -= scrollerRect.top + margin - elementRect.top;
    } else if (elementRect.bottom > scrollerRect.bottom - margin) {
      scroller.scrollTop += elementRect.bottom - scrollerRect.bottom + margin;
    }
  }, [revealStepId, selectedStepId, steps.length]);

  const rootClassName = [
    'score-line',
    steps.length > DENSE_NOTE_THRESHOLD ? 'score-line--dense' : '',
    readOnly ? 'score-line--readonly' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const soundingCount = steps.reduce((count, step) => count + (step.degree !== 0 ? 1 : 0), 0);

  return (
    <div
      className={rootClassName}
      ref={containerRef}
      role="group"
      aria-label={`简谱音符，共 ${steps.length} 个音符，其中 ${soundingCount} 个有音高`}
      data-total-beats={layout.totalBeats}
    >
      {layout.rows.map((row, rowIndex) => (
        <div className="score-line__row" key={`row-${rowIndex}`}>
          {row.map((item) =>
            item.kind === 'bar' ? (
              <span
                key={item.key}
                className={`score-line__bar${item.strong ? ' is-strong' : ''}${item.final ? ' is-final' : ''}`}
                aria-hidden="true"
              />
            ) : (
              <NoteChip
                key={item.key}
                step={item.step}
                index={item.index}
                isSelected={selectedStepId === item.step.id}
                isActive={activeStepId === item.step.id}
                isFlash={flashStepId === item.step.id}
                readOnly={readOnly}
                onSelect={onSelectStep}
                onPlay={onPlayStep}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

export default ScoreLineEditor;
