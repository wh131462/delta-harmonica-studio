/**
 * Electron 主进程入口：窗口、悬浮控制窗、全局快捷键、托盘、存储、演奏排程与截图模式。
 */
import { BrowserWindow, Menu, app } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PlaybackController } from './playback-controller';
import { AppStorage } from './storage';
import { registerIpcHandlers } from './ipc';
import { getWin32Bridge } from './native/win32';
import { debugLog, installCrashLogging } from './debug';
import { AppTray } from './tray';
import { HotkeyManager } from './hotkeys';
import { OverlayWindowManager } from './overlay-window';
import type { AppSettings, HotkeyRegistrationStatus } from '@shared/types';

installCrashLogging();
debugLog(`main module loaded: argv=${JSON.stringify(process.argv)} packaged=${app.isPackaged} screenshot=${process.env.DFH_SCREENSHOT_PATH ?? ''}`);

const startPage = process.env.DFH_START_PAGE ?? 'play';
const screenshotPath = process.env.DFH_SCREENSHOT_PATH ?? '';
const screenshotDelay = Number(process.env.DFH_SCREENSHOT_DELAY ?? 2600);

let mainWindow: BrowserWindow | null = null;
let storage: AppStorage | null = null;
let playback: PlaybackController | null = null;
let overlay: OverlayWindowManager | null = null;
let tray: AppTray | null = null;
let trayReady = false;
let isQuitting = false;
const hotkeys = new HotkeyManager();

app.setName('三角洲口琴工坊');

function resolveIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [join(app.getAppPath(), 'build', 'icon.png')];
  return candidates.find((candidate) => existsSync(candidate));
}

function broadcastAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function loadRenderer(win: BrowserWindow, overlayMode: boolean): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const suffix = overlayMode ? 'overlay=1' : '';
  if (devUrl) {
    const separator = devUrl.includes('?') ? '&' : '?';
    void win.loadURL(`${devUrl}${suffix ? separator + suffix : ''}`);
  } else {
    const file = join(__dirname, '../renderer/index.html');
    if (overlayMode) void win.loadFile(file, { query: { overlay: '1' } });
    else void win.loadFile(file);
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#080c13',
    title: '三角洲口琴工坊',
    autoHideMenuBar: true,
    ...(resolveIconPath() ? { icon: resolveIconPath() } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('close', (event) => {
    // 有托盘时关闭主窗口 = 隐藏到后台，演奏/悬浮窗不中断
    if (!isQuitting && trayReady) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  loadRenderer(win, false);

  if (screenshotPath) {
    win.webContents.on('render-process-gone', (_event, details) => {
      debugLog(`render-process-gone: ${JSON.stringify(details)}`);
      console.error('[renderer-gone]', details);
    });
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      debugLog(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    });
    win.webContents.once('did-finish-load', () => {
      debugLog('did-finish-load');
      setTimeout(async () => {
        debugLog('capturing screenshot...');
        try {
          const clickSelector = process.env.DFH_CLICK_SELECTOR;
          if (clickSelector) {
            const clicked = await win.webContents.executeJavaScript(
              `(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (el) { el.click(); return true; } return false; })()`,
            );
            debugLog(`screenshot click selector=${clickSelector} clicked=${String(clicked)}`);
            await new Promise((resolve) => setTimeout(resolve, 450));
          }
          const evalJs = process.env.DFH_EVAL_JS;
          if (evalJs) {
            const result = await win.webContents.executeJavaScript(evalJs);
            debugLog(`screenshot eval js result=${String(result)}`);
            await new Promise((resolve) => setTimeout(resolve, 450));
          }
          const image = await win.webContents.capturePage();
          await fs.writeFile(screenshotPath, image.toPNG());
          debugLog(`screenshot saved: ${screenshotPath}`);
          console.log(`[screenshot] saved to ${screenshotPath}`);
        } catch (error) {
          debugLog(`screenshot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          console.error('[screenshot] failed', error);
        } finally {
          app.exit(0);
        }
      }, Math.max(500, screenshotDelay));
    });
  }

  return win;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setOverlayVisible(visible: boolean): boolean {
  if (!overlay || !storage) return false;
  const settings = storage.getSettings();
  const actual = overlay.setVisible(visible, { ...settings.overlay, visible });
  void storage.updateSettings({ overlay: { ...settings.overlay, visible: actual } });
  return actual;
}

function refreshHotkeys(): HotkeyRegistrationStatus[] {
  if (!storage) return [];
  const statuses = hotkeys.apply(storage.getSettings().hotkeys, {
    togglePlay: () => mainWindow?.webContents.send('input:global-command', 'toggle-play'),
    panicStop: () => {
      void playback?.stop('紧急停止（全局快捷键）：已释放所有按键');
    },
    toggleOverlay: () => {
      setOverlayVisible(!(overlay?.isVisible() ?? false));
    },
    showMain: () => showMainWindow(),
  });
  debugLog(`hotkeys applied: ${JSON.stringify(statuses)}`);
  return statuses;
}

function handleSettingsUpdated(settings: AppSettings): void {
  refreshHotkeys();
  if (!overlay) return;
  overlay.applySettings(settings.overlay);
  const visible = overlay.isVisible();
  if (settings.overlay.visible && !visible) setOverlayVisible(true);
  if (!settings.overlay.visible && visible && !overlay.getWindow()) setOverlayVisible(false);
}

function initTray(): void {
  const iconPath = resolveIconPath();
  if (!iconPath) {
    debugLog('tray: icon not found, tray disabled');
    return;
  }
  tray = new AppTray(iconPath, {
    showMain: () => showMainWindow(),
    toggleOverlay: () => setOverlayVisible(!(overlay?.isVisible() ?? false)),
    togglePlay: () => mainWindow?.webContents.send('input:global-command', 'toggle-play'),
    quit: () => app.quit(),
  });
  trayReady = tray.init();
  debugLog(`tray ready=${trayReady}`);
  tray.refresh(overlay?.isVisible() ?? false);
}

async function bootstrap(): Promise<void> {
  debugLog('bootstrap start');
  if (!app.requestSingleInstanceLock()) {
    debugLog('single instance lock failed -> quit');
    app.quit();
    return;
  }
  app.on('second-instance', () => showMainWindow());

  await app.whenReady();
  debugLog('app ready');

  storage = new AppStorage(app.getPath('userData'));
  debugLog(`userData=${app.getPath('userData')}`);
  await storage.init();
  debugLog('storage initialized');

  playback = new PlaybackController((status) => {
    debugLog(`playback status: ${JSON.stringify(status)}`);
    broadcastAll('playback:status', status);
  });

  overlay = new OverlayWindowManager({
    preloadPath: join(__dirname, '../preload/index.js'),
    iconPath: resolveIconPath(),
    load: (win) => loadRenderer(win, true),
    savePosition: (position) => {
      if (!storage) return;
      void storage.updateSettings({ overlay: { ...storage.getSettings().overlay, position } });
    },
  });
  overlay.onVisibilityChange((visible) => {
    debugLog(`overlay visibility -> ${visible}`);
    mainWindow?.webContents.send('overlay:visibility', visible);
    tray?.refresh(visible);
  });

  registerIpcHandlers({
    storage,
    playback,
    getMainWindow: () => mainWindow,
    userDataDir: app.getPath('userData'),
    startPage,
    version: app.getVersion(),
    overlay,
    setOverlayVisible,
    showMainWindow,
    getHotkeyStatuses: () => hotkeys.getStatuses(),
    setHotkeyRecording: (recording) => {
      if (recording) hotkeys.dispose();
      else refreshHotkeys();
    },
    onSettingsUpdated: handleSettingsUpdated,
  });
  debugLog('ipc registered');

  mainWindow = createWindow();
  debugLog('window created');
  initTray();
  overlay.syncState({
    title: '未选择曲谱',
    playback: { state: 'idle' },
    hotkeys: storage.getSettings().hotkeys,
    backend: storage.getSettings().input.backend,
    overlayVisible: false,
  });
  refreshHotkeys();

  if (storage.getSettings().overlay.visible) {
    setOverlayVisible(true);
  }

  // 悬浮窗渲染自检（用于自动化验收：把悬浮窗自身截图保存，不依赖屏幕截图）
  const overlayScreenshotPath = process.env.DFH_OVERLAY_SCREENSHOT;
  if (overlayScreenshotPath) {
    setTimeout(async () => {
      const win = overlay?.getWindow();
      if (!win) {
        debugLog('overlay screenshot: window missing');
        return;
      }
      try {
        const image = await win.webContents.capturePage();
        await fs.writeFile(overlayScreenshotPath, image.toPNG());
        debugLog(`overlay screenshot saved: ${overlayScreenshotPath} visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`);
      } catch (error) {
        debugLog(`overlay screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 2600);
  }

  // 悬浮窗交互自检：自动点击「开始」按钮，验证渲染层 → IPC → 主进程命令链路
  if (process.env.DFH_OVERLAY_AUTOCLICK) {
    setTimeout(async () => {
      const win = overlay?.getWindow();
      if (!win) {
        debugLog('overlay autocklick: window missing');
        return;
      }
      try {
        await win.webContents.executeJavaScript("document.querySelector('.ov-btn.primary')?.click(); 'clicked';");
        debugLog('overlay autocklick: primary button clicked');
      } catch (error) {
        debugLog(`overlay autocklick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 3200);
  }

  app.on('activate', () => showMainWindow());
}

void app.whenReady().then(bootstrap).catch((error) => {
  debugLog(`bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error('[main] bootstrap failed', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  debugLog('window-all-closed -> quit');
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  debugLog('before-quit');
  hotkeys.dispose();
  overlay?.destroy();
  tray?.destroy();
  void playback?.stop('程序退出');
  getWin32Bridge().endPrecision();
});
