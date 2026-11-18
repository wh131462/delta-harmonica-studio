import { Icon } from './Icon';
import { useAppStore, type PageId } from '@renderer/state/app-store';

const NAV_ITEMS: Array<{ id: PageId; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'play', label: '演奏台', icon: 'play' },
  { id: 'editor', label: '简谱编辑器', icon: 'edit' },
  { id: 'import', label: '智能导入', icon: 'import' },
  { id: 'library', label: '音乐方案库', icon: 'library' },
  { id: 'settings', label: '设置与校准', icon: 'settings' },
];

export function Sidebar(): JSX.Element {
  const app = useAppStore();
  const elevated = app.appInfo?.elevated ?? false;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true">
            <defs>
              <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fbbf24" />
                <stop offset="1" stopColor="#f97316" />
              </linearGradient>
            </defs>
            <rect x="3" y="15" width="42" height="18" rx="5" fill="url(#brandGrad)" opacity="0.16" />
            <rect x="3" y="15" width="42" height="18" rx="5" stroke="url(#brandGrad)" strokeWidth="2" fill="none" />
            <path d="M11 17v14M17 17v14M23 17v14M29 17v14M35 17v14M41 17v14" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
            <rect x="7" y="20" width="34" height="5" fill="url(#brandGrad)" opacity="0.55" />
          </svg>
        </div>
        <div>
          <h1>口琴工坊</h1>
          <p>Delta Harmonica Studio</p>
        </div>
      </div>

      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${app.page === item.id ? 'active' : ''}`}
            onClick={() => app.navigate(item.id)}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
            {item.id === 'play' && app.playbackStatus.state === 'playing' ? <span className="nav-live">LIVE</span> : null}
            {item.id === 'editor' && app.dirty ? <span className="nav-dot" title="有未保存修改" /> : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`permission-chip ${elevated ? 'ok' : 'warn'}`}
          onClick={() => app.navigate('settings')}
          title={elevated ? '已以管理员权限运行' : '未以管理员运行，注入游戏可能失败'}
        >
          <Icon name="shield" size={15} />
          <span>{elevated ? '管理员权限' : '权限不足'}</span>
        </button>
        <p className="version">v{app.appInfo?.version ?? '0.1.0'} · 仅供个人娱乐</p>
      </div>
    </aside>
  );
}
