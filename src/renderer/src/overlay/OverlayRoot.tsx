/**
 * 悬浮控制窗页面：无边框透明小窗，用于游戏内快速开始/停止/急停。
 * 通过 preload 暴露的 window.api 与主进程通信。
 *
 * 信息层级：状态行（状态点 + 状态词 + 品牌）→ 曲名 → 目标窗口/输入方式
 *          → 进度或倒计时 → 操作行 → 快捷键提示。
 * 主操作按钮恒定保留 `.ov-btn.primary`（主进程 DFH_OVERLAY_AUTOCLICK 依赖该选择器）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { OverlaySyncState, PlaybackStatus } from '@shared/types';
import { Icon } from '@renderer/components/Icon';
import { formatDurationMs } from '@renderer/utils/format';
import './overlay.css';

const BACKEND_LABEL: Record<string, string> = {
  software: '游戏注入',
  'dry-run': '排练模式',
  serial: '串口硬件',
};

function stateText(status: PlaybackStatus): string {
  switch (status.state) {
    case 'countdown':
      // 秒数交给下方倒计时槽位显示，状态词只说一次
      return '倒计时';
    case 'playing':
      return '演奏中';
    case 'finished':
      return '演奏完成';
    case 'stopped':
      return '已停止';
    case 'focus-lost':
      return '失焦已停止';
    case 'error':
      return '出错';
    default:
      return '待命';
  }
}

export function OverlayRoot(): JSX.Element {
  const [state, setState] = useState<OverlaySyncState | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>({ state: 'idle' });

  useEffect(() => {
    const offState = window.api.overlay.onState((next) => setState(next));
    const offStatus = window.api.playback.onStatus((next) => setStatus(next));
    return () => {
      offState();
      offStatus();
    };
  }, []);

  const playback = status.state !== 'idle' ? status : state?.playback ?? status;
  const active = playback.state === 'playing' || playback.state === 'countdown';
  const progress = useMemo(() => {
    if (playback.state !== 'playing' || !playback.totalMs) return 0;
    return Math.min(100, Math.max(0, ((playback.elapsedMs ?? 0) / playback.totalMs) * 100));
  }, [playback]);

  const send = (command: Parameters<typeof window.api.overlay.sendCommand>[0]) => {
    void window.api.overlay.sendCommand(command);
  };

  const title = state?.title ?? '未选择曲谱';
  const metaLine = state
    ? [
        state.targetWindowTitle ? `目标窗口：${state.targetWindowTitle}` : '未选择目标窗口',
        BACKEND_LABEL[state.backend] ?? state.backend,
      ].join(' · ')
    : '未选择目标窗口';
  const totalMs = playback.totalMs ?? 0;
  const showTime = totalMs > 0 && (playback.state === 'playing' || playback.state === 'finished');
  const hotkeys = state?.hotkeys ?? null;
  const showHints = hotkeys !== null && state?.showHotkeyHint !== false;

  return (
    <div className="ov-shell">
      <section className="ov-card" data-state={playback.state} aria-label="悬浮控制窗">
        <header className="ov-drag">
          <div className="ov-head">
            <span className="ov-dot" aria-hidden="true" />
            <span className="ov-state" role="status" title={playback.message}>
              {stateText(playback)}
            </span>
          </div>
          <p className="ov-title" title={title}>
            {title}
          </p>
          <p className="ov-sub" title={metaLine}>
            {metaLine}
          </p>
        </header>

        <div className="ov-body">
          {playback.state === 'countdown' ? (
            <div className="ov-countdown">
              <strong className="num">{playback.countdown ?? 0}</strong>
              <span>秒后开始</span>
            </div>
          ) : showTime ? (
            <div className="ov-meter">
              <div
                className="ov-progress"
                role="progressbar"
                aria-label="演奏进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <i style={{ width: `${progress}%` }} aria-hidden="true" />
              </div>
              <span className="ov-time num">
                {formatDurationMs(playback.elapsedMs ?? 0)} / {formatDurationMs(totalMs)}
              </span>
            </div>
          ) : null}

          <div className="ov-actions">
            <button
              type="button"
              className={`ov-btn primary${active ? ' stop' : ''}`}
              onClick={() => send(active ? 'stop' : 'toggle-play')}
              title={active ? '停止演奏并释放全部按键' : '开始演奏'}
            >
              <Icon name={active ? 'stop' : 'play'} size={14} />
              {active ? '停止演奏' : '开始演奏'}
            </button>
            <button
              type="button"
              className="ov-btn danger"
              onClick={() => send('panic-stop')}
              title="立即停止并释放所有按键"
            >
              <Icon name="panic" size={13} />
              急停
            </button>
            <div className="ov-tools">
              <button
                type="button"
                className="ov-icon"
                aria-label="显示主窗口"
                title="显示主窗口"
                onClick={() => send('show-main')}
              >
                <Icon name="window" size={15} />
              </button>
              <button
                type="button"
                className="ov-icon"
                aria-label="收起悬浮窗"
                title="收起悬浮窗"
                onClick={() => send('hide-overlay')}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          </div>

          {hotkeys && showHints ? (
            <p className="ov-hints">
              <span>
                <span className="mono">{hotkeys.togglePlay}</span> 开始/停止
              </span>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span>
                <span className="mono">{hotkeys.panicStop}</span> 急停
              </span>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span>
                <span className="mono">{hotkeys.toggleOverlay}</span> 显隐
              </span>
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
