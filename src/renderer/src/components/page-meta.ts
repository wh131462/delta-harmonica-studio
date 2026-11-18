import { useMemo } from 'react';
import type { GlobalCommand } from '@shared/types';
import type { PageId } from '@renderer/state/app-store';

export const PAGE_TITLES: Record<PageId, { title: string; subtitle: string }> = {
  play: { title: '演奏台', subtitle: '选择曲谱 → 校准目标窗口 → 开始演奏' },
  editor: { title: '简谱编辑器', subtitle: '文本 / 可视化编辑 · 拍号校验 · 一键试听' },
  import: { title: '智能导入', subtitle: 'MIDI 与音频自动分析为口琴可演奏简谱' },
  library: { title: '音乐方案库', subtitle: '保存、搜索、导出你的演奏方案' },
  settings: { title: '设置与校准', subtitle: '按键时序 · 输入通道 · 安全选项' },
};

export const GLOBAL_COMMAND_LABEL: Record<GlobalCommand, string> = {
  'toggle-play': 'F9 开始 / 停止演奏',
  'panic-stop': 'F12 紧急停止',
};

export function useHotkeyHint(): string {
  return useMemo(() => 'F9 开始/停止 · F12 紧急停止', []);
}
