import { Icon } from './Icon';
import { PLAYBACK_LABEL } from './page-meta';
import { useAppStore } from '@renderer/state/app-store';
import { describeInputReadiness } from '@shared/settings';

/**
 * 顶栏：只承载「全局上下文」——当前曲谱、输入通道状态、悬浮窗与设置入口。
 * 页面标题由各页 PageHeader 承担，状态详情由设置页承担，这里不重复。
 */
export function TopBar(): JSX.Element {
  const app = useAppStore();
  const score = app.currentScore;
  const readiness = app.inputCheck ? describeInputReadiness(app.inputCheck) : null;
  const level = readiness?.level ?? 'warn';
  const playing = app.playbackStatus.state;

  const statusText = !app.inputCheck
    ? '检查输入通道…'
    : level === 'ok'
      ? '输入就绪'
      : level === 'error'
        ? '通道异常'
        : app.appInfo && !app.appInfo.capabilities.gameInjection
          ? '仅排练模式'
          : app.appInfo && !app.appInfo.elevated
            ? '需要管理员'
            : '有待确认';

  return (
    <header className="topbar">
      <div className="topbar-score-line">
        <strong title={score?.meta.title ?? '未选择曲谱'}>{score?.meta.title ?? '未选择曲谱'}</strong>
        {app.dirty ? <span className="badge badge--warn">未保存</span> : null}
        {playing !== 'idle' ? (
          <span className={`playback-chip playback-${playing}`}>
            {PLAYBACK_LABEL[playing]}
            {playing === 'countdown' && app.playbackStatus.countdown !== undefined
              ? ` ${app.playbackStatus.countdown}`
              : ''}
          </span>
        ) : null}
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className={`status-pill ${level}`}
          title={readiness?.message ?? '正在检查输入通道…'}
          onClick={() => app.navigate('settings')}
        >
          <span className={`status-dot ${level}`} />
          {statusText}
        </button>
        {app.appInfo && app.appInfo.capabilities.gameInjection && !app.appInfo.elevated ? (
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void window.api.app
                .relaunchElevated()
                .then((result) => app.showToast(result.ok ? 'info' : 'warning', result.message))
            }
          >
            <Icon name="shield" size={13} /> 以管理员重启
          </button>
        ) : null}
        <button
          type="button"
          className={`btn btn--quiet btn--sm ${app.overlayVisible ? 'is-active' : ''}`}
          aria-pressed={app.overlayVisible}
          aria-label={app.overlayVisible ? '收起悬浮窗' : '显示悬浮窗'}
          onClick={() => void app.setOverlayVisible(!app.overlayVisible)}
          title="在游戏画面上显示悬浮控制窗（游戏需使用“无边框窗口”模式；独占全屏时不可见，但全局热键仍可用）"
        >
          <Icon name="overlay" size={15} />
          <span className="topbar-overlay-label">{app.overlayVisible ? '收起悬浮窗' : '悬浮窗'}</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="设置与校准"
          title="设置与校准"
          onClick={() => app.navigate('settings')}
        >
          <Icon name="settings" size={16} />
        </button>
      </div>
    </header>
  );
}
