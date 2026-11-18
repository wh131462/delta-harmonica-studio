/**
 * 悬浮控制窗：无边框、透明、置顶、可拖动的小控制面板。
 * - focusable: false + showInactive()：不抢游戏焦点，避免触发演奏的焦点保护
 * - 状态与主窗口通过 IPC 同步；窗口位置持久化
 */
import { BrowserWindow, screen } from 'electron';
import type { OverlaySettings, OverlaySyncState } from '@shared/types';
import { debugLog } from './debug';

export interface OverlayWindowDeps {
  preloadPath: string;
  /** 由主进程决定 dev / 生产环境的加载方式（带 ?overlay=1） */
  load: (window: BrowserWindow) => void;
  /** 拖动后持久化位置 */
  savePosition: (position: { x: number; y: number }) => void;
  iconPath?: string;
}

const WIDTH = 392;
const HEIGHT = 176;
const IS_MAC = process.platform === 'darwin';

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.96;
  return Math.min(1, Math.max(0.3, value));
}

/**
 * 置顶层级：macOS 用 panel + screen-saver 层级才能盖在全屏游戏之上；
 * Windows / Linux 沿用原有 screen-saver 层级。
 */
function applyAlwaysOnTop(win: BrowserWindow, alwaysOnTop: boolean): void {
  if (IS_MAC) win.setAlwaysOnTop(alwaysOnTop, 'screen-saver', 1);
  else win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
}

export class OverlayWindowManager {
  private window: BrowserWindow | null = null;
  private state: OverlaySyncState | null = null;
  private readonly visibilityListeners = new Set<(visible: boolean) => void>();
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OverlayWindowDeps) {}

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  isVisible(): boolean {
    return this.window?.isVisible() ?? false;
  }

  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private ensureWindow(settings: OverlaySettings): BrowserWindow {
    const existing = this.getWindow();
    if (existing) return existing;

    const workArea = screen.getPrimaryDisplay().workArea;
    const position = settings.position ?? {
      x: workArea.x + workArea.width - WIDTH - 26,
      y: workArea.y + workArea.height - HEIGHT - 26,
    };

    const win = new BrowserWindow({
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.alwaysOnTop,
      focusable: false,
      hasShadow: false,
      show: false,
      title: '口琴工坊·悬浮控制',
      ...(IS_MAC ? { type: 'panel' as const, acceptFirstMouse: true } : {}),
      ...(this.deps.iconPath ? { icon: this.deps.iconPath } : {}),
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    applyAlwaysOnTop(win, settings.alwaysOnTop);
    win.setOpacity(clampOpacity(settings.opacity));
    win.setSkipTaskbar(true);
    // macOS：悬浮窗跟随所有桌面空间，并在全屏游戏之上可见
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    this.deps.load(win);
    win.webContents.on('did-finish-load', () => {
      debugLog(`overlay did-finish-load visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`);
      this.pushState();
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      debugLog(`overlay did-fail-load code=${code} desc=${description}`);
    });
    win.on('show', () => debugLog(`overlay show event visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`));
    win.on('hide', () => debugLog('overlay hide event'));

    win.on('moved', () => {
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        this.moveTimer = null;
        if (!win || win.isDestroyed()) return;
        const [x, y] = win.getPosition();
        this.deps.savePosition({ x, y });
      }, 500);
    });

    win.on('closed', () => {
      this.window = null;
      this.notifyVisibility(false);
    });

    this.window = win;
    return win;
  }

  /** 显示/隐藏悬浮窗；返回操作后的可见状态 */
  setVisible(visible: boolean, settings: OverlaySettings): boolean {
    const win = this.ensureWindow(settings);
    if (visible) {
      applyAlwaysOnTop(win, settings.alwaysOnTop);
      win.setOpacity(clampOpacity(settings.opacity));
      win.showInactive();
      debugLog(
        `overlay showInactive: visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())} opacity=${win.getOpacity()} topmost=${win.isAlwaysOnTop()} focusable=${win.isFocusable()}`,
      );
      this.notifyVisibility(true);
      return true;
    }
    if (win.isVisible()) win.hide();
    this.notifyVisibility(false);
    return false;
  }

  /** 应用外观设置（置顶/透明度/是否保持可见；position 为 null 时回到默认右下角） */
  applySettings(settings: OverlaySettings): void {
    const win = this.getWindow();
    if (!win) return;
    applyAlwaysOnTop(win, settings.alwaysOnTop);
    win.setOpacity(clampOpacity(settings.opacity));
    if (!settings.position) {
      const workArea = screen.getPrimaryDisplay().workArea;
      try {
        win.setPosition(workArea.x + workArea.width - WIDTH - 26, workArea.y + workArea.height - HEIGHT - 26);
      } catch (error) {
        // Wayland 等环境不允许程序定位窗口：保留当前位置，仅记录日志
        debugLog(`overlay reposition failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!settings.visible && win.isVisible()) {
      win.hide();
      this.notifyVisibility(false);
    }
  }

  syncState(state: OverlaySyncState): void {
    this.state = state;
    this.pushState();
  }

  broadcast(channel: string, payload: unknown): void {
    const win = this.getWindow();
    if (!win) return;
    win.webContents.send(channel, payload);
  }

  onVisibilityChange(listener: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  destroy(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    const win = this.getWindow();
    this.window = null;
    if (win) win.destroy();
  }

  private pushState(): void {
    const win = this.getWindow();
    if (!win || !this.state) return;
    if (win.webContents.isLoading()) return;
    win.webContents.send('overlay:state', this.state);
  }

  private notifyVisibility(visible: boolean): void {
    for (const listener of this.visibilityListeners) listener(visible);
  }
}
