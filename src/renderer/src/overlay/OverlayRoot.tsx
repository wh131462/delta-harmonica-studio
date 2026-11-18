/**
 * 悬浮控制窗页面：无边框透明小窗，用于游戏内快速开始/停止/急停。
 * 通过 preload 暴露的 window.api 与主进程通信。
 */
import { useEffect, useMemo, useState } from 'react';
import type { OverlaySyncState, PlaybackStatus } from '@shared/types';
import { Icon } from '@renderer/components/Icon';
import './overlay.css';

const BACKEND_LABEL: Record<string, string> = {
  software: '游戏注入',
  'dry-run': '排练模式',
  serial: '串口硬件',
};

function stateText(status: PlaybackStatus): string {
  switch (status.state) {
    case 'countdown':
      return `倒计时 ${status.countdown ?? 0}s`;
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

  return (
    <div className="ov-shell">
      <div className="ov-card">
        <div className="ov-drag">
          <div className="ov-head">
            <span className={`ov-dot ${active ? 'active' : ''} ${playback.state === 'countdown' ? 'countdown' : ''}`} />
            <span className="ov-brand">口琴工坊</span>
            <span className="ov-state">{stateText(playback)}</span>
          </div>
          <div className="ov-title">{state?.title ?? '未选择曲谱'}</div>
          <div className="ov-sub">
            {state?.targetWindowTitle ? `目标：${state.targetWindowTitle}` : '未选择游戏窗口'}
            {state ? ` · ${BACKEND_LABEL[state.backend] ?? state.backend}` : ''}
          </div>
        </div>

        <div className="ov-body">
          {playback.state === 'countdown' ? (
            <div className="ov-countdown">
              <strong>{playback.countdown ?? 0}</strong>
              <span>秒后开始</span>
            </div>
          ) : (
            <div className="ov-progress">
              <i style={{ width: `${progress}%` }} />
            </div>
          )}

          <div className="ov-actions">
            <button
              type="button"
              className={`ov-btn ${active ? 'stop' : 'primary'}`}
              onClick={() => send(active ? 'stop' : 'toggle-play')}
            >
              <Icon name={active ? 'stop' : 'play'} size={15} />
              {active ? '停止' : '开始'}
            </button>
            <button type="button" className="ov-btn danger" onClick={() => send('panic-stop')}>
              急停
            </button>
            <button type="button" className="ov-icon" title="显示主窗口" onClick={() => send('show-main')}>
              <Icon name="window" size={16} />
            </button>
            <button type="button" className="ov-icon" title="收起悬浮窗" onClick={() => send('hide-overlay')}>
              <Icon name="close" size={16} />
            </button>
          </div>

          {state?.hotkeys && state.showHotkeyHint !== false ? (
            <div className="ov-hints">
              <span>{state.hotkeys.togglePlay} 开始/停止</span>
              <span>{state.hotkeys.panicStop} 急停</span>
              <span>{state.hotkeys.toggleOverlay} 显隐</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
