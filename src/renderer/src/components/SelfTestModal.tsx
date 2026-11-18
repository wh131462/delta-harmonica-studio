import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useAppStore } from '@renderer/state/app-store';

const EXPECTED: Array<{ label: string; hint: string }> = [
  { label: 'Z 键按下 / 松开', hint: '中音 1（do）' },
  { label: 'X 键按下 / 松开', hint: '中音 2（re）' },
  { label: '鼠标中键 + 逗号键', hint: '高音 1 升半音（组合修饰键测试）' },
];

/**
 * 输入链路自检：把真实 SendInput 事件注入本窗口，验证系统输入通道可用。
 * 注意：自检只能验证“注入是否生效”，不能替代游戏内实机验证（权限、键位、时序仍需进游戏确认）。
 */
export function SelfTestModal(): JSX.Element | null {
  const app = useAppStore();
  const open = app.selfTestOpen;
  const canInject = app.appInfo?.capabilities.gameInjection ?? true;
  const [running, setRunning] = useState(false);
  const [received, setReceived] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    setReceived([]);
    setErrorText(null);
    setFinished(false);
    setRunning(true);
    runningRef.current = true;
    try {
      const result = await window.api.playback.selfTest();
      if (!result.ok && result.message) setErrorText(result.message);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      runningRef.current = false;
      setTimeout(() => setFinished(true), 700);
    }
  }, []);

  useEffect(() => {
    if (!open || !canInject) return undefined;
    void run();
    const push = (text: string) => {
      // 弹窗打开期间全程记录，便于确认最后一两个事件（如 mouseup）也送达
      setReceived((previous) => [...previous.slice(-40), text]);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'F12' || event.code === 'F9') return;
      push(`keydown ${event.code || event.key}`);
    };
    const onKeyUp = (event: KeyboardEvent) => push(`keyup ${event.code || event.key}`);
    const onMouseDown = (event: MouseEvent) => {
      push(`mousedown button=${event.button}`);
      event.preventDefault();
    };
    const onMouseUp = (event: MouseEvent) => {
      push(`mouseup button=${event.button}`);
      event.preventDefault();
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, [open, canInject, run]);

  if (!open) return null;

  const success =
    received.some((item) => item.startsWith('keydown KeyZ')) &&
    received.some((item) => item.startsWith('keydown KeyX')) &&
    received.some((item) => item.startsWith('keydown Comma')) &&
    received.some((item) => item.startsWith('mousedown button=1'));

  const tone = !canInject ? 'warn' : success ? 'ok' : errorText ? 'danger' : finished ? 'warn' : 'signal';
  const summary = !canInject
    ? `${app.appInfo?.capabilities.label ?? '当前平台'} 版不向系统注入按键，无法进行输入链路自检`
    : success
      ? '注入链路正常：Windows 输入通道与 SendInput 可用'
      : errorText
        ? `自检失败：${errorText}`
        : finished
          ? '未收到完整的注入事件'
          : '正在发送测试事件…';

  return (
    <Modal
      open={open}
      title="输入通道自检"
      subtitle={
        canInject
          ? '验证 Windows SendInput → 本窗口的按键注入链路'
          : `${app.appInfo?.capabilities.label ?? '当前平台'} 版没有按键注入链路`
      }
      onClose={() => app.setSelfTestOpen(false)}
      dismissOnOverlay={false}
      className="selftest-modal"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={() => app.setSelfTestOpen(false)}>
            关闭
          </button>
          {canInject ? (
            <button
              type="button"
              className={`btn btn--primary ${running ? 'btn--loading' : ''}`}
              disabled={running}
              onClick={() => void run()}
            >
              {running ? '自检中' : '重新自检'}
            </button>
          ) : null}
        </>
      }
    >
      <div className="selftest">
        {canInject ? (
          <div className="selftest-grid">
            <section>
            <p className="section-label">将会依次发送</p>
            <ol className="selftest-steps">
              {EXPECTED.map((item, index) => (
                <li key={item.label}>
                  <span className="selftest-step-index">{index + 1}</span>
                  <span className="selftest-step-text">
                    {item.label}
                    <em>{item.hint}</em>
                  </span>
                </li>
              ))}
            </ol>
            <p className="field-hint">
              自检开始后本窗口会被自动切到前台，请勿在此期间操作键盘鼠标。自检只验证「按键注入是否生效」，游戏内的权限、键位与时序仍建议进游戏实测。
            </p>
          </section>

          <section>
            <p className="section-label">窗口实际收到的事件（{received.length}）</p>
            <div className="event-log">
              {received.length === 0 ? (
                <span className="muted">{running ? '等待注入事件…' : '没有收到任何注入事件'}</span>
              ) : (
                received.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)
              )}
            </div>
          </section>
          </div>
        ) : (
          <p className="field-hint">
            本平台没有按键注入链路，自检不会发送任何事件；编辑、导入、练习、试听与宏导出照常可用。需要验证游戏注入时，请在 Windows 版运行自检。
          </p>
        )}

        <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
          <div className="notice__icon" aria-hidden="true">
            <Icon name={success ? 'check' : tone === 'signal' ? 'activity' : 'warning'} size={15} />
          </div>
          <div className="notice__body">
            <strong className="notice__title">{summary}</strong>
            {!success && finished ? (
              <span className="notice__desc">
                确认程序没有被安全软件拦截（可尝试「以管理员身份运行」）、自检时没有切到其他窗口；远程桌面 / 虚拟机环境下模拟输入可能受限。
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
