import { useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useAppStore } from '@renderer/state/app-store';

const RISK_POINTS: Array<{ icon: Parameters<typeof Icon>[0]['name']; text: string }> = [
  {
    icon: 'users',
    text: '建议仅在单人娱乐、录制视频、朋友娱乐等场景使用，不建议在排位 / 竞技对局中长时间开启。',
  },
  {
    icon: 'warning',
    text: '游戏内官方自带的「R 键自动演奏」是官方功能、只能播放已解锁曲目；本工具的自定义演奏与它是两回事。',
  },
  {
    icon: 'music',
    text: '演奏会把口琴声音传遍全图并暴露位置；请自行判断使用时机，由此产生的游戏后果由你自行承担。',
  },
];

/**
 * 首次启动风险确认。
 * 必须如实告知：官方已公开把鼠标宏/脚本/自动点击列为违规，最高封禁 10 年；
 * 本软件不做任何反检测，也不承诺安全。macOS / Linux 版不注入任何按键，提示对应调整。
 */
export function DisclaimerModal(): JSX.Element {
  const app = useAppStore();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = app.ready && !app.settings.disclaimerAccepted;
  const capabilities = app.appInfo?.capabilities;
  const canInject = capabilities?.gameInjection ?? true;
  const injectionPoint = capabilities && !capabilities.gameInjection
    ? {
        icon: 'shield' as const,
        text: `${capabilities.label} 版只提供简谱编辑、导入、练习、试听与宏导出，不向任何窗口注入按键；游戏内演奏需要 Windows 版。`,
      }
    : {
        icon: 'shield' as const,
        text: '本软件不注入游戏进程、不读写游戏内存、不安装驱动、不做反检测，只调用 Windows 标准的 SendInput 模拟按键。',
      };

  const accept = async () => {
    if (!checked) return;
    setBusy(true);
    await app.updateSettings({ disclaimerAccepted: true, disclaimerAcceptedAt: new Date().toISOString() });
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      title="使用前请阅读：风险与合规提示"
      subtitle="本软件是非官方工具，与腾讯 / 天美工作室群无关"
      closable={false}
      className="disclaimer-modal"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={() => window.close()}>
            退出应用
          </button>
          <button
            type="button"
            className={`btn btn--primary ${busy ? 'btn--loading' : ''}`}
            disabled={!checked || busy}
            onClick={() => void accept()}
          >
            {busy ? '正在保存' : '我已了解，开始使用'}
          </button>
        </>
      }
    >
      <div className="disclaimer">
        <div className="notice notice--danger">
          <div className="notice__icon" aria-hidden="true">
            <Icon name="warning" size={15} />
          </div>
          <div className="notice__body">
            <strong className="notice__title">账号风险提示（请务必阅读）</strong>
            <span className="notice__desc">
              《三角洲行动》官方已多次公开表示：通过第三方软件 / 脚本 / 鼠标宏自动完成操作属于违规行为，最高可封禁{' '}
              <strong>10 年</strong>。
              {canInject
                ? '本软件通过「模拟键鼠输入」来演奏口琴，属于第三方模拟输入工具，无法证明也不会被官方认可为合规，因此'
                : '本平台不向游戏注入按键，但导出的宏文件在 Windows 上使用仍属于第三方模拟输入，因此'}
              <strong>存在账号被处罚的真实风险</strong>。
            </span>
          </div>
        </div>

        <ul className="fact-list">
          {[injectionPoint, ...RISK_POINTS].map((point) => (
            <li key={point.text}>
              <Icon name={point.icon} size={15} />
              <span>{point.text}</span>
            </li>
          ))}
        </ul>

        <label className="checkbox-row">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>我已阅读并理解上述风险，自愿使用并自行承担一切后果</span>
        </label>

        <p className="field-hint">
          继续使用即表示你同意：本软件按「现状」提供，作者不对账号处罚、游戏体验或任何间接损失负责。若你不同意，请点击「退出应用」。
        </p>
      </div>
    </Modal>
  );
}
