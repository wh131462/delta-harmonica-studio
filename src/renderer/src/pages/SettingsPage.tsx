/**
 * 设置与校准页面（分 Tab 重构版）
 * ------------------------------------------------------------------
 * Tab 结构：
 *  1. 输入与权限：管理员权限横幅、输入方式、目标窗口、输入通道自检、演奏安全选项
 *  2. 演奏时序：5 个毫秒参数 + 时序示意 + 调参建议 + 恢复默认
 *  3. 快捷键：4 个全局动作的录制/保存/注册状态展示（HotkeyRecorder）
 *  4. 悬浮窗与外观：显隐、置顶、透明度、快捷键提示、重置位置、试听音色与音量
 *  5. 音频分析：主旋律提取模式、音域、最短音符、伴奏抑制、量化网格、自动调性
 *  6. 风险与关于：风险声明、官方公告、版本信息、数据目录、口琴键位表
 *
 * 约定：
 * - 所有设置改动即时写入 app.updateSettings（内部的 settings:update），并给出 toast；
 * - 页面级样式见 ../styles/settings.css（类名 st- 前缀）；
 * - 快捷键录制逻辑封装在 @renderer/components/HotkeyRecorder。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_TIMING } from '@core/instrument/plan';
import { DEFAULT_HARMONICA } from '@core/model/instrument';
import { midiToName } from '@core/model/pitch';
import { HotkeyRecorder, formatAccelerator } from '@renderer/components/HotkeyRecorder';
import { Icon, type IconName } from '@renderer/components/Icon';
import { PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { DEFAULT_SETTINGS, describeInputReadiness } from '@shared/settings';
import type {
  AudioAnalysisSettings,
  HotkeyAction,
  HotkeyRegistrationStatus,
  HotkeySettings,
  InputBackend,
  InputSettings,
  MelodyAnalysisMode,
  OverlaySettings,
  PreviewInstrument,
  PreviewSettings,
  TimingSettings,
} from '@shared/types';
import '../styles/settings.css';

/* ============================================================
   常量与配置
   ============================================================ */

type SettingsTabId = 'input' | 'timing' | 'hotkeys' | 'overlay' | 'audio' | 'about';

interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
  icon: IconName;
}

const TABS: SettingsTabDef[] = [
  { id: 'input', label: '输入与权限', icon: 'shield' },
  { id: 'timing', label: '演奏时序', icon: 'clock' },
  { id: 'hotkeys', label: '快捷键', icon: 'settings' },
  { id: 'overlay', label: '悬浮窗与外观', icon: 'overlay' },
  { id: 'audio', label: '音频分析', icon: 'music' },
  { id: 'about', label: '风险与关于', icon: 'warning' },
];

const INPUT_BACKEND_OPTIONS: Array<{ id: InputBackend; label: string; description: string; disabled?: boolean }> = [
  {
    id: 'software',
    label: '模拟按键注入游戏（推荐）',
    description: '通过 Win32 SendInput 向目标窗口发送真实键鼠事件；需要管理员权限才能注入游戏。',
  },
  {
    id: 'dry-run',
    label: '排练模式（不发送按键）',
    description: '只按时间轴走一遍流程，适合校准/录像前确认节奏，不会影响游戏。',
  },
  {
    id: 'serial',
    label: '串口 / Arduino 硬件输出（预留，尚未启用）',
    description: '预留的外部硬件通道，当前版本不可用。',
    disabled: true,
  },
];

const INPUT_BACKEND_LABEL: Record<InputBackend, string> = {
  software: '游戏注入',
  'dry-run': '排练模式',
  serial: '串口硬件',
};

interface HotkeyMeta {
  label: string;
  description: string;
  icon: IconName;
  defaultAccelerator: string;
}

const HOTKEY_ACTIONS: HotkeyAction[] = ['togglePlay', 'panicStop', 'toggleOverlay', 'showMain'];

const HOTKEY_META: Record<HotkeyAction, HotkeyMeta> = {
  togglePlay: {
    label: '开始 / 停止演奏',
    description: '在演奏台开始倒计时演奏；演奏中再次按下则停止并释放按键',
    icon: 'play',
    defaultAccelerator: DEFAULT_SETTINGS.hotkeys.togglePlay,
  },
  panicStop: {
    label: '紧急停止',
    description: '立刻停止并释放所有按下的键鼠，优先级最高，建议保留易按的独立按键',
    icon: 'stop',
    defaultAccelerator: DEFAULT_SETTINGS.hotkeys.panicStop,
  },
  toggleOverlay: {
    label: '显示 / 隐藏悬浮窗',
    description: '在游戏画面上显示或收起悬浮控制窗（不抢游戏焦点）',
    icon: 'overlay',
    defaultAccelerator: DEFAULT_SETTINGS.hotkeys.toggleOverlay,
  },
  showMain: {
    label: '显示主窗口',
    description: '把主窗口从后台 / 最小化状态唤到前台',
    icon: 'window',
    defaultAccelerator: DEFAULT_SETTINGS.hotkeys.showMain,
  },
};

interface TimingFieldDef {
  key: keyof TimingSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

const TIMING_FIELDS: TimingFieldDef[] = [
  {
    key: 'modifierSettleMs',
    label: '修饰键稳定时间',
    min: 4,
    max: 200,
    step: 1,
    hint: '按住鼠标修饰键后先稳定这么久，再按音符键，避免游戏丢掉修饰键。',
  },
  {
    key: 'transitionGapMs',
    label: '相邻音释放间隔',
    min: 0,
    max: 200,
    step: 1,
    hint: '两个音之间松开按键的间隔：太小容易粘连，太大容易出现断音。',
  },
  {
    key: 'minNoteHoldMs',
    label: '最短音符保持',
    min: 10,
    max: 300,
    step: 1,
    hint: '每个音至少按住这么久，防止快速音符被游戏吞掉。',
  },
  {
    key: 'modifierReleaseGapMs',
    label: '修饰键切换间隔',
    min: 0,
    max: 100,
    step: 1,
    hint: '切换鼠标修饰键（八度 / 半音）时前后留出的安全间隔。',
  },
  {
    key: 'leadInMs',
    label: '开头留白',
    min: 0,
    max: 500,
    step: 10,
    hint: '开始演奏后、第一个音之前的准备时间，避免第一个音丢失。',
  },
];

const MELODY_MODE_OPTIONS: Array<{ id: MelodyAnalysisMode; name: string; description: string }> = [
  { id: 'auto', name: '自动判断', description: '分析音频复音程度，自动选择单声部 / 复音策略（推荐）' },
  { id: 'monophonic', name: '单声部', description: '清唱、独奏等单旋律音频，使用基频跟踪' },
  { id: 'polyphonic', name: '复音 / 带伴奏', description: 'HPSS 分离伴奏 + 谐波显著度跟踪主旋律' },
];

const PREVIEW_INSTRUMENTS: Array<{ id: PreviewInstrument; name: string; description: string }> = [
  { id: 'harmonica', name: '口琴', description: '簧片泛音，接近游戏内听感' },
  { id: 'piano', name: '钢琴', description: '干净音头，便于核对音高与节奏' },
];

const PITCH_MIN = 48;
const PITCH_MAX = 84;

const PITCH_PRESETS: Array<{ label: string; min: number; max: number }> = [
  { label: 'C3 – C6（默认）', min: 48, max: 84 },
  { label: 'C4 – C6', min: 60, max: 84 },
  { label: 'C3 – C5', min: 48, max: 72 },
];

const QUANTIZE_LABEL: Record<number, string> = {
  0.125: '1/32',
  0.25: '1/16',
  0.5: '1/8',
};

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

/** 把错误对象转成可读文案 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ============================================================
   页面组件
   ============================================================ */

export function SettingsPage(): JSX.Element {
  const app = useAppStore();
  const { settings, appInfo, inputCheck, windows } = app;
  const { showToast, updateSettings, refreshWindows, refreshInputCheck, setSelfTestOpen, overlayVisible } = app;

  const [tab, setTab] = useState<SettingsTabId>('input');
  /** 当前正在录制的动作（用于互斥其他录制器） */
  const [recordingAction, setRecordingAction] = useState<HotkeyAction | null>(null);
  /** 快捷键注册状态（来自主进程 globalShortcut） */
  const [hotkeyStatuses, setHotkeyStatuses] = useState<HotkeyRegistrationStatus[] | null>(null);
  const [hotkeyStatusLoading, setHotkeyStatusLoading] = useState(true);
  const [hotkeyStatusError, setHotkeyStatusError] = useState(false);
  const [refreshingWindows, setRefreshingWindows] = useState(false);
  const [refreshingCheck, setRefreshingCheck] = useState(false);
  const [elevating, setElevating] = useState(false);

  // 异步回调里读取最新设置，避免闭包拿到旧值
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /* ---------------- 保存辅助（所有改动即时保存 + toast） ---------------- */

  const patchInput = useCallback(
    (patch: Partial<InputSettings>, message: string) => {
      const current = settingsRef.current.input;
      void updateSettings({ input: { ...current, ...patch } });
      showToast('success', message);
    },
    [showToast, updateSettings],
  );

  const patchTiming = useCallback(
    (patch: Partial<TimingSettings>, message: string) => {
      const current = settingsRef.current.input;
      void updateSettings({ input: { ...current, timing: { ...current.timing, ...patch } } });
      showToast('success', message);
    },
    [showToast, updateSettings],
  );

  const patchAudio = useCallback(
    (patch: Partial<AudioAnalysisSettings>, message: string) => {
      const current = settingsRef.current.audio;
      void updateSettings({ audio: { ...current, ...patch } });
      showToast('success', message);
    },
    [showToast, updateSettings],
  );

  const patchOverlay = useCallback(
    (patch: Partial<OverlaySettings>, message: string) => {
      const current = settingsRef.current.overlay;
      void updateSettings({ overlay: { ...current, ...patch } });
      showToast('success', message);
    },
    [showToast, updateSettings],
  );

  const patchPreview = useCallback(
    (patch: Partial<PreviewSettings>, message: string) => {
      const current = settingsRef.current.preview;
      void updateSettings({ preview: { ...current, ...patch } });
      showToast('success', message);
    },
    [showToast, updateSettings],
  );

  /* ---------------- 快捷键注册状态 ---------------- */

  const refreshHotkeyStatuses = useCallback(async () => {
    setHotkeyStatusLoading(true);
    setHotkeyStatusError(false);
    try {
      const list = await window.api.hotkeys.status();
      setHotkeyStatuses(list);
    } catch {
      setHotkeyStatuses(null);
      setHotkeyStatusError(true);
    } finally {
      setHotkeyStatusLoading(false);
    }
  }, []);

  // 首次进入设置页就拉一次注册状态（Tab 上有失败计数徽标）
  useEffect(() => {
    void refreshHotkeyStatuses();
  }, [refreshHotkeyStatuses]);

  // 切到快捷键 Tab 时再刷新一次，确保展示的是最新注册结果
  useEffect(() => {
    if (tab === 'hotkeys') void refreshHotkeyStatuses();
  }, [tab, refreshHotkeyStatuses]);

  /** 保存整组快捷键，成功后刷新主进程注册状态 */
  const saveHotkeys = useCallback(
    async (next: HotkeySettings, message: string) => {
      const current = settingsRef.current.hotkeys;
      const unchanged = HOTKEY_ACTIONS.every((action) => next[action] === current[action]);
      if (unchanged) return;
      await updateSettings({ hotkeys: next });
      showToast('success', message);
      // 主进程在 settings:update 内同步重建注册，这里 await 后 status 即为最新
      await refreshHotkeyStatuses();
    },
    [refreshHotkeyStatuses, showToast, updateSettings],
  );

  const handleRecordChange = useCallback(
    (action: HotkeyAction, accelerator: string) => {
      const next: HotkeySettings = { ...settingsRef.current.hotkeys };
      next[action] = accelerator;
      void saveHotkeys(next, `${HOTKEY_META[action].label}快捷键已更新为 ${formatAccelerator(accelerator)}`);
    },
    [saveHotkeys],
  );

  const handleRecordingChange = useCallback((action: HotkeyAction, recording: boolean) => {
    setRecordingAction((current) => {
      if (recording) return action;
      return current === action ? null : current;
    });
    // 录制期间临时注销全局热键，避免按 F9/F10 等录制时触发旧动作
    void window.api.hotkeys.setRecording(recording).catch(() => undefined);
  }, []);

  const resetHotkeys = useCallback(() => {
    const defaults = DEFAULT_SETTINGS.hotkeys;
    void saveHotkeys(
      { ...defaults },
      `快捷键已恢复默认（${defaults.togglePlay} / ${defaults.panicStop} / ${defaults.toggleOverlay} / ${defaults.showMain}）`,
    );
  }, [saveHotkeys]);

  /** 动作 → 注册状态 */
  const statusByAction = useMemo(() => {
    const map = new Map<HotkeyAction, HotkeyRegistrationStatus>();
    for (const status of hotkeyStatuses ?? []) map.set(status.action, status);
    return map;
  }, [hotkeyStatuses]);

  const registeredCount = hotkeyStatuses ? hotkeyStatuses.filter((item) => item.registered).length : 0;
  const failedCount = hotkeyStatuses ? hotkeyStatuses.filter((item) => !item.registered).length : 0;

  /** 客户端预检：两个动作录了同一个组合时提前提示 */
  const hotkeyConflicts = useMemo<Partial<Record<HotkeyAction, string>>>(() => {
    const groups = new Map<string, HotkeyAction[]>();
    for (const action of HOTKEY_ACTIONS) {
      const accelerator = (settings.hotkeys[action] ?? '').trim().toLowerCase();
      if (!accelerator) continue;
      const list = groups.get(accelerator);
      if (list) list.push(action);
      else groups.set(accelerator, [action]);
    }
    const conflicts: Partial<Record<HotkeyAction, string>> = {};
    for (const actions of groups.values()) {
      if (actions.length < 2) continue;
      for (const action of actions) {
        const others = actions
          .filter((item) => item !== action)
          .map((item) => `「${HOTKEY_META[item].label}」`)
          .join('、');
        conflicts[action] = `与${others}使用了相同快捷键，后注册的会失败`;
      }
    }
    return conflicts;
  }, [settings.hotkeys]);

  /* ---------------- 其它动作 ---------------- */

  const handleRefreshWindows = useCallback(async () => {
    if (refreshingWindows) return;
    setRefreshingWindows(true);
    try {
      await refreshWindows();
      showToast('success', '窗口列表已刷新');
    } finally {
      setRefreshingWindows(false);
    }
  }, [refreshWindows, refreshingWindows, showToast]);

  const handleRefreshCheck = useCallback(async () => {
    if (refreshingCheck) return;
    setRefreshingCheck(true);
    try {
      await refreshInputCheck();
      showToast('success', '输入通道状态已刷新');
    } finally {
      setRefreshingCheck(false);
    }
  }, [refreshInputCheck, refreshingCheck, showToast]);

  const handleRelaunch = useCallback(async () => {
    if (elevating) return;
    setElevating(true);
    try {
      const result = await window.api.app.relaunchElevated();
      showToast(result.ok ? 'info' : 'warning', result.message);
    } catch (error) {
      showToast('error', `提权重启失败：${errorText(error)}`);
    } finally {
      setElevating(false);
    }
  }, [elevating, showToast]);

  const openUserData = useCallback(() => {
    void window.api.app
      .openUserData()
      .then(() => showToast('info', '已打开数据目录'))
      .catch((error: unknown) => showToast('error', `打开数据目录失败：${errorText(error)}`));
  }, [showToast]);

  const openExternal = useCallback(
    (url: string) => {
      void window.api.shell.openExternal(url).catch((error: unknown) => showToast('error', `打开链接失败：${errorText(error)}`));
    },
    [showToast],
  );

  /** 显示 / 隐藏悬浮窗（主进程持久化 visible，并广播 overlay:visibility 同步 store） */
  const handleToggleOverlay = useCallback(async () => {
    const target = !overlayVisible;
    try {
      const actual = await window.api.overlay.setVisible(target);
      showToast('success', actual ? '悬浮窗已显示：可在游戏画面上拖动调整位置' : '悬浮窗已隐藏');
    } catch (error) {
      showToast('error', `悬浮窗操作失败：${errorText(error)}`);
    }
  }, [overlayVisible, showToast]);

  const handleResetOverlayPosition = useCallback(() => {
    const current = settingsRef.current.overlay;
    void updateSettings({ overlay: { ...current, position: null } });
    showToast('success', '悬浮窗位置已重置为默认（重启应用后生效）');
  }, [showToast, updateSettings]);

  const resetTiming = useCallback(() => {
    const current = settingsRef.current.input;
    void updateSettings({ input: { ...current, timing: { ...DEFAULT_TIMING } } });
    showToast('success', '演奏时序已恢复默认');
  }, [showToast, updateSettings]);

  const resetAudio = useCallback(() => {
    void updateSettings({ audio: { ...DEFAULT_SETTINGS.audio } });
    showToast('success', '音频分析参数已恢复默认');
  }, [showToast, updateSettings]);

  /* ---------------- 派生数据 ---------------- */

  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];
  const readiness = inputCheck ? describeInputReadiness(inputCheck) : null;
  const currentBackend = INPUT_BACKEND_OPTIONS.find((option) => option.id === settings.input.backend);
  const recordingLabel = recordingAction ? HOTKEY_META[recordingAction].label : null;

  /** 渲染某个动作的注册状态徽标 */
  const renderHotkeyStatus = (action: HotkeyAction): JSX.Element => {
    if (hotkeyStatusError) return <span className="st-badge">状态未知</span>;
    const status = statusByAction.get(action);
    if (!status) return <span className="st-badge">{hotkeyStatusLoading ? '检测中…' : '未检测'}</span>;
    if (status.registered) {
      return (
        <span className="st-badge ok">
          <Icon name="check" size={11} /> 已生效
        </span>
      );
    }
    return (
      <>
        <span className="st-badge danger">
          <Icon name="warning" size={11} /> 注册失败
        </span>
        {status.error ? <span className="st-hotkey-error">{status.error}</span> : null}
      </>
    );
  };

  /* ============================================================
     Tab 1：输入与权限
     ============================================================ */
  const inputTab = (
    <div className="st-panel">
      <div className={`st-banner ${appInfo?.elevated ? 'ok' : 'warn'}`}>
        <Icon name={appInfo?.elevated ? 'check' : 'warning'} size={19} />
        <div className="st-banner-text">
          <strong>{appInfo?.elevated ? '已以管理员权限运行' : '当前不是管理员权限'}</strong>
          <p>
            游戏进程以管理员（High 完整性）运行，Windows 的 UIPI 会<em>静默丢弃</em>低权限进程的模拟按键，因此注入游戏必须提权。
            排练模式与应用内试听不受影响。
          </p>
          {appInfo && !appInfo.elevated ? (
            <div className="st-banner-actions">
              <button type="button" className="button primary small" onClick={() => void handleRelaunch()} disabled={elevating}>
                <Icon name="shield" size={14} /> {elevating ? '正在请求重启…' : '以管理员身份重启'}
              </button>
              <button type="button" className="button ghost small" onClick={openUserData}>
                <Icon name="folder" size={14} /> 打开数据目录
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="st-grid">
        <section className="st-card">
          <CardHead icon="target" title="输入方式与目标窗口" subtitle="按键事件发往哪里、以什么方式发送" />
          <div className="st-fields">
            <label className="field">
              <span className="field-label">输入方式</span>
              <select
                className="select"
                value={settings.input.backend}
                onChange={(event) => {
                  const backend = event.target.value as InputBackend;
                  const option = INPUT_BACKEND_OPTIONS.find((item) => item.id === backend);
                  patchInput({ backend }, `输入方式已切换为「${option?.label ?? backend}」`);
                }}
              >
                {INPUT_BACKEND_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="hint-text">{currentBackend?.description}</span>
            </label>

            <label className="field">
              <span className="field-label">目标游戏窗口</span>
              <div className="field-inline">
                <select
                  className="select grow"
                  value={settings.input.targetWindowHandle ?? 0}
                  onChange={(event) => {
                    const handle = Number(event.target.value);
                    const info = windows.find((item) => item.handle === handle);
                    if (!handle) {
                      patchInput({ targetWindowHandle: null, targetWindowTitle: null }, '已清除目标窗口');
                      return;
                    }
                    patchInput({ targetWindowHandle: handle, targetWindowTitle: info?.title ?? null }, `目标窗口已设为「${info?.title ?? handle}」`);
                  }}
                >
                  <option value={0}>未选择（排练模式可跳过）</option>
                  {windows.map((item) => (
                    <option key={item.handle} value={item.handle}>
                      {`${item.looksLikeGame ? '🎮 ' : ''}${item.title}${item.isForeground ? '（当前前台）' : ''}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button bordered"
                  title="刷新窗口列表"
                  onClick={() => void handleRefreshWindows()}
                  disabled={refreshingWindows}
                >
                  <Icon name="refresh" size={15} />
                </button>
              </div>
              <span className="hint-text">
                先在 Windows 打开游戏，让它出现在列表中；点击刷新后选择标题含「三角洲行动」的窗口（共 {windows.length} 个窗口）。
              </span>
              {settings.input.targetWindowTitle ? (
                <span className="hint-text">
                  当前目标：{settings.input.targetWindowTitle}
                  {settings.input.targetWindowHandle ? `（HWND ${settings.input.targetWindowHandle}）` : ''}
                </span>
              ) : null}
            </label>
          </div>

          <div className="st-inline-actions">
            <button type="button" className="button ghost small" onClick={() => setSelfTestOpen(true)}>
              <Icon name="target" size={14} /> 输入通道自检
            </button>
            <button type="button" className="button ghost small" onClick={() => void handleRefreshCheck()} disabled={refreshingCheck}>
              <Icon name="refresh" size={14} /> {refreshingCheck ? '检查中…' : '重新检查输入状态'}
            </button>
          </div>

          {inputCheck && readiness ? (
            <div className={`st-check ${readiness.level}`}>
              <div className={`st-check-summary ${readiness.level}`}>
                <Icon name={readiness.level === 'ok' ? 'check' : 'warning'} size={15} />
                <span>{readiness.message}</span>
              </div>
              <div className="st-check-pills">
                <span className={`st-pill ${inputCheck.elevated ? 'ok' : 'warn'}`}>
                  管理员权限：{inputCheck.elevated ? '已获得' : '未获得'}
                </span>
                <span className={`st-pill ${inputCheck.helperAvailable ? 'ok' : 'danger'}`}>
                  按键桥接：{inputCheck.helperAvailable ? '可用' : '不可用'}
                </span>
                <span className="st-pill">输入方式：{INPUT_BACKEND_LABEL[inputCheck.backend] ?? inputCheck.backend}</span>
              </div>
              {inputCheck.helperPath ? <p className="st-check-line">桥接组件：{inputCheck.helperPath}</p> : null}
              {inputCheck.warnings.map((warning, index) => (
                <p key={`warning-${index}`} className="st-check-line warn">
                  <Icon name="warning" size={12} /> {warning}
                </p>
              ))}
              {inputCheck.notes.map((note, index) => (
                <p key={`note-${index}`} className="st-check-line note">
                  <Icon name="check" size={12} /> {note}
                </p>
              ))}
            </div>
          ) : (
            <p className="hint-text">正在等待输入通道状态…</p>
          )}
        </section>

        <section className="st-card">
          <CardHead icon="shield" title="演奏安全" subtitle="开始演奏前的保护性选项，建议全部保持开启" />
          <div className="st-rows">
            <ToggleRow
              title="焦点保护"
              description="目标窗口失去焦点时立即停止并释放所有按键（强烈建议开启）"
              checked={settings.input.focusGuard}
              onChange={(checked) => patchInput({ focusGuard: checked }, checked ? '焦点保护已开启' : '焦点保护已关闭')}
            />
            <ToggleRow
              title="自动聚焦目标窗口"
              description="开始演奏前尝试把目标窗口切到前台，避免按键发到错误窗口"
              checked={settings.input.autoFocusTarget}
              onChange={(checked) => patchInput({ autoFocusTarget: checked }, checked ? '自动聚焦已开启' : '自动聚焦已关闭')}
            />
            <ToggleRow
              title="允许「八度 + 半音」组合"
              description="开启后可吹出全部半音；若实机半音表现异常可关闭，按兼容模式排键"
              checked={settings.input.allowModifierCombos}
              onChange={(checked) => patchInput({ allowModifierCombos: checked }, checked ? '已允许八度 + 半音组合' : '已关闭组合键，使用兼容模式排键')}
            />
            <div className="st-row">
              <div className="st-row-text">
                <strong>开始前倒计时</strong>
                <span>给切回游戏窗口留出准备时间</span>
              </div>
              <select
                className="select st-select"
                value={settings.input.countdownSeconds}
                onChange={(event) => {
                  const seconds = Number(event.target.value);
                  patchInput({ countdownSeconds: seconds }, seconds === 0 ? '已关闭开始前倒计时' : `开始前倒计时已设为 ${seconds} 秒`);
                }}
              >
                <option value={0}>不等待</option>
                <option value={1}>1 秒</option>
                <option value={3}>3 秒</option>
                <option value={5}>5 秒</option>
              </select>
            </div>
            <div className="st-row">
              <div className="st-row-text">
                <strong>排练模式</strong>
                <span>不发送真实按键，只按时间轴走一遍，适合进游戏前校对节奏</span>
              </div>
              <button
                type="button"
                className={`button small ${settings.input.backend === 'dry-run' ? 'primary' : 'ghost'}`}
                onClick={() =>
                  patchInput(
                    { backend: settings.input.backend === 'dry-run' ? 'software' : 'dry-run' },
                    settings.input.backend === 'dry-run' ? '已切回游戏注入模式' : '已切换到排练模式（不发送按键）',
                  )
                }
              >
                <Icon name="play" size={14} /> {settings.input.backend === 'dry-run' ? '退出排练' : '进入排练'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  /* ============================================================
     Tab 2：演奏时序
     ============================================================ */
  const timing = settings.input.timing;
  const timingTab = (
    <div className="st-panel">
      <div className="st-grid st-grid-asym">
        <section className="st-card">
          <CardHead
            icon="clock"
            title="演奏时序（毫秒级）"
            subtitle="控制鼠标修饰键与音符键的按压节奏，直接影响游戏是否丢音"
            actions={
              <button type="button" className="button ghost small" onClick={resetTiming}>
                <Icon name="refresh" size={14} /> 恢复默认
              </button>
            }
          />
          <div className="st-flow">
            <span className="st-flow-chip">修饰键按下</span>
            <span className="st-flow-arrow">→</span>
            <span className="st-flow-chip">
              稳定 <em>{timing.modifierSettleMs}ms</em>
            </span>
            <span className="st-flow-arrow">→</span>
            <span className="st-flow-chip">音符键按下</span>
            <span className="st-flow-arrow">→</span>
            <span className="st-flow-chip">
              保持 ≥ <em>{timing.minNoteHoldMs}ms</em>
            </span>
            <span className="st-flow-arrow">→</span>
            <span className="st-flow-chip">
              释放后间隔 <em>{timing.transitionGapMs}ms</em>
            </span>
            <span className="st-flow-arrow">→</span>
            <span className="st-flow-chip">下一音</span>
            <span className="st-flow-arrow">·</span>
            <span className="st-flow-chip">
              开头留白 <em>{timing.leadInMs}ms</em>
            </span>
          </div>
          <div className="st-timing-grid">
            {TIMING_FIELDS.map((field) => (
              <NumberField
                key={field.key}
                label={field.label}
                value={timing[field.key]}
                min={field.min}
                max={field.max}
                step={field.step}
                defaultValue={DEFAULT_TIMING[field.key]}
                hint={field.hint}
                onCommit={(value) => {
                  const patch: Partial<TimingSettings> = {};
                  patch[field.key] = value;
                  patchTiming(patch, `${field.label}已设为 ${value}ms`);
                }}
              />
            ))}
          </div>
          <p className="hint-text">
            默认值来自社区实测：修饰键先稳定 {DEFAULT_TIMING.modifierSettleMs}ms 再按音符键，相邻音留 {DEFAULT_TIMING.transitionGapMs}ms
            释放窗口，单音最短保持 {DEFAULT_TIMING.minNoteHoldMs}ms。修改会立即保存到设置并用于下一次演奏。
          </p>
        </section>

        <section className="st-card">
          <CardHead icon="sparkle" title="调参建议" subtitle="从默认值小幅调整，每次只改一项再试" />
          <ul className="st-tips">
            <li>
              <strong>经常漏掉修饰音</strong>：把「修饰键稳定时间」从 24ms 调到 30–40ms。
            </li>
            <li>
              <strong>连音粘连 / 吞音</strong>：适当调大「相邻音释放间隔」，或稍微降低演奏速度。
            </li>
            <li>
              <strong>快速音符听不清</strong>：调大「最短音符保持」，但过快的段落会被压缩。
            </li>
            <li>
              <strong>八度 / 半音切换不跟手</strong>：调小「修饰键切换间隔」（过低可能丢修饰）。
            </li>
            <li>
              <strong>第一个音被吞</strong>：调大「开头留白」，或在上一个 Tab 开启倒计时。
            </li>
            <li>修改后先到演奏台用排练模式（不发送按键）确认节奏，再进游戏。</li>
          </ul>
          <p className="hint-text">
            默认时序：{DEFAULT_TIMING.modifierSettleMs} / {DEFAULT_TIMING.transitionGapMs} / {DEFAULT_TIMING.minNoteHoldMs} /{' '}
            {DEFAULT_TIMING.modifierReleaseGapMs} / {DEFAULT_TIMING.leadInMs} ms
          </p>
        </section>
      </div>
    </div>
  );

  /* ============================================================
     Tab 3：快捷键
     ============================================================ */
  const hotkeysTab = (
    <div className="st-panel">
      <div className="st-grid">
        <section className="st-card st-span-2">
          <CardHead
            icon="settings"
            title="全局快捷键"
            subtitle="点击快捷键框后按下新组合；单独按修饰键不会结束，Esc 取消。快捷键由系统全局注册，游戏全屏时同样生效"
            actions={
              <>
                {hotkeyStatusError ? (
                  <span className="st-badge warn">状态未知</span>
                ) : hotkeyStatuses ? (
                  failedCount > 0 ? (
                    <span className="st-badge danger">
                      <Icon name="warning" size={11} /> {failedCount} 项注册失败
                    </span>
                  ) : (
                    <span className="st-badge ok">
                      <Icon name="check" size={11} /> {registeredCount}/{HOTKEY_ACTIONS.length} 已生效
                    </span>
                  )
                ) : (
                  <span className="st-badge">检测中…</span>
                )}
                <button type="button" className="button ghost small" onClick={() => void refreshHotkeyStatuses()} disabled={hotkeyStatusLoading}>
                  <Icon name="refresh" size={14} /> 刷新状态
                </button>
                <button type="button" className="button ghost small" onClick={resetHotkeys}>
                  <Icon name="refresh" size={14} /> 恢复默认
                </button>
              </>
            }
          />

          {recordingLabel ? (
            <div className="st-recording-banner">
              <Icon name="sparkle" size={15} /> 正在录制「{recordingLabel}」：请按下组合键，按 Esc 取消
            </div>
          ) : null}

          <div className="st-hotkey-list">
            {HOTKEY_ACTIONS.map((action) => {
              const meta = HOTKEY_META[action];
              const isOtherRecording = recordingAction !== null && recordingAction !== action;
              return (
                <div key={action} className="st-hotkey-row">
                  <div className="st-hotkey-meta">
                    <span className="st-hotkey-icon">
                      <Icon name={meta.icon} size={15} />
                    </span>
                    <div className="st-hotkey-info">
                      <strong>{meta.label}</strong>
                      <span>{meta.description}</span>
                      <em className="st-hotkey-default">默认 {formatAccelerator(meta.defaultAccelerator)}</em>
                    </div>
                  </div>
                  <HotkeyRecorder
                    value={settings.hotkeys[action]}
                    conflict={hotkeyConflicts[action] ?? null}
                    disabled={isOtherRecording}
                    onChange={(accelerator) => handleRecordChange(action, accelerator)}
                    onRecordingChange={(recording) => handleRecordingChange(action, recording)}
                  />
                  <div className="st-hotkey-status">{renderHotkeyStatus(action)}</div>
                </div>
              );
            })}
          </div>

          <p className="hint-text">
            「已生效」表示主进程已成功注册该组合；「注册失败」通常是被系统 / 其他软件（如显卡驱动、聊天工具、录屏软件）占用，
            或与其他动作冲突。录制期间旧快捷键仍可能在系统层触发，这是 Electron 全局热键的限制。
            建议给「紧急停止」保留一个易按且独立的按键。
          </p>
        </section>
      </div>
    </div>
  );

  /* ============================================================
     Tab 4：悬浮窗与外观
     ============================================================ */
  const overlayTab = (
    <div className="st-panel">
      <div className="st-grid">
        <section className="st-card">
          <CardHead
            icon="overlay"
            title="悬浮控制窗"
            subtitle="常驻游戏画面之上的小控制面板，不抢游戏焦点，可拖动位置"
            actions={<span className={`st-badge ${overlayVisible ? 'ok' : ''}`}>{overlayVisible ? '已显示' : '已隐藏'}</span>}
          />
          <div className="st-overlay-hero">
            <span className={`st-overlay-state ${overlayVisible ? 'on' : ''}`}>
              <span className="st-overlay-dot" />
              {overlayVisible ? '悬浮窗正在显示' : '悬浮窗当前隐藏'}
            </span>
            <button type="button" className={`button small ${overlayVisible ? 'danger' : 'primary'}`} onClick={() => void handleToggleOverlay()}>
              <Icon name={overlayVisible ? 'close' : 'overlay'} size={15} /> {overlayVisible ? '隐藏悬浮窗' : '显示悬浮窗'}
            </button>
          </div>

          <RangeField
            label="不透明度"
            value={settings.overlay.opacity}
            min={0.3}
            max={1}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            hint="悬浮窗整体透明度：0.3 最淡，1 完全不透明。"
            onCommit={(value) => patchOverlay({ opacity: value }, `悬浮窗不透明度已保存：${Math.round(value * 100)}%`)}
          />

          <div className="st-rows">
            <ToggleRow
              title="保持置顶"
              description="始终显示在游戏画面之上；关闭后可能被游戏窗口遮挡"
              checked={settings.overlay.alwaysOnTop}
              onChange={(checked) => patchOverlay({ alwaysOnTop: checked }, checked ? '悬浮窗保持置顶已开启' : '悬浮窗保持置顶已关闭')}
            />
            <ToggleRow
              title="显示快捷键提示"
              description="在悬浮窗底部显示当前全局快捷键，方便游戏内查看"
              checked={settings.overlay.showHotkeyHint}
              onChange={(checked) => patchOverlay({ showHotkeyHint: checked }, checked ? '悬浮窗快捷键提示已开启' : '悬浮窗快捷键提示已关闭')}
            />
            <div className="st-row">
              <div className="st-row-text">
                <strong>重置位置</strong>
                <span>把悬浮窗移回屏幕右下角默认位置；当前版本需重启应用后生效</span>
              </div>
              <button type="button" className="button ghost small" onClick={handleResetOverlayPosition}>
                <Icon name="target" size={14} /> 重置位置
              </button>
            </div>
          </div>

          <div className="st-overlay-hints">
            <span className="hint-text">快捷键提示（开启后显示在悬浮窗上）：</span>
            {HOTKEY_ACTIONS.map((action) => (
              <span key={action} className="st-pill">
                <Icon name={HOTKEY_META[action].icon} size={11} />
                {formatAccelerator(settings.hotkeys[action])} {HOTKEY_META[action].label}
              </span>
            ))}
          </div>
        </section>

        <section className="st-card">
          <CardHead icon="headphones" title="试听音色与音量" subtitle="只影响应用内试听，不会改变游戏内实际发声" />
          <div className="st-segmented two">
            {PREVIEW_INSTRUMENTS.map((instrument) => (
              <button
                key={instrument.id}
                type="button"
                className={`st-segment ${settings.preview.instrument === instrument.id ? 'active' : ''}`}
                aria-pressed={settings.preview.instrument === instrument.id}
                onClick={() => patchPreview({ instrument: instrument.id }, `试听音色已切换为「${instrument.name}」`)}
              >
                <strong>{instrument.name}</strong>
                <span>{instrument.description}</span>
              </button>
            ))}
          </div>
          <RangeField
            label="试听音量"
            value={settings.preview.volume}
            min={0}
            max={1}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            hint="影响底部播放条、演奏台与编辑器中的试听音量。"
            onCommit={(value) => patchPreview({ volume: value }, `试听音量已保存：${Math.round(value * 100)}%`)}
          />
          <p className="hint-text">音色与音量保存在设置中，所有页面共用同一套试听配置；修改后可在底部播放条立即试听。</p>
        </section>
      </div>
    </div>
  );

  /* ============================================================
     Tab 5：音频分析
     ============================================================ */
  const audioTab = (
    <div className="st-panel">
      <div className="st-grid st-grid-asym">
        <section className="st-card">
          <CardHead
            icon="music"
            title="主旋律提取"
            subtitle="音频转谱时如何从混音中找出主旋律"
            actions={
              <button type="button" className="button ghost small" onClick={resetAudio}>
                <Icon name="refresh" size={14} /> 恢复默认
              </button>
            }
          />
          <div className="st-field">
            <span className="field-label">提取模式</span>
            <div className="st-segmented">
              {MELODY_MODE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`st-segment ${settings.audio.melodyMode === option.id ? 'active' : ''}`}
                  aria-pressed={settings.audio.melodyMode === option.id}
                  onClick={() => patchAudio({ melodyMode: option.id }, `分析模式已切换为「${option.name}」`)}
                >
                  <strong>{option.name}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="st-pitch">
            <div className="st-pitch-head">
              <span className="st-pitch-title">主旋律音域</span>
              <span className="st-pitch-value">
                {midiToName(settings.audio.pitchMin)} – {midiToName(settings.audio.pitchMax)}
                <em>
                  MIDI {settings.audio.pitchMin} – {settings.audio.pitchMax}
                </em>
              </span>
            </div>
            <RangeField
              label="音域下限"
              value={settings.audio.pitchMin}
              min={PITCH_MIN}
              max={settings.audio.pitchMax}
              step={1}
              format={(value) => `${midiToName(value)}（${value}）`}
              onCommit={(value) => patchAudio({ pitchMin: value }, `主旋律音域下限已设为 ${midiToName(value)}`)}
            />
            <RangeField
              label="音域上限"
              value={settings.audio.pitchMax}
              min={settings.audio.pitchMin}
              max={PITCH_MAX}
              step={1}
              format={(value) => `${midiToName(value)}（${value}）`}
              onCommit={(value) => patchAudio({ pitchMax: value }, `主旋律音域上限已设为 ${midiToName(value)}`)}
            />
            <div className="st-pitch-presets">
              {PITCH_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={`st-preset ${settings.audio.pitchMin === preset.min && settings.audio.pitchMax === preset.max ? 'active' : ''}`}
                  onClick={() => patchAudio({ pitchMin: preset.min, pitchMax: preset.max }, `主旋律音域已设为 ${midiToName(preset.min)} – ${midiToName(preset.max)}`)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="st-rows">
            <ToggleRow
              title="伴奏抑制（HPSS）"
              description="用谐波 / 打击分离削弱鼓点与伴奏，带伴奏歌曲强烈建议开启"
              checked={settings.audio.suppressAccompaniment}
              onChange={(checked) => patchAudio({ suppressAccompaniment: checked }, checked ? '伴奏抑制已开启' : '伴奏抑制已关闭')}
            />
            <ToggleRow
              title="自动检测调性"
              description="转谱时自动判断大调 / 小调，写入简谱调号"
              checked={settings.audio.autoKey}
              onChange={(checked) => patchAudio({ autoKey: checked }, checked ? '自动检测调性已开启' : '自动检测调性已关闭')}
            />
          </div>
        </section>

        <section className="st-card">
          <CardHead icon="target" title="扒谱细节" subtitle="影响转谱后的节奏密度与可演奏性" />
          <NumberField
            label="最短音符"
            value={settings.audio.minNoteMs}
            min={30}
            max={300}
            step={5}
            defaultValue={DEFAULT_SETTINGS.audio.minNoteMs}
            hint="短于该时长的音会被过滤：调大可去除颤音碎片，过大会丢快速音符。"
            onCommit={(value) => patchAudio({ minNoteMs: value }, `最短音符已设为 ${value}ms`)}
          />
          <div className="st-row">
            <div className="st-row-text">
              <strong>量化网格</strong>
              <span>音符起点对齐到节拍网格：1/16 更精细，1/8 更简单。</span>
            </div>
            <select
              className="select st-select"
              value={settings.audio.quantizeGrid}
              onChange={(event) => {
                const grid = Number(event.target.value);
                patchAudio({ quantizeGrid: grid }, `量化网格已设为 ${QUANTIZE_LABEL[grid] ?? grid}`);
              }}
            >
              <option value={0.125}>1/32（精细）</option>
              <option value={0.25}>1/16（推荐）</option>
              <option value={0.5}>1/8（简化）</option>
            </select>
          </div>

          <div className="st-banner warn">
            <Icon name="warning" size={17} />
            <div className="st-banner-text">
              <strong>带伴奏歌曲请用 auto / polyphonic + 开启伴奏抑制</strong>
              <p>否则很容易把低音、和弦当成主旋律，转谱结果会变得又乱又难演奏。</p>
            </div>
          </div>

          <ul className="st-tips">
            <li>
              <strong>清唱 / 独奏</strong>：选「单声部」通常更稳，音域按人声范围调整。
            </li>
            <li>
              <strong>音域越窄越干净</strong>，但超出范围的旋律会被丢弃或折返。
            </li>
            <li>
              <strong>最短音符与量化</strong>决定谱面可玩性：太难演奏的段落可放宽这两个参数。
            </li>
          </ul>
        </section>
      </div>
    </div>
  );

  /* ============================================================
     Tab 6：风险与关于
     ============================================================ */
  const aboutTab = (
    <div className="st-panel">
      <div className="st-grid">
        <section className="st-card st-span-2">
          <CardHead icon="warning" title="风险声明与合规提示" subtitle="使用前请确认你了解以下风险" />
          <div className="st-banner danger">
            <Icon name="warning" size={20} />
            <div className="st-banner-text">
              <strong>游戏官方已公开将「第三方软件 / 脚本 / 鼠标宏自动操作」列为违规行为，最高封禁 10 年。</strong>
              <p>
                本软件是非官方工具，与腾讯 / 天美工作室群无关，仅供个人练习与录制娱乐使用。软件只调用 Windows 标准 SendInput
                模拟键鼠输入，<em>不注入游戏进程、不读写游戏内存、不安装驱动、不做任何反检测</em>。
              </p>
              <p>使用本工具存在账号被处罚的风险，且风险由使用者自行承担；建议不要在排位 / 竞技对局中长时间使用。</p>
            </div>
          </div>
          <div className="st-link-list">
            <span className="section-label">官方公告与处罚说明</span>
            {OFFICIAL_LINKS.map((link) => (
              <button key={link.url} type="button" className="st-link-item" onClick={() => openExternal(link.url)}>
                <Icon name="chevron" size={12} /> {link.label}
              </button>
            ))}
          </div>
        </section>

        <section className="st-card">
          <CardHead
            icon="folder"
            title="版本与数据"
            subtitle="应用运行信息与本机数据目录"
            actions={
              <button type="button" className="button ghost small" onClick={openUserData}>
                <Icon name="folder" size={14} /> 打开数据目录
              </button>
            }
          />
          <div className="st-info-grid">
            <div className="st-info-chip">
              <span>版本</span>
              <span>v{appInfo?.version ?? '0.1.0'}</span>
            </div>
            <div className="st-info-chip">
              <span>Electron</span>
              <span>{appInfo?.electronVersion ?? '-'}</span>
            </div>
            <div className="st-info-chip">
              <span>Chromium</span>
              <span>{appInfo?.chromeVersion ?? '-'}</span>
            </div>
            <div className="st-info-chip">
              <span>Node</span>
              <span>{appInfo?.nodeVersion ?? '-'}</span>
            </div>
            <div className="st-info-chip">
              <span>平台</span>
              <span>{appInfo?.platform ?? '-'}</span>
            </div>
            <div className="st-info-chip">
              <span>运行模式</span>
              <span>{appInfo?.isPackaged ? '安装版' : '开发版'}</span>
            </div>
          </div>
          <div className="st-path">{appInfo?.userDataPath ?? '加载中…'}</div>
        </section>

        <section className="st-card">
          <CardHead icon="music" title="口琴键位表（PC）" subtitle="游戏内「守夜人口琴」演奏界面" />
          <div className="st-keysheet">
            <div className="st-keycap-row">
              {DEFAULT_HARMONICA.noteKeys.map((key) => (
                <div key={key.id} className="st-keycap-cell">
                  <span className="st-keycap">{key.label}</span>
                  <span className="st-keycap-degree">{key.degree === 8 ? '高音 1' : String(key.degree)}</span>
                </div>
              ))}
            </div>
            <div className="st-mouse-map">
              <span>
                <b>鼠标左键</b> 降八度
              </span>
              <span>
                <b>鼠标中键</b> 升半音
              </span>
              <span>
                <b>鼠标右键</b> 升八度
              </span>
            </div>
          </div>
          <p className="hint-text">
            音域 C3 – C#6（约 3 个八度、38 个半音），单音演奏。若游戏版本改过键位，可通过「输入通道自检」确认实际按键。
          </p>
        </section>
      </div>
    </div>
  );

  /* ---------------- 渲染 ---------------- */

  const tabContent: Record<SettingsTabId, ReactNode> = {
    input: inputTab,
    timing: timingTab,
    hotkeys: hotkeysTab,
    overlay: overlayTab,
    audio: audioTab,
    about: aboutTab,
  };

  return (
    <div className="page st-page">
      <PageHeader
        title="设置与校准"
        subtitle="输入通道 · 演奏时序 · 全局快捷键 · 悬浮窗 · 音频分析 —— 所有修改立即写入设置并生效"
        actions={
          <>
            <span className="st-autosave">
              <Icon name="check" size={12} /> 所有修改即时保存
            </span>
            <button type="button" className="button ghost small" onClick={openUserData}>
              <Icon name="folder" size={14} /> 打开数据目录
            </button>
          </>
        }
      />

      <div className="st-tabs" role="tablist" aria-label="设置分类">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`st-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={15} />
            <span>{item.label}</span>
            {item.id === 'hotkeys' && failedCount > 0 ? <span className="st-tab-badge">{failedCount}</span> : null}
            {item.id === 'input' && appInfo && !appInfo.elevated ? <span className="st-tab-badge warn">!</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={activeTab.label}>
        {tabContent[tab]}
      </div>
    </div>
  );
}

/* ============================================================
   页面内复用的小组件
   ============================================================ */

/** 卡片标题区：图标 + 标题 + 说明 + 右侧操作 */
function CardHead({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="st-card-head">
      <span className="st-card-icon">
        <Icon name={icon} size={17} />
      </span>
      <div className="st-card-heading">
        <h3>{title}</h3>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="st-card-actions">{actions}</div> : null}
    </header>
  );
}

/** 行式开关：左侧标题 + 说明，右侧开关（复用 global.css 的 .switch） */
function ToggleRow({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <div className="st-row">
      <div className="st-row-text">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <label className="switch" title={description}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={title}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="st-switch-state">{checked ? '已开启' : '已关闭'}</span>
      </label>
    </div>
  );
}

/**
 * 毫秒数字输入：编辑态用本地草稿，失焦 / 回车时钳制范围并提交，
 * 避免直接受控导致输入中间值被立即裁剪（例如先输 1 再输 0 变成 4）。
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit = 'ms',
  hint,
  defaultValue,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  defaultValue?: number;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <label className="st-num-field">
      <span className="st-num-top">
        <span className="st-num-label">{label}</span>
        {defaultValue !== undefined && value === defaultValue ? <em className="st-default-tag">默认</em> : null}
      </span>
      <span className="st-num-wrap">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setDraft(String(value));
              event.currentTarget.blur();
            }
          }}
        />
        <span className="st-unit">{unit}</span>
      </span>
      {hint ? <span className="st-num-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * 滑杆：拖动时本地实时显示，停顿 260ms 或卸载时提交并 toast，
 * 避免连续拖动触发大量 settings IPC 写入。
 */
function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  hint,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  hint?: string;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const valueRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    setDraft(value);
    draftRef.current = value;
    valueRef.current = value;
  }, [value]);

  /** 提交当前草稿（值与已保存值相同时跳过，避免无意义的 IPC 写入与 toast） */
  const commitDraft = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = draftRef.current;
    if (next !== valueRef.current) {
      valueRef.current = next;
      onCommitRef.current(next);
    }
  };

  // 卸载时如果还有未提交的拖动，补交一次（commitDraft 只引用 ref，闭包安全）
  useEffect(() => {
    return () => commitDraft();
  }, []);

  const handleChange = (next: number) => {
    setDraft(next);
    draftRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(commitDraft, 260);
  };

  return (
    <div className="st-slider-field">
      <div className="st-slider-top">
        <span className="st-slider-label">{label}</span>
        <span className="st-slider-value">{format(draft)}</span>
      </div>
      <input
        className="st-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-label={label}
        onChange={(event) => handleChange(Number(event.target.value))}
      />
      <div className="st-slider-scale">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
      {hint ? <span className="st-slider-hint">{hint}</span> : null}
    </div>
  );
}
