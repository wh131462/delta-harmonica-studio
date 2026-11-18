import { Icon, type IconName } from './Icon';
import { useAppStore, type PageId } from '@renderer/state/app-store';

interface NavItem {
  id: PageId;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'play', label: '演奏控制', icon: 'play' },
  { id: 'practice', label: '跟谱练习', icon: 'keyboard' },
  { id: 'editor', label: '简谱编辑', icon: 'edit' },
  { id: 'import', label: '智能导入', icon: 'import' },
  { id: 'library', label: '音乐方案', icon: 'library' },
  { id: 'settings', label: '设置校准', icon: 'settings' },
];

/** 侧边导航：品牌 + 6 个一级入口 + 权限状态。窄窗口收成图标轨。 */
export function Sidebar(): JSX.Element {
  const app = useAppStore();
  const elevated = app.appInfo?.elevated ?? false;
  // macOS / Linux 没有 Win32 注入能力：不显示「权限受限」这类误导状态，详细原因在设置页。
  const canInject = app.appInfo?.capabilities.gameInjection ?? false;
  const playing = app.playbackStatus.state === 'playing' || app.playbackStatus.state === 'countdown';

  return (
    <aside className="sidebar" aria-label="侧边导航">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 48 48" fill="none">
            <rect x="5" y="17" width="38" height="14" rx="3.4" stroke="currentColor" strokeWidth="2.6" />
            <path
              d="M12.5 20.5v7M19 20.5v7M25.5 20.5v7M32 20.5v7M38.5 20.5v7"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h1>口琴工坊</h1>
      </div>

      <nav className="nav" aria-label="主页面">
        {NAV_ITEMS.map((item) => {
          const active = app.page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => app.navigate(item.id)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              {item.id === 'play' && playing ? (
                <span className="nav-live" title="正在演奏">
                  LIVE
                </span>
              ) : null}
              {item.id === 'editor' && app.dirty ? <span className="nav-dot" title="有未保存修改" /> : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        {canInject ? (
          <button
            type="button"
            className={`permission-chip ${elevated ? 'ok' : 'warn'}`}
            onClick={() => app.navigate('settings')}
            title={
              elevated
                ? '已以管理员权限运行（满足向游戏注入按键的要求）'
                : '未以管理员运行，注入游戏可能被系统拦截；点此进入设置查看处理方式'
            }
            aria-label={elevated ? '管理员权限已就绪，打开设置' : '权限不足，打开设置查看处理方式'}
          >
            <Icon name={elevated ? 'shield' : 'warning'} size={13} />
            <span>{elevated ? '管理员权限' : '权限受限'}</span>
          </button>
        ) : null}
      </div>
    </aside>
  );
}
