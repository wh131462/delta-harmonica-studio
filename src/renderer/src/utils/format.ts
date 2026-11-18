import type { Score } from '@core/model/score';
import { scoreEndBeat } from '@core/model/score';
import { PITCH_CLASS_NAMES } from '@core/model/pitch';

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatScoreDuration(score: Score): string {
  const beats = scoreEndBeat(score);
  const beatMs = 60000 / Math.max(20, score.meta.tempo);
  return formatDurationMs(beats * beatMs);
}

export function keyLabel(keyRoot: number): string {
  return PITCH_CLASS_NAMES[((keyRoot % 12) + 12) % 12];
}

export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case 'midi':
      return 'MIDI 导入';
    case 'audio':
      return '音频分析';
    case 'text':
      return '文本录入';
    case 'keyscore':
      return '键位谱';
    case 'builtin':
      return '内置示例';
    default:
      return '手动录入';
  }
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function beatsToMs(beats: number, tempo: number): number {
  return beats * (60000 / Math.max(20, tempo));
}

export function describeChordMods(mods: readonly string[]): string {
  if (mods.length === 0) return '无修饰键';
  return mods
    .map((mod) => (mod === 'left' ? '鼠标左键' : mod === 'right' ? '鼠标右键' : '鼠标中键'))
    .join(' + ');
}
