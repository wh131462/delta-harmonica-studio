/**
 * 平台能力模型回归：macOS / Linux 必须保留编辑、导入、练习与试听能力，
 * 只关闭 Win32 游戏注入与提权入口，避免界面出现「权限受限」「通道异常」等误导状态。
 */
import { describe, expect, it } from 'vitest';
import {
  detectPlatformCapabilities,
  isGameInjectionSupported,
  normalizePlatform,
  platformBackendHint,
  platformLabel,
} from '@shared/platform';

describe('平台能力模型', () => {
  it('Windows 是唯一支持游戏注入与提权的平台', () => {
    expect(detectPlatformCapabilities('win32').gameInjection).toBe(true);
    expect(detectPlatformCapabilities('win32').elevation).toBe(true);
    for (const platform of ['darwin', 'linux', 'freebsd', 'aix']) {
      expect(isGameInjectionSupported(platform), platform).toBe(false);
      expect(detectPlatformCapabilities(platform).elevation, platform).toBe(false);
    }
  });

  it('macOS / Linux 仍保留快捷键、悬浮窗与托盘等非注入能力', () => {
    for (const platform of ['darwin', 'linux']) {
      const capabilities = detectPlatformCapabilities(platform);
      expect(capabilities.supported, platform).toBe(true);
      expect(capabilities.globalShortcuts, platform).toBe(true);
      expect(capabilities.overlay, platform).toBe(true);
      expect(capabilities.tray, platform).toBe(true);
    }
  });

  it('未知平台降级为不支持注入，而不是抛错', () => {
    const capabilities = detectPlatformCapabilities('sunos');
    expect(capabilities.platform).toBe('other');
    expect(capabilities.gameInjection).toBe(false);
    expect(capabilities.note).toContain('Windows');
    expect(platformLabel('sunos')).toBe('sunos');
  });

  it('平台标识归一化只接受三端白名单', () => {
    expect(normalizePlatform('win32')).toBe('win32');
    expect(normalizePlatform('darwin')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizePlatform('win64')).toBe('other');
    expect(normalizePlatform('')).toBe('other');
  });

  it('macOS / Linux 上 software 后端会被解释为排练', () => {
    expect(platformBackendHint('darwin', 'software')).toContain('排练模式');
    expect(platformBackendHint('linux', 'software')).toContain('排练模式');
    expect(platformBackendHint('win32', 'software')).toContain('SendInput');
  });

  it('能力对象是副本，调用方修改不会污染全局常量', () => {
    const first = detectPlatformCapabilities('win32');
    first.gameInjection = false;
    expect(detectPlatformCapabilities('win32').gameInjection).toBe(true);
  });
});
