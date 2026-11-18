/**
 * 应用菜单：
 * - Windows / Linux：隐藏菜单栏（界面里已有入口），保持原有观感。
 * - macOS：必须保留标准菜单，否则 Cmd+C / Cmd+V / Cmd+Q / Cmd+W 等系统快捷键全部失效。
 */
import { Menu, type MenuItemConstructorOptions } from 'electron';

export function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
