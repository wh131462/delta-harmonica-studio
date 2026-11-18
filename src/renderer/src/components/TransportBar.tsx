import { Icon } from './Icon';
import { useAppStore } from '@renderer/state/app-store';
import { usePerformance } from '@renderer/performance/performance-context';
import { usePreview } from '@renderer/audio/preview-context';
import { INSTRUMENTS } from '@renderer/audio/instruments';
import { formatDurationMs } from '@renderer/utils/format';

const BACKEND_LABEL: Record<string, string> = {
  software: '游戏注入',
  'dry-run': '排练模式',
  serial: '串口硬件',
};

/** 底部常驻播放条：试听（口琴/钢琴）+ 游戏演奏控制 + 快捷键提示 */
export function TransportBar(): JSX.Element {
  const app = useAppStore();
  const perf = usePerformance();
  const preview = usePreview();
  const playback = perf.playbackStatus;
  const active = playback.state === 'playing' || playback.state === 'countdown';
  const plan = perf.plan;

  const previewProgress = preview.totalMs > 0 ? Math.min(100, (preview.elapsedMs / preview.totalMs) * 100) : 0;
  const playProgress = plan && playback.totalMs ? Math.min(100, ((playback.elapsedMs ?? 0) / playback.totalMs) * 100) : 0;

  return (
    <footer className="transport">
      <div className="transport-score">
        <span className="transport-label">当前曲谱</span>
        <strong title={app.currentScore?.meta.title ?? ''}>{app.currentScore?.meta.title ?? '未选择曲谱'}</strong>
        <span className="transport-meta">
          {plan ? `${plan.stats.noteCount} 音 · ${formatDurationMs(plan.durationMs)}` : '—'}
          {app.dirty ? ' · 未保存' : ''}
        </span>
      </div>

      <div className="transport-preview">
        <div className="instrument-switch" role="group" aria-label="试听音色">
          {INSTRUMENTS.map((instrument) => (
            <button
              key={instrument.id}
              type="button"
              className={`inst-btn ${preview.instrument === instrument.id ? 'active' : ''}`}
              title={instrument.tagline}
              onClick={() => preview.setInstrument(instrument.id)}
            >
              {instrument.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button ghost small"
          disabled={!plan || plan.notes.length === 0}
          onClick={() => {
            if (preview.playing) preview.stop();
            else if (plan) void preview.play(plan);
          }}
        >
          <Icon name={preview.playing ? 'stop' : 'headphones'} size={15} /> {preview.playing ? '停止试听' : '试听'}
        </button>
        <div className="volume-control" title={`试听音量 ${Math.round(preview.volume * 100)}%`}>
          <Icon name="volume" size={15} />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(preview.volume * 100)}
            onChange={(event) => preview.setVolume(Number(event.target.value) / 100)}
          />
        </div>
        <div className="transport-track">
          <div className="transport-track-fill" style={{ width: `${previewProgress}%` }} />
        </div>
        <span className="transport-time">
          {formatDurationMs(preview.elapsedMs)} / {formatDurationMs(preview.totalMs)}
        </span>
      </div>

      <div className="transport-perform">
        <span className={`backend-pill ${app.settings.input.backend}`}>{BACKEND_LABEL[app.settings.input.backend] ?? app.settings.input.backend}</span>
        <button
          type="button"
          className="button danger small"
          disabled={!active}
          onClick={() => void perf.stop()}
          title="立即停止并释放所有按键"
        >
          <Icon name="stop" size={14} /> 停止
        </button>
        <button
          type="button"
          className="button primary"
          disabled={perf.starting || active || !plan || plan.notes.length === 0}
          onClick={() => void perf.start()}
        >
          <Icon name="play" size={16} /> {active ? '演奏中…' : perf.starting ? '准备中…' : '开始演奏'}
        </button>
        <span className="transport-hint">
          <kbd>{app.settings.hotkeys.togglePlay}</kbd> 开始/停止 · <kbd>{app.settings.hotkeys.panicStop}</kbd> 急停
        </span>
      </div>

      {active ? (
        <div className="transport-progress-line" title="演奏进度">
          <div style={{ width: `${playProgress}%` }} />
        </div>
      ) : null}
    </footer>
  );
}
