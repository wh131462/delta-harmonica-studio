import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AppInfo,
  AppSettings,
  GlobalCommand,
  InputCheck,
  LibraryEntry,
  PlaybackStatus,
  WindowInfo,
} from '@shared/types';
import type { Score } from '@core/model/score';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings';

export type PageId = 'play' | 'practice' | 'editor' | 'import' | 'library' | 'settings';

export interface ToastMessage {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warning';
  text: string;
}

export interface AppStore {
  ready: boolean;
  appInfo: AppInfo | null;
  settings: AppSettings;
  entries: LibraryEntry[];
  currentScore: Score | null;
  dirty: boolean;
  page: PageId;
  playbackStatus: PlaybackStatus;
  inputCheck: InputCheck | null;
  windows: WindowInfo[];
  overlayVisible: boolean;
  selfTestOpen: boolean;
  lastGlobalCommand: { command: GlobalCommand; nonce: number } | null;
  toast: ToastMessage | null;
  navigate(page: PageId): void;
  refreshLibrary(): Promise<void>;
  openScore(id: string, page?: PageId): Promise<void>;
  setCurrentScore(score: Score | null, dirty?: boolean): void;
  /** 传入 score 时保存该快照（编辑器用），否则保存 store 里的当前曲谱 */
  saveCurrentScore(score?: Score): Promise<Score | null>;
  deleteScore(id: string): Promise<void>;
  toggleFavorite(id: string): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  refreshInputCheck(): Promise<void>;
  refreshWindows(): Promise<void>;
  showToast(kind: ToastMessage['kind'], text: string): void;
  setSelfTestOpen(open: boolean): void;
  setOverlayVisible(visible: boolean): Promise<void>;
}

const AppStoreContext = createContext<AppStore | null>(null);

const PAGES: PageId[] = ['play', 'practice', 'editor', 'import', 'library', 'settings'];

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(structuredClone(DEFAULT_SETTINGS));
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [currentScore, setCurrentScoreState] = useState<Score | null>(null);
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState<PageId>('play');
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>({ state: 'idle' });
  const [inputCheck, setInputCheck] = useState<InputCheck | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [overlayVisible, setOverlayVisibleState] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [selfTestOpen, setSelfTestOpen] = useState(false);
  const [lastGlobalCommand, setLastGlobalCommand] = useState<{ command: GlobalCommand; nonce: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef(0);

  const showToast = useCallback((kind: ToastMessage['kind'], text: string) => {
    toastId.current += 1;
    setToast({ id: toastId.current, kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshLibrary = useCallback(async () => {
    try {
      const list = await window.api.library.list();
      setEntries(list);
    } catch (error) {
      showToast('error', `读取曲库失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [showToast]);

  const refreshInputCheck = useCallback(async () => {
    try {
      setInputCheck(await window.api.input.check());
    } catch {
      setInputCheck(null);
    }
  }, []);

  const refreshWindows = useCallback(async () => {
    try {
      setWindows(await window.api.windows.list());
    } catch {
      setWindows([]);
    }
  }, []);

  const navigate = useCallback((next: PageId) => {
    setPage(next);
  }, []);

  const setCurrentScore = useCallback((score: Score | null, nextDirty = false) => {
    setCurrentScoreState(score);
    setDirty(nextDirty);
  }, []);

  const openScore = useCallback(
    async (id: string, nextPage: PageId = 'play') => {
      try {
        const score = await window.api.library.load(id);
        setCurrentScoreState(score);
        setDirty(false);
        if (nextPage) setPage(nextPage);
      } catch (error) {
        showToast('error', `打开曲谱失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [showToast],
  );

  const saveCurrentScore = useCallback(async (score?: Score): Promise<Score | null> => {
    const target = score ?? currentScore;
    if (!target) return null;
    try {
      await window.api.library.save(target);
      setCurrentScoreState(target);
      await refreshLibrary();
      setDirty(false);
      showToast('success', `已保存《${target.meta.title}》`);
      return target;
    } catch (error) {
      showToast('error', `保存失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, [currentScore, refreshLibrary, showToast]);

  const deleteScore = useCallback(
    async (id: string) => {
      try {
        await window.api.library.remove(id);
        await refreshLibrary();
        if (currentScore?.id === id) {
          setCurrentScoreState(null);
          setDirty(false);
        }
        showToast('success', '已删除该音乐方案');
      } catch (error) {
        showToast('error', `删除失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [currentScore?.id, refreshLibrary, showToast],
  );

  const toggleFavorite = useCallback(
    async (id: string) => {
      try {
        await window.api.library.toggleFavorite(id);
        await refreshLibrary();
      } catch (error) {
        showToast('error', `收藏失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refreshLibrary, showToast],
  );

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSettings((previous) => mergeSettings(previous, patch));
      try {
        const next = await window.api.settings.update(patch);
        setSettings(next);
        void refreshInputCheck();
      } catch (error) {
        showToast('error', `保存设置失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refreshInputCheck, showToast],
  );

  const setOverlayVisible = useCallback(
    async (visible: boolean) => {
      try {
        const actual = await window.api.overlay.setVisible(visible);
        setOverlayVisibleState(actual);
        setSettings((previous) => ({ ...previous, overlay: { ...previous.overlay, visible: actual } }));
      } catch (error) {
        showToast('error', `悬浮窗操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [showToast],
  );

  // 初始化：应用信息 / 设置 / 曲库 / 输入状态
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [info, loadedSettings, list] = await Promise.all([
          window.api.app.getInfo(),
          window.api.settings.get(),
          window.api.library.list(),
        ]);
        if (cancelled) return;
        setAppInfo(info);
        setSettings(loadedSettings);
        setEntries(list);
        setOverlayVisibleState(loadedSettings.overlay.visible);
        // 启动时自动载入最近编辑的曲谱，演奏台/编辑器可直接看到内容
        if (list.length > 0) {
          try {
            const latest = await window.api.library.load(list[0].id);
            if (!cancelled) setCurrentScoreState(latest);
          } catch {
            /* 忽略：曲谱文件损坏时保持空状态 */
          }
        }
        const initialPage = PAGES.includes(info.startPage as PageId) ? (info.startPage as PageId) : 'play';
        setPage(initialPage);
        setReady(true);
        void refreshInputCheck();
        void refreshWindows();
      } catch (error) {
        showToast('error', `初始化失败：${error instanceof Error ? error.message : String(error)}`);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshInputCheck, refreshWindows, showToast]);

  // 播放状态订阅
  useEffect(() => {
    const unsubscribe = window.api.playback.onStatus((status) => {
      setPlaybackStatus(status);
      if (status.state === 'finished' || status.state === 'stopped' || status.state === 'focus-lost' || status.state === 'error') {
        void refreshInputCheck();
      }
    });
    return unsubscribe;
  }, [refreshInputCheck]);

  // 全局热键命令
  useEffect(() => {
    const unsubscribe = window.api.input.onGlobalCommand((command) => {
      setLastGlobalCommand({ command, nonce: Date.now() });
    });
    return unsubscribe;
  }, []);

  // 启动时自动选中疑似游戏窗口（仅当用户尚未选择目标窗口）
  useEffect(() => {
    if (!ready || windows.length === 0) return;
    if (settings.input.targetWindowHandle) return;
    const candidate = windows.find((item) => item.looksLikeGame);
    if (!candidate) return;
    void updateSettings({
      input: {
        ...settings.input,
        targetWindowHandle: candidate.handle,
        targetWindowTitle: candidate.title,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, windows, settings.input.targetWindowHandle]);

  // 悬浮窗显隐状态同步
  useEffect(() => {
    const unsubscribe = window.api.overlay.onVisibility((visible) => {
      setOverlayVisibleState(visible);
      setSettings((previous) => ({ ...previous, overlay: { ...previous.overlay, visible } }));
    });
    return unsubscribe;
  }, []);

  // 把当前曲谱 / 播放状态 / 快捷键持久同步给悬浮窗
  useEffect(() => {
    void window.api.overlay.syncState({
      title: currentScore?.meta.title ?? '未选择曲谱',
      playback: playbackStatus,
      hotkeys: settings.hotkeys,
      backend: settings.input.backend,
      targetWindowTitle: settings.input.targetWindowTitle,
      overlayVisible,
      showHotkeyHint: settings.overlay.showHotkeyHint,
    });
  }, [
    currentScore?.meta.title,
    playbackStatus,
    settings.hotkeys,
    settings.input.backend,
    settings.input.targetWindowTitle,
    overlayVisible,
    settings.overlay.showHotkeyHint,
  ]);

  const value = useMemo<AppStore>(
    () => ({
      ready,
      appInfo,
      settings,
      entries,
      currentScore,
      dirty,
      page,
      playbackStatus,
      inputCheck,
      windows,
      overlayVisible,
      selfTestOpen,
      lastGlobalCommand,
      toast,
      navigate,
      refreshLibrary,
      openScore,
      setCurrentScore,
      saveCurrentScore,
      deleteScore,
      toggleFavorite,
      updateSettings,
      refreshInputCheck,
      refreshWindows,
      showToast,
      setSelfTestOpen,
      setOverlayVisible,
    }),
    [
      ready,
      appInfo,
      settings,
      entries,
      currentScore,
      dirty,
      page,
      playbackStatus,
      inputCheck,
      windows,
      overlayVisible,
      selfTestOpen,
      lastGlobalCommand,
      toast,
      navigate,
      refreshLibrary,
      openScore,
      setCurrentScore,
      saveCurrentScore,
      deleteScore,
      toggleFavorite,
      updateSettings,
      refreshInputCheck,
      refreshWindows,
      showToast,
      setOverlayVisible,
    ],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error('useAppStore 必须在 AppProvider 内使用');
  return store;
}
