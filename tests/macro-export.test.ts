import { describe, expect, it } from 'vitest';
import { planPerformance } from '../src/core/instrument/plan';
import {
  generateMacroExport,
  getNoteTriggerRows,
  getTriggerKeyMapRows,
  MACRO_SOFTWARE_ROWS,
  MACRO_SUPPORT_LABEL,
} from '../src/core/export/macro';
import { buildScoreFromText } from '../src/core/score/dsl';

/** 低八度旋律：会用到鼠标左键修饰，便于验证鼠标事件导出 */
function makeLowScore(): ReturnType<typeof buildScoreFromText>['score'] {
  const parsed = buildScoreFromText(
    ['# 标题：宏测试曲', '# 速度：120', '# 拍号：4/4', '# 调号：1=C', '# 基础八度：3', '', '1 2 3 5 | 6 5 3 1 |'].join('\n'),
  );
  expect(parsed.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(0);
  return parsed.score;
}

function makeHighScore(): ReturnType<typeof buildScoreFromText>['score'] {
  const parsed = buildScoreFromText(
    ['# 标题：高音测试', '# 速度：100', '# 拍号：4/4', '# 调号：1=C', '# 基础八度：5', '', "5 6 7 1' | 1' 7 6 5 |"].join('\n'),
  );
  return parsed.score;
}

describe('触发键位表', () => {
  it('全音域映射覆盖 38 个半音且按音高排序', () => {
    const rows = getTriggerKeyMapRows();
    expect(rows).toHaveLength(38);
    expect(rows[0].midi).toBe(48);
    expect(rows[rows.length - 1].midi).toBe(85);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].midi).toBeGreaterThan(rows[index - 1].midi);
      expect(rows[index].keys.length).toBeGreaterThan(0);
      expect(Number.isFinite(rows[index].midi)).toBe(true);
    }
  });

  it('本曲逐音触发表与计划音符一一对应', () => {
    const score = makeLowScore();
    const plan = planPerformance(score, { transpose: 0 });
    const rows = getNoteTriggerRows(plan);
    expect(rows).toHaveLength(plan.notes.length);
    expect(rows.map((row) => row.index)).toEqual(plan.notes.map((note) => note.index + 1));
    // 低八度曲必有鼠标左键修饰
    expect(rows.some((row) => row.modsLabel.includes('左键'))).toBe(true);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].startMs).toBeGreaterThanOrEqual(rows[index - 1].startMs);
    }
    // 触发方式与键位记号一致（带修饰时触发方式包含对应鼠标键）
    for (const row of rows) {
      expect(row.trigger.length).toBeGreaterThan(0);
      expect(row.holdMs).toBeGreaterThanOrEqual(4);
      expect(row.endMs).toBe(row.startMs + row.holdMs);
      expect(Number.isInteger(row.startMs)).toBe(true);
      expect(Number.isInteger(row.endMs)).toBe(true);
      expect(Number.isInteger(row.holdMs)).toBe(true);
    }
  });

  it('触发键位表 Markdown 包含全音域映射、逐音表、统计与警告', () => {
    const score = makeLowScore();
    const plan = planPerformance(score, { transpose: 0 });
    const result = generateMacroExport(plan, 'trigger-table', { title: '宏测试曲' });
    expect(result.extension).toBe('trigger.md');
    expect(result.text).toContain('# 《宏测试曲》口琴触发键位表');
    expect(result.text).toContain('全音域触发键位表');
    expect(result.text).toContain('本曲逐音触发表');
    expect(result.text).toContain('组合使用统计');
    expect(result.text).toContain('输入事件统计');
    expect(result.text).toContain('右键');
    expect(result.text).toContain('| 1 |');
    expect(result.noteCount).toBe(plan.stats.noteCount);
    expect(result.eventCount).toBe(plan.events.length);
  });
});

describe('AutoHotkey 宏导出', () => {
  it('包含触发键、扫描码按键与鼠标修饰，事件数与计划一致', () => {
    const score = makeLowScore();
    const plan = planPerformance(score, { transpose: 0 });
    const result = generateMacroExport(plan, 'ahk', { title: '宏测试曲' });
    expect(result.extension).toBe('ahk');
    expect(result.text).toContain('#SingleInstance Force');
    expect(result.text).toContain('global triggerHotkey := "F9"');
    expect(result.text).toContain('SendInput');
    expect(result.text).toContain('sc02C down'); // Z
    expect(result.text).toContain('sc02D down'); // X
    expect(result.text).toContain('{LButton down}'); // 降八度修饰
    expect(result.text).toContain('Wait(');
    expect(result.text).not.toContain('undefined');
    expect(result.text).not.toContain('NaN');
    const keyEvents = plan.events.filter((event) => event.kind === 'keydown' || event.kind === 'keyup');
    const sentLines = result.text.split('\r\n').filter((line) => line.startsWith('  SendInput,'));
    expect(sentLines).toHaveLength(plan.events.length);
    expect(keyEvents.length).toBeGreaterThan(0);
  });

  it('支持自定义触发键（例如鼠标侧键 XButton1）', () => {
    const score = makeHighScore();
    const plan = planPerformance(score, { transpose: 0 });
    const result = generateMacroExport(plan, 'ahk', { ahkTrigger: 'XButton1' });
    expect(result.text).toContain('global triggerHotkey := "XButton1"');
    expect(result.text).toContain('Hotkey, %triggerHotkey%, StartMacro');
    expect(result.text).toContain('sc033'); // 逗号键（高音 1）
  });

  it('空谱也能生成合法脚本（PlayMacro 为空）', () => {
    const parsed = buildScoreFromText('# 标题：空\n0- - - -|\n');
    const plan = planPerformance(parsed.score, { transpose: 0 });
    const result = generateMacroExport(plan, 'ahk', { title: '空' });
    expect(result.text).toContain('PlayMacro() {');
    expect(result.text).toContain('return');
    expect(result.text).not.toContain('NaN');
  });
});

describe('AutoHotkey v2 宏导出', () => {
  it('生成 v2 语法且事件数与计划一致，不混入 v1 语法', () => {
    const score = makeLowScore();
    const plan = planPerformance(score, { transpose: 0 });
    const result = generateMacroExport(plan, 'ahk2', { title: '宏测试曲' });
    expect(result.extension).toBe('ahk');
    expect(result.filterName).toContain('v2');
    expect(result.text).toContain('#Requires AutoHotkey v2.0');
    expect(result.text).toContain('Hotkey triggerHotkey, StartMacro');
    expect(result.text).toContain('StartMacro(*) {');
    expect(result.text).toContain('SendInput "{sc02C down}"'); // Z
    expect(result.text).toContain('SendInput "{LButton down}"'); // 降八度修饰
    expect(result.text).not.toContain('#NoEnv');
    expect(result.text).not.toContain('Hotkey, %');
    expect(result.text).not.toContain('global triggerHotkey');
    const sent = result.text.split('\r\n').filter((line) => line.startsWith('  SendInput "'));
    expect(sent).toHaveLength(plan.events.length);
    expect(result.text).not.toContain('undefined');
    expect(result.text).not.toContain('NaN');
  });

  it('支持自定义触发键，空谱也保持合法结构', () => {
    const parsed = buildScoreFromText('# 标题：空\n0- - - -|\n');
    const plan = planPerformance(parsed.score);
    const result = generateMacroExport(plan, 'ahk2', { ahkTrigger: 'XButton2' });
    expect(result.text).toContain('triggerHotkey := "XButton2"');
    expect(result.text).toContain('PlayMacro() {');
    expect(result.text).not.toContain('Wait(NaN)');
    expect(result.text).not.toContain('SendInput "undefined"');
  });
});

describe('宏软件兼容性对照表', () => {
  it('罗技走原生脚本，其他品牌只能录制、用 AHK 或 CSV 兜底', () => {
    expect(MACRO_SOFTWARE_ROWS.length).toBeGreaterThanOrEqual(5);
    expect(MACRO_SOFTWARE_ROWS[0].software).toContain('罗技');
    expect(MACRO_SOFTWARE_ROWS[0].support).toBe('native');
    expect(MACRO_SOFTWARE_ROWS.some((row) => row.support === 'universal' && row.brand === '任意品牌')).toBe(true);
    expect(MACRO_SOFTWARE_ROWS.some((row) => row.support === 'record-only')).toBe(true);
    for (const row of MACRO_SOFTWARE_ROWS) {
      expect(row.format.length).toBeGreaterThan(0);
      expect(row.note.length).toBeGreaterThan(0);
      expect(MACRO_SUPPORT_LABEL[row.support].length).toBeGreaterThan(0);
    }
  });

  it('触发键位表带兼容性章节', () => {
    const plan = planPerformance(makeLowScore(), { transpose: 0 });
    const result = generateMacroExport(plan, 'trigger-table', { title: '宏测试曲' });
    expect(result.text).toContain('## 5. 宏软件兼容性');
    expect(result.text).toContain('仅录制');
    expect(result.text).toContain('AutoHotkey v2');
  });
});

describe('罗技 G HUB Lua 宏导出', () => {  it('包含 OnEvent/触发按钮/PressKey/鼠标映射，且可解析结构', () => {
    const score = makeLowScore();
    const plan = planPerformance(score, { transpose: 0 });
    const result = generateMacroExport(plan, 'lua', { title: '宏测试曲' });
    expect(result.extension).toBe('lua');
    expect(result.text).toContain('function OnEvent(event, arg)');
    expect(result.text).toContain('MOUSE_BUTTON_PRESSED');
    expect(result.text).toContain('local TRIGGER_BUTTON = 5');
    expect(result.text).toContain('PressKey("z")');
    expect(result.text).toContain('ReleaseKey("z")');
    expect(result.text).toContain('PressMouseButton(1)'); // 左键=降八度
    expect(result.text).toContain('ReleaseMouseButton(1)');
    expect(result.text).toContain('MouseDown("left")');
    expect(result.text).toContain('GetRunningTime()');
    expect(result.text).not.toContain('undefined');
    expect(result.text.split('\r\n').filter((line) => line.includes('PressKey(') || line.includes('ReleaseKey('))).toHaveLength(
      plan.events.filter((event) => event.keyId).length,
    );
  });

  it('支持自定义触发按钮编号', () => {
    const score = makeLowScore();
    const plan = planPerformance(score);
    const result = generateMacroExport(plan, 'lua', { logitechTriggerButton: 4 });
    expect(result.text).toContain('local TRIGGER_BUTTON = 4');
  });
});

describe('通用 CSV 宏时序表', () => {
  it('输出 BOM、表头、每事件一行，时间单调且列数正确', () => {
    const score = makeLowScore();
    const plan = planPerformance(score, { transpose: 0 });
    const result = generateMacroExport(plan, 'csv', { title: '宏测试曲' });
    expect(result.extension).toBe('csv');
    expect(result.text.startsWith('\uFEFF')).toBe(true);
    expect(result.text).toContain('时间(ms)');
    expect(result.text).toContain('说明');
    const lines = result.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    const dataLines = lines.filter((line) => !line.startsWith('#'));
    expect(dataLines.length).toBe(plan.events.length + 1);
    const header = dataLines[0].split(',');
    expect(header).toHaveLength(8);
    let previous = -1;
    for (const line of dataLines.slice(1)) {
      const columns = line.split(',');
      expect(columns.length).toBeGreaterThanOrEqual(8);
      const time = Number(columns[1]);
      expect(Number.isFinite(time)).toBe(true);
      expect(time).toBeGreaterThanOrEqual(previous);
      previous = time;
      expect(['按下', '松开']).toContain(columns[3]);
      expect(['键盘', '鼠标']).toContain(columns[4]);
    }
    expect(result.text).toContain('鼠标');
    expect(result.text).not.toContain('NaN');
  });
});
