/**
 * 鼠标宏 / 触发键位表导出。
 *
 * 设计目标：
 * - 用户可以把曲谱导出成鼠标宏驱动（罗技 G HUB / AutoHotkey / 支持"按键+延时"的通用宏编辑器）可用的脚本；
 * - 同时给出"触发键位表"：全音域 38 个半音分别该按哪个音键 + 哪个鼠标修饰键，以及本曲每个音的触发时间/保持时长；
 * - 与软件内演奏使用同一份 PlaybackPlan（同一套时序、移调、折返结果），保证"照着表/跑宏"和软件内演奏一致。
 *
 * 键位模型（与游戏内一致）：
 * - 音键：Z X C V B N M , → 1 2 3 4 5 6 7 高音1
 * - 鼠标修饰：左键=降八度，右键=升八度，中键=升半音，可组合
 */
import { allCombos, DEFAULT_HARMONICA, formatCombo, type MouseButton, type PhysicalCombo } from '../model/instrument';
import { midiToName } from '../model/pitch';
import type { InputEvent, PlaybackPlan, PlannedNote } from '../instrument/plan';

export type MacroFormat = 'ahk' | 'lua' | 'csv' | 'trigger-table';

export interface MacroExportOptions {
  title?: string;
  artist?: string;
  /** AHK 触发键，默认 F9；可填 XButton1 / XButton2（鼠标侧键） */
  ahkTrigger?: string;
  /** 罗技 OnEvent 的鼠标按钮编号，默认 5（前进侧键）；4=后退 5=前进 */
  logitechTriggerButton?: number;
  includeHeader?: boolean;
  /** 触发表/CSV 最多输出多少个输入事件或音符（默认 20000，足够整曲） */
  maxRows?: number;
}

export interface MacroExportResult {
  format: MacroFormat;
  text: string;
  extension: string;
  filterName: string;
  warnings: string[];
  eventCount: number;
  noteCount: number;
}

export interface TriggerKeyMapRow {
  midi: number;
  midiName: string;
  /** 简谱级数（1-7，8=高音1） */
  degree: number;
  /** 八度偏移 -1/0/+1 */
  octaveShift: number;
  /** 键位记号：↑Z / ↓#V / , 等 */
  keys: string;
  keyLabel: string;
  /** 鼠标修饰说明，如「右键+中键」；无修饰为空 */
  modsLabel: string;
}

export interface NoteTriggerRow {
  index: number;
  startMs: number;
  endMs: number;
  holdMs: number;
  midiName: string;
  keys: string;
  trigger: string;
  modsLabel: string;
}

const AHK_MOUSE: Record<MouseButton, string> = { left: 'LButton', middle: 'MButton', right: 'RButton' };
const LUA_MOUSE: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 };
const LUA_KEY: Record<string, string> = {
  k1: 'z',
  k2: 'x',
  k3: 'c',
  k4: 'v',
  k5: 'b',
  k6: 'n',
  k7: 'm',
  k8: 'comma',
};
const MOUSE_LABEL: Record<MouseButton, string> = { left: '左键', middle: '中键', right: '右键' };
const MOUSE_ACTION: Record<MouseButton, string> = { left: '降八度', middle: '升半音', right: '升八度' };

function keyLabelOf(keyId: string | undefined): string {
  return DEFAULT_HARMONICA.noteKeys.find((key) => key.id === keyId)?.label ?? keyId ?? '?';
}

function scanHex(scan: number | undefined): string {
  if (!scan) return '000';
  return scan.toString(16).toUpperCase().padStart(3, '0');
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function escapeCsv(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeMd(value: string | number): string {
  return String(value).replace(/\|/g, '\\|');
}

function comboTriggerText(combo: PhysicalCombo): string {
  const mods = combo.mods.map((mod) => MOUSE_LABEL[mod]);
  return [...mods, combo.keyLabel].join('+');
}

function comboModsText(combo: PhysicalCombo): string {
  return combo.mods.map((mod) => MOUSE_LABEL[mod]).join('+');
}

/** 全音域（C3–C#6，38 个半音）各音高推荐触发键位 */
export function getTriggerKeyMapRows(): TriggerKeyMapRow[] {
  const best = new Map<number, PhysicalCombo>();
  for (const combo of allCombos(DEFAULT_HARMONICA)) {
    const current = best.get(combo.midi);
    if (!current) {
      best.set(combo.midi, combo);
      continue;
    }
    const better =
      combo.modCount - current.modCount ||
      Math.abs(combo.octaveShift) - Math.abs(current.octaveShift) ||
      combo.semitone - current.semitone ||
      combo.degree - current.degree;
    if (better < 0) best.set(combo.midi, combo);
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([midi, combo]) => ({
      midi,
      midiName: midiToName(midi),
      degree: combo.degree,
      octaveShift: combo.octaveShift,
      keys: formatCombo(combo),
      keyLabel: combo.keyLabel,
      modsLabel: comboModsText(combo),
    }));
}

/** 本曲逐音触发表 */
export function getNoteTriggerRows(plan: PlaybackPlan, maxRows = 20000): NoteTriggerRow[] {
  const notes = plan.notes.slice(0, Math.max(0, maxRows));
  return notes.map((note) => {
    const startMs = Math.round(note.startMs);
    const endMs = Math.round(note.endMs);
    return {
      index: note.index + 1,
      startMs,
      endMs,
      holdMs: Math.max(0, endMs - startMs),
      midiName: note.midiName,
      keys: note.keys,
      trigger: comboTriggerText(note.combo),
      modsLabel: comboModsText(note.combo),
    };
  });
}

function noteAnnotation(plan: PlaybackPlan): Map<string, { note: PlannedNote; kind: 'start' | 'end' }> {
  const map = new Map<string, { note: PlannedNote; kind: 'start' | 'end' }>();
  for (const note of plan.notes) {
    map.set(`start:${note.startMs}:${note.combo.keyId}`, { note, kind: 'start' });
    map.set(`end:${note.endMs}:${note.combo.keyId}`, { note, kind: 'end' });
  }
  return map;
}

function eventAnnotation(plan: PlaybackPlan, annotations: Map<string, { note: PlannedNote; kind: 'start' | 'end' }>, event: InputEvent): string {
  if (event.keyId) {
    const match = annotations.get(`${event.kind === 'keydown' ? 'start' : 'end'}:${event.t}:${event.keyId}`);
    if (match) {
      return `${match.kind === 'start' ? '音符' : '松开'} #${match.note.index + 1} ${match.note.midiName} ${match.note.keys}`;
    }
    return `音键 ${keyLabelOf(event.keyId)}`;
  }
  if (event.button) return `${MOUSE_LABEL[event.button]}（${MOUSE_ACTION[event.button]}）`;
  return event.label;
}

function commonHeaderLines(plan: PlaybackPlan, options: MacroExportOptions): string[] {
  const title = options.title ?? '未命名';
  const lines: string[] = [];
  lines.push(`曲目：${title}${options.artist ? ` - ${options.artist}` : ''}`);
  lines.push(
    `速度：${plan.tempo.toFixed(1)} BPM ｜ 移调：${plan.transpose > 0 ? '+' : ''}${plan.transpose} 半音 ｜ 音符：${plan.stats.noteCount} ｜ 时长：${formatDuration(plan.durationMs)}`,
  );
  lines.push(`键位：Z X C V B N M , = 1 2 3 4 5 6 7 高音1 ｜ 鼠标：左键=降八度 右键=升八度 中键=升半音（可组合）`);
  if (plan.warnings.length > 0) lines.push(`注意：${plan.warnings.join('；')}`);
  return lines;
}

function ahkToken(event: InputEvent): string {
  if (event.kind === 'keydown' || event.kind === 'keyup') {
    return `{sc${scanHex(event.scan)} ${event.kind === 'keydown' ? 'down' : 'up'}}`;
  }
  return `{${AHK_MOUSE[event.button ?? 'left']} ${event.kind === 'mousedown' ? 'down' : 'up'}}`;
}

/** 生成 AutoHotkey v1 宏脚本 */
export function generateAhkMacro(plan: PlaybackPlan, options: MacroExportOptions = {}): MacroExportResult {
  const trigger = (options.ahkTrigger ?? 'F9').trim() || 'F9';
  const lines: string[] = [];
  lines.push('; ============================================================');
  lines.push('; 三角洲口琴工坊 · 鼠标宏导出（AutoHotkey v1）');
  for (const line of commonHeaderLines(plan, options)) lines.push(`; ${line}`);
  lines.push('; ------------------------------------------------------------');
  lines.push('; 使用说明：');
  lines.push('; 1. 安装 AutoHotkey v1，右键本脚本 →「以管理员身份运行」（否则游戏会丢弃模拟按键）；');
  lines.push('; 2. 游戏设置为「无边框窗口」，进入口琴手动演奏界面；');
  lines.push(`; 3. 按触发键 ${trigger} 开始/中止；鼠标侧键也可触发（见下方注释）；`);
  lines.push('; 4. 急停：按 F10 重新加载脚本（立即中止宏）；或关闭 AHK 托盘图标；');
  lines.push('; 5. 若游戏内无反应：确认 AHK 与游戏同为管理员权限、游戏窗口在前台、光标在游戏窗口内。');
  lines.push('; 6. 本脚本属于第三方模拟输入，与软件内注入同样存在账号风险，请自行判断使用场景。');
  lines.push('; ============================================================');
  lines.push('#NoEnv');
  lines.push('#SingleInstance Force');
  lines.push('#MaxThreadsPerHotkey 2');
  lines.push('SendMode Input');
  lines.push('SetWorkingDir %A_ScriptDir%');
  lines.push('');
  lines.push('global playing := false');
  lines.push(`global triggerHotkey := "${trigger}"`);
  lines.push('Hotkey, %triggerHotkey%, StartMacro');
  lines.push('; 鼠标侧键触发（去掉下面其中一行的注释即可）');
  lines.push('; XButton1::StartMacro');
  lines.push('; XButton2::StartMacro');
  lines.push('F10::Reload  ; 急停：重新加载脚本');
  lines.push('return');
  lines.push('');
  lines.push('StartMacro:');
  lines.push('  if (playing) {');
  lines.push('    playing := false');
  lines.push('    return');
  lines.push('  }');
  lines.push('  playing := true');
  lines.push('  PlayMacro()');
  lines.push('  playing := false');
  lines.push('return');
  lines.push('');
  lines.push('Wait(ms) {');
  lines.push('  global playing');
  lines.push('  end := A_TickCount + ms');
  lines.push('  while (A_TickCount < end) {');
  lines.push('    if (!playing)');
  lines.push('      return');
  lines.push('    Sleep, 5');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('PlayMacro() {');
  lines.push('  global playing');
  let cursor = 0;
  for (const event of plan.events) {
    const delta = Math.max(0, event.t - cursor);
    if (delta > 0) lines.push(`  Wait(${delta})`);
    cursor = event.t;
    lines.push('  if (!playing)');
    lines.push('    return');
    lines.push(`  SendInput, ${ahkToken(event)}`);
  }
  lines.push('}');
  lines.push('');

  return {
    format: 'ahk',
    text: lines.join('\r\n'),
    extension: 'ahk',
    filterName: 'AutoHotkey 宏脚本',
    warnings: plan.warnings,
    eventCount: plan.events.length,
    noteCount: plan.stats.noteCount,
  };
}

/** 生成罗技 G HUB / Gaming Software Lua 宏脚本 */
export function generateLogitechLuaMacro(plan: PlaybackPlan, options: MacroExportOptions = {}): MacroExportResult {
  const triggerButton = Math.min(5, Math.max(1, Math.round(options.logitechTriggerButton ?? 5)));
  const lines: string[] = [];
  lines.push('-- ============================================================');
  lines.push('-- 三角洲口琴工坊 · 鼠标宏导出（罗技 G HUB Lua）');
  for (const line of commonHeaderLines(plan, options)) lines.push(`-- ${line}`);
  lines.push('-- ------------------------------------------------------------');
  lines.push('-- 使用说明：');
  lines.push('-- 1. 打开罗技 G HUB → 游戏与应用程序配置 → 分配宏 → 新建 Lua 脚本，粘贴本文件；');
  lines.push('-- 2. 把脚本绑定到鼠标侧键（默认前进侧键，OnEvent arg=5；可改下方 TRIGGER_BUTTON）；');
  lines.push('-- 3. G HUB 需以管理员权限运行，游戏设为「无边框窗口」；进入口琴手动演奏界面；');
  lines.push('-- 4. 按一次鼠标侧键开始，再按一次中止；关闭 G HUB 配置也能中止；');
  lines.push('-- 5. 若游戏无反应：确认 G HUB 配置已保存并启用、游戏在前台、光标在游戏窗口内。');
  lines.push('-- 6. 本脚本属于第三方模拟输入，与软件内注入同样存在账号风险，请自行判断使用场景。');
  lines.push('-- ============================================================');
  lines.push(`local TRIGGER_BUTTON = ${triggerButton}  -- OnEvent 鼠标按钮：4=后退侧键 5=前进侧键`);
  lines.push('local playing = false');
  lines.push('');
  lines.push('local function Wait(ms)');
  lines.push('  local target = GetRunningTime() + ms');
  lines.push('  while GetRunningTime() < target do');
  lines.push('    if not playing then return end');
  lines.push('    Sleep(10)');
  lines.push('  end');
  lines.push('end');
  lines.push('');
  lines.push('local function MouseDown(button)');
  lines.push('  if button == "left" then');
  lines.push('    PressMouseButton(1)');
  lines.push('  elseif button == "middle" then');
  lines.push('    PressMouseButton(2)');
  lines.push('  else');
  lines.push('    PressMouseButton(3)');
  lines.push('  end');
  lines.push('end');
  lines.push('');
  lines.push('local function MouseUp(button)');
  lines.push('  if button == "left" then');
  lines.push('    ReleaseMouseButton(1)');
  lines.push('  elseif button == "middle" then');
  lines.push('    ReleaseMouseButton(2)');
  lines.push('  else');
  lines.push('    ReleaseMouseButton(3)');
  lines.push('  end');
  lines.push('end');
  lines.push('');
  lines.push('function PlayMacro()');
  lines.push('  if not playing then return end');
  let cursor = 0;
  for (const event of plan.events) {
    const delta = Math.max(0, event.t - cursor);
    if (delta > 0) lines.push(`  Wait(${delta})`);
    cursor = event.t;
    lines.push('  if not playing then return end');
    if (event.kind === 'keydown') lines.push(`  PressKey("${LUA_KEY[event.keyId ?? 'k1'] ?? 'z'}")`);
    else if (event.kind === 'keyup') lines.push(`  ReleaseKey("${LUA_KEY[event.keyId ?? 'k1'] ?? 'z'}")`);
    else if (event.kind === 'mousedown') lines.push(`  MouseDown("${event.button ?? 'left'}")`);
    else lines.push(`  MouseUp("${event.button ?? 'left'}")`);
  }
  lines.push('end');
  lines.push('');
  lines.push('function OnEvent(event, arg)');
  lines.push('  if event == "MOUSE_BUTTON_PRESSED" and arg == TRIGGER_BUTTON then');
  lines.push('    if playing then');
  lines.push('      playing = false');
  lines.push('      return');
  lines.push('    end');
  lines.push('    playing = true');
  lines.push('    PlayMacro()');
  lines.push('    playing = false');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return {
    format: 'lua',
    text: lines.join('\r\n'),
    extension: 'lua',
    filterName: '罗技 G HUB Lua 宏脚本',
    warnings: plan.warnings,
    eventCount: plan.events.length,
    noteCount: plan.stats.noteCount,
  };
}

/** 生成通用 CSV 时序表（适合罗技/雷蛇/其他支持「按键+延时」的宏编辑器逐行录入） */
export function generateMacroCsv(plan: PlaybackPlan, options: MacroExportOptions = {}): MacroExportResult {
  const maxRows = Math.max(1, options.maxRows ?? 20000);
  const events = plan.events.slice(0, maxRows);
  const annotations = noteAnnotation(plan);
  const rows: string[] = ['序号,时间(ms),距上一事件(ms),动作,设备,键位,扫描码,说明'];
  let last = 0;
  events.forEach((event, index) => {
    const action = event.kind.endsWith('down') ? '按下' : '松开';
    const device = event.keyId ? '键盘' : '鼠标';
    const keyName = event.keyId ? keyLabelOf(event.keyId) : MOUSE_LABEL[event.button ?? 'left'];
    const scan = event.scan ? `0x${scanHex(event.scan)}` : '';
    const annotation = eventAnnotation(plan, annotations, event);
    rows.push(
      [index + 1, event.t, event.t - last, action, device, keyName, scan, annotation].map(escapeCsv).join(','),
    );
    last = event.t;
  });
  const header: string[] = [];
  header.push(`# 三角洲口琴工坊 · 宏时序表（CSV）`);
  for (const line of commonHeaderLines(plan, options)) header.push(`# ${line}`);
  header.push('# 每一行可直接录入支持「按键/鼠标 + 延时」的鼠标宏编辑器；延时=距上一事件的毫秒数。');
  header.push('# 设备=键盘时按对应音键；设备=鼠标时按住/松开对应修饰键。');
  header.push('# 若编辑器只支持键盘宏，可忽略鼠标行并用键位表手动补修饰键（见触发键位表导出）。');

  return {
    format: 'csv',
    text: `\uFEFF${[...header, ...rows].join('\r\n')}\r\n`,
    extension: 'csv',
    filterName: '宏时序表（CSV）',
    warnings: plan.warnings,
    eventCount: plan.events.length,
    noteCount: plan.stats.noteCount,
  };
}

/** 生成触发键位表（Markdown）：全音域映射 + 本曲逐音触发表 + 组合统计 */
export function generateTriggerTable(plan: PlaybackPlan, options: MacroExportOptions = {}): MacroExportResult {
  const maxRows = Math.max(1, options.maxRows ?? 20000);
  const title = options.title ?? '未命名';
  const keyRows = getTriggerKeyMapRows();
  const noteRows = getNoteTriggerRows(plan, maxRows);
  const lines: string[] = [];
  lines.push(`# 《${title}》口琴触发键位表`);
  lines.push('');
  if (options.artist) lines.push(`- 艺术家：${options.artist}`);
  lines.push(`- 速度：${plan.tempo.toFixed(1)} BPM ｜ 移调：${plan.transpose > 0 ? '+' : ''}${plan.transpose} 半音`);
  lines.push(`- 音符：${plan.stats.noteCount} ｜ 输入事件：${plan.events.length} ｜ 总时长：${formatDuration(plan.durationMs)}`);
  lines.push('- 音键：Z X C V B N M , = 1 2 3 4 5 6 7 高音1');
  lines.push('- 鼠标修饰：左键=降八度，右键=升八度，中键=升半音（可组合，如「右键+中键+Z」）');
  lines.push('- 宏触发建议：鼠标侧键（AHK 可写 `XButton1::StartMacro`；罗技 Lua 改 `TRIGGER_BUTTON`）');
  lines.push('');
  lines.push('## 1. 全音域触发键位表（C3–C#6，共 ' + keyRows.length + ' 个半音）');
  lines.push('');
  lines.push('| # | 音名 | MIDI | 简谱级数 | 八度偏移 | 键位记号 | 音键 | 鼠标修饰 | 触发方式 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  keyRows.forEach((row, index) => {
    const degreeLabel = row.degree === 8 ? '高音1' : String(row.degree);
    lines.push(
      `| ${index + 1} | ${escapeMd(row.midiName)} | ${row.midi} | ${degreeLabel} | ${row.octaveShift > 0 ? '+1' : row.octaveShift < 0 ? '-1' : '0'} | \`${row.keys}\` | ${row.keyLabel} | ${row.modsLabel || '无'} | ${escapeMd([row.modsLabel, row.keyLabel].filter(Boolean).join('+'))} |`,
    );
  });
  lines.push('');
  lines.push(`## 2. 本曲逐音触发表（共 ${plan.stats.noteCount} 个音）`);
  lines.push('');
  lines.push('| # | 开始(ms) | 保持(ms) | 结束(ms) | 音名 | 键位记号 | 触发方式 |');
  lines.push('|---|---|---|---|---|---|---|');
  noteRows.forEach((row) => {
    lines.push(
      `| ${row.index} | ${row.startMs} | ${row.holdMs} | ${row.endMs} | ${escapeMd(row.midiName)} | \`${row.keys}\` | ${escapeMd(row.trigger)} |`,
    );
  });
  lines.push('');
  lines.push('## 3. 组合使用统计');
  lines.push('');
  const comboCount = new Map<string, number>();
  for (const note of plan.notes) {
    const key = comboTriggerText(note.combo);
    comboCount.set(key, (comboCount.get(key) ?? 0) + 1);
  }
  lines.push('| 触发方式 | 次数 |');
  lines.push('|---|---|');
  [...comboCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([combo, count]) => lines.push(`| ${escapeMd(combo)} | ${count} |`));
  lines.push('');
  lines.push('## 4. 输入事件统计');
  lines.push('');
  const counts = { keydown: 0, keyup: 0, mousedown: 0, mouseup: 0 };
  for (const event of plan.events) counts[event.kind] += 1;
  lines.push('| 事件 | 次数 |');
  lines.push('|---|---|');
  lines.push(`| 键盘按下 | ${counts.keydown} |`);
  lines.push(`| 键盘松开 | ${counts.keyup} |`);
  lines.push(`| 鼠标修饰按下 | ${counts.mousedown} |`);
  lines.push(`| 鼠标修饰松开 | ${counts.mouseup} |`);
  lines.push('');
  if (plan.warnings.length > 0) {
    lines.push('## 5. 注意');
    lines.push('');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  return {
    format: 'trigger-table',
    text: lines.join('\n'),
    extension: 'trigger.md',
    filterName: '触发键位表（Markdown）',
    warnings: plan.warnings,
    eventCount: plan.events.length,
    noteCount: plan.stats.noteCount,
  };
}

/** 统一入口：按格式生成宏/触发表文件 */
export function generateMacroExport(
  plan: PlaybackPlan,
  format: MacroFormat,
  options: MacroExportOptions = {},
): MacroExportResult {
  switch (format) {
    case 'ahk':
      return generateAhkMacro(plan, options);
    case 'lua':
      return generateLogitechLuaMacro(plan, options);
    case 'csv':
      return generateMacroCsv(plan, options);
    case 'trigger-table':
    default:
      return generateTriggerTable(plan, options);
  }
}
