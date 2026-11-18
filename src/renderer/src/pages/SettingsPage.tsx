import { DEFAULT_TIMING } from '@core/instrument/plan';
import { DEFAULT_HARMONICA } from '@core/model/instrument';
import { Icon } from '@renderer/components/Icon';
import { PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import type { InputSettings, TimingSettings } from '@shared/types';

const OFFICIAL_LINKS = [
  {
    label: '腾讯《三角洲行动》鼠标宏打击升级公告（最高 10 年封禁）',
    url: 'https://tech.ifeng.com/c/8ozvRBfUiiM',
  },
  {
    label: '腾讯游戏安全中心：鼠标宏就是外挂（2026-07）',
    url: 'https://news.17173.com/content/07162026/135258052.shtml',
  },
  {
    label: '《三角洲行动》主机端违规行为处罚制度',
    url: 'https://www.playdeltaforce.com/zh-tw/detail.html?father_content_id=6c7b5271aaa7ca4f6da9afca986b515cc898&content_id=41304e44a0f79a4158a8a7fa4f4f920cefc7',
  },
];

export function SettingsPage(): JSX.Element {
  const app = useAppStore();
  const input = app.settings.input;

  const patchInput = (patch: Partial<InputSettings>) => {
    void app.updateSettings({ input: { ...input, ...patch } });
  };

  const patchTiming = (patch: Partial<TimingSettings>) => {
    void app.updateSettings({ input: { ...input, timing: { ...input.timing, ...patch } } });
  };

  const patchAudio = (patch: Partial<typeof app.settings.audio>) => {
    void app.updateSettings({ audio: { ...app.settings.audio, ...patch } });
  };

  const relaunch = async () => {
    const result = await window.api.app.relaunchElevated();
    app.showToast(result.ok ? 'info' : 'warning', result.message);
  };

  return (
    <div className="page settings-page">
      <PageHeader
        title="设置与校准"
        subtitle="输入通道、按键时序、窗口与安全选项 —— 所有修改立即保存"
        actions={
          <button type="button" className="button ghost" onClick={() => void window.api.app.openUserData()}>
            <Icon name="folder" size={15} /> 打开数据目录
          </button>
        }
      />

      <div className="settings-grid">
        <section className="card settings-card">
          <h4 className="card-title">
            <Icon name="shield" size={16} /> 权限与输入通道
          </h4>
          <div className={`permission-banner ${app.appInfo?.elevated ? 'ok' : 'warn'}`}>
            <Icon name={app.appInfo?.elevated ? 'check' : 'warning'} size={18} />
            <div>
              <strong>{app.appInfo?.elevated ? '已以管理员权限运行' : '当前不是管理员权限'}</strong>
              <p>
                游戏进程（DeltaForceClient-Win64-Shipping.exe）以管理员（High 完整性）运行。
                Windows 的 UIPI 会<strong>静默丢弃</strong>低权限进程的模拟按键，因此注入游戏必须提权。
              </p>
              {!app.appInfo?.elevated ? (
                <button type="button" className="button primary small" onClick={() => void relaunch()}>
                  以管理员身份重启
                </button>
              ) : null}
            </div>
          </div>

          <label className="field">
            <span className="field-label">输入方式</span>
            <select
              className="select"
              value={input.backend}
              onChange={(event) => patchInput({ backend: event.target.value as InputSettings['backend'] })}
            >
              <option value="software">模拟按键注入游戏（默认）</option>
              <option value="dry-run">排练模式（只走时间轴，不发送按键）</option>
              <option value="serial" disabled>
                串口 / Arduino 硬件输出（预留，尚未启用）
              </option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">目标游戏窗口</span>
            <div className="field-inline">
              <select
                className="select grow"
                value={input.targetWindowHandle ?? 0}
                onChange={(event) => {
                  const handle = Number(event.target.value);
                  const info = app.windows.find((item) => item.handle === handle);
                  patchInput({ targetWindowHandle: handle || null, targetWindowTitle: info?.title ?? null });
                }}
              >
                <option value={0}>未选择</option>
                {app.windows.map((item) => (
                  <option key={item.handle} value={item.handle}>
                    {item.looksLikeGame ? '🎮 ' : ''}
                    {item.title}
                  </option>
                ))}
              </select>
              <button type="button" className="icon-button bordered" onClick={() => void app.refreshWindows()} title="刷新窗口列表">
                <Icon name="refresh" size={15} />
              </button>
            </div>
            <span className="hint-text">
              提示：先在 Windows 里打开游戏到大厅/对局，点击“刷新”后选择标题含“三角洲行动”的窗口。
            </span>
          </label>

          <div className="action-row">
            <button type="button" className="button ghost" onClick={() => app.setSelfTestOpen(true)}>
              <Icon name="target" size={15} /> 输入通道自检
            </button>
            <button type="button" className="button ghost" onClick={() => void app.refreshInputCheck()}>
              <Icon name="refresh" size={15} /> 重新检查
            </button>
          </div>

          {app.inputCheck ? (
            <div className="input-check">
              {app.inputCheck.warnings.map((warning, index) => (
                <p key={index} className="diag diag-warning">
                  <Icon name="warning" size={13} /> {warning}
                </p>
              ))}
              {app.inputCheck.notes.map((note, index) => (
                <p key={index} className="diag diag-info">
                  <Icon name="check" size={13} /> {note}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section className="card settings-card">
          <h4 className="card-title">
            <Icon name="clock" size={16} /> 按键时序（高级）
          </h4>
          <p className="hint-text">
            默认值来自社区实测：修饰键先按下稳定 24ms 再按音符键，相邻音留 12ms 释放窗口，单音最短保持 40ms。
            如果游戏对快速音符漏音，可适当调大“最短保持”和“修饰键稳定时间”。
          </p>
          <div className="timing-grid">
            <label className="field">
              <span className="field-label">修饰键稳定时间（ms）</span>
              <input
                className="input number"
                type="number"
                min={4}
                max={200}
                value={input.timing.modifierSettleMs}
                onChange={(event) => patchTiming({ modifierSettleMs: clamp(Number(event.target.value), 4, 200, 24) })}
              />
            </label>
            <label className="field">
              <span className="field-label">相邻音释放间隔（ms）</span>
              <input
                className="input number"
                type="number"
                min={0}
                max={200}
                value={input.timing.transitionGapMs}
                onChange={(event) => patchTiming({ transitionGapMs: clamp(Number(event.target.value), 0, 200, 12) })}
              />
            </label>
            <label className="field">
              <span className="field-label">最短保持时间（ms）</span>
              <input
                className="input number"
                type="number"
                min={10}
                max={300}
                value={input.timing.minNoteHoldMs}
                onChange={(event) => patchTiming({ minNoteHoldMs: clamp(Number(event.target.value), 10, 300, 40) })}
              />
            </label>
            <label className="field">
              <span className="field-label">修饰键切换间隔（ms）</span>
              <input
                className="input number"
                type="number"
                min={0}
                max={100}
                value={input.timing.modifierReleaseGapMs}
                onChange={(event) => patchTiming({ modifierReleaseGapMs: clamp(Number(event.target.value), 0, 100, 6) })}
              />
            </label>
            <label className="field">
              <span className="field-label">开头留白（ms）</span>
              <input
                className="input number"
                type="number"
                min={0}
                max={500}
                value={input.timing.leadInMs}
                onChange={(event) => patchTiming({ leadInMs: clamp(Number(event.target.value), 0, 500, 90) })}
              />
            </label>
          </div>
          <button
            type="button"
            className="button ghost"
            onClick={() => void app.updateSettings({ input: { ...input, timing: { ...DEFAULT_TIMING } } })}
          >
            <Icon name="refresh" size={15} /> 恢复默认时序
          </button>
        </section>

        <section className="card settings-card">
          <h4 className="card-title">
            <Icon name="target" size={16} /> 安全与兼容
          </h4>
          <label className="switch">
            <input
              type="checkbox"
              checked={input.focusGuard}
              onChange={(event) => patchInput({ focusGuard: event.target.checked })}
            />
            <span>焦点保护：目标窗口失去焦点时立即停止并释放所有按键（强烈建议开启）</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={input.autoFocusTarget}
              onChange={(event) => patchInput({ autoFocusTarget: event.target.checked })}
            />
            <span>开始演奏前自动把目标窗口切到前台</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={input.allowModifierCombos}
              onChange={(event) => patchInput({ allowModifierCombos: event.target.checked })}
            />
            <span>
              允许「鼠标八度键 + 中键半音」组合（默认开启；若实机发现半音只在中音区生效，可关闭此选项让软件按兼容模式排键）
            </span>
          </label>
          <label className="field">
            <span className="field-label">开始前倒计时</span>
            <select
              className="select"
              value={input.countdownSeconds}
              onChange={(event) => patchInput({ countdownSeconds: Number(event.target.value) })}
            >
              <option value={0}>不等待</option>
              <option value={1}>1 秒</option>
              <option value={3}>3 秒</option>
              <option value={5}>5 秒</option>
            </select>
          </label>

          <p className="section-label">音频导入默认参数</p>
          <div className="field-row">
            <label className="field">
              <span className="field-label">量化精度</span>
              <select
                className="select"
                value={app.settings.audio.quantizeGrid}
                onChange={(event) => patchAudio({ quantizeGrid: Number(event.target.value) })}
              >
                <option value={0.125}>1/32（精细）</option>
                <option value={0.25}>1/16（推荐）</option>
                <option value={0.5}>1/8（简化）</option>
              </select>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={app.settings.audio.autoKey}
                onChange={(event) => patchAudio({ autoKey: event.target.checked })}
              />
              <span>自动检测调性</span>
            </label>
          </div>
        </section>

        <section className="card settings-card">
          <h4 className="card-title">
            <Icon name="music" size={16} /> 口琴键位表（PC）
          </h4>
          <p className="hint-text">
            游戏内「守夜人口琴」演奏界面显示：上排音符 1-7 与高音 1，下排按键 Z X C V B N M 和逗号；鼠标三键分别对应降调 / 半音 / 升调。
          </p>
          <div className="keymap">
            <div className="keymap-row">
              {DEFAULT_HARMONICA.noteKeys.slice(0, 7).map((key) => (
                <div key={key.id} className="keymap-cell">
                  <kbd>{key.label}</kbd>
                  <span>{key.degree}</span>
                </div>
              ))}
            </div>
            <div className="keymap-row single">
              <div className="keymap-cell">
                <kbd>,</kbd>
                <span>高音 1</span>
              </div>
            </div>
            <div className="keymap-mouse">
              <span>
                <kbd>鼠标左键</kbd> 降八度
              </span>
              <span>
                <kbd>鼠标中键</kbd> 升半音
              </span>
              <span>
                <kbd>鼠标右键</kbd> 升八度
              </span>
            </div>
          </div>
          <p className="hint-text">
            音域：C3–C#6（约 3 个八度，共 38 个半音），单音演奏。若你的游戏版本改过键位，可在后续版本中使用自定义键位方案（当前版本键位表固定，可通过自检确认）。
          </p>
        </section>

        <section className="card settings-card settings-wide">
          <h4 className="card-title">
            <Icon name="warning" size={16} /> 风险声明与合规提示
          </h4>
          <p className="hint-text">
            本软件是非官方工具，与腾讯 / 天美工作室群无关，仅供个人练习与录制娱乐使用。软件只调用 Windows 标准
            SendInput 模拟键鼠输入，<strong>不注入游戏进程、不读写游戏内存、不安装驱动、不做任何反检测</strong>。
          </p>
          <p className="hint-text">
            但请注意：游戏官方已公开将「第三方软件/脚本/鼠标宏自动操作」列为违规行为，最高封禁 10 年。
            使用本工具存在账号被处罚的风险，且风险由使用者自行承担。建议不要在排位/竞技对局中长时间使用。
          </p>
          <div className="link-list">
            {OFFICIAL_LINKS.map((link) => (
              <button
                key={link.url}
                type="button"
                className="link-button"
                onClick={() => void window.api.shell.openExternal(link.url)}
              >
                <Icon name="chevron" size={13} /> {link.label}
              </button>
            ))}
          </div>
          <div className="about-row">
            <span>版本 v{app.appInfo?.version ?? '0.1.0'}</span>
            <span>Electron {app.appInfo?.electronVersion ?? '-'}</span>
            <span>Chrome {app.appInfo?.chromeVersion ?? '-'}</span>
            <span>Node {app.appInfo?.nodeVersion ?? '-'}</span>
            <span>数据目录：{app.appInfo?.userDataPath ?? '-'}</span>
          </div>
        </section>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
