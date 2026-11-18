/**
 * 键位谱导出：把人读的简谱转换成「照着按」的键位序列（含八度/半音修饰键记号）。
 * 记号：Z X C V B N M , = 1 2 3 4 5 6 7 高音1
 *       ↑ = 按住鼠标右键（高八度），↓ = 按住鼠标左键（低八度），# = 按住鼠标中键（升半音）
 */
import { meterBeats, type Score } from '../model/score';
import { formatCombo, DEFAULT_HARMONICA } from '../model/instrument';
import { planPerformance } from '../instrument/plan';

export interface KeySheetOptions {
  /** 移调半音数，默认按乐谱原调 */
  transpose?: number | 'auto';
  /** 每行包含多少小节（默认 4） */
  measuresPerLine?: number;
  /** 是否包含标题/参数说明 */
  includeHeader?: boolean;
}

export interface KeySheetResult {
  text: string;
  warnings: string[];
  noteCount: number;
}

export function generateKeySheet(score: Score, options: KeySheetOptions = {}): KeySheetResult {
  const measuresPerLine = Math.max(1, options.measuresPerLine ?? 4);
  const plan = planPerformance(score, {
    instrument: DEFAULT_HARMONICA,
    transpose: options.transpose ?? 0,
  });
  const measure = meterBeats(score.meta.meter);
  const lines: string[] = [];
  if (options.includeHeader !== false) {
    lines.push(`=== ${score.meta.title || '未命名'} · 口琴键位谱 ===`);
    lines.push(`速度 ${score.meta.tempo} BPM ｜ 拍号 ${score.meta.meter.num}/${score.meta.meter.den} ｜ 1=${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][score.meta.keyRoot]}`);
    lines.push('键位：Z X C V B N M , = 1 2 3 4 5 6 7 高音1');
    lines.push('修饰：↑=按住鼠标右键(高八度)  ↓=按住鼠标左键(低八度)  #=按住鼠标中键(升半音)');
    if (plan.transpose !== 0) lines.push(`已为可演奏性移调 ${plan.transpose > 0 ? '+' : ''}${plan.transpose} 个半音`);
    lines.push('');
  }

  // 按小节分组
  const measures: string[][] = [];
  let currentMeasure = 0;
  let current: string[] = [];
  for (const note of plan.notes) {
    const measureIndex = measure > 0 ? Math.floor(note.startBeat / measure + 1e-6) : 0;
    while (currentMeasure < measureIndex) {
      if (current.length > 0) measures.push(current);
      current = [];
      currentMeasure += 1;
    }
    current.push(formatCombo(note.combo));
  }
  if (current.length > 0) measures.push(current);

  for (let i = 0; i < measures.length; i += measuresPerLine) {
    const row = measures.slice(i, i + measuresPerLine).map((tokens) => tokens.join(' '));
    lines.push(`| ${row.join('  | ')}  |`);
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('注意：');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  return {
    text: lines.join('\n') + '\n',
    warnings: plan.warnings,
    noteCount: plan.notes.length,
  };
}
