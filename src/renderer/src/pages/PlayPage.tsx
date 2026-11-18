import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateKeySheet } from '@core/export/keysheet';
import { planPerformance, type PlaybackPlan } from '@core/instrument/plan';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader, EmptyState, Chip } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { PreviewPlayer, type PreviewHandle } from '@renderer/audio/preview';
import { formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';

type TransposeValue = number | 'auto';

const TRANSPOSE_CHOICES: TransposeValue[] = [0, 'auto', 1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6];

const BACKEND_LABEL: Record<string, string> = {
  software: '游戏注入',
  'dry-run': '排练模式',
  serial: '串口硬件',
};

export function PlayPage(): JSX.Element {
  const app = useAppStore();
  const score = app.currentScore;
  const [transpose, setTranspose] = useState<TransposeValue>(0);
  const [tempoOverride, setTempoOverride] = useState<number | null>(null);
  const [confirmSafety, setConfirmSafety] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showKeySheet, setShowKeySheet] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const previewPlayerRef = useRef<PreviewPlayer | null>(null);
  const previewHandleRef = useRef<PreviewHandle | null>(null);
  const previewStartRef = useRef<number | null>(null);
  const playStartRef = useRef<number | null>(null);

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

  const injectionActive = app.playbackStatus.state === 'playing';
  const isRunning = injectionActive || previewing;

  const stopPreview = useCallback(() => {
    previewHandleRef.current?.stop();
    previewHandleRef.current = null;
    previewPlayerRef.current?.stop();
    previewStartRef.current = null;
    setPreviewing(false);
  }, []);

  useEffect(() => {
    return () => {
      previewHandleRef.current?.stop();
      previewPlayerRef.current?.stop();
    };
  }, []);

  // 切换曲谱时重置临时参数
  useEffect(() => {
    setTranspose(0);
    setTempoOverride(null);
    setConfirmSafety(false);
    stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score?.id]);

  // 自动选中疑似游戏窗口（只信任进程名/标题判定，绝不随便选一个窗口）
  useEffect(() => {
    if (!app.windows.length) return;
    if (app.settings.input.targetWindowHandle) return;
    const candidate = app.windows.find((item) => item.looksLikeGame);
    if (!candidate) return;
    void app.updateSettings({
      input: { ...app.settings.input, targetWindowHandle: candidate.handle, targetWindowTitle: candidate.title },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.windows, app.settings.input.targetWindowHandle]);

  // 播放时钟（注入 / 试听共用）
  useEffect(() => {
    if (app.playbackStatus.state === 'playing') {
      playStartRef.current = performance.now() - (app.playbackStatus.elapsedMs ?? 0);
    } else if (['finished', 'stopped', 'error', 'focus-lost', 'idle'].includes(app.playbackStatus.state)) {
      playStartRef.current = null;
    }
  }, [app.playbackStatus.state, app.playbackStatus.elapsedMs]);

  useEffect(() => {
    if (!isRunning) {
      setElapsedMs(0);
      return undefined;
    }
    let frame = 0;
    const tick = () => {
      const start = previewing ? previewStartRef.current : playStartRef.current;
      setElapsedMs(start !== null ? performance.now() - start : 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isRunning, previewing]);

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

  const keySheet = useMemo(() => {
    if (!score || !showKeySheet) return null;
    try {
      return generateKeySheet(score, { transpose });
    } catch {
      return null;
    }
  }, [score, showKeySheet, transpose]);

  const requiresMouseFire = useMemo(
    () => plan?.notes.some((note) => note.combo.mods.some((mod) => mod === 'left' || mod === 'right')) ?? false,
    [plan],
  );

  const stopInjection = useCallback(async () => {
    await window.api.playback.stop();
  }, []);

  const startPlayback = useCallback(async () => {
    if (!plan || plan.notes.length === 0) {
      app.showToast('warning', '当前乐谱没有可演奏的音符');
      return;
    }
    if (app.settings.input.backend === 'software' && !app.settings.input.targetWindowHandle) {
      app.showToast('warning', '请先选择「三角洲行动」游戏窗口，再开始演奏');
      return;
    }
    if (app.settings.input.backend === 'software' && app.appInfo && !app.appInfo.elevated) {
      app.showToast('warning', '未以管理员权限运行：游戏会静默丢弃注入的按键。请点击顶部状态栏的「以管理员重启」。');
      return;
    }
    if (requiresMouseFire && !confirmSafety) {
      app.showToast('warning', '本谱需要按下鼠标左/右键（游戏中为开火/开镜），请先勾选安全确认');
      return;
    }
    stopPreview();
    setStarting(true);
    try {
      const result = await window.api.playback.start({
        events: plan.events,
        durationMs: plan.durationMs,
        countdownSeconds: app.settings.input.countdownSeconds,
        focusGuard: app.settings.input.focusGuard,
        autoFocusTarget: app.settings.input.autoFocusTarget,
        targetWindowHandle: app.settings.input.targetWindowHandle,
        backend: app.settings.input.backend,
        title: score?.meta.title ?? '未命名',
      });
      if (!result.ok) app.showToast('warning', result.message ?? '未能开始演奏');
    } finally {
      setStarting(false);
    }
  }, [app, plan, requiresMouseFire, confirmSafety, score?.meta.title, stopPreview]);

  const startPreview = useCallback(async () => {
    if (!plan || plan.notes.length === 0) {
      app.showToast('warning', '当前乐谱没有可演奏的音符');
      return;
    }
    if (injectionActive || app.playbackStatus.state === 'countdown') await stopInjection();
    stopPreview();
    const player = previewPlayerRef.current ?? new PreviewPlayer();
    previewPlayerRef.current = player;
    try {
      const handle = await player.play(plan, {
        onEnd: () => {
          setPreviewing(false);
          previewStartRef.current = null;
        },
      });
      previewHandleRef.current = handle;
      previewStartRef.current = performance.now();
      setPreviewing(true);
    } catch (error) {
      app.showToast('error', `试听失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [app, plan, injectionActive, stopInjection, stopPreview]);

  const startRef = useRef(startPlayback);
  startRef.current = startPlayback;

  // F9 全局热键：开始/停止
  useEffect(() => {
    if (!app.lastGlobalCommand) return;
    if (app.lastGlobalCommand.command !== 'toggle-play') return;
    if (app.playbackStatus.state === 'playing' || app.playbackStatus.state === 'countdown') {
      void stopInjection();
    } else {
      void startRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lastGlobalCommand?.nonce]);

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

  const playback = app.playbackStatus;
  const showCountdown = playback.state === 'countdown';
  const planStats = plan?.stats;

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
    <div className="page">
      <PageHeader title="演奏台" subtitle="选曲 → 确认安全设置 → 开始演奏（F9 可随时开始/停止）" actions={headerActions} />

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
        <>
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
                </div>
              </div>
              <div className="score-hero-actions">
                <button type="button" className="button ghost" onClick={() => app.navigate('editor')}>
                  <Icon name="edit" size={15} /> 编辑谱面
                </button>
                <button type="button" className="button ghost" onClick={() => setShowKeySheet((value) => !value)}>
                  <Icon name="headphones" size={15} /> {showKeySheet ? '收起键位谱' : '查看键位谱'}
                </button>
                <button type="button" className="button ghost" onClick={() => void exportKeys()}>
                  <Icon name="download" size={15} /> 导出键位谱
                </button>
              </div>
            </div>
            <div className="score-paper">
              <ScoreView score={score} activeNoteId={activeNoteId} measuresPerRow={4} />
            </div>
          </section>

          {showCountdown ? (
            <div className="countdown-banner">
              <Icon name="clock" size={20} />
              <div>
                <strong>{playback.countdown ?? app.settings.input.countdownSeconds} 秒后开始演奏</strong>
                <span>请切回游戏并取出口琴；F12 可紧急停止</span>
              </div>
            </div>
          ) : null}

          <div className="play-layout">
            <section className="card control-panel">
              <h4 className="card-title">
                <Icon name="target" size={16} /> 演奏控制
              </h4>

              <label className="field">
                <span className="field-label">目标窗口</span>
                <div className="field-inline">
                  <select
                    className="select grow"
                    value={app.settings.input.targetWindowHandle ?? 0}
                    onChange={(event) => updateTargetWindow(Number(event.target.value))}
                  >
                    <option value={0}>不指定（仅试听 / 排练）</option>
                    {app.windows.map((item) => (
                      <option key={item.handle} value={item.handle}>
                        {item.looksLikeGame ? '🎮 ' : ''}
                        {item.title}
                        {item.isForeground ? '（当前前台）' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="icon-button bordered"
                    title="刷新窗口列表"
                    onClick={() => void app.refreshWindows()}
                  >
                    <Icon name="refresh" size={15} />
                  </button>
                </div>
                <span className="hint-text">
                  开始演奏会自动把鼠标移入游戏窗口（低/高八度与半音依赖鼠标按键）；演奏期间请勿把鼠标移出游戏窗口。
                </span>
              </label>

              <div className="field-row">
                <label className="field">
                  <span className="field-label">移调</span>
                  <select
                    className="select"
                    value={transpose === 'auto' ? 'auto' : String(transpose)}
                    onChange={(event) =>
                      setTranspose(event.target.value === 'auto' ? 'auto' : Number(event.target.value))
                    }
                  >
                    <option value="0">原调（不移调）</option>
                    <option value="auto">自动选调（最省修饰键）</option>
                    {TRANSPOSE_CHOICES.filter((value): value is number => typeof value === 'number' && value !== 0).map(
                      (value) => (
                        <option key={value} value={value}>
                          {value > 0 ? `+${value}` : `${value}`} 半音
                        </option>
                      ),
                    )}
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
                      value={tempoOverride ?? score.meta.tempo}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setTempoOverride(Number.isFinite(value) ? Math.min(320, Math.max(20, value)) : null);
                      }}
                    />
                    <button type="button" className="button ghost small" onClick={() => setTempoOverride(null)}>
                      重置
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span className="field-label">倒计时</span>
                  <select
                    className="select"
                    value={app.settings.input.countdownSeconds}
                    onChange={(event) =>
                      void app.updateSettings({
                        input: { ...app.settings.input, countdownSeconds: Number(event.target.value) },
                      })
                    }
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
                  <input
                    type="checkbox"
                    checked={app.settings.input.focusGuard}
                    onChange={(event) =>
                      void app.updateSettings({
                        input: { ...app.settings.input, focusGuard: event.target.checked },
                      })
                    }
                  />
                  <span>焦点保护（游戏失焦自动停手）</span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={app.settings.input.autoFocusTarget}
                    onChange={(event) =>
                      void app.updateSettings({
                        input: { ...app.settings.input, autoFocusTarget: event.target.checked },
                      })
                    }
                  />
                  <span>开始前自动切到游戏窗口</span>
                </label>
                <span className="backend-badge">
                  输入通道：{BACKEND_LABEL[app.settings.input.backend] ?? app.settings.input.backend}
                </span>
              </div>

              {requiresMouseFire ? (
                <label className={`safety-check ${confirmSafety ? 'checked' : ''}`}>
                  <input type="checkbox" checked={confirmSafety} onChange={(event) => setConfirmSafety(event.target.checked)} />
                  <span>
                    <strong>安全确认：</strong>本谱会按下鼠标左/右键（游戏中分别是开火 / 开镜）。我已在游戏中取出口琴并进入手动演奏界面。
                  </span>
                </label>
              ) : (
                <p className="hint-text">
                  <Icon name="check" size={14} /> 本谱只需要键盘与（可能的）鼠标中键，不会触发开火/开镜。
                </p>
              )}

              <div className="action-row">
                <button
                  type="button"
                  className="button primary large"
                  disabled={starting || injectionActive || !plan || (plan.notes.length === 0)}
                  onClick={() => void startPlayback()}
                >
                  <Icon name="play" size={17} /> {starting ? '准备中…' : '开始演奏'}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={!injectionActive && playback.state !== 'countdown'}
                  onClick={() => void stopInjection()}
                >
                  <Icon name="stop" size={15} /> 停止
                </button>
                <button type="button" className="button ghost" disabled={previewing || !plan} onClick={() => void startPreview()}>
                  <Icon name="headphones" size={15} /> 试听
                </button>
                <button type="button" className="button ghost" disabled={!previewing} onClick={stopPreview}>
                  停止试听
                </button>
              </div>

              {planState.error ? <p className="inline-error">{planState.error}</p> : null}
              {playback.state === 'focus-lost' || playback.state === 'error' ? (
                <p className="inline-error">{playback.message ?? '演奏中断'}</p>
              ) : null}
            </section>

            <section className="card plan-panel">
              <h4 className="card-title">
                <Icon name="sparkle" size={16} /> 演奏计划
              </h4>
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
                      <span className="stat-value">{plan.stats.minHoldMsUsed}-{plan.stats.maxHoldMsUsed}ms</span>
                      <span className="stat-label">按键保持</span>
                    </div>
                  </div>

                  {playback.state === 'playing' && playback.totalMs ? (
                    <div className="progress">
                      <div
                        className="progress-bar"
                        style={{ width: `${Math.min(100, ((playback.elapsedMs ?? 0) / playback.totalMs) * 100)}%` }}
                      />
                    </div>
                  ) : null}

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

                  {keySheet ? (
                    <div className="keysheet-box">
                      <pre className="keysheet">{keySheet.text}</pre>
                      <div className="keysheet-actions">
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
                        <span className="muted">键位记号：↑=右键高八度 ↓=左键低八度 #=中键升半音</span>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="muted">无法生成演奏计划</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
