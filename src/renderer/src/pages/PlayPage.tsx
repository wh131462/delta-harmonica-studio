import { useMemo, useState } from 'react';
import { generateKeySheet } from '@core/export/keysheet';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader, EmptyState, Chip } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { usePreview } from '@renderer/audio/preview-context';
import { usePerformance, type TransposeValue } from '@renderer/performance/performance-context';
import { formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';

type PanelTab = 'settings' | 'plan' | 'keysheet';

const TRANSPOSE_CHOICES: TransposeValue[] = [0, 'auto', 1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6];

export function PlayPage(): JSX.Element {
  const app = useAppStore();
  const perf = usePerformance();
  const preview = usePreview();
  const score = app.currentScore;
  const [tab, setTab] = useState<PanelTab>('settings');
  const plan = perf.plan;
  const playback = perf.playbackStatus;
  const active = playback.state === 'playing' || playback.state === 'countdown';

  const keySheet = useMemo(() => {
    if (!score) return null;
    try {
      return generateKeySheet(score, { transpose: perf.transpose });
    } catch {
      return null;
    }
  }, [score, perf.transpose]);

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

  const exportKeys = async () => {
    if (!score) return;
    const path = await window.api.library.exportScore(score, 'keys');
    if (path) app.showToast('success', `键位谱已导出：${path}`);
  };

  const headerActions = (
    <>
      <select
        className="select"
        value={score?.id ?? ''}
        onChange={(event) => {
          const id = event.target.value;
          if (id) void app.openScore(id, 'play');
        }}
        aria-label="选择曲谱"
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
      <button type="button" className="button ghost" onClick={() => void app.refreshLibrary()}>
        <Icon name="refresh" size={15} /> 刷新
      </button>
      <button type="button" className="button ghost" onClick={() => app.navigate('import')}>
        <Icon name="import" size={15} /> 导入
      </button>
    </>
  );

  return (
    <div className="page play-page">
      <PageHeader title="演奏台" subtitle="选曲 → 确认安全设置 → 开始演奏（底部播放条 / F9 随时开始或停止）" actions={headerActions} />

      {!score ? (
        <EmptyState
          icon={<Icon name="music" size={34} />}
          title="还没有选择曲谱"
          description="从音乐方案库选择一首，或者导入 MIDI / 音频 / 简谱文本自动生成口琴谱。"
          actions={
            <>
              <button type="button" className="button primary" onClick={() => app.navigate('library')}>
                <Icon name="library" size={15} /> 打开方案库
              </button>
              <button type="button" className="button ghost" onClick={() => app.navigate('import')}>
                <Icon name="import" size={15} /> 智能导入
              </button>
            </>
          }
        />
      ) : (
        <div className="play-layout">
          <section className="card score-hero">
            <div className="score-hero-head">
              <div className="score-title-block">
                <h3>{score.meta.title}</h3>
                {score.meta.artist ? <p className="artist">{score.meta.artist}</p> : null}
                <div className="chip-row">
                  <Chip label="速度" value={`${plan?.tempo ?? score.meta.tempo} BPM`} />
                  <Chip label="调号" value={`1=${keyLabel(score.meta.keyRoot)}`} />
                  <Chip label="拍号" value={`${score.meta.meter.num}/${score.meta.meter.den}`} />
                  <Chip label="音符" value={`${score.notes.filter((note) => note.degree !== 0).length}`} />
                  <Chip label="时长" value={plan ? formatDurationMs(plan.durationMs) : '—'} />
                  <Chip label="来源" value={sourceKindLabel(score.source.kind)} />
                  {plan && plan.stats.transpose !== 0 ? (
                    <Chip label="移调" value={`${plan.stats.transpose > 0 ? '+' : ''}${plan.stats.transpose}`} tone="accent" />
                  ) : null}
                </div>
              </div>
              <div className="score-hero-actions">
                <button
                  type="button"
                  className="button ghost small"
                  disabled={!plan || plan.notes.length === 0}
                  onClick={() => (preview.playing ? preview.stop() : plan ? void preview.play(plan) : undefined)}
                >
                  <Icon name={preview.playing ? 'stop' : 'headphones'} size={15} /> {preview.playing ? '停止试听' : `试听（${preview.instrument === 'piano' ? '钢琴' : '口琴'}）`}
                </button>
                <button type="button" className="button ghost small" onClick={() => app.navigate('editor')}>
                  <Icon name="edit" size={15} /> 编辑谱面
                </button>
                <button type="button" className="button ghost small" onClick={() => void exportKeys()}>
                  <Icon name="download" size={15} /> 导出键位谱
                </button>
              </div>
            </div>
            <div className="score-paper">
              <ScoreView score={score} activeNoteId={perf.activeNoteId} measuresPerRow={4} />
            </div>
            {playback.state === 'countdown' ? (
              <div className="countdown-banner">
                <Icon name="clock" size={20} />
                <div>
                  <strong>{playback.countdown ?? app.settings.input.countdownSeconds} 秒后开始演奏</strong>
                  <span>请切回游戏并取出口琴；F12 / 急停可随时中止</span>
                </div>
              </div>
            ) : null}
            {playback.state === 'playing' ? (
              <div className="play-progress">
                <div className="play-progress-fill" style={{ width: `${plan && playback.totalMs ? Math.min(100, ((playback.elapsedMs ?? 0) / playback.totalMs) * 100) : 0}%` }} />
                <span className="play-progress-text">
                  演奏中 {formatDurationMs(playback.elapsedMs ?? 0)} / {formatDurationMs(playback.totalMs ?? plan?.durationMs ?? 0)}
                </span>
              </div>
            ) : null}
            {playback.state === 'focus-lost' || playback.state === 'error' ? (
              <p className="inline-error">
                <Icon name="warning" size={15} /> {playback.message ?? '演奏中断'}
              </p>
            ) : null}
          </section>

          <section className="card right-panel">
            <div className="panel-tabs">
              <button type="button" className={`panel-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
                <Icon name="target" size={15} /> 演奏设置
              </button>
              <button type="button" className={`panel-tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>
                <Icon name="sparkle" size={15} /> 演奏计划
              </button>
              <button type="button" className={`panel-tab ${tab === 'keysheet' ? 'active' : ''}`} onClick={() => setTab('keysheet')}>
                <Icon name="headphones" size={15} /> 键位谱
              </button>
            </div>

            {tab === 'settings' ? (
              <div className="panel-body">
                <label className="field">
                  <span className="field-label">目标窗口</span>
                  <div className="field-inline">
                    <select className="select grow" value={app.settings.input.targetWindowHandle ?? 0} onChange={(event) => updateTargetWindow(Number(event.target.value))}>
                      <option value={0}>不指定（仅试听 / 排练）</option>
                      {app.windows.map((item) => (
                        <option key={item.handle} value={item.handle}>
                          {item.looksLikeGame ? '🎮 ' : ''}
                          {item.title}
                          {item.isForeground ? '（当前前台）' : ''}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="icon-button bordered" title="刷新窗口列表" onClick={() => void app.refreshWindows()}>
                      <Icon name="refresh" size={15} />
                    </button>
                    {app.settings.input.targetWindowHandle ? (
                      <button
                        type="button"
                        className="icon-button bordered"
                        title="把游戏窗口切到前台"
                        onClick={() =>
                          void window.api.windows.focus(app.settings.input.targetWindowHandle ?? 0).then((ok) =>
                            app.showToast(ok ? 'success' : 'warning', ok ? '已把游戏窗口切到前台' : '切换失败，请手动切回游戏'),
                          )
                        }
                      >
                        <Icon name="window" size={15} />
                      </button>
                    ) : null}
                  </div>
                  <span className="hint-text">演奏开始时会自动把鼠标移入游戏窗口（八度/半音修饰键依赖鼠标位置）。</span>
                </label>

                <div className="field-row">
                  <label className="field">
                    <span className="field-label">移调</span>
                    <select className="select" value={perf.transpose === 'auto' ? 'auto' : String(perf.transpose)} onChange={(event) => perf.setTranspose(event.target.value === 'auto' ? 'auto' : (Number(event.target.value) as TransposeValue))}>
                      <option value="0">原调（不移调）</option>
                      <option value="auto">自动选调（最省修饰键）</option>
                      {TRANSPOSE_CHOICES.filter((value): value is number => typeof value === 'number' && value !== 0).map((value) => (
                        <option key={value} value={value}>
                          {value > 0 ? `+${value}` : value} 半音
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">速度覆盖</span>
                    <div className="field-inline">
                      <input
                        className="input number"
                        type="number"
                        min={20}
                        max={320}
                        value={perf.tempoOverride ?? score.meta.tempo}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          perf.setTempoOverride(Number.isFinite(value) ? Math.min(320, Math.max(20, value)) : null);
                        }}
                      />
                      <button type="button" className="button ghost small" onClick={() => perf.setTempoOverride(null)}>
                        重置
                      </button>
                    </div>
                  </label>
                  <label className="field">
                    <span className="field-label">倒计时</span>
                    <select
                      className="select"
                      value={app.settings.input.countdownSeconds}
                      onChange={(event) => void app.updateSettings({ input: { ...app.settings.input, countdownSeconds: Number(event.target.value) } })}
                    >
                      <option value={0}>不等待</option>
                      <option value={1}>1 秒</option>
                      <option value={3}>3 秒</option>
                      <option value={5}>5 秒</option>
                    </select>
                  </label>
                </div>

                <div className="switch-row">
                  <label className="switch">
                    <input type="checkbox" checked={app.settings.input.focusGuard} onChange={(event) => void app.updateSettings({ input: { ...app.settings.input, focusGuard: event.target.checked } })} />
                    <span>焦点保护</span>
                  </label>
                  <label className="switch">
                    <input type="checkbox" checked={app.settings.input.autoFocusTarget} onChange={(event) => void app.updateSettings({ input: { ...app.settings.input, autoFocusTarget: event.target.checked } })} />
                    <span>自动切前台</span>
                  </label>
                  <span className={`backend-pill ${app.settings.input.backend}`}>
                    {app.settings.input.backend === 'software' ? '游戏注入' : app.settings.input.backend === 'dry-run' ? '排练模式' : '串口硬件'}
                  </span>
                </div>

                {perf.requiresMouseFire ? (
                  <label className={`safety-check ${perf.confirmSafety ? 'checked' : ''}`}>
                    <input type="checkbox" checked={perf.confirmSafety} onChange={(event) => perf.setConfirmSafety(event.target.checked)} />
                    <span>
                      <strong>安全确认：</strong>本谱会按下鼠标左/右键（游戏中分别为开火 / 开镜）。我已在游戏中取出口琴并进入手动演奏界面。
                    </span>
                  </label>
                ) : (
                  <p className="hint-text success-text">
                    <Icon name="check" size={14} /> 本谱只需要键盘与（可能的）鼠标中键，不会触发开火/开镜。
                  </p>
                )}

                <div className="action-row">
                  <button type="button" className="button primary large" disabled={perf.starting || active || !plan} onClick={() => void perf.start()}>
                    <Icon name="play" size={17} /> {active ? '演奏中…' : perf.starting ? '准备中…' : '开始演奏'}
                  </button>
                  <button type="button" className="button danger" disabled={!active} onClick={() => void perf.stop()}>
                    <Icon name="stop" size={15} /> 停止
                  </button>
                </div>
                {perf.planError ? <p className="inline-error">{perf.planError}</p> : null}
              </div>
            ) : null}

            {tab === 'plan' ? (
              <div className="panel-body">
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
                        <span className="stat-value">{plan.stats.transpose > 0 ? `+${plan.stats.transpose}` : plan.stats.transpose}</span>
                        <span className="stat-label">移调半音</span>
                      </div>
                      <div className="stat">
                        <span className="stat-value">{formatDurationMs(plan.durationMs)}</span>
                        <span className="stat-label">总时长</span>
                      </div>
                      <div className="stat">
                        <span className="stat-value">
                          {plan.stats.minHoldMsUsed}-{plan.stats.maxHoldMsUsed}ms
                        </span>
                        <span className="stat-label">按键保持</span>
                      </div>
                    </div>
                    <p className={`mode-hint ${app.settings.input.backend}`}>
                      {app.settings.input.backend === 'software'
                        ? `将向游戏注入 ${plan.events.length} 个键鼠事件（先按修饰键，再按音符键）。`
                        : '排练模式：只走时间轴，不发送任何按键。'}
                    </p>
                    {plan.warnings.length > 0 ? (
                      <div className="warning-list">
                        {plan.warnings.map((warning, index) => (
                          <p key={`${warning}-${index}`}>
                            <Icon name="warning" size={14} /> {warning}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="hint-text success-text">
                        <Icon name="check" size={14} /> 计划检查通过：无需折返，节奏可行
                      </p>
                    )}
                  </>
                ) : (
                  <p className="muted">无法生成演奏计划</p>
                )}
              </div>
            ) : null}

            {tab === 'keysheet' ? (
              <div className="panel-body">
                {keySheet ? (
                  <>
                    <div className="keysheet-box">
                      <pre className="keysheet">{keySheet.text}</pre>
                    </div>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => {
                          void navigator.clipboard.writeText(keySheet.text).then(
                            () => app.showToast('success', '键位谱已复制到剪贴板'),
                            () => app.showToast('error', '复制失败，请手动选择文本复制'),
                          );
                        }}
                      >
                        复制键位谱
                      </button>
                      <button type="button" className="button ghost small" onClick={() => void exportKeys()}>
                        导出键位谱
                      </button>
                    </div>
                    <p className="hint-text">记号：↑=右键高八度，↓=左键低八度，#=中键升半音；`Z X C V B N M ,` = 1 2 3 4 5 6 7 高音1。</p>
                  </>
                ) : (
                  <p className="muted">暂无键位谱</p>
                )}
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
