/// <reference types="vite/client" />
/**
 * ScoreView —— 简谱 SVG 渲染组件（自包含、纯展示）。
 *
 * - 依赖：React + 核心数据模型 `@core/model/score` 的类型 + 同目录 layout.ts，不依赖应用级
 *   CSS / 状态 / store，可被编辑器、演奏页、预览弹窗等任意位置复用；
 * - 排版计算全部在 layout.ts（纯函数、可单测）里完成，这里只负责把布局数据画成 SVG；
 * - 响应式：SVG 使用 viewBox + width:100%，跟随父容器宽度等比缩放；zoom 通过改变 SVG
 *   的百分比宽度实现整体缩放（配合父容器的横向滚动即可放大查看）；
 * - 暗色主题：颜色全部走 CSS 变量（--sv-ink / --sv-accent ……），父容器可覆盖；
 * - 性能：<= 1000 个音符正常渲染；单个音符用 memo 化组件 + 稳定 key，高亮切换时只重渲染
 *   受影响的音符；点击用事件委托，避免每个音符都创建闭包。
 */
import {
  memo,
  useCallback,
  useMemo,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { Score } from '@core/model/score';
import {
  layoutScore,
  SCORE_LAYOUT_METRICS as M,
  type LayoutBarline,
  type LayoutNote,
} from './layout';
import './ScoreView.css';

export interface ScoreViewProps {
  score: Score;
  /** 被选中的音符 id（编辑器高亮） */
  selectedNoteId?: string | null;
  /** 正在播放的音符 id（演奏高亮） */
  activeNoteId?: string | null;
  /** 每行最多几小节，默认 4 */
  measuresPerRow?: number;
  /** 缩放，默认 1（0.25 ~ 4，超出会被夹取） */
  zoom?: number;
  /** 是否显示小节号，默认 true */
  showMeasureNumbers?: boolean;
  /** 点击音符回调（用于编辑器选中） */
  onSelectNote?: (noteId: string) => void;
  className?: string;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

function normalizeZoom(zoom: number | undefined): number {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

const BARLINE_CLASS_NAMES: Record<LayoutBarline['kind'], string> = {
  start: 'sv-barline sv-barline--start',
  bar: 'sv-barline',
  'final-thin': 'sv-barline sv-barline--final-thin',
  'final-thick': 'sv-barline sv-barline--final-thick',
};

const LYRIC_FONT_SIZE = 15;
const TIE_STROKE_WIDTH = 1.8;

interface NoteGlyphProps {
  note: LayoutNote;
  selected: boolean;
  active: boolean;
  clickable: boolean;
  showLyric: boolean;
}

/** 单个音符的 SVG 绘制（memo 化：布局数据不变时，仅高亮状态变化才重渲染） */
const NoteGlyph = memo(function NoteGlyph({
  note,
  selected,
  active,
  clickable,
  showLyric,
}: NoteGlyphProps): JSX.Element {
  const classes = ['sv-note'];
  if (note.isRest) classes.push('sv-note--rest');
  if (clickable) classes.push('sv-note--clickable');
  if (selected) classes.push('sv-note--selected');
  if (active) classes.push('sv-note--active');

  return (
    <g className={classes.join(' ')} data-note-id={note.id}>
      {selected || active ? (
        <rect
          className="sv-note-bg"
          x={note.bounds.x}
          y={note.bounds.y}
          width={note.bounds.width}
          height={note.bounds.height}
          rx={7}
        />
      ) : null}
      {/* hover 时浏览器原生 tooltip：音名 + 时值拍数 */}
      <title>{note.tooltip}</title>
      {note.accidentalSymbol ? (
        <text
          className="sv-accidental"
          x={note.accidentalX}
          y={note.accidentalBaselineY}
          textAnchor="middle"
          fontSize={M.accidentalFontSize}
        >
          {note.accidentalSymbol}
        </text>
      ) : null}
      <text className="sv-digit" x={note.x} y={note.digitBaselineY} textAnchor="middle" fontSize={M.fontSize}>
        {note.text}
      </text>
      {note.underlines.map((line, index) => (
        <line
          key={`underline-${index}`}
          className="sv-underline"
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          strokeWidth={M.underlineThickness}
        />
      ))}
      {note.octaveDots.map((dot, index) => (
        <circle
          key={`octave-${index}`}
          className="sv-octave-dot"
          cx={dot.x}
          cy={dot.y}
          r={M.octaveDotRadius}
        />
      ))}
      {note.dottedPoint ? (
        <circle
          className="sv-duration-dot"
          cx={note.dottedPoint.x}
          cy={note.dottedPoint.y}
          r={M.dottedDotRadius}
        />
      ) : null}
      {note.extensionLines.map((line, index) => (
        <line
          key={`dash-${index}`}
          className="sv-duration-dash"
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          strokeWidth={M.dashThickness}
          strokeLinecap="round"
        />
      ))}
      {showLyric && note.lyric ? (
        <text className="sv-lyric" x={note.lyricX} y={note.lyricY} textAnchor="middle" fontSize={LYRIC_FONT_SIZE}>
          {note.lyric}
        </text>
      ) : null}
    </g>
  );
});

/**
 * 简谱 SVG 渲染组件。
 *
 * ```tsx
 * <ScoreView
 *   score={score}
 *   selectedNoteId={selectedId}
 *   activeNoteId={playingNoteId}
 *   measuresPerRow={4}
 *   zoom={1.2}
 *   onSelectNote={setSelectedId}
 * />
 * ```
 */
export function ScoreView({
  score,
  selectedNoteId = null,
  activeNoteId = null,
  measuresPerRow = 4,
  zoom = 1,
  showMeasureNumbers = true,
  onSelectNote,
  className,
}: ScoreViewProps): JSX.Element {
  const layout = useMemo(() => layoutScore(score, { measuresPerRow }), [score, measuresPerRow]);
  const safeZoom = normalizeZoom(zoom);
  const clickable = typeof onSelectNote === 'function';

  // 事件委托：整张 SVG 只挂一个 click，从 target 向上找 data-note-id
  const handleClick = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>): void => {
      if (!onSelectNote) return;
      const target = event.target as Element | null;
      const noteElement = target && typeof target.closest === 'function' ? target.closest('[data-note-id]') : null;
      const noteId = noteElement?.getAttribute('data-note-id');
      if (noteId) onSelectNote(noteId);
    },
    [onSelectNote],
  );

  const ariaLabel = `简谱：${score?.meta?.title?.trim() || '未命名'}，共 ${layout.notes.length} 个音符`;
  const rootClassName = className ? `sv-score ${className}` : 'sv-score';

  return (
    <div className={rootClassName}>
      <svg
        className="sv-canvas"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMinYMin meet"
        style={{ width: `${safeZoom * 100}%` }}
        role="img"
        aria-label={ariaLabel}
        onClick={clickable ? handleClick : undefined}
      >
        {showMeasureNumbers
          ? layout.measureNumbers.map((label) => (
              <text
                key={`measure-number-${label.measureIndex}`}
                className="sv-measure-number"
                x={label.x}
                y={label.y}
                fontSize={M.measureNumberFontSize}
              >
                {label.text}
              </text>
            ))
          : null}
        {layout.barlines.map((line) => (
          <line
            key={`barline-${line.rowIndex}-${line.measureIndex}-${line.kind}`}
            className={BARLINE_CLASS_NAMES[line.kind]}
            x1={line.x}
            y1={line.y1}
            x2={line.x}
            y2={line.y2}
          />
        ))}
        {layout.ties.map((tie, index) => (
          <path
            key={`tie-${index}-${tie.fromNoteId}-${tie.toNoteId}`}
            className="sv-tie"
            d={tie.path}
            strokeWidth={TIE_STROKE_WIDTH}
          />
        ))}
        {layout.notes.map((note) => (
          <NoteGlyph
            key={note.key}
            note={note}
            selected={selectedNoteId !== null && selectedNoteId !== undefined && note.id === selectedNoteId}
            active={activeNoteId !== null && activeNoteId !== undefined && note.id === activeNoteId}
            clickable={clickable}
            showLyric={layout.hasLyric}
          />
        ))}
      </svg>
    </div>
  );
}

export default ScoreView;
