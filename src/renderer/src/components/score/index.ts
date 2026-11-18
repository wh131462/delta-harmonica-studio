/**
 * 简谱渲染组件统一出口。
 *
 * ```tsx
 * import { ScoreView, layoutScore } from '@renderer/components/score';
 * ```
 */
export {
  ScoreView,
  type ScoreViewProps,
} from './ScoreView';

export {
  ScoreLineEditor,
  type ScoreLineEditorProps,
} from './ScoreLineEditor';

export {
  beatToPoint,
  describeDuration,
  formatBeatCount,
  layoutScore,
  SCORE_LAYOUT_METRICS,
  type BarlineKind,
  type DurationGlyphs,
  type LayoutBarline,
  type LayoutMeasure,
  type LayoutMeasureNumber,
  type LayoutNote,
  type LayoutPoint,
  type LayoutRect,
  type LayoutRow,
  type LayoutSegment,
  type LayoutTie,
  type OctaveDirection,
  type ScoreLayout,
  type ScoreLayoutOptions,
} from './layout';

export { default } from './ScoreView';
