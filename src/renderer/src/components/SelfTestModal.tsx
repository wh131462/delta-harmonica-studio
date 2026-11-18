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
    if (!open) return undefined;
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
  }, [open, run]);

  if (!open) return null;

  const success =
    received.some((item) => item.startsWith('keydown KeyZ')) &&
    received.some((item) => item.startsWith('keydown KeyX')) &&
    received.some((item) => item.startsWith('keydown Comma')) &&
    received.some((item) => item.startsWith('mousedown button=1'));

  return (
    <Modal
      open={open}
      title="输入通道自检"
      subtitle="验证 Windows SendInput → 本窗口的按键注入链路"
      onClose={() => app.setSelfTestOpen(false)}
      dismissOnOverlay={false}
      footer={
        <>
          <button type="button" className="button ghost" onClick={() => app.setSelfTestOpen(false)}>
            关闭
          </button>
          <button type="button" className="button primary" disabled={running} onClick={() => void run()}>
            {running ? '自检中…' : '重新自检'}
          </button>
        </>
      }
    >
      <div className="selftest">
        <div className="selftest-checklist">
          <p className="section-label">将会依次发送</p>
          <ol>
            {EXPECTED.map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <em>{item.hint}</em>
              </li>
            ))}
          </ol>
          <p className="hint-text">
            自检开始后本窗口会被自动切到前台；请勿在此期间操作键盘鼠标。自检只验证“按键注入是否生效”，游戏内的权限、键位与时序仍建议进游戏实测。
          </p>
        </div>

        <div className="selftest-received">
          <p className="section-label">窗口实际收到的事件（{received.length}）</p>
          <div className="event-log">
            {received.length === 0 ? (
              <span className="muted">{running ? '等待注入事件…' : '没有收到任何注入事件'}</span>
            ) : (
              received.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)
            )}
          </div>
        </div>

        <div className={`selftest-result ${success ? 'ok' : errorText ? 'error' : finished ? 'warn' : ''}`}>
          <Icon name={success ? 'check' : 'warning'} size={18} />
          <div>
            <strong>
              {success
                ? '注入链路正常：Windows 输入通道与 SendInput 可用'
                : errorText
                  ? `自检失败：${errorText}`
                  : finished
                    ? '未收到完整的注入事件'
                    : '自检进行中…'}
            </strong>
            {!success && finished ? (
              <ul>
                <li>确认本程序没有被安全软件拦截（可尝试“以管理员身份运行”）</li>
                <li>确认自检时没有切换到其他窗口</li>
                <li>若系统使用远程桌面/虚拟机，模拟输入可能受限</li>
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
