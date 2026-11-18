/**
 * 系统托盘：主窗口隐藏后仍可快速显示/控制。
 */
import { Menu, Tray, nativeImage } from 'electron';

export interface TrayHandlers {
  showMain: () => void;
  toggleOverlay: () => void;
  togglePlay: () => void;
  quit: () => void;
}

export class AppTray {
  private tray: Tray | null = null;

  constructor(
    private readonly iconPath: string,
    private readonly handlers: TrayHandlers,
  ) {}

  init(): boolean {
    try {
      const image = nativeImage.createFromPath(this.iconPath);
      if (image.isEmpty()) return false;
      const tray = new Tray(image.resize({ width: 18, height: 18 }));
      tray.setToolTip('三角洲口琴工坊');
      tray.on('click', () => this.handlers.showMain());
      this.tray = tray;
      this.refresh(false);
      return true;
    } catch {
      return false;
    }
  }

  isReady(): boolean {
    return this.tray !== null;
  }

  refresh(overlayVisible: boolean): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.handlers.showMain() },
      {
        label: overlayVisible ? '隐藏悬浮控制窗' : '显示悬浮控制窗',
        click: () => this.handlers.toggleOverlay(),
      },
      { type: 'separator' },
      { label: '开始 / 停止演奏', click: () => this.handlers.togglePlay() },
      { type: 'separator' },
      { label: '退出口琴工坊', click: () => this.handlers.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
