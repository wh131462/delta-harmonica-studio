import { useEffect } from 'react';
import { useAppStore } from './state/app-store';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { TransportBar } from './components/TransportBar';
import { Toast } from './components/Modal';
import { DisclaimerModal } from './components/DisclaimerModal';
import { SelfTestModal } from './components/SelfTestModal';
import { PlayPage } from './pages/PlayPage';
import { PracticePage } from './pages/PracticePage';
import { EditorPage } from './pages/EditorPage';
import { ImportPage } from './pages/ImportPage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App(): JSX.Element {
  const app = useAppStore();

  // 自动化验证模式：自动打开输入自检弹窗（DFH_AUTOTEST=1）
  useEffect(() => {
    if (!app.ready || !app.appInfo?.autotest) return undefined;
    const timer = setTimeout(() => app.setSelfTestOpen(true), 700);
    return () => clearTimeout(timer);
  }, [app.ready, app.appInfo?.autotest, app.setSelfTestOpen]);

  if (!app.ready) {
    return (
      <div className="splash">
        <div className="splash-inner">
          <div className="splash-mark" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 48 48" fill="none">
              <rect x="6" y="16" width="36" height="16" rx="4" stroke="currentColor" strokeWidth="2.4" />
              <path d="M13 19.5v9M19.5 19.5v9M26 19.5v9M32.5 19.5v9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </div>
          <h1>口琴工坊</h1>
          <p>
            正在载入曲库与输入通道
            <span className="splash-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <Sidebar />
      <div className="main">
        <TopBar />
        <div className="page-scroll" id="main-content" role="main">
          {app.page === 'play' ? <PlayPage /> : null}
          {app.page === 'practice' ? <PracticePage /> : null}
          {app.page === 'editor' ? <EditorPage /> : null}
          {app.page === 'import' ? <ImportPage /> : null}
          {app.page === 'library' ? <LibraryPage /> : null}
          {app.page === 'settings' ? <SettingsPage /> : null}
        </div>
        <TransportBar />
      </div>
      <DisclaimerModal />
      <SelfTestModal />
      {app.toast ? <Toast kind={app.toast.kind} text={app.toast.text} /> : null}
    </div>
  );
}
