/**
 * Electron IPC 注册：渲染进程所有能力都通过这里暴露（contextIsolation 下不直接碰 Node）。
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serializeScore } from '@core/score/dsl';
import { generateKeySheet } from '@core/export/keysheet';
import type { Score } from '@core/model/score';
import type {
  AppInfo,
  ExportFormat,
  InputCheck,
  PlaybackRequest,
  PickedFile,
  SaveFileRequest,
} from '@shared/types';
import { getWin32Bridge } from './native/win32';
import { debugLog } from './debug';
import type { PlaybackController } from './playback-controller';
import type { AppStorage } from './storage';

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PICKED_FILES = 10;

export interface IpcContext {
  storage: AppStorage;
  playback: PlaybackController;
  getMainWindow: () => BrowserWindow | null;
  userDataDir: string;
  startPage: string;
  version: string;
}

function safeFileName(title: string): string {
  const base = (title || '未命名').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60);
  return base || '未命名';
}

async function readPickedFile(filePath: string): Promise<PickedFile> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（>${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB）：${path.basename(filePath)}`);
  }
  const buffer = await fs.readFile(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    data: new Uint8Array(buffer),
  };
}

function focusAppWindow(win: BrowserWindow | null): void {
  if (!win) return;
  const bridge = getWin32Bridge();
  try {
    if (win.isMinimized()) win.restore();
    // FindWindowW 能拿到本窗口的原生句柄（自己的窗口不会出现在“目标游戏窗口”列表里）
    const handle = bridge.findWindowByTitle(win.getTitle());
    if (handle) bridge.focusWindow(handle);
  } catch {
    // 焦点切换失败时退化为 Electron 自己的 focus
  }
  win.show();
  win.focus();
  win.webContents.focus();
}

async function relaunchElevated(): Promise<{ ok: boolean; message: string }> {
  const bridge = getWin32Bridge();
  if (bridge.elevated) return { ok: true, message: '当前已经是管理员权限' };
  if (!app.isPackaged) {
    return { ok: false, message: '开发模式请以管理员身份重新启动终端后再运行；打包后的版本会通过 UAC 自动提权。' };
  }
  try {
    const { spawn } = await import('node:child_process');
    const exePath = process.execPath.replace(/'/g, "''");
    const command = `Start-Process -FilePath '${exePath}' -Verb RunAs`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    setTimeout(() => app.quit(), 500);
    return { ok: true, message: '正在请求管理员权限，请在系统 UAC 弹窗中点击“是”' };
  } catch (error) {
    return { ok: false, message: `提权失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function buildInputCheck(context: IpcContext): InputCheck {
  const bridge = getWin32Bridge();
  const settings = context.storage.getSettings();
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!bridge.available) warnings.push(`原生按键桥加载失败：${bridge.error ?? '未知错误'}`);
  if (!bridge.elevated) {
    warnings.push('当前不是管理员权限：游戏以管理员权限运行时，Windows 会静默拦截本程序的按键（UIPI）。请点击「以管理员身份重启」后在 UAC 中确认。');
  } else {
    notes.push('已以管理员权限运行（满足向游戏注入按键的权限要求）');
  }
  if (settings.input.backend === 'dry-run') {
    notes.push('当前为「排练模式」：会走完整时间轴但不向游戏发送按键');
  }
  if (settings.input.backend === 'serial') {
    warnings.push('串口 / Arduino 硬件输出尚未启用，请改用模拟按键或排练模式');
  }
  if (settings.input.backend === 'software' && !settings.input.targetWindowHandle) {
    warnings.push('尚未选择目标游戏窗口：开始演奏前请在顶部选择「三角洲行动」窗口');
  } else if (settings.input.targetWindowHandle) {
    notes.push(`目标窗口：${settings.input.targetWindowTitle ?? '已选择'}`);
  }
  notes.push('快捷键：F9 开始/停止演奏 ｜ F12 紧急停止并释放所有按下的键');
  notes.push(settings.input.focusGuard ? '焦点保护已开启：游戏窗口失去焦点时会自动停手' : '焦点保护已关闭：请自行确保游戏窗口在前台');
  return {
    elevated: bridge.elevated,
    backend: settings.input.backend,
    helperAvailable: bridge.available,
    helperPath: null,
    warnings,
    notes,
  };
}

export function registerIpcHandlers(context: IpcContext): void {
  const { storage, playback } = context;

  ipcMain.handle('app:getInfo', (): AppInfo => ({
    version: context.version,
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node ?? '',
    platform: process.platform,
    elevated: getWin32Bridge().elevated,
    userDataPath: context.userDataDir,
    isPackaged: app.isPackaged,
    startPage: context.startPage,
    autotest: process.env.DFH_AUTOTEST === '1',
    gameAutoplay: process.env.DFH_GAME_AUTOPLAY === '1',
  }));

  ipcMain.handle('app:relaunchElevated', () => relaunchElevated());
  ipcMain.handle('app:openUserData', () => shell.openPath(context.userDataDir));
  ipcMain.handle('shell:openExternal', (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });

  ipcMain.handle('settings:get', () => storage.getSettings());
  ipcMain.handle('settings:update', (_event, patch) => storage.updateSettings(patch ?? {}));

  ipcMain.handle('library:list', () => storage.list());
  ipcMain.handle('library:load', (_event, id: string) => {
    const score = storage.get(id);
    if (!score) throw new Error(`曲谱不存在：${id}`);
    return score;
  });
  ipcMain.handle('library:save', (_event, score: Score) => storage.save(score));
  ipcMain.handle('library:remove', async (_event, id: string) => {
    await storage.remove(id);
  });
  ipcMain.handle('library:toggleFavorite', (_event, id: string) => storage.toggleFavorite(id));

  ipcMain.handle('library:importScoreFile', async (): Promise<PickedFile[]> => {
    const result = await dialog.showOpenDialog({
      title: '导入曲谱文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '曲谱文件', extensions: ['json', 'dfh', 'txt', 'mid', 'midi', 'jianpu'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    const files: PickedFile[] = [];
    for (const filePath of result.filePaths.slice(0, MAX_PICKED_FILES)) {
      files.push(await readPickedFile(filePath));
    }
    return files;
  });

  ipcMain.handle('files:pick', async (_event, filters: Array<{ name: string; extensions: string[] }>): Promise<PickedFile[]> => {
    const safeFilters = Array.isArray(filters) && filters.length > 0
      ? filters.map((filter) => ({ name: filter.name || '文件', extensions: filter.extensions }))
      : [{ name: '全部文件', extensions: ['*'] }];
    const result = await dialog.showOpenDialog({
      title: '选择文件',
      properties: ['openFile', 'multiSelections'],
      filters: safeFilters,
    });
    if (result.canceled) return [];
    const files: PickedFile[] = [];
    for (const filePath of result.filePaths.slice(0, MAX_PICKED_FILES)) {
      files.push(await readPickedFile(filePath));
    }
    return files;
  });

  ipcMain.handle('files:save', async (_event, request: SaveFileRequest): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      title: '导出文件',
      defaultPath: request.suggestedName,
      filters: request.filters,
    });
    if (result.canceled || !result.filePath) return null;
    if (typeof request.data === 'string') {
      await fs.writeFile(result.filePath, request.data, 'utf8');
    } else {
      await fs.writeFile(result.filePath, Buffer.from(request.data));
    }
    return result.filePath;
  });

  ipcMain.handle('library:export', async (_event, score: Score, format: ExportFormat): Promise<string | null> => {
    const baseName = safeFileName(score?.meta?.title ?? '未命名');
    let content: string;
    let extension: string;
    let filterName: string;
    switch (format) {
      case 'json':
        content = JSON.stringify(score, null, 2);
        extension = 'dfh.json';
        filterName = '口琴演奏方案（JSON）';
        break;
      case 'keys':
        content = generateKeySheet(score).text;
        extension = 'keys.txt';
        filterName = '键位谱（文本）';
        break;
      case 'dsl':
      case 'txt':
        content = serializeScore(score);
        extension = 'jianpu.txt';
        filterName = '简谱文本';
        break;
      default:
        content = serializeScore(score);
        extension = 'jianpu.txt';
        filterName = '简谱文本';
    }
    const result = await dialog.showSaveDialog({
      title: '导出曲谱',
      defaultPath: `${baseName}.${extension}`,
      filters: [{ name: filterName, extensions: [extension.split('.').pop() ?? 'txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, content, 'utf8');
    return result.filePath;
  });

  ipcMain.handle('playback:start', (_event, request: PlaybackRequest) => {
    debugLog(
      `playback:start events=${request.events?.length ?? 0} backend=${request.backend} target=${String(request.targetWindowHandle)} focusGuard=${String(request.focusGuard)} countdown=${String(request.countdownSeconds)}`,
    );
    return playback.start(request).then((result) => {
      debugLog(`playback:start result=${JSON.stringify(result)}`);
      return result;
    });
  });
  ipcMain.handle('playback:stop', async () => {
    await playback.stop();
  });
  ipcMain.handle('playback:panicRelease', async () => {
    await playback.panicRelease();
  });
  ipcMain.handle('playback:selfTest', async () => {
    const win = context.getMainWindow();
    focusAppWindow(win);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bridge = getWin32Bridge();
    const handle = win ? bridge.findWindowByTitle(win.getTitle()) : null;
    const foreground = bridge.foregroundWindow();
    const focused = win?.isFocused() ?? false;
    if (!focused || (handle !== null && foreground !== handle)) {
      return {
        ok: false,
        message: '无法把本程序窗口切到前台（可能被其他置顶窗口占用），已取消自检，避免按键被发送到其他程序',
      };
    }
    // 鼠标事件会投递到光标下的窗口：先把光标移到本窗口中心，结束后恢复
    const previousCursor = bridge.cursorPosition();
    if (handle) {
      if (!bridge.ensureCursorInsideWindow(handle)) {
        return {
          ok: false,
          message: '无法把鼠标光标移入本程序窗口，已取消自检，避免点击到其他程序',
        };
      }
    }
    try {
      return await playback.selfTest();
    } finally {
      if (previousCursor) bridge.moveCursor(previousCursor.x, previousCursor.y);
    }
  });

  ipcMain.handle('windows:list', () => getWin32Bridge().listWindows());
  ipcMain.handle('windows:focus', (_event, handle: number) => getWin32Bridge().focusWindow(handle));
  ipcMain.handle('input:check', () => buildInputCheck(context));
}
