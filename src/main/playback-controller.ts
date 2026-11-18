/**
 * 演奏排程器（Electron 主进程）：
 * - 绝对时间轴：所有事件按相对毫秒时间戳对齐到同一个起点，不会累积漂移
 * - 混合等待：远距离 sleep + 最后 4ms 自旋，配合 timeBeginPeriod(1) 把抖动压到毫秒级
 * - 焦点看门狗：目标窗口一旦不在前台立即停手并释放所有按键（避免误输入到聊天框）
 * - 全量松键：任何停止/异常路径都会释放已按下的键与鼠标键（安全第一）
 */
import { getNativeBridge, getPlatformCapabilities, isTargetForeground } from './native';
import type { InputEvent } from '@core/instrument/plan';
import type { InputBackend, PlaybackRequest, PlaybackStatus, StartPlaybackResult } from '@shared/types';

const NS_PER_MS = 1_000_000n;
const SPIN_THRESHOLD_NS = 4n * NS_PER_MS;
const FOCUS_POLL_MS = 80;

const nowNs = (): bigint => process.hrtime.bigint();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type PlaybackStatusListener = (status: PlaybackStatus) => void;

type Phase = 'idle' | 'countdown' | 'playing';

export class PlaybackController {
  private phase: Phase = 'idle';
  private cancelled = false;
  private runId = 0;
  private pressedKeys = new Map<string, InputEvent>();
  private pressedButtons = new Set<'left' | 'middle' | 'right'>();
  private focusTimer: ReturnType<typeof setInterval> | null = null;
  private focusGuard = true;
  private targetHandle: number | null = null;
  private backend: InputBackend = 'software';
  /** 计划中是否存在鼠标按键事件（鼠标事件投递到光标下窗口，必须保证光标在目标窗口内） */
  private usesMouseEvents = false;

  constructor(private readonly emit: PlaybackStatusListener) {}

  isRunning(): boolean {
    return this.phase !== 'idle';
  }

  private getBridge() {
    return getNativeBridge();
  }

  /** 开始演奏（含倒计时、焦点检查） */
  async start(request: PlaybackRequest): Promise<StartPlaybackResult> {
    if (this.phase !== 'idle') {
      await this.stop('新的演奏已开始');
    }
    const events = Array.isArray(request.events) ? request.events : [];
    if (events.length === 0) return { ok: false, message: '演奏计划为空' };

    const capabilities = getPlatformCapabilities();
    const bridge = this.getBridge();
    if (request.backend === 'serial') {
      return { ok: false, message: '串口/Arduino 硬件输出尚未启用（预留接口），请使用“模拟按键”或“仅试听”模式' };
    }
    if (request.backend === 'software' && !capabilities.gameInjection) {
      return {
        ok: false,
        message: `${capabilities.label} 版不向其他窗口注入按键：请在设置里使用「排练模式」，或改用 Windows 版演奏。`,
      };
    }
    if (request.backend === 'software' && !bridge.available) {
      return { ok: false, message: `原生按键桥不可用：${bridge.error ?? '未知错误'}` };
    }
    if (request.backend === 'software' && !bridge.elevated) {
      return {
        ok: false,
        message: '当前不是管理员权限：游戏以管理员权限运行时，Windows 会静默丢弃本程序的模拟按键。请点击状态栏或设置页的「以管理员身份重启」，在 UAC 弹窗中确认后再演奏。',
      };
    }

    this.runId += 1;
    const runId = this.runId;
    this.cancelled = false;
    this.phase = 'countdown';
    this.backend = request.backend;
    this.focusGuard = request.focusGuard;
    this.targetHandle = request.targetWindowHandle;
    this.usesMouseEvents = events.some((event) => event.kind === 'mousedown' || event.kind === 'mouseup');
    this.pressedKeys.clear();
    this.pressedButtons.clear();

    try {
      // 目标窗口前台检查 / 自动切换
      if (this.focusGuard && this.targetHandle) {
        if (!isTargetForeground(this.targetHandle)) {
          if (request.autoFocusTarget) {
            bridge.focusWindow(this.targetHandle);
            await sleep(150);
          }
          if (!isTargetForeground(this.targetHandle)) {
            this.phase = 'idle';
            return {
              ok: false,
              message: '游戏窗口当前不在前台：请先切回游戏（或关闭“焦点保护”后重试）。为保证安全，本次未发送任何按键。',
            };
          }
        }
      }

      // 鼠标修饰键（低八度/高八度/升半音）依赖鼠标位置：必须让光标落在游戏窗口内
      if (this.backend === 'software' && this.targetHandle && this.usesMouseEvents) {
        if (!bridge.ensureCursorInsideWindow(this.targetHandle)) {
          this.phase = 'idle';
          return {
            ok: false,
            message:
              '无法把鼠标光标移入游戏窗口（窗口可能已最小化或被其他窗口遮挡）。口琴的低/高八度与半音依赖鼠标按键，必须让鼠标位于游戏窗口内。请手动处理后重试。',
          };
        }
      }

      // 倒计时（给用户切回游戏的时间）
      for (let remaining = Math.max(0, Math.floor(request.countdownSeconds)); remaining > 0; remaining -= 1) {
        if (this.cancelled || runId !== this.runId) {
          this.phase = 'idle';
          this.emit({ state: 'stopped', message: '已取消演奏', totalMs: request.durationMs });
          return { ok: false, message: '已取消' };
        }
        this.emit({ state: 'countdown', countdown: remaining, totalMs: request.durationMs });
        await sleep(1000);
      }
      if (this.cancelled || runId !== this.runId) {
        this.phase = 'idle';
        this.emit({ state: 'stopped', message: '已取消演奏', totalMs: request.durationMs });
        return { ok: false, message: '已取消' };
      }

      this.phase = 'playing';
      bridge.beginPrecision();
      this.startFocusWatch();
      this.emit({ state: 'playing', totalMs: request.durationMs, elapsedMs: 0, eventsSent: 0 });

      const startNs = nowNs();
      let sent = 0;
      for (let index = 0; index < events.length; index += 1) {
        if (this.cancelled || runId !== this.runId) break;
        const target = startNs + BigInt(Math.round(events[index].t * 1_000_000));
        await this.waitUntil(target);
        if (this.cancelled || runId !== this.runId) break;

        if (this.focusGuard && this.targetHandle && !isTargetForeground(this.targetHandle)) {
          this.cancelled = true;
          this.releaseAll();
          this.emit({ state: 'focus-lost', message: '游戏窗口失去焦点：已自动停止并释放全部按键' });
          return { ok: false, message: '游戏窗口失去焦点，已自动停止' };
        }

        if (this.backend === 'software') {
          this.getBridge().sendEvents([events[index]]);
        }
        this.track(events[index]);
        sent += 1;

        if (index % 30 === 0 || index === events.length - 1) {
          const elapsedMs = Number((nowNs() - startNs) / NS_PER_MS);
          this.emit({ state: 'playing', elapsedMs, totalMs: request.durationMs, eventsSent: sent });
        }
      }

      if (this.cancelled) {
        this.emit({ state: 'stopped', message: '已停止演奏', totalMs: request.durationMs });
        return { ok: false, message: '已停止' };
      }

      this.emit({ state: 'finished', elapsedMs: request.durationMs, totalMs: request.durationMs, eventsSent: sent });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ state: 'error', message });
      return { ok: false, message };
    } finally {
      this.cleanup();
    }
  }

  /** 请求停止（可由全局热键 F12 / UI 调用） */
  async stop(message = '已停止演奏'): Promise<void> {
    const wasActive = this.phase !== 'idle';
    this.cancelled = true;
    this.runId += 1;
    this.releaseAll();
    this.cleanup();
    if (wasActive) {
      this.emit({ state: 'stopped', message });
    }
  }

  /** 紧急释放所有按下的键（不改变运行状态） */
  async panicRelease(): Promise<void> {
    this.releaseAll();
  }

  private async waitUntil(targetNs: bigint): Promise<void> {
    for (;;) {
      if (this.cancelled) return;
      const diff = targetNs - nowNs();
      if (diff <= 0n) return;
      if (diff > SPIN_THRESHOLD_NS) {
        const sleepMs = Math.max(1, Math.min(30, Number((diff - SPIN_THRESHOLD_NS) / NS_PER_MS)));
        await sleep(sleepMs);
      }
      // 剩余 <= 4ms：自旋等待，保证毫秒级精度
    }
  }

  private startFocusWatch(): void {
    this.stopFocusWatch();
    if (!this.focusGuard || !this.targetHandle) return;
    this.focusTimer = setInterval(() => {
      if (this.phase !== 'playing' || !this.targetHandle) return;
      if (!isTargetForeground(this.targetHandle)) {
        this.cancelled = true;
        this.releaseAll();
        this.emit({ state: 'focus-lost', message: '游戏窗口失去焦点：已自动停止并释放全部按键' });
        return;
      }
      if (this.usesMouseEvents && !this.getBridge().isCursorInsideWindow(this.targetHandle)) {
        this.cancelled = true;
        this.releaseAll();
        this.emit({ state: 'focus-lost', message: '鼠标光标离开了游戏窗口：已自动停止（否则八度/半音修饰键会失效或误点到其他程序）' });
      }
    }, FOCUS_POLL_MS);
  }

  private stopFocusWatch(): void {
    if (this.focusTimer) {
      clearInterval(this.focusTimer);
      this.focusTimer = null;
    }
  }

  private track(event: InputEvent): void {
    if (event.kind === 'keydown' && event.keyId) this.pressedKeys.set(event.keyId, event);
    else if (event.kind === 'keyup' && event.keyId) this.pressedKeys.delete(event.keyId);
    else if (event.kind === 'mousedown' && event.button) this.pressedButtons.add(event.button);
    else if (event.kind === 'mouseup' && event.button) this.pressedButtons.delete(event.button);
  }

  /** 释放所有当前按下的键/鼠标键 */
  private releaseAll(): void {
    if (this.pressedKeys.size === 0 && this.pressedButtons.size === 0) return;
    const bridge = this.getBridge();
    const events: InputEvent[] = [];
    for (const [keyId, keyEvent] of this.pressedKeys) {
      events.push({
        t: 0,
        kind: 'keyup',
        label: `${keyId} release`,
        keyId: keyEvent.keyId,
        vk: keyEvent.vk,
        scan: keyEvent.scan,
      });
    }
    for (const button of this.pressedButtons) {
      events.push({ t: 0, kind: 'mouseup', label: `${button} release`, button });
    }
    if (bridge.available && events.length > 0) bridge.sendEvents(events);
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }

  private cleanup(): void {
    this.stopFocusWatch();
    this.releaseAll();
    this.getBridge().endPrecision();
    this.phase = 'idle';
  }

  /** 输入链路自检：只使用中键与字母/逗号键，避免误触 UI 左键 */
  async selfTest(): Promise<StartPlaybackResult> {
    const events: InputEvent[] = [
      { t: 0, kind: 'keydown', label: 'Z down', keyId: 'k1', vk: 0x5a, scan: 0x2c },
      { t: 130, kind: 'keyup', label: 'Z up', keyId: 'k1', vk: 0x5a, scan: 0x2c },
      { t: 200, kind: 'keydown', label: 'X down', keyId: 'k2', vk: 0x58, scan: 0x2d },
      { t: 330, kind: 'keyup', label: 'X up', keyId: 'k2', vk: 0x58, scan: 0x2d },
      { t: 420, kind: 'mousedown', label: 'middle down', button: 'middle' },
      { t: 470, kind: 'keydown', label: ', down', keyId: 'k8', vk: 0xbc, scan: 0x33 },
      { t: 600, kind: 'keyup', label: ', up', keyId: 'k8', vk: 0xbc, scan: 0x33 },
      { t: 650, kind: 'mouseup', label: 'middle up', button: 'middle' },
    ];
    return this.start({
      events,
      durationMs: 800,
      countdownSeconds: 0,
      focusGuard: false,
      autoFocusTarget: false,
      targetWindowHandle: null,
      backend: 'software',
      title: '输入链路自检',
    });
  }
}
