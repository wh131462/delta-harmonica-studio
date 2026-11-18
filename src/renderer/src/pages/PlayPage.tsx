import { memo, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { generateKeySheet } from '@core/export/keysheet';
import {
  generateMacroExport,
  getNoteTriggerRows,
  getTriggerKeyMapRows,
  MACRO_SOFTWARE_ROWS,
  MACRO_SUPPORT_LABEL,
  type MacroExportResult,
  type MacroFormat,
  type MacroSoftwareSupport,
  type NoteTriggerRow,
  type TriggerKeyMapRow,
} from '@core/export/macro';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader, EmptyState, Chip, Notice } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { useAuditionTarget } from '@renderer/audio/preview-context';
import { usePerformance, type TransposeValue } from '@renderer/performance/performance-context';
import { formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';
import '@renderer/styles/page-play.css';
import '@renderer/styles/play-macro.css';

type PanelTab = 'settings' | 'plan' | 'keysheet' | 'macro';

const PANEL_TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'settings', label: '演奏设置' },
  { id: 'plan', label: '演奏计划' },
  { id: 'keysheet', label: '键位谱' },
  { id: 'macro', label: '宏导出' },
];

const TRANSPOSE_CHOICES: TransposeValue[] = [0, 'auto', 1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6];

const MACRO_PREVIEW_TABS: Array<{ id: MacroFormat; label: string; hint: string }> = [
  { id: 'ahk', label: 'AHK v1', hint: 'AutoHotkey v1 宏脚本' },
  { id: 'ahk2', label: 'AHK v2', hint: 'AutoHotkey v2 宏脚本' },
  { id: 'lua', label: 'Lua', hint: '罗技 G HUB Lua 脚本' },
  { id: 'csv', label: 'CSV', hint: 'CSV 时序表' },
  { id: 'trigger-table', label: '触发表', hint: '触发键位表' },
];

const MACRO_SUPPORT_TONE: Record<MacroSoftwareSupport, string> = {
  native: 'badge badge--ok',
  universal: 'badge',
  'record-only': 'badge badge--warn',
};

const COUNTDOWN_PRESETS = [0, 1, 3, 5];

type BadgeTone = '' | 'badge--ok' | 'badge--warn' | 'badge--danger' | 'badge--accent';

/**
 * 触发表与逐音表行数较多，而演奏中本页会随进度每帧重渲染；
 * 这里用 memo 把「行数据不变就不重渲染」的表格隔离出来。
 */
const KeyMapTable = memo(function KeyMapTable({ rows }: { rows: TriggerKeyMapRow[] }): JSX.Element {
  return (
    <div className="macro-table-wrap">
      <table className="macro-table" aria-label="全音域触发键位表">
        <thead>
          <tr>
            <th scope="col">音名</th>
            <th scope="col">MIDI</th>
            <th scope="col">简谱</th>
            <th scope="col">八度</th>
            <th scope="col">键位记号</th>
            <th scope="col">触发方式</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.midi}>
              <td>{row.midiName}</td>
              <td className="num">{row.midi}</td>
              <td>{row.degree === 8 ? '高音1' : row.degree}</td>
              <td className="num">{row.octaveShift > 0 ? '+1' : row.octaveShift < 0 ? '-1' : '0'}</td>
              <td>
                <code>{row.keys}</code>
              </td>
              <td>{[row.modsLabel, row.keyLabel].filter(Boolean).join('+')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

const NoteTriggerTable = memo(function NoteTriggerTable({ rows }: { rows: NoteTriggerRow[] }): JSX.Element {
  return (
    <div className="macro-table-wrap">
      <table className="macro-table" aria-label="本曲逐音触发表">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">开始（ms）</th>
            <th scope="col">保持（ms）</th>
            <th scope="col">音名</th>
            <th scope="col">键位</th>
            <th scope="col">触发方式</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.index}>
              <td className="num">{row.index}</td>
              <td className="num">{row.startMs}</td>
              <td className="num">{row.holdMs}</td>
              <td>{row.midiName}</td>
              <td>
                <code>{row.keys}</code>
              </td>
              <td>{row.trigger}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export function PlayPage(): JSX.Element {
  const app = useAppStore();
  const perf = usePerformance();
  const score = app.currentScore;
  const [tab, setTab] = useState<PanelTab>('settings');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [ahkTrigger, setAhkTrigger] = useState<'F9' | 'XButton1' | 'XButton2'>('F9');
  const [luaTriggerButton, setLuaTriggerButton] = useState<4 | 5>(5);
  const [macroPreviewKind, setMacroPreviewKind] = useState<MacroFormat>('ahk');
  const [noteLimit, setNoteLimit] = useState(200);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const plan = perf.plan;
  const playback = perf.playbackStatus;
  const active = playback.state === 'playing' || playback.state === 'countdown';
  const ready = Boolean(plan && plan.notes.length > 0);
  /** 游戏注入仅 Windows 可用；其余平台以排练模式演示时间轴 */
  const canInject = app.appInfo?.capabilities.gameInjection ?? true;

  // 试听统一由底部播放条负责：登记当前计划，播放条按它播放并同步显示曲名
  useAuditionTarget(plan, score?.meta.title || '当前曲谱');

  const toggleHotkey = app.settings.hotkeys.togglePlay;
  const panicHotkey = app.settings.hotkeys.panicStop;
  const countdownSeconds = app.settings.input.countdownSeconds;
  const noteCount = score ? score.notes.filter((note) => note.degree !== 0).length : 0;

  const keySheet = useMemo(() => {
    if (!score) return null;
    try {
      return generateKeySheet(score, { transpose: perf.transpose });
    } catch {
      return null;
    }
  }, [score, perf.transpose]);

  /** 宏导出与触发键位表：与当前演奏计划（含移调/速度）完全一致 */
  const macroExports = useMemo<Record<MacroFormat, MacroExportResult> | null>(() => {
    if (!plan || !score) return null;
    const options = {
      title: score.meta.title,
      ...(score.meta.artist ? { artist: score.meta.artist } : {}),
      ahkTrigger,
      logitechTriggerButton: luaTriggerButton,
    };
    try {
      return {
        ahk: generateMacroExport(plan, 'ahk', options),
        ahk2: generateMacroExport(plan, 'ahk2', options),
        lua: generateMacroExport(plan, 'lua', options),
        csv: generateMacroExport(plan, 'csv', options),
        'trigger-table': generateMacroExport(plan, 'trigger-table', options),
      };
    } catch {
      return null;
    }
  }, [plan, score, ahkTrigger, luaTriggerButton]);
  const keyMapRows = useMemo(() => getTriggerKeyMapRows(), []);
  const noteTriggerRows = useMemo(() => (plan ? getNoteTriggerRows(plan, noteLimit) : []), [plan, noteLimit]);
  const macroPreview = useMemo(() => {
    if (!macroExports) return '';
    const lines = macroExports[macroPreviewKind].text.split(/\r?\n/);
    if (lines.length <= 180) return macroExports[macroPreviewKind].text;
    return `${lines.slice(0, 180).join('\n')}\n…（预览已截断，导出可查看完整内容）`;
  }, [macroExports, macroPreviewKind]);

  const selectedNote = useMemo(
    () => (score && selectedNoteId ? score.notes.find((note) => note.id === selectedNoteId) ?? null : null),
    [score, selectedNoteId],
  );
  const selectedNoteIndex = score && selectedNote ? score.notes.indexOf(selectedNote) : -1;

  const elapsedMs = playback.state === 'playing' ? perf.elapsedMs : 0;
  const totalMs = playback.totalMs ?? plan?.durationMs ?? 0;
  const progressPercent = totalMs > 0 ? Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100)) : 0;

  // 状态徽标：与顶栏 / 播放条使用同一套状态叫法，短标签放置顶说明用
  const playbackBadge: { label: string; tone: BadgeTone } = (() => {
    switch (playback.state) {
      case 'countdown':
        return { label: '倒计时', tone: 'badge--accent' };
      case 'playing':
        return { label: '演奏中', tone: 'badge--ok' };
      case 'finished':
        return { label: '演奏完成', tone: 'badge--ok' };
      case 'stopped':
        return { label: '已停止', tone: '' };
      case 'focus-lost':
        return { label: '焦点丢失', tone: 'badge--danger' };
      case 'error':
        return { label: '出错', tone: 'badge--danger' };
      default:
        return ready ? { label: '可演奏', tone: 'badge--ok' } : { label: '无计划', tone: 'badge--warn' };
    }
  })();

  // 页面内开始入口降级为 .btn--primary：不可用时必须说明原因
  const startDisabledReason = !ready
    ? `无法开始：${perf.planError ?? '当前曲谱没有可演奏的音符'}`
    : perf.starting
      ? '正在准备演奏…'
      : playback.state === 'countdown'
        ? `倒计时 ${playback.countdown ?? countdownSeconds} 秒，按 ${panicHotkey} 可取消`
        : playback.state === 'playing'
          ? `正在演奏，停止请用底部播放条或 ${panicHotkey}`
          : perf.requiresMouseFire && !perf.confirmSafety
            ? '先勾选上方安全确认：本谱会按下鼠标左 / 右键（游戏中为开火 / 开镜）'
            : null;
  const startDisabled = !ready || perf.starting || active || (perf.requiresMouseFire && !perf.confirmSafety);
  const startLabel = perf.starting
    ? '准备中…'
    : playback.state === 'countdown'
      ? `${playback.countdown ?? 0} 秒后开始`
      : playback.state === 'playing'
        ? '演奏中…'
        : '开始演奏';
  const startTitle =
    startDisabledReason ??
    `开始演奏（与底部播放条、${toggleHotkey} 是同一动作；开始前有 ${countdownSeconds} 秒倒计时）`;

  const planErrorText = `无法生成演奏计划：${perf.planError ?? '曲谱没有可演奏的音符'}。请到简谱编辑器检查音域与时值。`;

  const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % PANEL_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + PANEL_TABS.length) % PANEL_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = PANEL_TABS.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    setTab(PANEL_TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  const exportMacro = async (format: MacroFormat) => {
    if (!macroExports || !score) return;
    const result = macroExports[format];
    const extension = result.extension.includes('.') ? result.extension.split('.').pop() ?? 'txt' : result.extension;
    try {
      const path = await window.api.files.save({
        suggestedName: `${sanitizeFileName(score.meta.title)}.${result.extension}`,
        filters: [{ name: result.filterName, extensions: [extension] }],
        data: result.text,
      });
      if (path) app.showToast('success', `${result.filterName}已导出：${path}`);
    } catch (error) {
      app.showToast('error', `导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const copyMacroText = async (format: MacroFormat) => {
    if (!macroExports) return;
    try {
      await navigator.clipboard.writeText(macroExports[format].text);
      app.showToast('success', '已复制到剪贴板');
    } catch {
      app.showToast('error', '复制失败，请手动选择文本复制');
    }
  };

  const updateTargetWindow = (handle: number) => {
    const info = app.windows.find((item) => item.handle === handle);
    void app.updateSettings({
      input: {
        ...app.settings.input,
        targetWindowHandle: handle || null,
        targetWindowTitle: info?.title ?? null,
      },
    });
  };

  const focusTargetWindow = () => {
    const handle = app.settings.input.targetWindowHandle;
    if (!handle) return;
    void window.api.windows.focus(handle).then((ok) =>
      app.showToast(ok ? 'success' : 'warning', ok ? '已把游戏窗口切到前台' : '切换失败，请手动切回游戏'),
    );
  };

  const exportKeys = async () => {
    if (!score) return;
    const path = await window.api.library.exportScore(score, 'keys');
    if (path) app.showToast('success', `键位谱已导出：${path}`);
  };

  const copyKeySheet = async () => {
    if (!keySheet) return;
    try {
      await navigator.clipboard.writeText(keySheet.text);
      app.showToast('success', '键位谱已复制到剪贴板');
    } catch {
      app.showToast('error', '复制失败，请手动选择文本复制');
    }
  };

  const macroDisabledTitle = macroExports
    ? '保存为文件'
    : '当前曲谱没有可演奏的音符：先在简谱编辑器准备一份可演奏的曲谱';

  const headerActions = (
    <>
      <select
        className="select compact play-score-select"
        value={score?.id ?? ''}
        onChange={(event) => {
          const id = event.target.value;
          if (id) void app.openScore(id, 'play');
        }}
        aria-label="选择曲谱"
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
      <button type="button" className="btn btn--sm" onClick={() => void app.refreshLibrary()} title="重新读取曲库列表">
        <Icon name="refresh" size={14} /> 刷新
      </button>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => app.navigate('import')}
        title="从 MIDI / 音频 / 简谱文本导入新曲谱"
      >
        <Icon name="import" size={14} /> 导入
      </button>
    </>
  );

  return (
    <div className="page play-page">
      <PageHeader
        title="演奏台"
        subtitle={`选曲 → 确认安全 → 开始演奏（${toggleHotkey} / ${panicHotkey} 随时可用）`}
        actions={headerActions}
      />

      {!score ? (
        <EmptyState
          icon={<Icon name="file-music" size={20} />}
          title="还没有可演奏的曲谱"
          description="从音乐方案库挑一首已保存的曲谱，或导入 MIDI / 音频 / 简谱文本，自动生成口琴谱。"
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
        <div className="play-stage">
          <section className="card play-score-card" aria-label="曲谱概览">
            <div className="card-title-row">
              <h2 className="card-title">曲谱概览</h2>
              <div className="inline-actions">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => app.navigate('editor')}
                  title="到简谱编辑器修改这首曲谱"
                >
                  <Icon name="edit" size={13} /> 编辑谱面
                </button>
              </div>
            </div>

            <div className="play-score-head">
              <div className="play-score-title">
                <h3 className="play-score-name" title={score.meta.title}>
                  {score.meta.title}
                </h3>
                <div className="play-score-badges" aria-live="polite">
                  <span className={`badge ${playbackBadge.tone}`.trim()}>{playbackBadge.label}</span>
                </div>
              </div>
              {score.meta.artist ? (
                <p className="play-score-artist" title={score.meta.artist}>
                  {score.meta.artist}
                </p>
              ) : null}
              <div className="chip-row">
                <Chip label="速度" value={`${plan?.tempo ?? score.meta.tempo} BPM`} />
                <Chip label="调号" value={`1=${keyLabel(score.meta.keyRoot)}`} />
                <Chip label="拍号" value={`${score.meta.meter.num}/${score.meta.meter.den}`} />
                <Chip label="音符" value={`${noteCount}`} />
                <Chip label="时长" value={plan ? formatDurationMs(plan.durationMs) : '—'} />
                <Chip label="来源" value={sourceKindLabel(score.source.kind)} />
                {plan && plan.stats.transpose !== 0 ? (
                  <Chip
                    label="移调"
                    value={`${plan.stats.transpose > 0 ? '+' : ''}${plan.stats.transpose}`}
                    tone="accent"
                  />
                ) : null}
              </div>
            </div>

            <div className="score-surface play-score" title="点击谱面中的音符可选中，再次点击取消">
              <ScoreView
                score={score}
                activeNoteId={perf.activeNoteId}
                selectedNoteId={selectedNote ? selectedNote.id : null}
                measuresPerRow={4}
                onSelectNote={(noteId) => setSelectedNoteId((previous) => (previous === noteId ? null : noteId))}
              />
            </div>

            {playback.state === 'countdown' ? (
              <div className="play-countdown">
                <Icon name="clock" size={15} />
                <span>
                  <strong className="num">{playback.countdown ?? countdownSeconds} 秒</strong> 后开始演奏
                </span>
                <span className="play-countdown__hint">
                  切回游戏窗口并取出口琴；按 <kbd>{panicHotkey}</kbd> 可随时取消
                </span>
              </div>
            ) : null}

            {playback.state === 'playing' ? (
              <div className="play-status">
                <div
                  className="progress"
                  role="progressbar"
                  aria-label="演奏进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progressPercent)}
                  aria-valuetext={`${formatDurationMs(elapsedMs)} / ${formatDurationMs(totalMs)}`}
                >
                  <div className="progress-bar" style={{ width: `${progressPercent}%` }} />
                </div>
                <span className="play-status__time">
                  {formatDurationMs(elapsedMs)} / {formatDurationMs(totalMs)}
                </span>
              </div>
            ) : null}

            {playback.state === 'focus-lost' || playback.state === 'error' ? (
              <p className="inline-error">
                <Icon name="warning" size={14} /> {playback.message ?? '演奏已中断，请检查目标窗口后重试'}
              </p>
            ) : null}

            {selectedNoteIndex >= 0 ? (
              <div className="play-note-pick">
                <span className="play-note-pick__text">
                  <Icon name="music" size={13} /> 已选中第 {selectedNoteIndex + 1} 个音符
                </span>
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setSelectedNoteId(null)}>
                  取消选中
                </button>
              </div>
            ) : null}
          </section>

          <section className="card play-panel" aria-label="演奏设置与演奏资料">
            <div className="tabs" role="tablist" aria-label="演奏台面板">
              {PANEL_TABS.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`play-tab-${item.id}`}
                  aria-controls={`play-tabpanel-${item.id}`}
                  aria-selected={tab === item.id}
                  tabIndex={tab === item.id ? 0 : -1}
                  className="tab"
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div
              className={tab === 'macro' ? 'play-panel__body macro-panel' : 'play-panel__body'}
              role="tabpanel"
              id={`play-tabpanel-${tab}`}
              aria-labelledby={`play-tab-${tab}`}
              tabIndex={0}
            >
              {tab === 'settings' ? (
                <>
                  <div className="field">
                    <span className="field-label" id="play-target-window-label">
                      目标窗口
                    </span>
                    <div className="field-inline">
                      <select
                        className="select grow"
                        aria-labelledby="play-target-window-label"
                        value={app.settings.input.targetWindowHandle ?? 0}
                        disabled={!canInject}
                        onChange={(event) => updateTargetWindow(Number(event.target.value))}
                        title="演奏时把鼠标移入这个窗口：八度与半音修饰键依赖鼠标位置"
                      >
                        <option value={0}>不指定（仅试听 / 排练）</option>
                        {app.windows.map((item) => (
                          <option key={item.handle} value={item.handle}>
                            {item.title}
                            {item.looksLikeGame ? '（游戏）' : ''}
                            {item.isForeground ? '（当前前台）' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--icon"
                        aria-label="刷新窗口列表"
                        title={canInject ? '刷新窗口列表' : '当前平台不支持游戏注入'}
                        disabled={!canInject}
                        onClick={() => void app.refreshWindows()}
                      >
                        <Icon name="refresh" size={15} />
                      </button>
                      {canInject && app.settings.input.targetWindowHandle ? (
                        <button
                          type="button"
                          className="btn btn--icon"
                          aria-label="把游戏窗口切到前台"
                          title="把游戏窗口切到前台"
                          onClick={focusTargetWindow}
                        >
                          <Icon name="window" size={15} />
                        </button>
                      ) : null}
                    </div>
                    <span className="field-hint">
                      {canInject
                        ? '开始演奏时自动把鼠标移入该窗口；切走会触发焦点保护。'
                        : '开始演奏只按时间轴排练，不向任何窗口发送按键。'}
                    </span>
                  </div>

                  <span className="section-label">演奏参数</span>
                  <div className="stack">
                    <label className="field">
                      <span className="field-label">移调</span>
                      <select
                        className="select"
                        value={perf.transpose === 'auto' ? 'auto' : String(perf.transpose)}
                        onChange={(event) =>
                          perf.setTranspose(
                            event.target.value === 'auto' ? 'auto' : (Number(event.target.value) as TransposeValue),
                          )
                        }
                        title="正数升调、负数降调；自动选调会挑最省修饰键的调"
                      >
                        <option value="0">原调（不移调）</option>
                        <option value="auto">自动选调（最省修饰键）</option>
                        {TRANSPOSE_CHOICES.filter(
                          (value): value is number => typeof value === 'number' && value !== 0,
                        ).map((value) => (
                          <option key={value} value={value}>
                            {value > 0 ? `+${value}` : value} 半音
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="play-field-grid">
                      <div className="field">
                        <span className="field-label" id="play-tempo-label">
                          速度覆盖（BPM）
                        </span>
                        <div className="field-inline">
                          <input
                            className="input number"
                            type="number"
                            min={20}
                            max={320}
                            aria-labelledby="play-tempo-label"
                            title="范围 20–320 BPM"
                            value={perf.tempoOverride ?? score.meta.tempo}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              perf.setTempoOverride(Number.isFinite(value) ? Math.min(320, Math.max(20, value)) : null);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn--quiet"
                            disabled={perf.tempoOverride === null}
                            onClick={() => perf.setTempoOverride(null)}
                            title="恢复曲谱原始速度"
                          >
                            重置
                          </button>
                        </div>
                      </div>

                      <label className="field">
                        <span className="field-label">倒计时</span>
                        <select
                          className="select"
                          value={countdownSeconds}
                          onChange={(event) =>
                            void app.updateSettings({
                              input: { ...app.settings.input, countdownSeconds: Number(event.target.value) },
                            })
                          }
                          title="开始演奏前留给你切回游戏的时间"
                        >
                          <option value={0}>不等待</option>
                          <option value={1}>1 秒</option>
                          <option value={3}>3 秒</option>
                          <option value={5}>5 秒</option>
                          {COUNTDOWN_PRESETS.includes(countdownSeconds) ? null : (
                            <option value={countdownSeconds}>{countdownSeconds} 秒</option>
                          )}
                        </select>
                      </label>
                    </div>
                  </div>

                  <div className="switch-row">
                    <label className="switch" title="目标窗口不在前台时立即停止并释放按键">
                      <input
                        type="checkbox"
                        checked={app.settings.input.focusGuard}
                        onChange={(event) =>
                          void app.updateSettings({
                            input: { ...app.settings.input, focusGuard: event.target.checked },
                          })
                        }
                      />
                      <span>焦点保护</span>
                    </label>
                    <label className="switch" title="开始演奏前把目标窗口切到前台">
                      <input
                        type="checkbox"
                        checked={app.settings.input.autoFocusTarget}
                        onChange={(event) =>
                          void app.updateSettings({
                            input: { ...app.settings.input, autoFocusTarget: event.target.checked },
                          })
                        }
                      />
                      <span>自动切前台</span>
                    </label>
                  </div>

                  {!ready ? (
                    <p className="inline-error">
                      <Icon name="warning" size={14} /> {planErrorText}
                    </p>
                  ) : (
                    <>
                      <span className="section-label">安全确认</span>
                      {perf.requiresMouseFire ? (
                        <div className="notice notice--warn">
                          <div className="notice__icon" aria-hidden="true">
                            <Icon name="warning" size={15} />
                          </div>
                          <div className="notice__body">
                            <strong className="notice__title">本谱会按下鼠标左 / 右键</strong>
                            <span className="notice__desc">
                              游戏中分别为开火 / 开镜。未勾选时不会发送任何按键。
                            </span>
                            <label className="checkbox-row play-safety">
                              <input
                                type="checkbox"
                                checked={perf.confirmSafety}
                                onChange={(event) => perf.setConfirmSafety(event.target.checked)}
                              />
                              <span>我已在游戏中取出口琴并进入手动演奏界面</span>
                            </label>
                          </div>
                        </div>
                      ) : (
                        <p className="success-text">
                          <Icon name="check" size={14} /> 本谱只需要键盘与（可能的）鼠标中键，不会触发开火 / 开镜
                        </p>
                      )}
                    </>
                  )}

                  <div className="play-start">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={startDisabled}
                      title={startTitle}
                      onClick={() => void perf.start()}
                    >
                      <Icon name="play" size={15} /> {startLabel}
                    </button>
                    <span className="hint-text play-start__hint">
                      与播放条 / <kbd>{toggleHotkey}</kbd> 同一动作
                    </span>
                  </div>
                </>
              ) : null}

              {tab === 'plan' ? (
                <>
                  {plan ? (
                    <>
                      <div className="stat-grid">
                        <div className="stat">
                          <span className="stat-value">{plan.stats.noteCount}</span>
                          <span className="stat-label">计划音符</span>
                        </div>
                        <div className="stat">
                          <span className="stat-value">{plan.stats.modifierSwitchCount}</span>
                          <span className="stat-label">修饰键切换</span>
                        </div>
                        <div className="stat">
                          <span className="stat-value">{plan.stats.foldedCount}</span>
                          <span className="stat-label">八度折返</span>
                        </div>
                        <div className="stat">
                          <span className="stat-value">
                            {plan.stats.transpose > 0 ? `+${plan.stats.transpose}` : plan.stats.transpose}
                          </span>
                          <span className="stat-label">移调半音</span>
                        </div>
                        <div className="stat">
                          <span className="stat-value">{formatDurationMs(plan.durationMs)}</span>
                          <span className="stat-label">总时长</span>
                        </div>
                        <div className="stat">
                          <span className="stat-value">
                            {plan.stats.minHoldMsUsed}-{plan.stats.maxHoldMsUsed} ms
                          </span>
                          <span className="stat-label">按键保持</span>
                        </div>
                      </div>
                      <p className="hint-text">
                        {app.settings.input.backend === 'software'
                          ? `游戏注入：将向目标窗口发送 ${plan.events.length} 个键鼠事件（先按修饰键，再按音符键）。`
                          : app.settings.input.backend === 'serial'
                            ? '串口硬件：按键通过串口设备发送，不经过系统键鼠。'
                            : '排练模式：只走时间轴，不发送任何按键。'}
                      </p>
                      {plan.warnings.length > 0 ? (
                        <ul className="play-warning-list">
                          {plan.warnings.map((warning, index) => (
                            <li key={`${warning}-${index}`} className="play-warning">
                              <Icon name="warning" size={14} />
                              <span>{warning}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="success-text">
                          <Icon name="check" size={14} /> 计划检查通过：未发现节奏或音域问题
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="inline-error">
                      <Icon name="warning" size={14} /> {planErrorText}
                    </p>
                  )}
                </>
              ) : null}

              {tab === 'keysheet' ? (
                <>
                  {keySheet ? (
                    <>
                      <div className="play-keysheet">
                        <pre className="play-keysheet__text">{keySheet.text}</pre>
                      </div>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => void copyKeySheet()}
                          title="复制整份键位谱文本"
                        >
                          <Icon name="copy" size={13} /> 复制键位谱
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => void exportKeys()}
                          title="把键位谱保存为文本文件"
                        >
                          <Icon name="download" size={13} /> 导出键位谱
                        </button>
                      </div>
                      <p className="hint-text">
                        记号：↑=右键高八度，↓=左键低八度，#=中键升半音；<code>Z X C V B N M ,</code> = 1 2 3 4 5 6 7
                        高音1。
                      </p>
                    </>
                  ) : (
                    <p className="muted">
                      暂无键位谱：曲谱可能没有可演奏的音符。到简谱编辑器检查音域与时值后再回到这里。
                    </p>
                  )}
                </>
              ) : null}

              {tab === 'macro' ? (
                <>
                  <div className="stack">
                    <label className="field">
                      <span className="field-label">AHK 触发键（v1 / v2）</span>
                      <select
                        className="select"
                        value={ahkTrigger}
                        onChange={(event) => setAhkTrigger(event.target.value as 'F9' | 'XButton1' | 'XButton2')}
                        title="AutoHotkey 脚本里启动演奏的按键"
                      >
                        <option value="F9">F9（键盘，默认）</option>
                        <option value="XButton1">鼠标侧键 XButton1（后退）</option>
                        <option value="XButton2">鼠标侧键 XButton2（前进）</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">罗技触发按钮</span>
                      <select
                        className="select"
                        value={luaTriggerButton}
                        onChange={(event) => setLuaTriggerButton(Number(event.target.value) as 4 | 5)}
                        title="罗技 G HUB Lua 脚本里 OnEvent 的按钮编号"
                      >
                        <option value={5}>前进侧键（OnEvent arg=5，默认）</option>
                        <option value={4}>后退侧键（OnEvent arg=4）</option>
                      </select>
                    </label>
                  </div>

                  <div className="macro-actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!macroExports}
                      title={macroDisabledTitle}
                      onClick={() => void exportMacro('ahk')}
                    >
                      <Icon name="download" size={13} /> AHK v1 脚本
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!macroExports}
                      title={macroDisabledTitle}
                      onClick={() => void exportMacro('ahk2')}
                    >
                      <Icon name="download" size={13} /> AHK v2 脚本
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!macroExports}
                      title={macroDisabledTitle}
                      onClick={() => void exportMacro('lua')}
                    >
                      <Icon name="download" size={13} /> 罗技 G HUB Lua
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!macroExports}
                      title={macroDisabledTitle}
                      onClick={() => void exportMacro('csv')}
                    >
                      <Icon name="download" size={13} /> CSV 时序表
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!macroExports}
                      title={macroDisabledTitle}
                      onClick={() => void exportMacro('trigger-table')}
                    >
                      <Icon name="download" size={13} /> 触发键位表
                    </button>
                  </div>
                  <p className="hint-text">触发键位表包含：全音域 38 键映射 + 本曲逐音触发表 + 组合统计。</p>

                  <details className="macro-compat">
                    <summary>其他鼠标品牌怎么用？宏软件兼容性</summary>
                    <ul className="macro-compat__list">
                      {MACRO_SOFTWARE_ROWS.map((row) => (
                        <li key={row.software} className="macro-compat__item">
                          <div className="macro-compat__head">
                            <span className="macro-compat__software">{row.software}</span>
                            <span className={MACRO_SUPPORT_TONE[row.support]}>{MACRO_SUPPORT_LABEL[row.support]}</span>
                          </div>
                          <p className="macro-compat__body">
                            {row.brand} · 推荐 <b>{row.format}</b>。{row.note}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>

                  <Notice
                    tone="warn"
                    title="不要在宏运行的同时用软件开始演奏"
                    icon={<Icon name="warning" size={15} />}
                  >
                    宏脚本与软件内演奏共用同一份时间轴（含当前移调与速度），同时触发会让按键重复。AHK / 罗技 G HUB
                    需以管理员身份运行，游戏建议使用无边框窗口；宏软件同属第三方模拟输入，账号风险与软件内注入一致。
                  </Notice>

                  <div className="segmented play-format-switch" role="group" aria-label="宏脚本预览格式">
                    {MACRO_PREVIEW_TABS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="segmented__item"
                        aria-pressed={macroPreviewKind === item.id}
                        title={item.hint}
                        aria-label={`${item.label} 预览：${item.hint}`}
                        onClick={() => setMacroPreviewKind(item.id)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <pre className="macro-preview">{macroPreview || '暂无数据'}</pre>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      disabled={!macroExports}
                      title="复制当前格式的完整文本"
                      onClick={() => void copyMacroText(macroPreviewKind)}
                    >
                      <Icon name="copy" size={13} /> 复制完整内容
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      disabled={!macroExports}
                      title="把当前格式保存为文件"
                      onClick={() => void exportMacro(macroPreviewKind)}
                    >
                      <Icon name="download" size={13} /> 导出当前格式
                    </button>
                  </div>

                  <h5 className="macro-section-title">
                    全音域触发键位表
                    <span className="macro-section-count num">{keyMapRows.length} 键</span>
                  </h5>
                  <KeyMapTable rows={keyMapRows} />

                  <h5 className="macro-section-title">
                    本曲逐音触发
                    <span className="macro-section-count num">
                      {noteTriggerRows.length}/{plan?.stats.noteCount ?? 0}
                    </span>
                  </h5>
                  <NoteTriggerTable rows={noteTriggerRows} />

                  <div className="inline-actions">
                    {plan && noteLimit < plan.stats.noteCount ? (
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm"
                        onClick={() => setNoteLimit((value) => Math.min(plan.stats.noteCount, value + 300))}
                      >
                        加载更多 300 行
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      disabled={!macroExports}
                      title="导出完整触发表（不受预览行数限制）"
                      onClick={() => void exportMacro('trigger-table')}
                    >
                      <Icon name="download" size={13} /> 导出完整触发表
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
