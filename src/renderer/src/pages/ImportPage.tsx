import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { melodyToScore } from '@core/import/melody-to-score';
import { importMidiFile, summarizeMidiTracks, type MidiTrackSummary } from '@core/import/midi';
import { buildScoreFromText } from '@core/score/dsl';
import { planPerformance } from '@core/instrument/plan';
import { midiToName } from '@core/model/pitch';
import type { Score } from '@core/model/score';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { Chip, EmptyState, Notice, PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { useAuditionTarget, usePreview } from '@renderer/audio/preview-context';
import { decodeAudioFile } from '@renderer/audio/decode';
import { analyzeMelody, type MelodyAnalysisResult } from '@renderer/audio/melody-adapter';
import { formatDurationMs, formatScoreDuration, keyLabel, sourceKindLabel } from '@renderer/utils/format';
import type { PickedFile } from '@shared/types';
import '@renderer/styles/page-import.css';

/** 来源只有两种：MIDI 与音频；简谱文本作为次要入口放在来源卡片底部 */
type ImportTab = 'midi' | 'audio';

interface RunStage {
  label: string;
  percent: number;
}

interface PreviewState {
  score: Score;
  warnings: string[];
  /** 结果详情（调性/置信度等不适合放进 Chip 的补充信息） */
  facts?: string;
  /** MIDI 结果对应的音轨 */
  trackLabel?: string;
  /** 音频分析模式 */
  modeLabel?: string;
}

type FailureStep = '读取文件' | '解析 MIDI' | '解析方案' | '解码音频' | '分析音频' | '生成谱面' | '解析简谱';

interface ImportFailure {
  step: FailureStep;
  detail: string;
}

const FAILURE_TITLE: Record<FailureStep, string> = {
  读取文件: '读取文件失败',
  '解析 MIDI': '解析 MIDI 失败',
  解析方案: '解析方案文件失败',
  解码音频: '解码音频失败',
  分析音频: '分析音频失败',
  生成谱面: '生成谱面失败',
  解析简谱: '解析简谱失败',
};

const FAILURE_ADVICE: Record<FailureStep, string> = {
  读取文件: '文件可能被占用或已损坏，换一个文件后重试。',
  '解析 MIDI': '确认文件是标准 .mid/.midi；也可以换一条音轨，或改用音频导入。',
  解析方案: '确认是本应用导出的 JSON / DFH 方案文件，或改用 MIDI、简谱文本导入。',
  解码音频: '换 MP3 / WAV / M4A / FLAC / OGG 文件；格式特殊时先转成 WAV。',
  分析音频: '把「最短音符」调大、收窄音域，或改用单声部模式后重新分析。',
  生成谱面: '把「谱面密度」调成宽松，或手动指定调号后重新分析。',
  解析简谱: '按逐行提示修正后重新解析；也可以先导入 MIDI 或音频。',
};

const SOURCE_TABS: Array<{ id: ImportTab; label: string }> = [
  { id: 'midi', label: 'MIDI 文件' },
  { id: 'audio', label: '音频文件' },
];

const MIDI_EXTENSIONS = ['mid', 'midi'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'];
const AUDIO_PATTERN = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/;

const QUANTIZE_OPTIONS = [
  { value: 0.125, label: '1/32 音符（精细）' },
  { value: 0.25, label: '1/16 音符（推荐）' },
  { value: 0.5, label: '1/8 音符（简化）' },
];

const MELODY_DENSITY_OPTIONS = [
  { value: 'loose', label: '宽松：每拍最多 1 个音' },
  { value: 'normal', label: '标准：每拍最多 2 个音（推荐）' },
  { value: 'fine', label: '精细：保留 1/16 细节' },
] as const;

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

function asPickedFile(file: File, data: Uint8Array): PickedFile {
  return { name: file.name, path: file.name, size: file.size, data };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

/** 等一帧，让「阶段文案 + 进度条」先画出来，再执行同步的重计算；窗口被遮挡时用超时兜底 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    window.setTimeout(finish, 120);
  });
}

function diagnosticTone(severity: string): 'error' | 'warning' | 'info' {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

export function ImportPage(): JSX.Element {
  const app = useAppStore();
  const preview = usePreview();
  const audioSettings = app.settings.audio;

  const [tab, setTab] = useState<ImportTab>('audio');
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [stage, setStage] = useState<RunStage | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewPlan, setPreviewPlan] = useState<ReturnType<typeof planPerformance> | null>(null);

  // 试听统一由底部播放条负责：把当前分析结果登记成试听对象，播放条会显示它的名字
  useAuditionTarget(previewPlan, previewState?.score.meta.title || '分析结果');

  // MIDI
  const [midiFile, setMidiFile] = useState<PickedFile | null>(null);
  const [midiTracks, setMidiTracks] = useState<MidiTrackSummary[]>([]);
  const [trackIndex, setTrackIndex] = useState<number | null>(null);

  // 音频
  const [audioFile, setAudioFile] = useState<PickedFile | null>(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [analysis, setAnalysis] = useState<MelodyAnalysisResult | null>(null);
  const [bpmOverride, setBpmOverride] = useState<number | null>(null);

  // 简谱文本（次要入口）
  const [textOpen, setTextOpen] = useState(false);
  const [textInput, setTextInput] = useState(
    '# 标题：我的曲子\n# 速度：100\n# 拍号：4/4\n# 调号：1=C\n\n1 1 5 5 | 6 6 5- | 4 4 3 3 | 2 2 1- |',
  );
  const [textDiagnostics, setTextDiagnostics] = useState<Array<{ severity: string; message: string }>>([]);

  const [keyRoot, setKeyRoot] = useState<number | 'auto'>('auto');

  const activeFile = tab === 'midi' ? midiFile : audioFile;

  const patchAudio = (patch: Partial<typeof audioSettings>) => {
    void app.updateSettings({ audio: { ...audioSettings, ...patch } });
  };

  const clearPreview = () => {
    preview.stop();
    setPreviewState(null);
    setPreviewPlan(null);
    setFailure(null);
  };

  const switchTab = (next: ImportTab) => {
    if (next === tab || busy) return;
    setTab(next);
    clearPreview();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (busy) return;
    const index = SOURCE_TABS.findIndex((item) => item.id === tab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % SOURCE_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + SOURCE_TABS.length) % SOURCE_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = SOURCE_TABS.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = SOURCE_TABS[nextIndex];
    switchTab(next.id);
    document.getElementById(`import-tab-${next.id}`)?.focus();
  };

  const showScore = (
    score: Score,
    warnings: string[],
    meta: { facts?: string; trackLabel?: string; modeLabel?: string } = {},
  ) => {
    setPreviewState({ score, warnings, ...meta });
    setPreviewPlan(buildPlan(score));
  };

  const buildPlan = (score: Score) => {
    try {
      return planPerformance(score);
    } catch {
      return null;
    }
  };

  /** 重新分析时沿用用户改过的标题；只认同一来源类型的旧结果 */
  const titleFor = (kind: string, fileName: string): string => {
    const fallback = fileName.replace(/\.[^.]+$/, '');
    if (previewState && previewState.score.source.kind === kind) {
      return previewState.score.meta.title.trim() || fallback;
    }
    return fallback;
  };

  const prepareMidi = (file: PickedFile) => {
    clearPreview();
    setMidiFile(file);
    setTrackIndex(null);
    setTab('midi');
    // 选文件时先列出音轨（不生成谱面），方便分析前先挑轨
    try {
      setMidiTracks(summarizeMidiTracks(file.data));
    } catch (error) {
      setMidiTracks([]);
      setFailure({ step: '解析 MIDI', detail: errorText(error) });
    }
  };

  const prepareAudio = (file: PickedFile) => {
    clearPreview();
    setAudioFile(file);
    setAnalysis(null);
    setAudioDuration(0);
    setBpmOverride(null);
    setTab('audio');
  };

  /** 选择文件只入队，不立刻分析：让「分析参数」在第一次分析前生效 */
  const selectSourceFile = async () => {
    try {
      const files = await window.api.files.pick(
        tab === 'midi'
          ? [{ name: 'MIDI 文件', extensions: MIDI_EXTENSIONS }]
          : [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
      );
      const file = files[0];
      if (!file) return;
      if (tab === 'midi') prepareMidi(file);
      else prepareAudio(file);
    } catch (error) {
      setFailure({ step: '读取文件', detail: errorText(error) });
    }
  };

  const analyzeMidi = async (file: PickedFile, track: number | null) => {
    setBusy(true);
    setFailure(null);
    preview.stop();
    setStage({ label: '读取 MIDI 数据', percent: 25 });
    try {
      await nextPaint();
      setStage({ label: '解析轨道并挑选主旋律', percent: 60 });
      await nextPaint();
      const result = importMidiFile(file.data, {
        fileName: file.name,
        title: titleFor('midi', file.name),
        quantizeGrid: audioSettings.quantizeGrid,
        ...(track !== null ? { trackIndex: track } : {}),
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
      });
      setMidiFile(file);
      setMidiTracks(result.tracks);
      setTrackIndex(result.selectedTrack);
      setTab('midi');
      showScore(result.score, result.warnings, {
        facts: keyRoot === 'auto' ? `调性置信度 ${(result.key.confidence * 100).toFixed(0)}%` : '已手动指定调号',
        trackLabel: `第 ${result.selectedTrack + 1} 轨`,
      });
    } catch (error) {
      setFailure({ step: '解析 MIDI', detail: errorText(error) });
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const regenerateAudioScore = (
    file: PickedFile | null = audioFile,
    result: MelodyAnalysisResult | null = analysis,
    tempo = bpmOverride ?? analysis?.bpm ?? 100,
    density = audioSettings.melodyDensity,
  ) => {
    if (!result || !file) return null;
    try {
      const mapped = melodyToScore(result.notes, {
        title: titleFor('audio', file.name),
        tempo,
        quantizeGrid: audioSettings.quantizeGrid,
        density,
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
        sourceKind: 'audio',
        source: { kind: 'audio', fileName: file.name },
      });
      const stats = mapped.simplifyStats;
      showScore(mapped.score, [...result.warnings, ...mapped.warnings], {
        facts: `BPM 置信度 ${(result.bpmConfidence * 100).toFixed(0)}% · 有声帧 ${(result.voicedRatio * 100).toFixed(0)}%`
          + (stats ? ` · 主旋律 ${stats.outputNotes} 音（${stats.notesPerBeat.toFixed(2)}/拍）` : ''),
        modeLabel: result.method === 'polyphonic' ? '复音主旋律' : '单声部',
      });
      return mapped;
    } catch (error) {
      setFailure({ step: '生成谱面', detail: errorText(error) });
      return null;
    }
  };

  const analyzeAudio = async (file: PickedFile) => {
    setBusy(true);
    setFailure(null);
    preview.stop();
    setStage({ label: '读取音频数据', percent: 15 });
    try {
      await nextPaint();
      setStage({ label: '解码音频（单声道 22.05 kHz）', percent: 35 });
      let decoded: Awaited<ReturnType<typeof decodeAudioFile>>;
      try {
        decoded = await decodeAudioFile(file.data);
      } catch (error) {
        setFailure({ step: '解码音频', detail: errorText(error) });
        return;
      }
      if (decoded.pcm.length === 0) {
        setFailure({ step: '解码音频', detail: '音频为空，没有可分析的采样数据' });
        return;
      }
      setAudioFile(file);
      setAudioDuration(decoded.durationSec);
      setStage({ label: '提取主旋律（音域约束 / 伴奏抑制）', percent: 65 });
      await nextPaint();
      const result = analyzeMelody(decoded.pcm, decoded.sampleRate, audioSettings);
      setAnalysis(result);
      setTab('audio');
      setStage({ label: '量化节奏并生成谱面', percent: 90 });
      await nextPaint();
      const mapped = regenerateAudioScore(file, result, bpmOverride ?? result.bpm);
      const tempoHint = result.bpmConfidence < 0.25 ? 'BPM 置信度较低，建议手动指定速度' : `检测 BPM ${result.bpm.toFixed(1)}`;
      const finalNotes = mapped?.simplifyStats?.outputNotes ?? result.notes.length;
      app.showToast('info', `音频已分析：主旋律 ${finalNotes} 个音 · ${tempoHint}`);
    } catch (error) {
      setFailure({ step: '分析音频', detail: errorText(error) });
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const runAnalysis = () => {
    if (busy) return;
    if (tab === 'midi' && midiFile) void analyzeMidi(midiFile, trackIndex);
    else if (tab === 'audio' && audioFile) void analyzeAudio(audioFile);
  };

  const analyzeText = () => {
    const parsed = buildScoreFromText(textInput);
    setTextDiagnostics(parsed.diagnostics);
    const fatal = parsed.diagnostics.filter((item) => item.severity === 'error');
    if (fatal.length > 0) {
      setFailure({ step: '解析简谱', detail: `简谱文本有 ${fatal.length} 处错误，没有生成谱面` });
      preview.stop();
      setPreviewState(null);
      setPreviewPlan(null);
      return;
    }
    setFailure(null);
    showScore(
      parsed.score,
      parsed.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message),
    );
  };

  const updateTitle = (next: string) => {
    setPreviewState((current) =>
      current ? { ...current, score: { ...current.score, meta: { ...current.score.meta, title: next } } } : current,
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
    } catch (error) {
      app.showToast('error', `保存失败：${errorText(error)}`);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      setFailure({ step: '读取文件', detail: errorText(error) });
      return;
    }
    const picked = asPickedFile(file, data);
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
      prepareMidi(picked);
      return;
    }
    if (AUDIO_PATTERN.test(lower)) {
      prepareAudio(picked);
      return;
    }
    if (lower.endsWith('.json') || lower.endsWith('.dfh')) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(picked.data)) as Score;
        if (!parsed.meta || !Array.isArray(parsed.notes)) throw new Error('不是有效的曲谱 JSON');
        clearPreview();
        showScore(parsed, [], { facts: `来自方案文件 ${file.name}` });
      } catch (error) {
        setFailure({ step: '解析方案', detail: errorText(error) });
      }
      return;
    }
    setTextInput(new TextDecoder().decode(picked.data));
    setTextOpen(true);
  };

  const noteCount = previewState ? previewState.score.notes.filter((note) => note.degree !== 0).length : 0;
  const previewDuration = previewState ? formatScoreDuration(previewState.score) : '—';
  const dropHint =
    tab === 'midi'
      ? '支持 .mid / .midi；自动挑选主旋律轨，选好后可手动切轨'
      : '支持 MP3 / WAV / M4A / FLAC / OGG；清唱、哼唱与单乐器效果最好';
  const runHint = !activeFile
    ? '先选择文件，按钮才会启用'
    : previewState
      ? '参数改动后点这里重新分析，结果会覆盖当前预览'
      : null;

  const midiFileSummary = midiFile
    ? [
        formatBytes(midiFile.size),
        midiTracks.length > 0 ? `共 ${midiTracks.length} 轨` : null,
        trackIndex !== null ? `选中第 ${trackIndex + 1} 轨` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : '';

  const audioFileSummary = audioFile
    ? [formatBytes(audioFile.size), audioDuration > 0 ? `时长 ${formatDurationMs(audioDuration * 1000)}` : null]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : '';

  return (
    <div className="page">
      <PageHeader
        title="智能导入"
        subtitle="音频约束音域并抑制伴奏，MIDI 自动选轨单音化"
      />

      {/* ---------- 1 来源 ---------- */}
      <section className="card" aria-labelledby="import-source-title">
        <div className="card-title-row">
          <h2 className="card-title" id="import-source-title">
            <span className="import-step" aria-hidden="true">
              1
            </span>
            选择来源
          </h2>
        </div>

        <div className="tabs import-source-tabs" role="tablist" aria-label="来源类型">
          {SOURCE_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              id={`import-tab-${item.id}`}
              role="tab"
              className={`tab ${tab === item.id ? 'active' : ''}`}
              aria-selected={tab === item.id}
              aria-controls="import-source-panel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => switchTab(item.id)}
              onKeyDown={onTabKeyDown}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="import-source-body" id="import-source-panel" role="tabpanel" aria-labelledby={`import-tab-${tab}`}>
          <button
            type="button"
            className={`import-dropzone ${dragActive ? 'is-drag' : ''}`}
            aria-describedby="import-dropzone-hint"
            disabled={busy}
            onClick={() => void selectSourceFile()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragActive(false);
            }}
            onDrop={(event) => void handleDrop(event)}
          >
            <span className="import-dropzone__icon">
              <Icon name={tab === 'midi' ? 'file-music' : 'headphones'} size={20} />
            </span>
            <span className="import-dropzone__body">
              <span className="import-dropzone__title">
                {tab === 'midi' ? '拖入 MIDI 文件，或点击选择' : '拖入音频文件，或点击选择'}
              </span>
              <span className="import-dropzone__hint" id="import-dropzone-hint">
                {dropHint}
              </span>
            </span>
          </button>

          {activeFile ? (
            <div className="import-file">
              <Icon name={tab === 'midi' ? 'file-music' : 'headphones'} size={16} />
              <div className="import-file__text">
                <strong className="truncate" title={activeFile.name}>
                  {activeFile.name}
                </strong>
                <span>{tab === 'midi' ? midiFileSummary : audioFileSummary}</span>
              </div>
            </div>
          ) : null}

          {tab === 'midi' && midiTracks.length > 0 ? (
            <fieldset className="import-tracks">
              <legend className="section-label">音轨（不选则自动选轨，切换后立即分析）</legend>
              {midiTracks.map((track) => (
                <label key={track.index} className={`import-track ${trackIndex === track.index ? 'is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="import-midi-track"
                    value={track.index}
                    checked={trackIndex === track.index}
                    disabled={busy}
                    onChange={() => {
                      setTrackIndex(track.index);
                      if (midiFile) void analyzeMidi(midiFile, track.index);
                    }}
                  />
                  <span className="import-track__name truncate" title={`轨道 ${track.index + 1} · ${track.name || '未命名'}`}>
                    轨道 {track.index + 1} · {track.name || '未命名'}
                    {track.isDrum ? '（鼓轨）' : ''}
                  </span>
                  <span className="import-track__meta">
                    {track.noteCount} 音 · {track.noteCount > 0 ? `${midiToName(track.pitchMin)}–${midiToName(track.pitchMax)}` : '空轨'} · 单音{' '}
                    {Math.round(track.monophonicRatio * 100)}%
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          <div className="import-alt">
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              aria-expanded={textOpen}
              aria-controls="import-text-panel"
              onClick={() => setTextOpen((open) => !open)}
            >
              <Icon name="edit" size={13} />
              {textOpen ? '收起简谱文本导入' : '改用简谱文本导入'}
            </button>
            {textOpen ? (
              <div className="import-text" id="import-text-panel">
                <label className="field">
                  <span className="field-label">简谱文本</span>
                  <textarea
                    className="textarea import-textarea"
                    spellCheck={false}
                    value={textInput}
                    onChange={(event) => setTextInput(event.target.value)}
                  />
                </label>
                <div className="action-row">
                  <button type="button" className="btn btn--sm" onClick={analyzeText}>
                    <Icon name="file-music" size={13} /> 解析为可演奏谱
                  </button>
                  <span className="field-hint">支持 1-7 音级、0 休止与头部信息（标题 / 速度 / 调号）</span>
                </div>
                {textDiagnostics.length > 0 ? (
                  <ul className="import-diags">
                    {textDiagnostics.map((item, index) => (
                      <li
                        key={`${item.message}-${index}`}
                        className={`import-diag import-diag--${diagnosticTone(item.severity)}`}
                      >
                        <Icon name={item.severity === 'error' ? 'warning' : 'info'} size={12} />
                        <span>{item.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ---------- 2 分析参数 + 执行 ---------- */}
      <section className="card" aria-labelledby="import-params-title">
        <div className="card-title-row">
          <h2 className="card-title" id="import-params-title">
            <span className="import-step" aria-hidden="true">
              2
            </span>
            分析参数
          </h2>
        </div>

        <div className="import-params-body">
          {tab === 'audio' ? (
            <>
              <div className="import-fieldgroup">
                <span className="section-label">主旋律提取</span>
                <div className="field-row import-field-row">
                  <label className="field">
                    <span className="field-label">分析模式</span>
                    <select
                      className="select"
                      value={audioSettings.melodyMode}
                      onChange={(event) => patchAudio({ melodyMode: event.target.value as typeof audioSettings.melodyMode })}
                    >
                      <option value="auto">自动判断（推荐）</option>
                      <option value="monophonic">单声部（清唱 / 独奏）</option>
                      <option value="polyphonic">复音主旋律（带伴奏）</option>
                    </select>
                    <span className="field-hint">清唱、独奏用单声部；带伴奏成品歌用复音主旋律</span>
                  </label>
                  <label className="field">
                    <span className="field-label">最短音符（毫秒）</span>
                    <input
                      className="input number"
                      type="number"
                      min={30}
                      max={500}
                      step={10}
                      title="30–500 毫秒"
                      value={audioSettings.minNoteMs}
                      onChange={(event) =>
                        patchAudio({ minNoteMs: Math.max(30, Math.min(500, Number(event.target.value) || 70)) })
                      }
                    />
                    <span className="field-hint">调大可滤掉颤音碎片；短于该时长的音会被忽略</span>
                  </label>
                  <div className="field">
                    <span className="field-label">伴奏抑制</span>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={audioSettings.suppressAccompaniment}
                        onChange={(event) => patchAudio({ suppressAccompaniment: event.target.checked })}
                      />
                      <span>削弱鼓点与伴奏（HPSS）</span>
                    </label>
                    <span className="field-hint">带伴奏歌曲建议开启</span>
                  </div>
                </div>
              </div>

              <div className="import-fieldgroup">
                <span className="section-label">音域约束</span>
                <div className="field-row import-field-row">
                  <div className="field">
                    <span className="field-label">主旋律音域</span>
                    <div className="field-inline">
                      <select
                        className="select"
                        aria-label="音域下限"
                        value={audioSettings.pitchMin}
                        onChange={(event) => patchAudio({ pitchMin: Number(event.target.value) })}
                      >
                        {PITCH_CHOICES.map((choice) => (
                          <option key={choice.midi} value={choice.midi}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                      <span className="muted">至</span>
                      <select
                        className="select"
                        aria-label="音域上限"
                        value={audioSettings.pitchMax}
                        onChange={(event) => patchAudio({ pitchMax: Number(event.target.value) })}
                      >
                        {PITCH_CHOICES.map((choice) => (
                          <option key={choice.midi} value={choice.midi}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <span className="field-hint">收窄音域可减少错音；口琴常用 C3–C6</span>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          <div className="import-fieldgroup">
            <span className="section-label">节奏与调性</span>
            <div className="field-row import-field-row">
              {tab === 'audio' ? (
                <label className="field">
                  <span className="field-label">谱面密度</span>
                  <select
                    className="select"
                    value={audioSettings.melodyDensity}
                    onChange={(event) => {
                      const density = event.target.value as typeof audioSettings.melodyDensity;
                      patchAudio({ melodyDensity: density });
                      // 密度只是谱面重排，不需要重新解码/提取；已有分析结果时立即刷新预览。
                      if (analysis && audioFile && !busy) {
                        regenerateAudioScore(audioFile, analysis, bpmOverride ?? analysis.bpm, density);
                      }
                    }}
                  >
                    {MELODY_DENSITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">标准会合并碎片并限制每拍音符数；宽松最易演奏，精细保留原曲细节</span>
                </label>
              ) : (
                <label className="field">
                  <span className="field-label">量化网格</span>
                  <select
                    className="select"
                    value={audioSettings.quantizeGrid}
                    onChange={(event) => patchAudio({ quantizeGrid: Number(event.target.value) })}
                  >
                    {QUANTIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">选 1/16 更贴合原曲，选 1/8 更易演奏</span>
                </label>
              )}
              <label className="field">
                <span className="field-label">调号</span>
                <select
                  className="select"
                  value={keyRoot === 'auto' ? 'auto' : String(keyRoot)}
                  onChange={(event) => setKeyRoot(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}
                >
                  <option value="auto">自动检测</option>
                  {Array.from({ length: 12 }, (_, index) => (
                    <option key={index} value={index}>
                      1={keyLabel(index)}
                    </option>
                  ))}
                </select>
                <span className="field-hint">不确定时手动指定 1=?，默认自动检测调性</span>
              </label>
              {tab === 'audio' ? (
                <label className="field">
                  <span className="field-label">速度覆盖（BPM）</span>
                  <input
                    className="input number"
                    type="number"
                    min={40}
                    max={240}
                    title="40–240 BPM"
                    value={bpmOverride ?? Math.round(analysis?.bpm ?? 100)}
                    onChange={(event) => setBpmOverride(Number(event.target.value) || null)}
                  />
                  <span className="field-hint">
                    {analysis
                      ? `覆盖自动检测的 ${analysis.bpm.toFixed(1)} BPM（置信度 ${(analysis.bpmConfidence * 100).toFixed(0)}%）`
                      : '首次分析后填入检测速度，可手动覆盖'}
                  </span>
                </label>
              ) : null}
            </div>
          </div>

          <div className="import-run">
            <button
              type="button"
              className={`btn ${previewState ? '' : 'btn--primary'} ${busy ? 'btn--loading' : ''}`}
              disabled={!activeFile || busy}
              aria-busy={busy}
              aria-describedby={runHint ? 'import-run-hint' : undefined}
              title={
                busy
                  ? '正在分析，请稍候'
                  : activeFile
                    ? previewState
                      ? '按当前参数重新分析，结果会覆盖当前预览'
                      : '按当前参数开始分析'
                    : '先在上方选择或拖入一个文件'
              }
              onClick={runAnalysis}
            >
              <Icon name="waveform" size={15} />
              {busy ? '分析中…' : previewState ? '重新分析' : '开始分析'}
            </button>

            <div className="import-run__status">
              {busy ? (
                <>
                  <span className="import-run__stage" role="status" aria-live="polite">
                    {stage?.label ?? '准备中…'}
                  </span>
                  <div
                    className="progress import-run__progress"
                    role="progressbar"
                    aria-label="分析进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={stage?.percent ?? 0}
                  >
                    <div className="progress-bar" style={{ width: `${stage?.percent ?? 0}%` }} />
                  </div>
                </>
              ) : (
                runHint ? (
                  <span className="muted" id="import-run-hint">
                    {runHint}
                  </span>
                ) : null
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 3 结果 ---------- */}
      <section className="card" aria-labelledby="import-result-title">
        <div className="card-title-row">
          <h2 className="card-title" id="import-result-title">
            <span className="import-step" aria-hidden="true">
              3
            </span>
            分析结果
          </h2>
          {previewState ? (
            <div className="inline-actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={busy}
                onClick={() => void savePreview()}
              >
                <Icon name="save" size={13} /> 加入方案库
              </button>
            </div>
          ) : null}
        </div>

        <div className="import-result-body">
          {failure ? (
            <Notice tone="danger" title={FAILURE_TITLE[failure.step]} icon={<Icon name="warning" size={15} />}>
              {`${failure.detail}。${FAILURE_ADVICE[failure.step]}${previewState ? ' 下方仍是上一次的分析结果。' : ''}`}
            </Notice>
          ) : null}

          {previewState ? (
            <>
              <p className="sr-only" role="status">
                {`分析完成：${noteCount} 个音符，${
                  previewState.warnings.length > 0 ? `${previewState.warnings.length} 条可演奏性提示` : '没有可演奏性问题'
                }`}
              </p>
              <div className="import-result-summary">
                <label className="field import-result-title">
                  <span className="field-label">标题</span>
                  <input className="input" value={previewState.score.meta.title} onChange={(event) => updateTitle(event.target.value)} />
                </label>
                <div className="chip-row">
                  <Chip label="来源" value={sourceKindLabel(previewState.score.source.kind)} />
                  <Chip label="速度" value={`${previewState.score.meta.tempo.toFixed(0)} BPM`} />
                  <Chip label="调号" value={`1=${keyLabel(previewState.score.meta.keyRoot)}`} />
                  <Chip label="音符" value={`${noteCount}`} />
                  <Chip label="时长" value={previewDuration} />
                  {previewState.trackLabel ? <Chip label="轨" value={previewState.trackLabel} /> : null}
                  {previewState.modeLabel ? <Chip label="模式" value={previewState.modeLabel} /> : null}
                </div>
              </div>

              {previewState.facts ? <p className="muted">{previewState.facts}</p> : null}

              <div className="score-surface score-surface--compact import-score">
                <ScoreView score={previewState.score} measuresPerRow={4} />
              </div>

              {!failure ? (
                previewState.warnings.length > 0 ? (
                  <div className="notice notice--warn">
                    <div className="notice__icon" aria-hidden="true">
                      <Icon name="warning" size={15} />
                    </div>
                    <div className="notice__body">
                      <strong className="notice__title">可演奏性提示（{previewState.warnings.length} 条）</strong>
                      <ul className="fact-list">
                        {previewState.warnings.map((warning, index) => (
                          <li key={`${warning}-${index}`}>
                            <Icon name="warning" size={13} />
                            <span>{warning}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : (
                  <p className="import-ok">
                    <Icon name="check" size={13} /> 未发现可演奏性问题
                  </p>
                )
              ) : null}
            </>
          ) : failure ? null : (
            <EmptyState
              icon={<Icon name="file-music" size={20} />}
              title={activeFile ? '等待生成谱面' : '还没有分析结果'}
              description={
                activeFile
                  ? '点上方「开始分析」，谱面与可演奏性提示会出现在这里，随后可用底部播放条试听。'
                  : '拖入 MIDI 或音频文件，设置参数后点「开始分析」。'
              }
              actions={
                activeFile ? undefined : (
                  <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void selectSourceFile()}>
                    <Icon name="folder" size={13} /> 选择{tab === 'midi' ? ' MIDI ' : '音频'}文件
                  </button>
                )
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}
