/**
 * 可配置全局快捷键管理。
 * - 使用 Electron globalShortcut（系统级，游戏在前台也能触发）
 * - 每次设置变化时整体重建注册，并缓存每个动作的注册结果供 UI 展示
 * - 检测重复快捷键/被系统或其他软件占用的情况
 */
import { globalShortcut } from 'electron';
import type { HotkeyAction, HotkeyRegistrationStatus, HotkeySettings } from '@shared/types';

export interface HotkeyHandlers {
  togglePlay: () => void;
  panicStop: () => void;
  toggleOverlay: () => void;
  showMain: () => void;
}

interface ActionMeta {
  action: HotkeyAction;
  handler: keyof HotkeyHandlers;
  label: string;
}

const ACTION_META: ActionMeta[] = [
  { action: 'togglePlay', handler: 'togglePlay', label: '开始/停止演奏' },
  { action: 'panicStop', handler: 'panicStop', label: '紧急停止' },
  { action: 'toggleOverlay', handler: 'toggleOverlay', label: '显示/隐藏悬浮窗' },
  { action: 'showMain', handler: 'showMain', label: '显示主窗口' },
];

export class HotkeyManager {
  private statuses: HotkeyRegistrationStatus[] = [];

  apply(settings: HotkeySettings, handlers: HotkeyHandlers): HotkeyRegistrationStatus[] {
    globalShortcut.unregisterAll();
    const statuses: HotkeyRegistrationStatus[] = [];
    const registered = new Map<string, HotkeyAction>();

    for (const meta of ACTION_META) {
      const raw = settings[meta.action];
      const accelerator = typeof raw === 'string' ? raw.trim() : '';
      if (!accelerator) {
        statuses.push({ action: meta.action, accelerator: '', registered: false, error: '未设置快捷键' });
        continue;
      }
      const normalized = accelerator.toLowerCase();
      const duplicateOf = registered.get(normalized);
      if (duplicateOf) {
        const other = ACTION_META.find((item) => item.action === duplicateOf);
        statuses.push({
          action: meta.action,
          accelerator,
          registered: false,
          error: `与「${other?.label ?? '其他动作'}」使用了相同快捷键`,
        });
        continue;
      }
      let ok = false;
      let error: string | undefined;
      try {
        ok = globalShortcut.register(accelerator, handlers[meta.handler]);
        if (!ok) error = '注册失败：可能被系统、游戏或其他软件占用';
      } catch (err) {
        error = `快捷键格式无效：${err instanceof Error ? err.message : String(err)}`;
      }
      if (ok) registered.set(normalized, meta.action);
      statuses.push({
        action: meta.action,
        accelerator,
        registered: ok,
        ...(error ? { error } : {}),
      });
    }

    this.statuses = statuses;
    return statuses;
  }

  getStatuses(): HotkeyRegistrationStatus[] {
    return this.statuses;
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.statuses = [];
  }
}
