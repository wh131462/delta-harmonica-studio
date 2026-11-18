import { useEffect } from 'react';
import { useAppStore } from './state/app-store';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { TransportBar } from './components/TransportBar';
import { Toast } from './components/Modal';
import { DisclaimerModal } from './components/DisclaimerModal';
import { SelfTestModal } from './components/SelfTestModal';
import { PlayPage } from './pages/PlayPage';
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
        <div className="splash-mark">♪</div>
        <h1>三角洲口琴工坊</h1>
        <p>正在加载曲库与输入通道…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <TopBar />
        <div className="page-scroll">
          {app.page === 'play' ? <PlayPage /> : null}
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
