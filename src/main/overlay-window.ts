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

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.96;
  return Math.min(1, Math.max(0.3, value));
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

    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    win.setOpacity(clampOpacity(settings.opacity));
    win.setSkipTaskbar(true);

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
      win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
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
    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    win.setOpacity(clampOpacity(settings.opacity));
    if (!settings.position) {
      const workArea = screen.getPrimaryDisplay().workArea;
      win.setPosition(workArea.x + workArea.width - WIDTH - 26, workArea.y + workArea.height - HEIGHT - 26);
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
