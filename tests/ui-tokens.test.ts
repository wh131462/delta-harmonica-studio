/**
 * 设计令牌回归测试：守住对比度与关键令牌的存在性。
 * 设计系统约定见 `.dsh/skills/ui-design/references/tokens.md`。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tokensPath = fileURLToPath(new URL('../src/renderer/src/styles/tokens.css', import.meta.url));
const css = readFileSync(tokensPath, 'utf8');

const tokens = new Map<string, string>();
for (const match of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
  tokens.set(match[1], match[2].trim());
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function parseHex(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

function luminance(rgb: [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(foreground: string, background: string): number {
  const fg = parseHex(tokens.get(foreground));
  const bg = parseHex(tokens.get(background));
  if (!fg || !bg) throw new Error(`令牌不是十六进制颜色：${foreground} / ${background}`);
  const light = Math.max(luminance(fg), luminance(bg));
  const dark = Math.min(luminance(fg), luminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

const REQUIRED = [
  'canvas',
  'canvas-elev',
  'surface-1',
  'surface-2',
  'surface-3',
  'surface-inset',
  'text-1',
  'text-2',
  'text-3',
  'text-4',
  'accent',
  'accent-hover',
  'signal',
  'ok',
  'warn',
  'danger',
  'paper',
  'paper-ink',
  'font-sans',
  'fs-display',
  'fs-body',
  'sp-4',
  'r-md',
  'r-panel',
  'h-control',
  'sidebar-w',
  'topbar-h',
  'dock-h',
  'page-max',
  'z-modal',
];

describe('设计令牌', () => {
  it('关键令牌齐全', () => {
    const missing = REQUIRED.filter((name) => !tokens.has(name));
    expect(missing).toEqual([]);
  });

  it('正文与次要文本达到 WCAG AA（在面板底色上）', () => {
    expect(contrast('text-1', 'surface-2')).toBeGreaterThanOrEqual(12);
    expect(contrast('text-2', 'surface-2')).toBeGreaterThanOrEqual(7);
    expect(contrast('text-3', 'surface-2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('text-3', 'surface-1')).toBeGreaterThanOrEqual(4.5);
  });

  it('强调色与语义色在深色底上可读', () => {
    expect(contrast('accent', 'surface-2')).toBeGreaterThanOrEqual(7);
    expect(contrast('danger', 'surface-2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('warn', 'surface-2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('ok', 'surface-2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('signal', 'surface-2')).toBeGreaterThanOrEqual(4.5);
  });

  it('琥珀底上的深色文字可读', () => {
    expect(contrast('text-on-accent', 'accent')).toBeGreaterThanOrEqual(7);
  });

  it('谱面墨迹与纸面对比足够', () => {
    expect(contrast('paper-ink', 'paper')).toBeGreaterThanOrEqual(7);
  });

  it('播放条与页面背景能区分开', () => {
    expect(contrast('canvas-elev', 'surface-1')).toBeLessThan(1.6);
    expect(contrast('canvas', 'canvas-elev')).toBeLessThan(1.4);
  });
});
