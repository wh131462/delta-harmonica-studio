import { useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useAppStore } from '@renderer/state/app-store';

/**
 * 首次启动风险确认。
 * 必须如实告知：官方已公开把鼠标宏/脚本/自动点击列为违规，最高封禁 10 年；
 * 本软件不做任何反检测，也不承诺安全。
 */
export function DisclaimerModal(): JSX.Element {
  const app = useAppStore();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = app.ready && !app.settings.disclaimerAccepted;

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
      footer={
        <>
          <button type="button" className="button ghost" onClick={() => window.close()}>
            退出应用
          </button>
          <button type="button" className="button primary" disabled={!checked || busy} onClick={() => void accept()}>
            {busy ? '正在保存…' : '我已了解，开始使用'}
          </button>
        </>
      }
    >
      <div className="disclaimer">
        <div className="disclaimer-banner">
          <Icon name="warning" size={22} />
          <div>
            <strong>账号风险提示（请务必阅读）</strong>
            <p>
              《三角洲行动》官方已多次公开表示：通过第三方软件 / 脚本 / 鼠标宏自动完成操作属于违规行为，
              最高可封禁 <strong>10 年</strong>。本软件通过“模拟键鼠输入”来演奏口琴，属于第三方模拟输入工具，
              无法证明也不会被官方认可为合规，因此<strong>存在账号被处罚的真实风险</strong>。
            </p>
          </div>
        </div>

        <ul className="disclaimer-list">
          <li>
            <Icon name="shield" size={15} />
            <span>本软件<strong>不注入游戏进程、不读写游戏内存、不安装驱动、不做反检测</strong>，只调用 Windows 标准的 SendInput 模拟按键。</span>
          </li>
          <li>
            <Icon name="target" size={15} />
            <span>建议仅在<strong>单人娱乐、录制视频、朋友娱乐</strong>等场景使用，不建议在排位/竞技对局中长时间开启。</span>
          </li>
          <li>
            <Icon name="warning" size={15} />
            <span>游戏内官方自带的 “R 键自动演奏” 是官方功能、只能播放已解锁曲目；本工具的自定义演奏与它是两回事。</span>
          </li>
          <li>
            <Icon name="music" size={15} />
            <span>演奏会把口琴声音传遍全图并暴露位置；请自行判断使用时机，由此产生的游戏后果由你自行承担。</span>
          </li>
        </ul>

        <div className="disclaimer-actions">
          <label className="checkbox-row">
            <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
            <span>我已阅读并理解上述风险，自愿使用并自行承担一切后果</span>
          </label>
        </div>

        <p className="disclaimer-footnote">
          继续使用即表示你同意：本软件按“现状”提供，作者不对账号处罚、游戏体验或任何间接损失负责。若你不同意，请点击“退出应用”。
        </p>
      </div>
    </Modal>
  );
}
