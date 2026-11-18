import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Score } from '@core/model/score';
import { DEFAULT_HARMONICA } from '@core/model/instrument';
import {
  PRACTICE_GRADE_LABEL,
  buildPracticeSession,
  scoreBarCount,
  type PracticeGrade,
  type PracticeSession,
  type PracticeStep,
} from '@core/practice';
import type { PracticeNoteStyle, PracticeSettings } from '@shared/types';
import { Icon } from '@renderer/components/Icon';
import { EmptyState, Notice, PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { usePreview } from '@renderer/audio/preview-context';
import { usePerformance, type TransposeValue } from '@renderer/performance/performance-context';
import {
  usePracticeRun,
  type LaneMetrics,
  type PracticePhase,
} from '@renderer/practice/practice-run';
import { formatDurationMs } from '@renderer/utils/format';
import '@renderer/styles/page-practice.css';

const TRANSPOSE_CHOICES: TransposeValue[] = [0, 'auto', 1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6];
const GRADE_ORDER: PracticeGrade[] = ['perfect', 'great', 'good', 'miss', 'wrong'];
const SPEED_MIN = 50;
const SPEED_MAX = 125;
const SPEED_STEP = 5;
/** 下落式的音键列：与物理键位一致，便于把「哪一列」直接映射成按哪个键 */
const KEY_COLUMNS = DEFAULT_HARMONICA.noteKeys.map((key) => key.label);

const PHASE_BADGE: Record<PracticePhase, { label: string; tone: string }> = {
  idle: { label: '待开始', tone: '' },
  running: { label: '练习中', tone: 'badge--ok' },
  waiting: { label: '等待按键', tone: 'badge--accent' },
  paused: { label: '已暂停', tone: '' },
  finished: { label: '已完成', tone: 'badge--ok' },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDelta(deltaMs: number): string {
  const rounded = Math.round(deltaMs);
  if (rounded === 0) return '±0 ms';
  return `${rounded > 0 ? '+' : ''}${rounded} ms`;
}

function formatAccuracy(accuracy: number | null): string {
  if (accuracy === null) return '—';
  if (accuracy >= 99.95) return '100%';
  if (accuracy < 0.05) return '0%';
  return `${accuracy.toFixed(1)}%`;
}

/** 下落式占用的音键列：取推荐按法的最后一个字符（Z / X / … / ,） */
function columnOf(step: PracticeStep): number {
  const label = step.keys.slice(-1);
  const index = KEY_COLUMNS.indexOf(label);
  return index >= 0 ? index : 3;
}

/** 谱面显示方式切换：横向滚动 / 下落式 */
function NoteStyleSwitch({
  value,
  onChange,
  label,
}: {
  value: PracticeNoteStyle;
  onChange(value: PracticeNoteStyle): void;
  label: string;
}): JSX.Element {
  return (
    <div className="segmented practice-note-style" role="group" aria-label={label}>
      <button
        type="button"
        className="segmented__item"
        aria-pressed={value === 'scroll'}
        title="音符从右向左滚动，经过左侧判定线"
        onClick={() => onChange('scroll')}
      >
        横向
      </button>
      <button
        type="button"
        className="segmented__item"
        aria-pressed={value === 'fall'}
        title="音符按音键分列下落，落到下方判定线时按键"
        onClick={() => onChange('fall')}
      >
        下落
      </button>
    </div>
  );
}

/** 当前练习时间对应的小节号 */
function barAt(session: PracticeSession, clockMs: number): number {
  const relativeBeat = (clockMs - session.leadInMs) / session.beatMs;
  if (relativeBeat <= 0) return session.startBar;
  const barOffset = Math.floor(relativeBeat / session.measureBeats);
  return Math.min(session.endBar, session.startBar + barOffset);
}

/** 轨道上的单个音符：音符头固定在拍点上，时值用后面的细尾表示，避免长音盖住旁边的音 */
const PracticeNote = memo(function PracticeNote({
  step,
  pxPerMs,
  headMaxWidth,
  grade,
  isTarget,
}: {
  step: PracticeStep;
  pxPerMs: number;
  /** 音符头最大宽度：由相邻音的间距决定，保证两个音头不相撞 */
  headMaxWidth: number;
  grade: PracticeGrade | null;
  isTarget: boolean;
}): JSX.Element {
  const headWidth = Math.max(18, Math.min(52, headMaxWidth));
  const tailWidth = Math.max(0, step.holdMs * pxPerMs);
  const showTail = tailWidth > headWidth / 2 + 2;
  const compact = headWidth < 40;
  const accidental = step.accidental === 1 ? '#' : step.accidental === -1 ? 'b' : '';
  const upDots = step.octave > 0 ? '·'.repeat(Math.min(3, step.octave)) : '';
  const downDots = step.octave < 0 ? '·'.repeat(Math.min(3, -step.octave)) : '';
  return (
    <div
      className={`practice-note${isTarget ? ' is-target' : ''}${compact ? ' is-compact' : ''}`}
      data-grade={grade ?? undefined}
      data-keys={step.keys}
      style={{ left: step.timeMs * pxPerMs }}
      aria-hidden="true"
    >
      {showTail ? <span className="practice-note__tail" style={{ width: tailWidth }} /> : null}
      <span className="practice-note__head" style={{ width: headWidth }}>
        <span className="practice-note__digit">
          {upDots ? <span className="practice-note__dots practice-note__dots--up">{upDots}</span> : null}
          {accidental}
          {step.degree}
          {downDots ? <span className="practice-note__dots practice-note__dots--down">{downDots}</span> : null}
        </span>
        <span className="practice-note__keys">{step.keys}</span>
      </span>
    </div>
  );
});

/** 轨道本体：小节线 / 预备区 / 音符。与 HUD 分离，时钟刷新时不会重画整条轨道。 */
const PracticeTrack = memo(function PracticeTrack({
  session,
  metrics,
  grades,
  waitTargetIndex,
  trackRef,
}: {
  session: PracticeSession;
  metrics: LaneMetrics;
  grades: ReadonlyArray<PracticeGrade | null>;
  waitTargetIndex: number | null;
  trackRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const { pxPerMs, pxPerBeat } = metrics;
  const barWidth = session.measureBeats * pxPerBeat;
  const beatWidth = pxPerBeat;
  const countInWidth = session.leadInMs * pxPerMs;
  const segmentWidth = session.totalBeats * pxPerBeat;
  const trackWidth = session.durationMs * pxPerMs + 160;
  const labelStep = barWidth < 56 ? 4 : barWidth < 88 ? 2 : 1;
  const trackStyle = {
    width: trackWidth,
    '--beat-w': `${beatWidth}px`,
  } as CSSProperties;
  const barsStyle = {
    left: countInWidth,
    width: segmentWidth,
    '--bar-w': `${barWidth}px`,
    '--beat-w': `${beatWidth}px`,
  } as CSSProperties;
  const countInStyle = {
    width: countInWidth,
    '--beat-w': `${beatWidth}px`,
  } as CSSProperties;

  return (
    <div className="practice-track" ref={trackRef} style={trackStyle}>
      <div className="practice-track__countin" style={countInStyle} />
      <div className="practice-track__bars" style={barsStyle}>
        {Array.from({ length: session.segmentBars }, (_, index) => index)
          .filter((index) => index % labelStep === 0)
          .map((index) => (
            <span key={index} className="practice-bar-label" style={{ left: index * barWidth }}>
              {session.startBar + index}
            </span>
          ))}
      </div>
      {session.steps.map((step, index) => {
        const previous = session.steps[index - 1];
        const next = session.steps[index + 1];
        const previousGap = previous ? (step.timeMs - previous.timeMs) * pxPerMs : 220;
        const nextGap = next ? (next.timeMs - step.timeMs) * pxPerMs : 220;
        return (
          <PracticeNote
            key={step.id}
            step={step}
            pxPerMs={pxPerMs}
            headMaxWidth={Math.min(previousGap, nextGap) - 2}
            grade={grades[step.index] ?? null}
            isTarget={waitTargetIndex === step.index}
          />
        );
      })}
    </div>
  );
});

/** 下落式单个音符：上下方向表示时间，横向位置对应音键列。 */
const FallingNote = memo(function FallingNote({
  step,
  pxPerMs,
  headHeight,
  columnWidth,
  column,
  grade,
  isTarget,
}: {
  step: PracticeStep;
  pxPerMs: number;
  headHeight: number;
  columnWidth: number;
  column: number;
  grade: PracticeGrade | null;
  isTarget: boolean;
}): JSX.Element {
  const headWidth = Math.max(28, columnWidth - 8);
  const compact = headHeight < 34;
  const tailHeight = step.holdMs * pxPerMs;
  const showTail = tailHeight > headHeight + 6;
  const accidental = step.accidental === 1 ? '#' : step.accidental === -1 ? 'b' : '';
  const upDots = step.octave > 0 ? '·'.repeat(Math.min(3, step.octave)) : '';
  const downDots = step.octave < 0 ? '·'.repeat(Math.min(3, -step.octave)) : '';
  return (
    <div
      className={`practice-fall-note${isTarget ? ' is-target' : ''}${compact ? ' is-compact' : ''}`}
      data-grade={grade ?? undefined}
      data-keys={step.keys}
      style={{
        left: column * columnWidth + columnWidth / 2,
        top: -(step.timeMs * pxPerMs) - headHeight,
        width: headWidth,
        height: headHeight,
      }}
      aria-hidden="true"
    >
      {showTail ? <span className="practice-fall-note__tail" style={{ height: tailHeight }} /> : null}
      <span className="practice-fall-note__face">
        <span className="practice-fall-note__pitch">
          {upDots ? <span className="practice-fall-note__dots">{upDots}</span> : null}
          <span className="practice-fall-note__digit">
            {accidental}
            {step.degree}
          </span>
          {downDots ? <span className="practice-fall-note__dots">{downDots}</span> : null}
        </span>
        {compact ? null : <span className="practice-fall-note__keys">{step.keys}</span>}
      </span>
    </div>
  );
});

/** 下落式轨道本体：预备区 / 小节线 / 音符；时间向上增长，向下落向判定线。 */
const FallingTrack = memo(function FallingTrack({
  session,
  metrics,
  grades,
  waitTargetIndex,
  trackRef,
}: {
  session: PracticeSession;
  metrics: LaneMetrics;
  grades: ReadonlyArray<PracticeGrade | null>;
  waitTargetIndex: number | null;
  trackRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const { pxPerMs, pxPerBeat, columnWidth } = metrics;
  const countInHeight = session.leadInMs * pxPerMs;
  const segmentHeight = session.totalBeats * pxPerBeat;
  const barHeight = session.measureBeats * pxPerBeat;
  const labelStep = barHeight < 56 ? 4 : barHeight < 88 ? 2 : 1;

  // 同一列相邻音之间收窄音头，快速重复音不会叠在一起
  const headHeights = useMemo(() => {
    const heights = new Array<number>(session.steps.length).fill(56);
    const nextByColumn = new Map<number, number>();
    for (let index = session.steps.length - 1; index >= 0; index -= 1) {
      const step = session.steps[index];
      const column = columnOf(step);
      const nextIndex = nextByColumn.get(column);
      const gap =
        nextIndex === undefined
          ? Number.POSITIVE_INFINITY
          : (session.steps[nextIndex].timeMs - step.timeMs) * pxPerMs;
      heights[index] = clamp(gap - 6, 22, 56);
      nextByColumn.set(column, index);
    }
    return heights;
  }, [session.steps, pxPerMs]);

  const countInStyle = {
    top: -countInHeight,
    height: countInHeight,
    '--beat-h': `${pxPerBeat}px`,
  } as CSSProperties;
  const barsStyle = {
    top: -(countInHeight + segmentHeight),
    height: segmentHeight,
    '--bar-h': `${barHeight}px`,
    '--beat-h': `${pxPerBeat}px`,
  } as CSSProperties;

  return (
    <div className="practice-track practice-track--fall" ref={trackRef}>
      <div className="practice-fall-board" style={{ left: metrics.boardLeft, width: columnWidth * 8 }}>
        <div className="practice-fall-countin" style={countInStyle} />
        <div className="practice-fall-bars" style={barsStyle} />
        {Array.from({ length: session.segmentBars }, (_, index) => index)
          .filter((index) => index % labelStep === 0)
          .map((index) => (
            <span
              key={index}
              className="practice-bar-label practice-bar-label--fall"
              style={{ top: -(countInHeight + index * barHeight) }}
            >
              {session.startBar + index}
            </span>
          ))}
        {session.steps.map((step, index) => (
          <FallingNote
            key={step.id}
            step={step}
            pxPerMs={pxPerMs}
            headHeight={headHeights[index]}
            columnWidth={columnWidth}
            column={columnOf(step)}
            grade={grades[step.index] ?? null}
            isTarget={waitTargetIndex === step.index}
          />
        ))}
      </div>
    </div>
  );
});

/** 下落式静态底板：音键列与判定线，不随时间移动。 */
const FallingGrid = memo(function FallingGrid({ metrics }: { metrics: LaneMetrics }): JSX.Element {
  const boardStyle = {
    left: metrics.boardLeft,
    width: metrics.columnWidth * 8,
  } as CSSProperties;
  return (
    <>
      <div className="practice-fall-grid" style={boardStyle} aria-hidden="true">
        {KEY_COLUMNS.map((label) => (
          <span key={label} className="practice-fall-column" />
        ))}
      </div>
      <div
        className="practice-fall-floor"
        style={{ top: metrics.hitY }}
        aria-hidden="true"
      />
      <div
        className="practice-fall-hitline"
        style={{ top: metrics.hitY, left: metrics.boardLeft - 16, width: metrics.columnWidth * 8 + 32 }}
        aria-hidden="true"
      />
      <div className="practice-fall-keys" style={boardStyle} aria-hidden="true">
        {KEY_COLUMNS.map((label) => (
          <span key={label} className="practice-fall-key">
            {label}
          </span>
        ))}
      </div>
    </>
  );
});

function PracticeBoard({
  session,
  run,
  mode,
  noteStyle,
  hitSound,
  locked,
  onStart,
  onPause,
  onResume,
  onStop,
}: {
  session: PracticeSession;
  run: ReturnType<typeof usePracticeRun>;
  mode: PracticeSettings['mode'];
  noteStyle: PracticeNoteStyle;
  hitSound: boolean;
  locked: boolean;
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}): JSX.Element {
  const { summary, phase, feedback } = run;
  const canStart = session.steps.length > 0;
  const progress = session.durationMs > 0 ? clamp((run.clockMs / session.durationMs) * 100, 0, 100) : 0;
  const accuracyText = formatAccuracy(summary.accuracy);
  const phaseBadge = PHASE_BADGE[phase];
  const currentBar = barAt(session, run.clockMs);
  const positionText =
    phase === 'idle'
      ? `第 ${session.startBar}–${session.endBar} 小节 · ${session.steps.length} 个音`
      : phase === 'running' || phase === 'waiting' || phase === 'paused'
        ? `第 ${currentBar} 小节 / ${session.endBar}${run.loopCount > 1 ? ` · 第 ${run.loopCount} 遍` : ''}`
        : null;

  const expectedStep = (() => {
    if (!feedback) return null;
    if (feedback.grade === 'wrong') return run.nextStepIndex >= 0 ? session.steps[run.nextStepIndex] : null;
    if (feedback.grade === 'miss') return feedback.noteIndex !== null ? session.steps[feedback.noteIndex] : null;
    return null;
  })();

  const laneStyle = {
    '--hit-x': `${run.metrics.hitX}px`,
    '--hit-y': `${run.metrics.hitY}px`,
  } as CSSProperties;

  return (
    <section className="card practice-board" aria-label="练习轨道">
      <div className="practice-hud">
        <div className="practice-metric">
          <span className="practice-metric__value num">{accuracyText}</span>
          <span className="practice-metric__label">准确率</span>
        </div>
        <div className="practice-metric">
          <span className="practice-metric__value num">{summary.combo}</span>
          <span className="practice-metric__label">连击</span>
        </div>
        <div className="practice-hud__status">
          <span className={`badge ${phaseBadge.tone}`.trim()}>{phaseBadge.label}</span>
          {positionText ? <span className="hint-text">{positionText}</span> : null}
        </div>
        <div className="practice-hud__actions">
          {phase === 'running' || phase === 'waiting' ? (
            <button type="button" className="btn" onClick={onPause} title="暂停练习（空格）">
              <Icon name="pause" size={14} /> 暂停
            </button>
          ) : phase === 'paused' ? (
            <button type="button" className="btn btn--primary" onClick={onResume} title="继续练习（空格）">
              <Icon name="play" size={14} /> 继续
            </button>
          ) : phase === 'finished' ? (
            <button type="button" className="btn btn--primary" onClick={onStart} title="按同样的设置再练一遍">
              <Icon name="reset" size={14} /> 重新开始
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canStart || locked}
              title={canStart ? '开始练习（含预备拍）' : '所选段落没有可练习的音符'}
              onClick={onStart}
            >
              <Icon name="play" size={14} /> 开始练习
            </button>
          )}
          {phase !== 'idle' ? (
            <button type="button" className="btn btn--danger btn--sm" onClick={onStop} title="结束本次练习并清空成绩">
              结束
            </button>
          ) : null}
        </div>
      </div>

      <div className="practice-progress">
        <div
          className="progress"
          role="progressbar"
          aria-label="练习进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          aria-valuetext={`${formatDurationMs(run.clockMs)} / ${formatDurationMs(session.durationMs)}`}
        >
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
        <span className="practice-progress__time">
          {formatDurationMs(run.clockMs)} / {formatDurationMs(session.durationMs)}
        </span>
      </div>

      <div
        className={`practice-lane${noteStyle === 'fall' ? ' practice-lane--fall' : ''}`}
        style={laneStyle}
        ref={run.laneRef}
      >
        {noteStyle === 'fall' ? (
          <>
            <FallingGrid metrics={run.metrics} />
            <FallingTrack
              session={session}
              metrics={run.metrics}
              grades={run.judge.grades}
              waitTargetIndex={run.waitTargetIndex}
              trackRef={run.trackRef}
            />
          </>
        ) : (
          <>
            <PracticeTrack
              session={session}
              metrics={run.metrics}
              grades={run.judge.grades}
              waitTargetIndex={run.waitTargetIndex}
              trackRef={run.trackRef}
            />
            <div className="practice-hitline" aria-hidden="true" />
          </>
        )}

        {session.steps.length === 0 ? (
          <div className="practice-veil">
            <p className="practice-veil__title">本段没有音符</p>
            <p className="practice-veil__text">换一个段落，或到简谱编辑器给这一段补充音符。</p>
          </div>
        ) : phase === 'paused' ? (
          <div className="practice-veil">
            <p className="practice-veil__title">按空格继续</p>
            <p className="practice-veil__text">点「继续」接着练；按 Esc 结束本次练习。</p>
          </div>
        ) : phase === 'finished' ? (
          <div className="practice-veil">
            <p className="practice-veil__title">按空格再来一遍</p>
            <p className="practice-veil__text">也可以换一段或加一点速度，再练一遍。</p>
          </div>
        ) : null}
      </div>

      <div className="practice-feedback-row">
        {feedback ? (
          <div className="practice-feedback" data-grade={feedback.grade} key={feedback.nonce}>
            <strong>{PRACTICE_GRADE_LABEL[feedback.grade]}</strong>
            {feedback.grade === 'perfect' || feedback.grade === 'great' || feedback.grade === 'good' ? (
              <span className="practice-feedback__delta num">{formatDelta(feedback.deltaMs)}</span>
            ) : null}
            {expectedStep ? (
              <span className="practice-feedback__expected">
                应为 {expectedStep.noteName} · {expectedStep.keys}
              </span>
            ) : null}
          </div>
        ) : phase === 'idle' && session.steps.length > 0 ? (
          <p className="hint-text practice-start-hint">
            先听 {Math.round(session.countInBeats * 10) / 10} 拍预备；
            {noteStyle === 'fall' ? '音符从上方按音键分列下落，' : '音符从右侧进入判定线，'}
            {hitSound ? '按下音键就有声音。' : '按键发声已关闭，只有节拍器。'}
          </p>
        ) : null}
      </div>

      <p className="hint-text practice-legend">
        <span>
          音键 <code>Z X C V B N M ,</code> = 1 2 3 4 5 6 7 高音1
        </span>
        <span>鼠标左键降八度 · 右键升八度 · 中键升半音（同音高的其他按法同样算对）</span>
        <span>
          <kbd>空格</kbd> 暂停/继续 · <kbd>Esc</kbd> 结束
        </span>
      </p>

      <div className="practice-summary">
        <span className="practice-summary__label">本次成绩</span>
        <div className="practice-summary__grades">
          {mode === 'wait' ? (
            <>
              <span className="practice-summary__grade" data-grade="perfect">
                命中 <b className="num">{summary.hits}</b>
              </span>
              <span className="practice-summary__grade" data-grade="wrong">
                错音 <b className="num">{summary.wrong}</b>
              </span>
            </>
          ) : (
            GRADE_ORDER.map((grade) => (
              <span key={grade} className="practice-summary__grade" data-grade={grade}>
                {PRACTICE_GRADE_LABEL[grade]} <b className="num">{summary.counts[grade]}</b>
              </span>
            ))
          )}
        </div>
        <span className="practice-summary__meta">
          最高连击 <b className="num">{summary.maxCombo}</b>
          {mode === 'timing' && summary.meanDeltaMs !== null ? (
            <>
              {' · '}平均偏差 <b className="num">{formatDelta(summary.meanDeltaMs)}</b>
            </>
          ) : null}
          {' · '}已判定 <b className="num">{summary.judged}</b>/<b className="num">{summary.totalNotes}</b>
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          {phase === 'paused' ? '练习已暂停' : phase === 'finished' ? '练习已完成' : ''}
        </span>
      </div>
    </section>
  );
}

function PracticeSettingsCard({
  session,
  barCount,
  startBar,
  endBar,
  speed,
  locked,
  mode,
  practice,
  effectiveTranspose,
  transposeValue,
  onChangeStartBar,
  onChangeEndBar,
  onChangeSpeed,
  onChangeMode,
  onChangePractice,
  onChangeTranspose,
  onResetRange,
}: {
  session: PracticeSession;
  barCount: number;
  startBar: number;
  endBar: number;
  speed: number;
  locked: boolean;
  mode: PracticeSettings['mode'];
  practice: PracticeSettings;
  effectiveTranspose: number;
  transposeValue: TransposeValue;
  onChangeStartBar(value: number): void;
  onChangeEndBar(value: number): void;
  onChangeSpeed(value: number): void;
  onChangeMode(value: PracticeSettings['mode']): void;
  onChangePractice(patch: Partial<PracticeSettings>): void;
  onChangeTranspose(value: TransposeValue): void;
  onResetRange(): void;
}): JSX.Element {
  const fullRange = startBar === 1 && endBar === barCount;
  const lockedTitle = locked ? '练习进行中：结束或完成后才能修改' : undefined;
  return (
    <section className="card practice-config" aria-label="练习设置">
      <div className="card-title-row">
        <h2 className="card-title">练习设置</h2>
        {locked ? <span className="badge">练习中锁定</span> : null}
      </div>

      <div className="field">
        <span className="field-label" id="practice-range-label">
          段落
        </span>
        <div className="practice-range" role="group" aria-labelledby="practice-range-label">
          <select
            className="select"
            aria-label="起始小节"
            value={startBar}
            disabled={locked}
            title={lockedTitle}
            onChange={(event) => onChangeStartBar(Number(event.target.value))}
          >
            {Array.from({ length: barCount }, (_, index) => index + 1).map((bar) => (
              <option key={bar} value={bar}>
                第 {bar} 小节
              </option>
            ))}
          </select>
          <span className="practice-range__sep" aria-hidden="true">
            –
          </span>
          <select
            className="select"
            aria-label="结束小节"
            value={endBar}
            disabled={locked}
            title={lockedTitle}
            onChange={(event) => onChangeEndBar(Number(event.target.value))}
          >
            {Array.from({ length: barCount }, (_, index) => index + 1).map((bar) => (
              <option key={bar} value={bar}>
                第 {bar} 小节{bar === barCount ? '（曲末）' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={locked || fullRange}
            title="练整首"
            onClick={onResetRange}
          >
            全曲
          </button>
        </div>
        <span className="field-hint">
          共 {barCount} 小节 · 练习时长 {formatDurationMs(session.durationMs)}
        </span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="practice-speed">
          速度 <span className="practice-value num">{Math.round(speed * 100)}%</span>
        </label>
        <input
          id="practice-speed"
          className="range practice-speed"
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={Math.round(speed * 100)}
          disabled={locked}
          title={lockedTitle ?? '降低速度先练熟，再逐步加速'}
          onChange={(event) => onChangeSpeed(Number(event.target.value) / 100)}
        />
        <span className="field-hint">
          实际 {Math.round(session.tempo)} BPM（原速 {Math.round(session.scoreTempo)} BPM）
        </span>
      </div>

      <div className="field">
        <span className="field-label" id="practice-mode-label">
          模式
        </span>
        <div className="segmented" role="group" aria-labelledby="practice-mode-label">
          <button
            type="button"
            className="segmented__item"
            aria-pressed={mode === 'timing'}
            disabled={locked}
            title="音符按时间滚动，踩准判定线；漏掉的音会记为失误"
            onClick={() => onChangeMode('timing')}
          >
            计时判定
          </button>
          <button
            type="button"
            className="segmented__item"
            aria-pressed={mode === 'wait'}
            disabled={locked}
            title="时间停住，按对当前音才继续——适合认谱和找键位"
            onClick={() => onChangeMode('wait')}
          >
            等待按键
          </button>
        </div>
        <span className="field-hint">
          {mode === 'wait' ? '时间停住，按对当前音才继续；不计时，只看音准。' : '按时间滚动；判定窗口 ±150ms，完美 ±55ms。'}
        </span>
      </div>

      <div className="field">
        <span className="field-label">谱面</span>
        <NoteStyleSwitch
          value={practice.noteStyle}
          label="谱面显示方式"
          onChange={(value) => onChangePractice({ noteStyle: value })}
        />
        <span className="field-hint">
          {practice.noteStyle === 'fall'
            ? '音符按音键分列下落，落到判定线时按键；练习中也能随时切换。'
            : '音符从右向左经过判定线；练习中也能随时切换为下落式。'}
        </span>
      </div>

      <div className="switch-row">
        <label className="switch" title="练完本段后自动从头再来">
          <input
            type="checkbox"
            checked={practice.loop}
            onChange={(event) => onChangePractice({ loop: event.target.checked })}
          />
          <span>循环本段</span>
        </label>
        <label className="switch" title="预备拍与每拍都有点击声">
          <input
            type="checkbox"
            checked={practice.metronome}
            onChange={(event) => onChangePractice({ metronome: event.target.checked })}
          />
          <span>节拍器</span>
        </label>
        <label className="switch" title="每次按下音键立即用当前音色发声；关闭后只剩节拍器">
          <input
            type="checkbox"
            checked={practice.hitSound}
            onChange={(event) => onChangePractice({ hitSound: event.target.checked })}
          />
          <span>按键发声</span>
        </label>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="practice-transpose">
          移调 <span className="practice-value num">{effectiveTranspose > 0 ? `+${effectiveTranspose}` : effectiveTranspose} 半音</span>
        </label>
        <select
          id="practice-transpose"
          className="select"
          value={transposeValue === 'auto' ? 'auto' : String(transposeValue)}
          disabled={locked}
          title={lockedTitle ?? '与演奏台共用：练习时按同样的移调按法'}
          onChange={(event) =>
            onChangeTranspose(event.target.value === 'auto' ? 'auto' : (Number(event.target.value) as TransposeValue))
          }
        >
          <option value="0">原调（不移调）</option>
          <option value="auto">自动选调（与演奏台一致）</option>
          {TRANSPOSE_CHOICES.filter((value): value is number => typeof value === 'number' && value !== 0).map(
            (value) => (
              <option key={value} value={value}>
                {value > 0 ? `+${value}` : value} 半音
              </option>
            ),
          )}
        </select>
      </div>

      {session.warnings.length > 0 && session.steps.length > 0 ? (
        <Notice tone="warn" title="这段谱面需要注意" icon={<Icon name="warning" size={15} />}>
          {session.warnings.join('；')}
        </Notice>
      ) : null}
    </section>
  );
}

/** 全屏练习的顶栏：曲名 / 谱面切换 / 退出。设置面板在全屏下隐藏，显示方式仍需随手可切。 */
function PracticeFocusBar({
  title,
  noteStyle,
  onChangeNoteStyle,
  onExit,
}: {
  title: string;
  noteStyle: PracticeNoteStyle;
  onChangeNoteStyle(value: PracticeNoteStyle): void;
  onExit(): void;
}): JSX.Element {
  return (
    <div className="practice-focus-bar">
      <span className="practice-focus-bar__title" title={title}>
        {title}
      </span>
      <div className="practice-focus-bar__actions">
        <NoteStyleSwitch value={noteStyle} label="谱面显示方式" onChange={onChangeNoteStyle} />
        <button type="button" className="btn btn--sm" onClick={onExit} title="退出全屏练习">
          <Icon name="collapse" size={14} /> 退出全屏
        </button>
      </div>
    </div>
  );
}

function PracticeScoreView({
  score,
  focus,
  onChangeFocus,
}: {
  score: Score;
  focus: boolean;
  onChangeFocus(focus: boolean): void;
}): JSX.Element {
  const app = useAppStore();
  const perf = usePerformance();
  const preview = usePreview();
  const practice = app.settings.practice;
  const barCount = useMemo(() => scoreBarCount(score), [score]);
  const [startBar, setStartBar] = useState(1);
  const [endBar, setEndBar] = useState(barCount);
  const [speed, setSpeed] = useState(practice.speed);
  const speedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStartBar(1);
    setEndBar(barCount);
  }, [score.id, barCount]);

  const persistedSpeed = practice.speed;
  useEffect(() => {
    if (Math.abs(speed - persistedSpeed) < 1e-6) return undefined;
    speedTimer.current = setTimeout(() => {
      void app.updateSettings({ practice: { ...app.settings.practice, speed } });
    }, 300);
    return () => {
      if (speedTimer.current) clearTimeout(speedTimer.current);
    };
  }, [speed, persistedSpeed, app]);

  const safeStart = clamp(startBar, 1, barCount);
  const safeEnd = clamp(endBar, safeStart, barCount);
  const effectiveTranspose = perf.transpose === 'auto' ? (perf.plan?.stats.transpose ?? 0) : perf.transpose;
  // 与设置里的「允许八度+半音组合」保持一致，避免练到游戏不接受的按法
  const practiceInstrument = useMemo(
    () => ({ ...DEFAULT_HARMONICA, allowModifierCombos: app.settings.input.allowModifierCombos }),
    [app.settings.input.allowModifierCombos],
  );

  const session = useMemo(
    () =>
      buildPracticeSession(score, {
        speed,
        startBar: safeStart,
        endBar: safeEnd,
        transpose: effectiveTranspose,
        instrument: practiceInstrument,
      }),
    [score, speed, safeStart, safeEnd, effectiveTranspose, practiceInstrument],
  );

  const run = usePracticeRun({
    session,
    mode: practice.mode,
    noteStyle: practice.noteStyle,
    loop: practice.loop,
    metronome: practice.metronome,
    hitSound: practice.hitSound,
    volume: preview.volume,
    instrument: preview.instrument,
    allowModifierCombos: app.settings.input.allowModifierCombos,
  });

  // 全屏练习：隐藏外壳与页面头，只留练习区；离开页面 / 退出时自动还原
  useLayoutEffect(() => {
    if (!focus) return undefined;
    document.body.classList.add('practice-focusing');
    return () => {
      document.body.classList.remove('practice-focusing');
    };
  }, [focus]);

  // F11 在练习页随时进出全屏；Esc 只在没有正在进行的练习时退出全屏（练习中 Esc 仍是结束）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      if (event.code === 'F11') {
        event.preventDefault();
        onChangeFocus(!focus);
        return;
      }
      if (event.code !== 'Escape' || !focus) return;
      if (run.phase === 'running' || run.phase === 'waiting' || run.phase === 'paused') return;
      event.preventDefault();
      onChangeFocus(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [focus, run.phase, onChangeFocus]);

  // 开始练习时停掉试听，避免两条音频同时响
  const practiceActiveRef = useRef(false);
  useEffect(() => {
    const active = run.phase === 'running' || run.phase === 'waiting';
    if (active && !practiceActiveRef.current) preview.stop();
    practiceActiveRef.current = active;
  }, [run.phase, preview.stop]);

  // 游戏演奏（F9 / 播放条）优先：开始注入时结束练习，避免两套按键同时响
  const gamePlaybackActive = app.playbackStatus.state === 'playing' || app.playbackStatus.state === 'countdown';
  const practiceActive = run.phase === 'running' || run.phase === 'waiting' || run.phase === 'paused';
  const playbackStopNotified = useRef(false);
  useEffect(() => {
    if (gamePlaybackActive && practiceActive) {
      run.stop();
      if (!playbackStopNotified.current) {
        playbackStopNotified.current = true;
        app.showToast('warning', '游戏演奏进行中，练习已停止');
      }
    }
    if (!gamePlaybackActive) playbackStopNotified.current = false;
  }, [gamePlaybackActive, practiceActive, run.stop, app.showToast]);

  const locked = run.phase !== 'idle' && run.phase !== 'finished';

  const startPractice = () => {
    if (gamePlaybackActive) {
      app.showToast('warning', '游戏演奏进行中：先停止演奏，再开始练习');
      return;
    }
    preview.stop();
    run.start();
  };

  const updatePractice = (patch: Partial<PracticeSettings>) => {
    void app.updateSettings({ practice: { ...app.settings.practice, ...patch } });
  };

  const changeStartBar = (value: number) => {
    const next = clamp(value, 1, barCount);
    setStartBar(next);
    if (safeEnd < next) setEndBar(next);
  };

  return (
    <div className={`practice-stage${focus ? ' is-focus' : ''}`}>
      {focus ? (
        <PracticeFocusBar
          title={session.title}
          noteStyle={practice.noteStyle}
          onChangeNoteStyle={(value) => updatePractice({ noteStyle: value })}
          onExit={() => onChangeFocus(false)}
        />
      ) : null}
      <PracticeBoard
        session={session}
        run={run}
        mode={practice.mode}
        noteStyle={practice.noteStyle}
        hitSound={practice.hitSound}
        locked={locked}
        onStart={startPractice}
        onPause={run.pause}
        onResume={run.resume}
        onStop={run.stop}
      />
      <aside className="practice-side">
        <PracticeSettingsCard
          session={session}
          barCount={barCount}
          startBar={safeStart}
          endBar={safeEnd}
          speed={speed}
          locked={locked}
          mode={practice.mode}
          practice={practice}
          effectiveTranspose={effectiveTranspose}
          transposeValue={perf.transpose}
          onChangeStartBar={changeStartBar}
          onChangeEndBar={(value) => setEndBar(clamp(value, safeStart, barCount))}
          onChangeSpeed={setSpeed}
          onChangeMode={(value) => updatePractice({ mode: value })}
          onChangePractice={updatePractice}
          onChangeTranspose={perf.setTranspose}
          onResetRange={() => {
            setStartBar(1);
            setEndBar(barCount);
          }}
        />
      </aside>
    </div>
  );
}

export function PracticePage(): JSX.Element {
  const app = useAppStore();
  const score = app.currentScore;
  const [focus, setFocus] = useState(false);

  // 换曲 / 曲谱被删除后回到普通版面，避免停留在一个没有内容的"全屏"里
  useEffect(() => {
    if (!score) setFocus(false);
  }, [score]);

  return (
    <div className={`page practice-page${focus ? ' is-focus' : ''}`}>
      <PageHeader
        title="练习"
        subtitle="跟谱击键：慢速、循环、等待模式，按音准与拍点逐音判定"
        actions={
          <>
            <select
              className="select compact practice-score-select"
              value={score?.id ?? ''}
              onChange={(event) => {
                const id = event.target.value;
                if (id) void app.openScore(id, 'practice');
              }}
              aria-label="选择练习曲谱"
              title={score ? `当前曲谱：${score.meta.title}` : '从音乐方案库选择曲谱'}
            >
              <option value="">选择曲谱…</option>
              {app.entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.favorite ? '★ ' : ''}
                  {entry.title}
                </option>
              ))}
              {score && !app.entries.some((entry) => entry.id === score.id) ? (
                <option value={score.id}>{score.meta.title}（未保存）</option>
              ) : null}
            </select>
            {score ? (
              <button
                type="button"
                className="btn btn--sm"
                title="全屏专注练习（F11）"
                onClick={() => setFocus(true)}
              >
                <Icon name="expand" size={14} /> 全屏练习
              </button>
            ) : null}
          </>
        }
      />

      {!score ? (
        <EmptyState
          icon={<Icon name="keyboard" size={22} />}
          title="还没有可练习的曲谱"
          description="从音乐方案库挑一首曲谱，或导入 MIDI / 音频生成新谱，再回到这里分段慢练。"
          actions={
            <>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => app.navigate('library')}>
                <Icon name="library" size={14} /> 去方案库选曲
              </button>
              <button type="button" className="btn btn--sm" onClick={() => app.navigate('import')}>
                <Icon name="import" size={14} /> 智能导入
              </button>
            </>
          }
        />
      ) : (
        <PracticeScoreView score={score} focus={focus} onChangeFocus={setFocus} />
      )}
    </div>
  );
}
