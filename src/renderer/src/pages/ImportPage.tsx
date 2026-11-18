import { useMemo, useState, type DragEvent } from 'react';
import { melodyToScore } from '@core/import/melody-to-score';
import { importMidiFile, type MidiImportResult, type MidiTrackSummary } from '@core/import/midi';
import { buildScoreFromText } from '@core/score/dsl';
import { planPerformance } from '@core/instrument/plan';
import { scoreEndBeat, type Score } from '@core/model/score';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader, EmptyState, Chip } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { usePreview } from '@renderer/audio/preview-context';
import { decodeAudioFile } from '@renderer/audio/decode';
import { analyzeMelody, type MelodyAnalysisResult } from '@renderer/audio/melody-adapter';
import { formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';
import type { PickedFile } from '@shared/types';

type ImportTab = 'midi' | 'audio' | 'text' | 'keys';

interface PreviewState {
  score: Score;
  warnings: string[];
  sourceLabel: string;
  extra?: string;
  analysis?: MelodyAnalysisResult;
}

const QUANTIZE_OPTIONS = [
  { value: 0.125, label: '1/32 音符（精细）' },
  { value: 0.25, label: '1/16 音符（推荐）' },
  { value: 0.5, label: '1/8 音符（简化）' },
];

const PITCH_CHOICES = [
  { midi: 36, label: 'C2' },
  { midi: 43, label: 'G2' },
  { midi: 48, label: 'C3' },
  { midi: 55, label: 'G3' },
  { midi: 60, label: 'C4' },
  { midi: 67, label: 'G4' },
  { midi: 72, label: 'C5' },
  { midi: 79, label: 'G5' },
  { midi: 84, label: 'C6' },
  { midi: 96, label: 'C7' },
];

function pitchLabel(midi: number): string {
  const choice = PITCH_CHOICES.find((item) => item.midi === midi);
  return choice ? `${choice.label}` : `MIDI ${midi}`;
}

function asPickedFile(file: File, data: Uint8Array): PickedFile {
  return { name: file.name, path: file.name, size: file.size, data };
}

export function ImportPage(): JSX.Element {
  const app = useAppStore();
  const preview = usePreview();
  const audioSettings = app.settings.audio;
  const [tab, setTab] = useState<ImportTab>('audio');
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewPlan, setPreviewPlan] = useState<ReturnType<typeof planPerformance> | null>(null);

  // MIDI
  const [midiFile, setMidiFile] = useState<PickedFile | null>(null);
  const [midiTracks, setMidiTracks] = useState<MidiTrackSummary[]>([]);
  const [trackIndex, setTrackIndex] = useState<number | null>(null);
  const [midiResult, setMidiResult] = useState<MidiImportResult | null>(null);

  // 音频
  const [audioFile, setAudioFile] = useState<PickedFile | null>(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [analysis, setAnalysis] = useState<MelodyAnalysisResult | null>(null);
  const [bpmOverride, setBpmOverride] = useState<number | null>(null);

  // 文本
  const [textInput, setTextInput] = useState(
    '# 标题：我的曲子\n# 速度：100\n# 拍号：4/4\n# 调号：1=C\n\n1 1 5 5 | 6 6 5- | 4 4 3 3 | 2 2 1- |',
  );
  const [textDiagnostics, setTextDiagnostics] = useState<Array<{ severity: string; message: string }>>([]);

  const [title, setTitle] = useState('');
  const [keyRoot, setKeyRoot] = useState<number | 'auto'>('auto');

  const patchAudio = (patch: Partial<typeof audioSettings>) => {
    void app.updateSettings({ audio: { ...audioSettings, ...patch } });
  };

  const resetPreview = () => {
    preview.stop();
    setPreviewState(null);
    setPreviewPlan(null);
    setError(null);
  };

  const switchTab = (next: ImportTab) => {
    setTab(next);
    resetPreview();
  };

  const buildPlan = (score: Score) => {
    try {
      return planPerformance(score);
    } catch {
      return null;
    }
  };

  const showScore = (score: Score, warnings: string[], sourceLabel: string, extra?: string, analysisResult?: MelodyAnalysisResult) => {
    setPreviewState({ score, warnings, sourceLabel, ...(extra ? { extra } : {}), ...(analysisResult ? { analysis: analysisResult } : {}) });
    setPreviewPlan(buildPlan(score));
    setTitle(score.meta.title);
  };

  const audition = async (instrument: 'harmonica' | 'piano') => {
    if (!preview.playing && previewPlan) {
      preview.setInstrument(instrument);
      await preview.play(previewPlan);
    } else {
      preview.stop();
    }
  };

  const pickMidi = async () => {
    const files = await window.api.files.pick([{ name: 'MIDI 文件', extensions: ['mid', 'midi'] }]);
    if (files.length > 0) await analyzeMidiFile(files[0]);
  };

  const analyzeMidiFile = async (file: PickedFile) => {
    setBusy(true);
    setError(null);
    try {
      const result = importMidiFile(file.data, {
        fileName: file.name,
        title: file.name.replace(/\.(mid|midi)$/i, ''),
        quantizeGrid: audioSettings.quantizeGrid,
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
      });
      setMidiFile(file);
      setMidiResult(result);
      setMidiTracks(result.tracks);
      setTrackIndex(result.selectedTrack);
      setTab('midi');
      showScore(
        result.score,
        result.warnings,
        `MIDI · ${file.name}`,
        `第 ${result.selectedTrack + 1} 轨 · 检测调性：${keyLabel(result.key.keyRoot)} 大调 · 置信度 ${(result.key.confidence * 100).toFixed(0)}%`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const analyzeMidiTrack = async (nextTrack: number | null) => {
    if (!midiFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = importMidiFile(midiFile.data, {
        fileName: midiFile.name,
        title: title.trim() || midiFile.name.replace(/\.(mid|midi)$/i, ''),
        quantizeGrid: audioSettings.quantizeGrid,
        ...(nextTrack !== null ? { trackIndex: nextTrack } : {}),
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
      });
      setMidiResult(result);
      setTrackIndex(result.selectedTrack);
      showScore(result.score, result.warnings, `MIDI · ${midiFile.name}`, `第 ${result.selectedTrack + 1} 轨 · ${result.tracks[result.selectedTrack]?.noteCount ?? 0} 个音`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const analyzeAudioFile = async (file: PickedFile) => {
    setBusy(true);
    setError(null);
    try {
      const decoded = await decodeAudioFile(file.data);
      if (decoded.pcm.length === 0) throw new Error('音频为空或无法解码');
      const result = analyzeMelody(decoded.pcm, decoded.sampleRate, audioSettings);
      setAudioFile(file);
      setAudioDuration(decoded.durationSec);
      setAnalysis(result);
      setTab('audio');
      regenerateAudioScore(file, result, bpmOverride ?? result.bpm);
      const tempoHint = result.bpmConfidence < 0.25 ? 'BPM 置信度较低，建议手动指定速度' : `检测 BPM ${result.bpm.toFixed(1)}`;
      app.showToast('info', `音频已分析：${result.notes.length} 个旋律音 · ${tempoHint}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerateAudioScore = (file = audioFile, result = analysis, tempo = bpmOverride ?? analysis?.bpm ?? 100) => {
    if (!result || !file) return;
    try {
      const mapped = melodyToScore(result.notes, {
        title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
        tempo,
        quantizeGrid: audioSettings.quantizeGrid,
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
        sourceKind: 'audio',
        source: { kind: 'audio', fileName: file.name },
      });
      const methodLabel = result.method === 'polyphonic' ? '复音主旋律模式' : '单声部模式';
      showScore(
        mapped.score,
        [...result.warnings, ...mapped.warnings],
        `音频 · ${file.name}`,
        `${methodLabel} · ${result.notes.length} 个旋律音 · ${tempo.toFixed(0)} BPM`,
        result,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const analyzeText = () => {
    const parsed = buildScoreFromText(textInput);
    setTextDiagnostics(parsed.diagnostics);
    const fatal = parsed.diagnostics.filter((item) => item.severity === 'error');
    if (fatal.length > 0) {
      setError(`文本中有 ${fatal.length} 处错误，请先修复`);
      setPreviewState(null);
      return;
    }
    setError(null);
    showScore(
      parsed.score,
      parsed.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message),
      '简谱文本',
    );
  };

  const savePreview = async () => {
    if (!previewState) return;
    try {
      await window.api.library.save(previewState.score);
      await app.refreshLibrary();
      app.showToast('success', `已保存《${previewState.score.meta.title}》到音乐方案库`);
      preview.stop();
      setPreviewState(null);
      setPreviewPlan(null);
      app.navigate('library');
    } catch (err) {
      app.showToast('error', `保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const previewDuration = useMemo(() => {
    if (!previewState) return '';
    const beats = scoreEndBeat(previewState.score);
    return formatDurationMs((beats * 60000) / Math.max(20, previewState.score.meta.tempo));
  }, [previewState]);

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const picked = asPickedFile(file, data);
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.mid') || lower.endsWith('.midi')) await analyzeMidiFile(picked);
    else if (/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/.test(lower)) await analyzeAudioFile(picked);
    else if (lower.endsWith('.json') || lower.endsWith('.dfh')) {
      const parsed = JSON.parse(new TextDecoder().decode(picked.data)) as Score;
      if (!parsed.meta || !Array.isArray(parsed.notes)) throw new Error('不是有效的曲谱 JSON');
      showScore(parsed, [], `方案 JSON · ${file.name}`);
    } else {
      setTextInput(new TextDecoder().decode(picked.data));
      setTab('text');
    }
  };

  const tabButtons: Array<{ id: ImportTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
    { id: 'audio', label: '音频扒谱（主旋律）', icon: 'headphones' },
    { id: 'midi', label: 'MIDI 导入', icon: 'music' },
    { id: 'text', label: '简谱文本', icon: 'edit' },
    { id: 'keys', label: '键位谱', icon: 'target' },
  ];

  return (
    <div className="page import-page">
      <PageHeader title="智能导入" subtitle="以主旋律为核心：音频扒谱支持音域约束与伴奏抑制；MIDI 自动选轨单音化；生成后可直接双音色试听" />

      <div className="import-tabs">
        {tabButtons.map((item) => (
          <button key={item.id} type="button" className={`import-tab ${tab === item.id ? 'active' : ''}`} onClick={() => switchTab(item.id)}>
            <Icon name={item.icon} size={16} /> {item.label}
          </button>
        ))}
      </div>

      <div className="import-layout">
        <section
          className={`card import-source ${dragActive ? 'drag-active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => void handleDrop(event)}
        >
          <div className="drop-hint">
            <Icon name="import" size={16} /> 拖入文件快速导入（MIDI / MP3 / WAV / 简谱 TXT / 方案 JSON）
          </div>

          {tab === 'audio' ? (
            <>
              <h4 className="card-title">
                <Icon name="headphones" size={16} /> 音频 → 主旋律
              </h4>
              <div className="caveat">
                <Icon name="warning" size={18} />
                <div>
                  <strong>扒谱建议</strong>
                  <p>清唱/哼唱/单乐器效果最好；带伴奏歌曲请开启「伴奏抑制」并使用「自动/复音主旋律」模式。成品歌仍建议用 MIDI 或粘贴简谱。</p>
                </div>
              </div>
              <button type="button" className="button primary" disabled={busy} onClick={async () => {
                const files = await window.api.files.pick([{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }]);
                if (files.length > 0) await analyzeAudioFile(files[0]);
              }}>
                <Icon name="folder" size={15} /> {busy ? '分析中…' : audioFile ? '重新选择音频' : '选择音频文件'}
              </button>
              {audioFile ? (
                <div className="file-info">
                  <Icon name="headphones" size={16} />
                  <div>
                    <strong>{audioFile.name}</strong>
                    <span>
                      {(audioFile.size / 1024 / 1024).toFixed(2)} MB · 时长 {formatDurationMs(audioDuration * 1000)}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="field-row">
                <label className="field">
                  <span className="field-label">分析模式</span>
                  <select
                    className="select"
                    value={audioSettings.melodyMode}
                    onChange={(event) => patchAudio({ melodyMode: event.target.value as typeof audioSettings.melodyMode })}
                  >
                    <option value="auto">自动判断（推荐）</option>
                    <option value="monophonic">单声部（清唱/独奏）</option>
                    <option value="polyphonic">复音主旋律（带伴奏）</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">主旋律音域</span>
                  <div className="field-inline">
                    <select className="select" value={audioSettings.pitchMin} onChange={(event) => patchAudio({ pitchMin: Number(event.target.value) })}>
                      {PITCH_CHOICES.map((choice) => (
                        <option key={choice.midi} value={choice.midi}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                    <span className="muted">~</span>
                    <select className="select" value={audioSettings.pitchMax} onChange={(event) => patchAudio({ pitchMax: Number(event.target.value) })}>
                      {PITCH_CHOICES.map((choice) => (
                        <option key={choice.midi} value={choice.midi}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span className="field-label">最短音符</span>
                  <input
                    className="input number"
                    type="number"
                    min={30}
                    max={500}
                    step={10}
                    value={audioSettings.minNoteMs}
                    onChange={(event) => patchAudio({ minNoteMs: Math.max(30, Math.min(500, Number(event.target.value) || 70)) })}
                  />
                </label>
                <label className="switch">
                  <input type="checkbox" checked={audioSettings.suppressAccompaniment} onChange={(event) => patchAudio({ suppressAccompaniment: event.target.checked })} />
                  <span>伴奏抑制（HPSS）</span>
                </label>
                <label className="field">
                  <span className="field-label">BPM 覆盖</span>
                  <input
                    className="input number"
                    type="number"
                    min={40}
                    max={240}
                    value={bpmOverride ?? Math.round(analysis?.bpm ?? 100)}
                    onChange={(event) => setBpmOverride(Number(event.target.value) || null)}
                  />
                </label>
              </div>
              {analysis ? (
                <div className="analysis-summary">
                  <span>
                    模式：{analysis.method === 'polyphonic' ? '复音主旋律' : '单声部'} · 旋律音 {analysis.notes.length}
                  </span>
                  <span>
                    BPM {analysis.bpm.toFixed(1)}（置信度 {(analysis.bpmConfidence * 100).toFixed(0)}%）
                  </span>
                  <span>有声帧占比 {(analysis.voicedRatio * 100).toFixed(0)}%</span>
                  <button type="button" className="button ghost small" onClick={() => regenerateAudioScore()}>
                    <Icon name="refresh" size={14} /> 用当前参数重新生成
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {tab === 'midi' ? (
            <>
              <h4 className="card-title">
                <Icon name="music" size={16} /> MIDI 导入
              </h4>
              <p className="hint-text">支持 .mid / .midi，自动挑主旋律轨并做单音化处理；可手动切换轨道。</p>
              <button type="button" className="button primary" disabled={busy} onClick={() => void pickMidi()}>
                <Icon name="folder" size={15} /> {busy ? '分析中…' : midiFile ? '重新选择 MIDI' : '选择 MIDI 文件'}
              </button>
              {midiFile ? (
                <div className="file-info">
                  <Icon name="music" size={16} />
                  <div>
                    <strong>{midiFile.name}</strong>
                    <span>{(midiFile.size / 1024).toFixed(1)} KB · 共 {midiTracks.length} 轨</span>
                  </div>
                </div>
              ) : null}
              {midiTracks.length > 0 ? (
                <div className="track-list">
                  <p className="section-label">选择音轨</p>
                  {midiTracks.map((track) => (
                    <label key={track.index} className={`track-item ${trackIndex === track.index ? 'active' : ''}`}>
                      <input type="radio" name="midi-track" checked={trackIndex === track.index} onChange={() => void analyzeMidiTrack(track.index)} />
                      <div>
                        <strong>
                          轨道 {track.index + 1}：{track.name || '未命名'}
                          {track.isDrum ? '（鼓轨）' : ''}
                        </strong>
                        <span>
                          {track.noteCount} 个音 · 音域 {track.pitchMin}-{track.pitchMax} · 单音比例 {(track.monophonicRatio * 100).toFixed(0)}%
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="field-row">
                <label className="field">
                  <span className="field-label">量化精度</span>
                  <select className="select" value={audioSettings.quantizeGrid} onChange={(event) => patchAudio({ quantizeGrid: Number(event.target.value) })}>
                    {QUANTIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">调号</span>
                  <select className="select" value={keyRoot === 'auto' ? 'auto' : String(keyRoot)} onChange={(event) => setKeyRoot(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}>
                    <option value="auto">自动检测</option>
                    {Array.from({ length: 12 }, (_, index) => (
                      <option key={index} value={index}>
                        1={keyLabel(index)}
                      </option>
                    ))}
                  </select>
                </label>
                {midiFile ? (
                  <button type="button" className="button ghost" disabled={busy} onClick={() => void analyzeMidiTrack(trackIndex)}>
                    <Icon name="refresh" size={15} /> 重新分析
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {tab === 'text' ? (
            <>
              <h4 className="card-title">
                <Icon name="edit" size={16} /> 粘贴简谱文本
              </h4>
              <textarea className="score-textarea small" value={textInput} spellCheck={false} onChange={(event) => setTextInput(event.target.value)} />
              <div className="field-row">
                <label className="field">
                  <span className="field-label">量化精度</span>
                  <select className="select" value={audioSettings.quantizeGrid} onChange={(event) => patchAudio({ quantizeGrid: Number(event.target.value) })}>
                    {QUANTIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="button primary" onClick={analyzeText}>
                  <Icon name="sparkle" size={15} /> 解析为可演奏谱
                </button>
              </div>
              {textDiagnostics.length > 0 ? (
                <div className="diagnostics">
                  {textDiagnostics.map((item, index) => (
                    <p key={index} className={`diag diag-${item.severity}`}>
                      <Icon name="warning" size={13} /> {item.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {tab === 'keys' ? (
            <EmptyState
              icon={<Icon name="target" size={30} />}
              title="键位谱导入（规划中）"
              description="后续支持粘贴 ZXCVBNM 键位串（含 ↑↓# 修饰键）自动还原为简谱。当前可先用简谱文本或 MIDI 导入。"
            />
          ) : null}

          {error ? (
            <p className="inline-error">
              <Icon name="warning" size={15} /> {error}
            </p>
          ) : null}
        </section>

        <section className="card import-preview">
          <div className="card-title-row">
            <h4 className="card-title">
              <Icon name="sparkle" size={16} /> 转谱结果
            </h4>
            {previewState ? (
              <div className="inline-actions">
                <button type="button" className={`button small ${preview.playing ? 'danger' : 'ghost'}`} onClick={() => void audition(preview.instrument)}>
                  <Icon name={preview.playing ? 'stop' : 'headphones'} size={14} /> {preview.playing ? '停止' : '试听'}
                </button>
                <button type="button" className="button primary small" onClick={() => void savePreview()}>
                  <Icon name="check" size={14} /> 保存到方案库
                </button>
              </div>
            ) : null}
          </div>

          {!previewState ? (
            <EmptyState
              icon={<Icon name="music" size={30} />}
              title="还没有分析结果"
              description="拖入音频/MIDI，或粘贴简谱后，这里会显示主旋律谱面、可演奏性提示与试听。"
            />
          ) : (
            <>
              <div className="preview-head">
                <label className="field grow">
                  <span className="field-label">标题</span>
                  <input
                    className="input"
                    value={previewState.score.meta.title}
                    onChange={(event) => {
                      const next = { ...previewState, score: { ...previewState.score, meta: { ...previewState.score.meta, title: event.target.value } } };
                      setPreviewState(next);
                    }}
                  />
                </label>
                <div className="chip-row">
                  <Chip label="来源" value={sourceKindLabel(previewState.score.source.kind)} />
                  <Chip label="速度" value={`${previewState.score.meta.tempo.toFixed(0)} BPM`} />
                  <Chip label="调号" value={`1=${keyLabel(previewState.score.meta.keyRoot)}`} />
                  <Chip label="音符" value={`${previewState.score.notes.filter((note) => note.degree !== 0).length}`} />
                  <Chip label="时长" value={previewDuration} />
                </div>
              </div>
              {previewState.extra ? <p className="hint-text">{previewState.extra}</p> : null}
              <div className="preview-audition">
                <span className="hint-text">试听音色：</span>
                <button type="button" className="button ghost small" disabled={!previewPlan || preview.playing} onClick={() => void audition('harmonica')}>
                  <Icon name="music" size={14} /> 口琴音效
                </button>
                <button type="button" className="button ghost small" disabled={!previewPlan || preview.playing} onClick={() => void audition('piano')}>
                  <Icon name="music" size={14} /> 钢琴音
                </button>
                <span className="hint-text">（可在底部播放条切换默认音色/音量）</span>
              </div>
              <div className="score-paper compact">
                <ScoreView score={previewState.score} measuresPerRow={4} />
              </div>
              {previewState.warnings.length > 0 ? (
                <div className="warning-list">
                  {previewState.warnings.map((warning, index) => (
                    <p key={index}>
                      <Icon name="warning" size={14} /> {warning}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="hint-text success-text">
                  <Icon name="check" size={14} /> 未发现明显问题
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
