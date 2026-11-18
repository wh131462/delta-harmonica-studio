import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParseDiagnostic } from '@core/score/dsl';
import { buildScoreFromText, createNewScoreDraft, serializeScore } from '@core/score/dsl';
import { createNote, DEFAULT_META, scoreEndBeat, type Accidental, type Degree, type Score, type ScoreNote } from '@core/model/score';
import { planPerformance } from '@core/instrument/plan';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { usePreview } from '@renderer/audio/preview-context';
import { keyLabel } from '@renderer/utils/format';

const QUICK_DURATIONS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function EditorPage(): JSX.Element {
  const app = useAppStore();
  const [text, setText] = useState('');
  const [workingScore, setWorkingScore] = useState<Score | null>(null);
  const [diagnostics, setDiagnostics] = useState<ParseDiagnostic[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [measuresPerRow, setMeasuresPerRow] = useState(4);
  const [zoom, setZoom] = useState(1);
  const skipParseRef = useRef(false);
  const scoreRef = useRef<Score | null>(null);
  const preview = usePreview();
  const initializedRef = useRef<string | 'draft' | null>(null);
  scoreRef.current = workingScore;

  // 从当前曲谱初始化（或创建草稿）
  useEffect(() => {
    const id = app.currentScore?.id ?? 'draft';
    if (initializedRef.current === id) return;
    initializedRef.current = id;
    if (app.currentScore) {
      setWorkingScore(app.currentScore);
      setText(serializeScore(app.currentScore));
      setDiagnostics([]);
      setSelectedNoteId(null);
    } else {
      const draft = createNewScoreDraft('新乐谱');
      setWorkingScore(draft.score);
      setText(draft.text);
      setDiagnostics([]);
      setSelectedNoteId(null);
      app.setCurrentScore(draft.score, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.currentScore?.id]);

  const parseNow = useCallback(
    (source: string) => {
      const parsed = buildScoreFromText(source, { source: { kind: 'text' } });
      setDiagnostics(parsed.diagnostics);
      const hasFatal = parsed.diagnostics.some((item) => item.severity === 'error');
      if (hasFatal || parsed.score.notes.length === 0) return;
      const previous = scoreRef.current;
      const next: Score = {
        ...parsed.score,
        ...(previous ? { id: previous.id, createdAt: previous.createdAt } : {}),
      };
      setWorkingScore(next);
      setSelectedNoteId(null);
      app.setCurrentScore(next, true);
    },
    [app],
  );

  // 文本变化后自动解析（400ms 防抖）
  useEffect(() => {
    if (!text.trim()) return undefined;
    if (skipParseRef.current) {
      skipParseRef.current = false;
      return undefined;
    }
    const timer = setTimeout(() => parseNow(text), 420);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const applyModel = useCallback(
    (next: Score) => {
      skipParseRef.current = true;
      setWorkingScore(next);
      setText(serializeScore(next));
      app.setCurrentScore(next, true);
    },
    [app],
  );

  const updateMeta = (patch: Partial<Score['meta']>) => {
    if (!workingScore) return;
    applyModel({ ...workingScore, meta: { ...workingScore.meta, ...patch } });
  };

  const selectedNote = useMemo(
    () => workingScore?.notes.find((note) => note.id === selectedNoteId) ?? null,
    [workingScore, selectedNoteId],
  );

  const updateSelectedNote = (patch: Partial<ScoreNote>) => {
    if (!workingScore || !selectedNote) return;
    applyModel({
      ...workingScore,
      notes: workingScore.notes.map((note) => (note.id === selectedNote.id ? { ...note, ...patch } : note)),
    });
  };

  const deleteSelectedNote = () => {
    if (!workingScore || !selectedNote) return;
    applyModel({ ...workingScore, notes: workingScore.notes.filter((note) => note.id !== selectedNote.id) });
    setSelectedNoteId(null);
  };

  const appendNote = () => {
    if (!workingScore) return;
    const end = scoreEndBeat(workingScore);
    const note = createNote({ degree: 1, startBeat: end, duration: 1 });
    applyModel({ ...workingScore, notes: [...workingScore.notes, note] });
    setSelectedNoteId(note.id);
  };

  const plan = useMemo(() => {
    if (!workingScore) return null;
    try {
      return planPerformance(workingScore, { timing: app.settings.input.timing });
    } catch {
      return null;
    }
  }, [workingScore, app.settings.input.timing]);

  const activeNoteId = useMemo(() => {
    if (!plan || !workingScore || !preview.playing) return null;
    const elapsed = preview.elapsedMs;
    let currentIndex = -1;
    for (let index = 0; index < plan.notes.length; index += 1) {
      if (plan.notes[index].startMs <= elapsed) currentIndex = index;
      else break;
    }
    if (currentIndex < 0) return null;
    const plannedNote = plan.notes[currentIndex];
    if (elapsed > plannedNote.endMs + 200) return null;
    return (
      workingScore.notes.find(
        (note) => note.degree !== 0 && Math.abs(note.startBeat - plannedNote.startBeat) < 0.01,
      )?.id ?? null
    );
  }, [plan, workingScore, preview.playing, preview.elapsedMs]);

  const togglePreview = () => {
    if (preview.playing) {
      preview.stop();
      return;
    }
    if (!plan || plan.notes.length === 0) {
      app.showToast('warning', '当前谱面没有可演奏的音符');
      return;
    }
    void preview.play(plan);
  };

  const save = async () => {
    if (!workingScore) return;
    // 确保 store 里是最新版本
    app.setCurrentScore(workingScore, true);
    await app.saveCurrentScore();
  };

  const newScore = () => {
    const draft = createNewScoreDraft('新乐谱');
    skipParseRef.current = true;
    setWorkingScore(draft.score);
    setText(draft.text);
    setDiagnostics([]);
    setSelectedNoteId(null);
    app.setCurrentScore(draft.score, false);
  };

  const importFromFile = async () => {
    try {
      const files = await window.api.library.importScoreFile();
      if (files.length === 0) return;
      const file = files[0];
      const decoded = new TextDecoder('utf-8').decode(file.data);
      if (file.name.endsWith('.json') || file.name.endsWith('.dfh')) {
        const parsed = JSON.parse(decoded) as Score;
        if (!parsed.meta || !Array.isArray(parsed.notes)) throw new Error('不是有效的曲谱 JSON');
        skipParseRef.current = true;
        setWorkingScore(parsed);
        setText(serializeScore(parsed));
        setDiagnostics([]);
        app.setCurrentScore(parsed, true);
        app.showToast('success', `已载入 ${file.name}`);
      } else {
        skipParseRef.current = true;
        setText(decoded);
        parseNow(decoded);
        app.showToast('success', `已导入文本谱：${file.name}`);
      }
    } catch (error) {
      app.showToast('error', `导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportText = async () => {
    if (!workingScore) return;
    const path = await window.api.library.exportScore(workingScore, 'dsl');
    if (path) app.showToast('success', `简谱已导出：${path}`);
  };

  const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
  const warningCount = diagnostics.length - errorCount;

  return (
    <div className="page">
      <PageHeader
        title="简谱编辑器"
        subtitle="直接输入/粘贴数字简谱，或点击谱面音符可视化修改；自动校验拍号与时值"
        actions={
          <>
            <button type="button" className="button ghost" onClick={newScore}>
              <Icon name="plus" size={15} /> 新建
            </button>
            <button type="button" className="button ghost" onClick={() => app.navigate('library')}>
              <Icon name="library" size={15} /> 方案库
            </button>
            <button type="button" className="button ghost" onClick={() => void importFromFile()}>
              <Icon name="import" size={15} /> 导入文件
            </button>
            <button type="button" className="button ghost" onClick={() => void exportText()}>
              <Icon name="download" size={15} /> 导出简谱
            </button>
            <button type="button" className="button primary" onClick={() => void save()}>
              <Icon name="check" size={15} /> 保存方案
            </button>
          </>
        }
      />

      {workingScore ? (
        <>
          <section className="card editor-meta">
            <div className="meta-grid">
              <label className="field grow-2">
                <span className="field-label">标题</span>
                <input
                  className="input"
                  value={workingScore.meta.title}
                  onChange={(event) => updateMeta({ title: event.target.value })}
                  placeholder="曲谱标题"
                />
              </label>
              <label className="field">
                <span className="field-label">速度（BPM）</span>
                <input
                  className="input number"
                  type="number"
                  min={20}
                  max={320}
                  value={workingScore.meta.tempo}
                  onChange={(event) => updateMeta({ tempo: Math.min(320, Math.max(20, Number(event.target.value) || 100)) })}
                />
              </label>
              <label className="field">
                <span className="field-label">调号（1=?）</span>
                <select
                  className="select"
                  value={workingScore.meta.keyRoot}
                  onChange={(event) => updateMeta({ keyRoot: Number(event.target.value) })}
                >
                  {Array.from({ length: 12 }, (_, index) => (
                    <option key={index} value={index}>
                      1={keyLabel(index)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">拍号</span>
                <div className="field-inline">
                  <select
                    className="select"
                    value={workingScore.meta.meter.num}
                    onChange={(event) =>
                      updateMeta({ meter: { ...workingScore.meta.meter, num: Number(event.target.value) } })
                    }
                  >
                    {[2, 3, 4, 6, 8, 12].map((num) => (
                      <option key={num} value={num}>
                        {num}
                      </option>
                    ))}
                  </select>
                  <span className="muted">/</span>
                  <select
                    className="select"
                    value={workingScore.meta.meter.den}
                    onChange={(event) =>
                      updateMeta({
                        meter: { ...workingScore.meta.meter, den: Number(event.target.value) as 2 | 4 | 8 | 16 },
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
              </label>
              <label className="field">
                <span className="field-label">基础八度</span>
                <input
                  className="input number"
                  type="number"
                  min={0}
                  max={8}
                  value={workingScore.meta.baseOctave}
                  onChange={(event) => updateMeta({ baseOctave: Math.min(8, Math.max(0, Number(event.target.value) || 4)) })}
                />
              </label>
            </div>
            <p className="hint-text">
              简谱语法：<code>1-7</code> 音级、<code>0</code> 休止、<code>#4</code>/<code>b7</code> 升降、
              <code>1'</code> 高八度、<code>,1</code> 低八度、<code>5_</code> 半拍、<code>5.</code> 附点、
              <code>5-</code> 延长一拍、<code>5~ 5</code> 连音、<code>|</code> 小节线、<code># 标题：xxx</code> 头部信息。
            </p>
          </section>

          <div className="editor-layout">
            <section className="card editor-text-card">
              <div className="card-title-row">
                <h4 className="card-title">
                  <Icon name="edit" size={16} /> 简谱文本
                </h4>
                <div className="inline-actions">
                  <button type="button" className="button ghost small" onClick={() => parseNow(text)}>
                    立即解析
                  </button>
                  <button type="button" className="button ghost small" onClick={appendNote}>
                    <Icon name="plus" size={13} /> 追加音符
                  </button>
                </div>
              </div>
              <textarea
                className="score-textarea"
                spellCheck={false}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={`# 标题：我的曲子\n# 速度：100\n# 拍号：4/4\n# 调号：1=C\n\n1 1 5 5 | 6 6 5- | 4 4 3 3 | 2 2 1- |`}
              />
              <div className="diagnostics">
                {diagnostics.length === 0 ? (
                  <p className="diag-ok">
                    <Icon name="check" size={14} /> 解析通过，拍号和时值校验正常
                  </p>
                ) : (
                  <>
                    {errorCount > 0 ? <p className="diag-error-title">发现 {errorCount} 个错误（修复后才会更新谱面）</p> : null}
                    {diagnostics.map((item, index) => (
                      <p key={`${item.message}-${index}`} className={`diag diag-${item.severity}`}>
                        <Icon name="warning" size={13} /> {item.line ? `第 ${item.line} 行：` : ''}
                        {item.message}
                      </p>
                    ))}
                  </>
                )}
              </div>
            </section>

            <section className="card editor-preview-card">
              <div className="card-title-row">
                <h4 className="card-title">
                  <Icon name="music" size={16} /> 谱面预览
                </h4>
                <div className="inline-actions">
                  <select
                    className="select compact-select"
                    value={measuresPerRow}
                    title="每行小节数"
                    onChange={(event) => setMeasuresPerRow(Number(event.target.value))}
                  >
                    <option value={2}>每行 2 小节</option>
                    <option value={3}>每行 3 小节</option>
                    <option value={4}>每行 4 小节</option>
                  </select>
                  <button type="button" className="button ghost small" title="缩小" onClick={() => setZoom((value) => Math.max(0.7, Math.round((value - 0.1) * 10) / 10))}>
                    −
                  </button>
                  <button type="button" className="button ghost small" title="放大" onClick={() => setZoom((value) => Math.min(1.6, Math.round((value + 0.1) * 10) / 10))}>
                    +
                  </button>
                  <button type="button" className={`button small ${preview.playing ? 'danger' : 'ghost'}`} onClick={togglePreview}>
                    <Icon name={preview.playing ? 'stop' : 'headphones'} size={13} /> {preview.playing ? '停止试听' : `试听（${preview.instrument === 'piano' ? '钢琴' : '口琴'}）`}
                  </button>
                </div>
              </div>
              <div className="score-paper compact">
                <ScoreView
                  score={workingScore}
                  selectedNoteId={selectedNoteId}
                  activeNoteId={activeNoteId}
                  measuresPerRow={measuresPerRow}
                  zoom={zoom}
                  onSelectNote={(noteId) => setSelectedNoteId(noteId)}
                />
              </div>
              <div className="inspector">
                {selectedNote ? (
                  <>
                    <p className="section-label">音符属性（第 {workingScore.notes.findIndex((note) => note.id === selectedNote.id) + 1} 个）</p>
                    <div className="inspector-grid">
                      <label className="field">
                        <span className="field-label">音级</span>
                        <select
                          className="select"
                          value={selectedNote.degree}
                          onChange={(event) => updateSelectedNote({ degree: Number(event.target.value) as Degree })}
                        >
                          <option value={0}>0 休止</option>
                          {[1, 2, 3, 4, 5, 6, 7].map((degree) => (
                            <option key={degree} value={degree}>
                              {degree}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">升降</span>
                        <select
                          className="select"
                          value={selectedNote.accidental}
                          onChange={(event) => updateSelectedNote({ accidental: Number(event.target.value) as Accidental })}
                        >
                          <option value={0}>本位</option>
                          <option value={1}># 升</option>
                          <option value={-1}>b 降</option>
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">八度</span>
                        <input
                          className="input number"
                          type="number"
                          min={-3}
                          max={3}
                          value={selectedNote.octave}
                          onChange={(event) => updateSelectedNote({ octave: Number(event.target.value) || 0 })}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">时值（拍）</span>
                        <input
                          className="input number"
                          type="number"
                          min={0.05}
                          max={64}
                          step={0.25}
                          value={selectedNote.duration}
                          onChange={(event) => updateSelectedNote({ duration: Math.max(0.05, Number(event.target.value) || 1) })}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">起始拍</span>
                        <input
                          className="input number"
                          type="number"
                          min={0}
                          step={0.25}
                          value={selectedNote.startBeat}
                          onChange={(event) => updateSelectedNote({ startBeat: Math.max(0, Number(event.target.value) || 0) })}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">连音</span>
                        <label className="switch compact">
                          <input
                            type="checkbox"
                            checked={selectedNote.tie}
                            onChange={(event) => updateSelectedNote({ tie: event.target.checked })}
                          />
                          <span>连到下一个同音</span>
                        </label>
                      </label>
                    </div>
                    <div className="quick-durations">
                      <span className="muted">快捷时值：</span>
                      {QUICK_DURATIONS.map((duration) => (
                        <button
                          key={duration}
                          type="button"
                          className={`quick-chip ${selectedNote.duration === duration ? 'active' : ''}`}
                          onClick={() => updateSelectedNote({ duration })}
                        >
                          {duration} 拍
                        </button>
                      ))}
                      <button type="button" className="button danger small" onClick={deleteSelectedNote}>
                        <Icon name="trash" size={13} /> 删除音符
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="muted">
                    <Icon name="target" size={14} /> 点击上方谱面中的音符可编辑属性；也可以直接在左侧文本里修改。
                  </p>
                )}
              </div>
              <p className="hint-text">
                当前共 {workingScore.notes.filter((note) => note.degree !== 0).length} 个音、
                {plan?.notes.length ?? 0} 个可执行音 · 计划时长 {plan ? Math.round(plan.durationMs / 1000) : 0}s
                {warningCount > 0 ? ` · ${warningCount} 条提示` : ''}
                {app.dirty ? ' · 有未保存修改' : ''}
              </p>
            </section>
          </div>
        </>
      ) : (
        <p className="muted">正在准备编辑器…</p>
      )}
    </div>
  );
}

// 避免未使用告警（DEFAULT_META 供后续扩展使用）
void DEFAULT_META;
