import { useCallback, useMemo, useState } from 'react';
import { transcribeMelody, type TranscriptionResult } from '@core/audio';
import { melodyToScore } from '@core/import/melody-to-score';
import { importMidiFile, type MidiImportResult, type MidiTrackSummary } from '@core/import/midi';
import { buildScoreFromText } from '@core/score/dsl';
import { scoreEndBeat, type Score } from '@core/model/score';
import { ScoreView } from '@renderer/components/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader, EmptyState, Chip } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { decodeAudioFile } from '@renderer/audio/decode';
import { formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';
import type { PickedFile } from '@shared/types';

type ImportTab = 'midi' | 'audio' | 'text' | 'keys';

interface PreviewState {
  score: Score;
  warnings: string[];
  sourceLabel: string;
  extra?: string;
}

const QUANTIZE_OPTIONS = [
  { value: 0.125, label: '1/32 音符（精细）' },
  { value: 0.25, label: '1/16 音符（推荐）' },
  { value: 0.5, label: '1/8 音符（简化）' },
];

export function ImportPage(): JSX.Element {
  const app = useAppStore();
  const [tab, setTab] = useState<ImportTab>('midi');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  // MIDI
  const [midiFile, setMidiFile] = useState<PickedFile | null>(null);
  const [midiTracks, setMidiTracks] = useState<MidiTrackSummary[]>([]);
  const [trackIndex, setTrackIndex] = useState<number | null>(null);
  const [midiResult, setMidiResult] = useState<MidiImportResult | null>(null);

  // 音频
  const [audioFile, setAudioFile] = useState<PickedFile | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null);
  const [transcriptionDetail, setTranscriptionDetail] = useState<string>('');
  const [bpmOverride, setBpmOverride] = useState<number | null>(null);

  // 文本
  const [textInput, setTextInput] = useState(
    '# 标题：我的曲子\n# 速度：100\n# 拍号：4/4\n# 调号：1=C\n\n1 1 5 5 | 6 6 5- | 4 4 3 3 | 2 2 1- |',
  );

  const [title, setTitle] = useState('');
  const [quantizeGrid, setQuantizeGrid] = useState(0.25);
  const [keyRoot, setKeyRoot] = useState<number | 'auto'>('auto');

  const resetPreview = () => {
    setPreview(null);
    setError(null);
  };

  const switchTab = (next: ImportTab) => {
    setTab(next);
    resetPreview();
  };

  /** MIDI：选文件 + 轨道分析 */
  const pickMidi = async () => {
    setBusy(true);
    setError(null);
    try {
      const files = await window.api.files.pick([{ name: 'MIDI 文件', extensions: ['mid', 'midi'] }]);
      if (files.length === 0) return;
      const file = files[0];
      setMidiFile(file);
      const result = importMidiFile(file.data, {
        fileName: file.name,
        title: file.name.replace(/\.(mid|midi)$/i, ''),
        quantizeGrid,
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
      });
      setMidiResult(result);
      setMidiTracks(result.tracks);
      setTrackIndex(result.selectedTrack);
      setTitle(result.score.meta.title);
      setPreview({
        score: result.score,
        warnings: result.warnings,
        sourceLabel: `MIDI · ${file.name}`,
        extra: `检测调性：${keyLabel(result.key.keyRoot)} 大调${result.key.mode === 'minor' ? '（关系大调）' : ''} · 置信度 ${(result.key.confidence * 100).toFixed(0)}%`,
      });
      if (result.warnings.length > 0) app.showToast('info', 'MIDI 已导入，请查看右侧分析提示');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const analyzeMidi = async (nextTrack: number | null) => {
    if (!midiFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = importMidiFile(midiFile.data, {
        fileName: midiFile.name,
        title: title.trim() || midiFile.name.replace(/\.(mid|midi)$/i, ''),
        quantizeGrid,
        ...(nextTrack !== null ? { trackIndex: nextTrack } : {}),
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
      });
      setMidiResult(result);
      setTrackIndex(result.selectedTrack);
      setPreview({
        score: result.score,
        warnings: result.warnings,
        sourceLabel: `MIDI · ${midiFile.name}`,
        extra: `第 ${result.selectedTrack + 1} 轨 · 检测调性：${keyLabel(result.key.keyRoot)} 大调 · 置信度 ${(result.key.confidence * 100).toFixed(0)}%`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 音频：解码 + 转谱 */
  const pickAudio = async () => {
    setBusy(true);
    setError(null);
    try {
      const files = await window.api.files.pick([{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }]);
      if (files.length === 0) return;
      const file = files[0];
      setAudioFile(file);
      setTitle(file.name.replace(/\.[^.]+$/, ''));
      await analyzeAudio(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const buildAudioScore = useCallback(
    (result: TranscriptionResult, tempo: number, file: PickedFile | null, scoreTitle: string) => {
      const mapped = melodyToScore(result.notes, {
        title: scoreTitle || '音频导入',
        tempo,
        quantizeGrid,
        ...(keyRoot !== 'auto' ? { keyRoot } : {}),
        sourceKind: 'audio',
        source: { kind: 'audio', fileName: file?.name },
      });
      return mapped;
    },
    [quantizeGrid, keyRoot],
  );

  const analyzeAudio = async (file: PickedFile) => {
    setBusy(true);
    setError(null);
    try {
      const decoded = await decodeAudioFile(file.data);
      if (decoded.pcm.length === 0) throw new Error('音频为空或无法解码');
      const result = transcribeMelody(decoded.pcm, decoded.sampleRate, {});
      setTranscription(result);
      const tempo = bpmOverride ?? result.bpm;
      const mapped = buildAudioScore(result, tempo, file, title || file.name.replace(/\.[^.]+$/, ''));
      setPreview({
        score: mapped.score,
        warnings: [...result.warnings, ...mapped.warnings],
        sourceLabel: `音频 · ${file.name}`,
        extra: `检测 BPM ${result.bpm.toFixed(1)}（置信度 ${(result.bpmConfidence * 100).toFixed(0)}%）· 有声帧占比 ${(result.voicedRatio * 100).toFixed(0)}%`,
      });
      setTranscriptionDetail(
        `音频时长 ${formatDurationMs(decoded.durationSec * 1000)}，解码为 ${decoded.sampleRate}Hz 单声道，检测到 ${result.notes.length} 个旋律音。`,
      );
      app.showToast('info', '音频已分析，请在右侧检查转谱结果并保存');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerateAudio = () => {
    if (!transcription) return;
    const tempo = bpmOverride ?? transcription.bpm;
    try {
      const mapped = buildAudioScore(transcription, tempo, audioFile, title || '音频导入');
      setPreview({
        score: mapped.score,
        warnings: [...transcription.warnings, ...mapped.warnings],
        sourceLabel: `音频 · ${audioFile?.name ?? ''}`,
        extra: `BPM ${tempo.toFixed(1)} · ${transcription.notes.length} 个旋律音`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 文本简谱 */
  const analyzeText = () => {
    const parsed = buildScoreFromText(textInput);
    setDiagnosticsForText(parsed.diagnostics);
    const fatal = parsed.diagnostics.filter((item) => item.severity === 'error');
    if (fatal.length > 0) {
      setError(`文本中有 ${fatal.length} 处错误，请先修复`);
      setPreview(null);
      return;
    }
    setError(null);
    setPreview({
      score: parsed.score,
      warnings: parsed.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message),
      sourceLabel: '简谱文本',
    });
    setTitle(parsed.score.meta.title);
  };

  const [textDiagnostics, setDiagnosticsForText] = useState<Array<{ severity: 'error' | 'warning'; message: string }>>([]);

  const savePreview = async () => {
    if (!preview) return;
    try {
      await window.api.library.save(preview.score);
      await app.refreshLibrary();
      app.showToast('success', `已保存《${preview.score.meta.title}》到音乐方案库`);
      setPreview(null);
      app.navigate('library');
    } catch (err) {
      app.showToast('error', `保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const previewDuration = useMemo(() => {
    if (!preview) return '';
    const beats = scoreEndBeat(preview.score);
    return formatDurationMs((beats * 60000) / Math.max(20, preview.score.meta.tempo));
  }, [preview]);

  const tabButtons: Array<{ id: ImportTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
    { id: 'midi', label: 'MIDI 导入', icon: 'music' },
    { id: 'audio', label: '音频分析', icon: 'headphones' },
    { id: 'text', label: '简谱文本', icon: 'edit' },
    { id: 'keys', label: '键位谱', icon: 'target' },
  ];

  return (
    <div className="page">
      <PageHeader
        title="智能导入"
        subtitle="MIDI 与音频自动分析为主旋律，并生成受口琴音域约束的可演奏简谱"
      />

      <div className="import-tabs">
        {tabButtons.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`import-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => switchTab(item.id)}
          >
            <Icon name={item.icon} size={16} /> {item.label}
          </button>
        ))}
      </div>

      <div className="import-layout">
        <section className="card import-source">
          {tab === 'midi' ? (
            <>
              <h4 className="card-title">
                <Icon name="music" size={16} /> 选择 MIDI 文件
              </h4>
              <p className="hint-text">支持 .mid / .midi；建议使用单旋律音轨或主旋律轨，软件会自动挑轨并做单音化处理。</p>
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
                      <input
                        type="radio"
                        name="midi-track"
                        checked={trackIndex === track.index}
                        onChange={() => void analyzeMidi(track.index)}
                      />
                      <div>
                        <strong>
                          轨道 {track.index + 1}：{track.name || '未命名'}
                          {track.isDrum ? '（鼓轨）' : ''}
                        </strong>
                        <span>
                          {track.noteCount} 个音 · 音域 {track.pitchMin}-{track.pitchMax} · 单音比例{' '}
                          {(track.monophonicRatio * 100).toFixed(0)}%
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              ) : null}

              <div className="field-row">
                <label className="field">
                  <span className="field-label">量化精度</span>
                  <select className="select" value={quantizeGrid} onChange={(event) => setQuantizeGrid(Number(event.target.value))}>
                    {QUANTIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
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
                </label>
              </div>
              {midiFile ? (
                <button type="button" className="button ghost" disabled={busy} onClick={() => void analyzeMidi(trackIndex)}>
                  <Icon name="refresh" size={15} /> 用当前选项重新分析
                </button>
              ) : null}
            </>
          ) : null}

          {tab === 'audio' ? (
            <>
              <h4 className="card-title">
                <Icon name="headphones" size={16} /> 音频转谱
              </h4>
              <div className="caveat">
                <Icon name="warning" size={18} />
                <div>
                  <strong>音频扒谱有局限，请先了解</strong>
                  <p>
                    本功能适合<strong>清唱、哼唱、口哨、单乐器独奏</strong>等单声部录音；
                    带伴奏的成品歌曲容易把伴奏误判成旋律。对成品歌建议优先使用 MIDI，或把网上的简谱文本粘贴进来。
                  </p>
                </div>
              </div>
              <button type="button" className="button primary" disabled={busy} onClick={() => void pickAudio()}>
                <Icon name="folder" size={15} /> {busy ? '分析中…' : audioFile ? '重新选择音频' : '选择音频文件'}
              </button>
              {audioFile ? (
                <div className="file-info">
                  <Icon name="headphones" size={16} />
                  <div>
                    <strong>{audioFile.name}</strong>
                    <span>{(audioFile.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                </div>
              ) : null}
              {transcription ? (
                <>
                  <p className="hint-text">{transcriptionDetail}</p>
                  <div className="field-row">
                    <label className="field">
                      <span className="field-label">BPM（可覆盖）</span>
                      <input
                        className="input number"
                        type="number"
                        min={40}
                        max={240}
                        value={bpmOverride ?? Math.round(transcription.bpm)}
                        onChange={(event) => setBpmOverride(Number(event.target.value) || null)}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">量化精度</span>
                      <select className="select" value={quantizeGrid} onChange={(event) => setQuantizeGrid(Number(event.target.value))}>
                        {QUANTIZE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="button ghost" onClick={regenerateAudio}>
                      <Icon name="refresh" size={15} /> 重新生成
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'text' ? (
            <>
              <h4 className="card-title">
                <Icon name="edit" size={16} /> 粘贴简谱文本
              </h4>
              <p className="hint-text">支持数字简谱、<code># 标题：</code> 头部信息、八度点与延音线等。</p>
              <textarea
                className="score-textarea small"
                value={textInput}
                spellCheck={false}
                onChange={(event) => setTextInput(event.target.value)}
              />
              <button type="button" className="button primary" onClick={analyzeText}>
                <Icon name="sparkle" size={15} /> 解析为可演奏谱
              </button>
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
              title="键位谱导入（v1.1）"
              description="计划支持粘贴 ZXCVBNM 键位串（如 MNMNCBV、含 ↑↓# 修饰键）自动还原为简谱。当前可先用「简谱文本」或「MIDI 导入」。"
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
            {preview ? (
              <button type="button" className="button primary small" onClick={() => void savePreview()}>
                <Icon name="check" size={14} /> 保存到方案库
              </button>
            ) : null}
          </div>

          {!preview ? (
            <EmptyState
              icon={<Icon name="music" size={30} />}
              title="还没有分析结果"
              description="选择文件或粘贴简谱后，这里会显示可演奏谱面、节奏校准结果与注意事项。"
            />
          ) : (
            <>
              <div className="preview-head">
                <label className="field grow">
                  <span className="field-label">标题</span>
                  <input
                    className="input"
                    value={preview.score.meta.title}
                    onChange={(event) =>
                      setPreview({ ...preview, score: { ...preview.score, meta: { ...preview.score.meta, title: event.target.value } } })
                    }
                  />
                </label>
                <div className="chip-row">
                  <Chip label="来源" value={sourceKindLabel(preview.score.source.kind)} />
                  <Chip label="速度" value={`${preview.score.meta.tempo.toFixed(0)} BPM`} />
                  <Chip label="调号" value={`1=${keyLabel(preview.score.meta.keyRoot)}`} />
                  <Chip label="拍号" value={`${preview.score.meta.meter.num}/${preview.score.meta.meter.den}`} />
                  <Chip label="音符" value={`${preview.score.notes.filter((note) => note.degree !== 0).length}`} />
                  <Chip label="时长" value={previewDuration} />
                </div>
              </div>
              {preview.extra ? <p className="hint-text">{preview.extra}</p> : null}
              <div className="score-paper compact">
                <ScoreView score={preview.score} measuresPerRow={4} />
              </div>
              {preview.warnings.length > 0 ? (
                <div className="warning-list">
                  {preview.warnings.map((warning, index) => (
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
              <p className="hint-text">
                来源：{preview.sourceLabel} · 保存后可在演奏台选择移调/速度并试听或注入游戏。
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
