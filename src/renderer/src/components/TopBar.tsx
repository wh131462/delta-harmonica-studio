import { Icon } from './Icon';
import { PAGE_TITLES } from './page-meta';
import { useAppStore } from '@renderer/state/app-store';
import { describeInputReadiness } from '@shared/settings';

/** 顶部状态栏：页面标题 + 输入通道状态 + 快捷键提示 + 悬浮窗/设置入口 */
export function TopBar(): JSX.Element {
  const app = useAppStore();
  const meta = PAGE_TITLES[app.page];
  const readiness = app.inputCheck ? describeInputReadiness(app.inputCheck) : null;
  const level = readiness?.level ?? 'warn';
  const hotkeys = app.settings.hotkeys;
  const score = app.currentScore;

  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="topbar-kicker">口琴工坊 · {meta.title}</span>
        <strong className="topbar-score">{score?.meta.title ?? '未选择曲谱'}</strong>
        <span className="topbar-sub">
          {score
            ? `${score.meta.tempo} BPM · 1=${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][score.meta.keyRoot]} · ${score.notes.filter((note) => note.degree !== 0).length} 个音`
            : '从方案库选曲，或导入 MIDI / 音频 / 简谱'}
        </span>
      </div>
      <div className="topbar-actions">
        <div className={`topbar-status ${level}`} title={readiness?.message ?? ''}>
          <span className={`status-dot ${level}`} />
          <span className="topbar-status-text">{readiness?.message ?? '正在检查输入通道…'}</span>
          {app.appInfo && !app.appInfo.elevated ? (
            <button
              type="button"
              className="link-button"
              onClick={() => void window.api.app.relaunchElevated().then((result) => app.showToast(result.ok ? 'info' : 'warning', result.message))}
            >
              以管理员重启
            </button>
          ) : null}
        </div>
        <div className="topbar-hotkeys" title="全局快捷键（可在设置中修改）">
          <span>
            <kbd>{hotkeys.togglePlay}</kbd> 开始/停止
          </span>
          <span>
            <kbd>{hotkeys.panicStop}</kbd> 急停
          </span>
          <span>
            <kbd>{hotkeys.toggleOverlay}</kbd> 悬浮窗
          </span>
        </div>
        <button
          type="button"
          className={`button small ${app.overlayVisible ? 'primary' : 'ghost'}`}
          onClick={() => void app.setOverlayVisible(!app.overlayVisible)}
          title="在游戏画面上显示常驻悬浮控制窗（游戏需使用“无边框窗口”模式；独占全屏时悬浮窗不可见，但全局热键仍可用）"
        >
          <Icon name="overlay" size={15} /> {app.overlayVisible ? '隐藏悬浮窗' : '悬浮窗'}
        </button>
        <button type="button" className="icon-button bordered" title="设置与校准" onClick={() => app.navigate('settings')}>
          <Icon name="settings" size={16} />
        </button>
      </div>
    </header>
  );
}
