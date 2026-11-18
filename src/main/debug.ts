/**
 * 轻量文件日志（仅在设置 DFH_DEBUG_LOG 时写入），用于排查打包环境下的启动问题。
 */
import { appendFileSync } from 'node:fs';

const target = process.env.DFH_DEBUG_LOG ?? '';

export function debugLog(message: string): void {
  if (!target) return;
  try {
    appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* 忽略日志失败 */
  }
}

export function installCrashLogging(): void {
  if (!target) return;
  process.on('uncaughtException', (error) => {
    debugLog(`uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    debugLog(`unhandledRejection: ${String(reason)}`);
  });
  process.on('exit', (code) => debugLog(`process exit code=${code}`));
}
