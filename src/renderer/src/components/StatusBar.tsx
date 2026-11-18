import { describeInputReadiness } from '@shared/settings';
import { useAppStore } from '@renderer/state/app-store';
import { Icon } from './Icon';

const PLAYBACK_LABEL: Record<string, string> = {
  idle: '待命',
  countdown: '倒计时',
  playing: '演奏中',
  finished: '演奏完成',
  stopped: '已停止',
  error: '出错',
  'focus-lost': '焦点丢失已停止',
};

export function StatusBar(): JSX.Element {
  const app = useAppStore();
  const readiness = app.inputCheck ? describeInputReadiness(app.inputCheck) : null;
  const playback = app.playbackStatus;
  const level = readiness?.level ?? 'warn';

  const relaunch = async () => {
    try {
      const result = await window.api.app.relaunchElevated();
      app.showToast(result.ok ? 'info' : 'warning', result.message);
    } catch (error) {
      app.showToast('error', `提权失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className={`status-dot ${level}`} />
        <span className="status-message">{readiness?.message ?? '正在检查输入通道…'}</span>
        {app.appInfo && !app.appInfo.elevated ? (
          <button type="button" className="link-button" onClick={relaunch}>
            <Icon name="shield" size={13} /> 以管理员重启
          </button>
        ) : null}
      </div>
      <div className="statusbar-right">
        {playback.state !== 'idle' ? (
          <span className={`playback-chip playback-${playback.state}`}>
            {PLAYBACK_LABEL[playback.state] ?? playback.state}
            {playback.state === 'countdown' && playback.countdown !== undefined ? ` ${playback.countdown}` : ''}
          </span>
        ) : null}
        <span className="hotkey-hint">F9 开始/停止 · F12 紧急停止</span>
      </div>
    </div>
  );
}
