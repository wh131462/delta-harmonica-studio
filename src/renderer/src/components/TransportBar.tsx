import type { CSSProperties } from 'react';
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

/**
 * 底部常驻播放条：全应用唯一的「开始演奏」主操作 + 试听区 + 当前曲谱上下文。
 * 页面内不再重复主按钮，只保留次级入口。
 */
export function TransportBar(): JSX.Element {
  const app = useAppStore();
  const perf = usePerformance();
  const preview = usePreview();
  const playback = perf.playbackStatus;
  const active = playback.state === 'playing' || playback.state === 'countdown';
  const plan = perf.plan;
  // 页面登记了自己的试听对象（分析结果 / 编辑器草稿）就听它，否则回退到当前曲谱
  const audition =
    preview.target ?? (plan ? { plan, label: app.currentScore?.meta.title ?? '当前曲谱' } : null);
  const canPerform = Boolean(plan && plan.notes.length > 0);
  const canAudition = Boolean(audition && audition.plan.notes.length > 0);
  const nowPlaying = preview.playing ? preview.nowPlaying : null;
  const scoreTitle = app.currentScore?.meta.title ?? '未选择曲谱';

  const previewProgress = preview.totalMs > 0 ? Math.min(100, (preview.elapsedMs / preview.totalMs) * 100) : 0;
  const volumePercent = Math.round(preview.volume * 100);
  const playProgress =
    plan && playback.totalMs ? Math.min(100, ((playback.elapsedMs ?? 0) / playback.totalMs) * 100) : 0;

  return (
    <footer className="dock" aria-label="演奏与试听控制">
      <div className="dock-zone dock-score">
        <strong title={nowPlaying?.label || scoreTitle}>{nowPlaying?.label || scoreTitle}</strong>
        <small>
          {nowPlaying
            ? `试听中 · ${nowPlaying.noteCount} 音`
            : `${plan ? `${plan.stats.noteCount} 音 · ${formatDurationMs(plan.durationMs)}` : '选曲后可试听与演奏'}${
                app.dirty ? ' · 未保存' : ''
              }`}
        </small>
      </div>

      <div className="dock-divider" aria-hidden="true" />

      <div className="dock-zone dock-zone--grow">
        <div className="segmented" role="group" aria-label="试听音色">
          {INSTRUMENTS.map((instrument) => (
            <button
              key={instrument.id}
              type="button"
              className="segmented__item"
              aria-pressed={preview.instrument === instrument.id}
              title={instrument.tagline}
              onClick={() => preview.setInstrument(instrument.id)}
            >
              {instrument.name}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn btn--sm"
          disabled={!canAudition}
          title={
            !canAudition
              ? '当前没有可试听的内容'
              : preview.playing
                ? '停止试听'
                : `试听《${audition?.label ?? ''}》`
          }
          onClick={() => {
            if (preview.playing) preview.stop();
            else if (audition) void preview.play(audition.plan, audition.label);
          }}
        >
          <Icon name={preview.playing ? 'stop' : 'headphones'} size={14} />
          {preview.playing ? '停止试听' : '试听'}
        </button>

        <div className="dock-volume" title={`试听音量 ${volumePercent}%`}>
          <Icon name="volume" size={14} />
          <input
            className="range"
            type="range"
            aria-label="试听音量"
            aria-valuetext={`${volumePercent}%`}
            min={0}
            max={100}
            value={volumePercent}
            style={{ '--range-fill': `${volumePercent}%` } as CSSProperties}
            onChange={(event) => preview.setVolume(Number(event.target.value) / 100)}
          />
        </div>

        {preview.totalMs > 0 ? (
          <>
            <div
              className="progress dock-track"
              role="progressbar"
              aria-label="试听进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(previewProgress)}
            >
              <div className="progress-bar" style={{ width: `${previewProgress}%` }} />
            </div>
            <span className="dock-time">
              {formatDurationMs(preview.elapsedMs)} / {formatDurationMs(preview.totalMs)}
            </span>
          </>
        ) : null}
      </div>

      <div className="dock-divider" aria-hidden="true" />

      <div className="dock-zone">
        <span className={`badge ${app.settings.input.backend === 'software' ? 'badge--signal' : ''}`}>
          {BACKEND_LABEL[app.settings.input.backend] ?? app.settings.input.backend}
        </span>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={!active}
          onClick={() => void perf.stop()}
          title="立即停止并释放所有按键"
        >
          <Icon name="stop" size={13} /> 停止
        </button>
        <button
          type="button"
          className="btn btn--accent"
          disabled={perf.starting || active || !canPerform}
          onClick={() => void perf.start()}
          title={canPerform ? '开始演奏（F9）' : '先在编辑器或导入页准备一首可演奏的曲谱'}
        >
          <Icon name="play" size={15} />
          {playback.state === 'countdown'
            ? `${playback.countdown ?? 0} 秒后开始`
            : active
              ? '演奏中…'
              : perf.starting
                ? '准备中…'
                : '开始演奏'}
        </button>
        <span className="hotkey-hint">
          <kbd>{app.settings.hotkeys.togglePlay}</kbd> 开始/停止 · <kbd>{app.settings.hotkeys.panicStop}</kbd> 急停
        </span>
      </div>

      {active ? (
        <div className="dock-progress" title="演奏进度">
          <i style={{ width: `${playProgress}%` }} />
        </div>
      ) : null}
    </footer>
  );
}
