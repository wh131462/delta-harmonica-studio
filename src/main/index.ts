/**
 * Electron 主进程入口：窗口、存储、全局热键、截图模式。
 */
import { BrowserWindow, Menu, app, globalShortcut } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PlaybackController } from './playback-controller';
import { AppStorage } from './storage';
import { registerIpcHandlers } from './ipc';
import { getWin32Bridge } from './native/win32';
import { debugLog, installCrashLogging } from './debug';

installCrashLogging();
debugLog(`main module loaded: argv=${JSON.stringify(process.argv)} packaged=${app.isPackaged} screenshot=${process.env.DFH_SCREENSHOT_PATH ?? ''}`);

const startPage = process.env.DFH_START_PAGE ?? 'play';
const screenshotPath = process.env.DFH_SCREENSHOT_PATH ?? '';
const screenshotDelay = Number(process.env.DFH_SCREENSHOT_DELAY ?? 2600);

let mainWindow: BrowserWindow | null = null;
let storage: AppStorage | null = null;
let playback: PlaybackController | null = null;

app.setName('三角洲口琴工坊');

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0f17',
    title: '三角洲口琴工坊',
    autoHideMenuBar: true,
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
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

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

function registerGlobalShortcuts(): void {
  globalShortcut.register('F9', () => {
    mainWindow?.webContents.send('input:global-command', 'toggle-play');
  });
  globalShortcut.register('F12', () => {
    void playback?.stop('紧急停止（F12）：已释放所有按键');
  });
}

async function bootstrap(): Promise<void> {
  debugLog('bootstrap start');
  if (!app.requestSingleInstanceLock()) {
    debugLog('single instance lock failed -> quit');
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  await app.whenReady();
  debugLog('app ready');

  storage = new AppStorage(app.getPath('userData'));
  debugLog(`userData=${app.getPath('userData')}`);
  await storage.init();
  debugLog('storage initialized');
  playback = new PlaybackController((status) => {
    debugLog(`playback status: ${JSON.stringify(status)}`);
    mainWindow?.webContents.send('playback:status', status);
  });

  registerIpcHandlers({
    storage,
    playback,
    getMainWindow: () => mainWindow,
    userDataDir: app.getPath('userData'),
    startPage,
    version: app.getVersion(),
  });
  debugLog('ipc registered');

  mainWindow = createWindow();
  debugLog('window created');
  registerGlobalShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
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
  debugLog('before-quit');
  globalShortcut.unregisterAll();
  void playback?.stop('程序退出');
  getWin32Bridge().endPrecision();
});
