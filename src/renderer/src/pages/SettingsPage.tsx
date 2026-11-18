/**
 * 设置与校准页面
 * ------------------------------------------------------------------
 * 结构：PageHeader（标题 + 打开数据目录）
 *      → 管理员权限提示（全页唯一一处，只在这里解释提权与豁免）
 *      → 6 个 tab：输入与权限 / 演奏时序 / 快捷键 / 悬浮窗与外观 / 音频分析 / 风险与关于
 *      → 每个 tab 1–2 张卡片；设置行统一为「左侧标签 + 说明 / 右侧控件」
 *
 * 约定：
 * - 所有设置改动即时写入 app.updateSettings（settings:update）并给出 toast；
 * - 页面级样式见 ../styles/settings.css（类名 settings- 前缀），只组合组件库基元；
 * - 快捷键录制逻辑封装在 @renderer/components/HotkeyRecorder。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { DEFAULT_TIMING } from '@core/instrument/plan';
import { DEFAULT_HARMONICA } from '@core/model/instrument';
import { midiToName } from '@core/model/pitch';
import { HotkeyRecorder, formatAccelerator } from '@renderer/components/HotkeyRecorder';
import { Icon, type IconName } from '@renderer/components/Icon';
import { Chip, Notice, PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { DEFAULT_SETTINGS } from '@shared/settings';
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
}

const TABS: SettingsTabDef[] = [
  { id: 'input', label: '输入与权限' },
  { id: 'timing', label: '演奏时序' },
  { id: 'hotkeys', label: '快捷键' },
  { id: 'overlay', label: '悬浮窗与外观' },
  { id: 'audio', label: '音频分析' },
  { id: 'about', label: '风险与关于' },
];

const INPUT_BACKEND_OPTIONS: Array<{ id: InputBackend; label: string; description: string; disabled?: boolean }> = [
  {
    id: 'software',
    label: '模拟按键注入游戏（推荐）',
    description: '通过 Win32 SendInput 向目标窗口发送真实键鼠事件，是游戏内生效的正式模式。',
  },
  {
    id: 'dry-run',
    label: '排练模式（不发送按键）',
    description: '只按时间轴走一遍流程，适合校准、录像前确认节奏，不会影响游戏。',
  },
  {
    id: 'serial',
    label: '串口 / Arduino 硬件输出（预留，尚未启用）',
    description: '预留的外部硬件通道，当前版本不可用。',
    disabled: true,
  },
];

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

const MELODY_MODE_OPTIONS: Array<{ id: MelodyAnalysisMode; name: string }> = [
  { id: 'auto', name: '自动判断' },
  { id: 'monophonic', name: '单声部' },
  { id: 'polyphonic', name: '复音' },
];

const PREVIEW_INSTRUMENTS: Array<{ id: PreviewInstrument; name: string }> = [
  { id: 'harmonica', name: '口琴' },
  { id: 'piano', name: '钢琴' },
];

const PITCH_MIN = 48;
const PITCH_MAX = 84;

const PITCH_PRESETS: Array<{ label: string; min: number; max: number }> = [
  { label: 'C3 – C6', min: 48, max: 84 },
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

/**
 * 输入自检里这些信息已在页面其它位置呈现（顶部权限提示 / 目标窗口行 / 页面其他 tab），
 * 不再在自检明细里重复第二遍。
 */
const DUPLICATED_CHECK_PATTERNS = [/管理员/, /提权/, /UIPI/, /尚未选择目标游戏窗口/, /串口 \/ Arduino/];

type CheckTone = 'ok' | 'warn' | 'danger' | 'muted';

interface CheckConclusion {
  tone: CheckTone;
  title: string;
  hint?: string;
}

interface CheckFact {
  label: string;
  value: string;
  tone: CheckTone;
}

/** 把错误对象转成可读文案 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 自检结论 / 明细共用的色调图标 */
function checkIcon(tone: CheckTone): IconName {
  if (tone === 'ok') return 'check';
  if (tone === 'warn' || tone === 'danger') return 'warning';
  return 'info';
}

/* ============================================================
   页面组件
   ============================================================ */

export function SettingsPage(): JSX.Element {
  const app = useAppStore();
  const { settings, appInfo, inputCheck, windows, overlayVisible } = app;
  const { showToast, updateSettings, refreshWindows, refreshInputCheck, setSelfTestOpen } = app;

  const [tab, setTab] = useState<SettingsTabId>('input');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
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

  // 首次进入设置页就拉一次注册状态
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
      void window.api.shell
        .openExternal(url)
        .catch((error: unknown) => showToast('error', `打开链接失败：${errorText(error)}`));
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

  const elevated = Boolean(appInfo?.elevated);
  const capabilities = appInfo?.capabilities;
  /** 非 Windows 平台没有 Win32 注入链路：相关控件置灰并在结论里说明原因 */
  const canInject = capabilities?.gameInjection ?? true;
  const isRehearsal = settings.input.backend === 'dry-run';
  const isSerial = settings.input.backend === 'serial';
  const backendOptions = INPUT_BACKEND_OPTIONS.map((option) =>
    option.id === 'software' && !canInject
      ? {
          ...option,
          disabled: true,
          label: '模拟按键注入游戏（仅 Windows 可用）',
          description: `${capabilities?.label ?? '当前平台'} 版不发送真实按键；请使用排练模式，或改用 Windows 版演奏。`,
        }
      : option,
  );
  const currentBackend = backendOptions.find((option) => option.id === settings.input.backend);
  const timing = settings.input.timing;
  const targetTitle = settings.input.targetWindowTitle;

  /** 快捷键卡片只在出现异常时给汇总徽标；正常情况下由每行的单项徽标说明状态，避免重复 */
  const hotkeySummaryBadge: JSX.Element | null = hotkeyStatusError ? (
    <span className="badge badge--warn">状态未知</span>
  ) : hotkeyStatusLoading ? (
    <span className="badge">检测中</span>
  ) : failedCount > 0 ? (
    <span className="badge badge--danger">{failedCount} 项失败</span>
  ) : null;

  /** 输入通道结论：先给结论，再给明细（管理员权限只在页面顶部提示一次） */
  let checkConclusion: CheckConclusion;
  if (!inputCheck) {
    checkConclusion = { tone: 'muted', title: '正在读取输入通道状态…', hint: '点「重新检查」重试' };
  } else if (!canInject) {
    checkConclusion = {
      tone: 'warn',
      title: `${capabilities?.label ?? '当前平台'} 版不支持游戏注入`,
      hint: '编辑、导入、练习、试听与宏导出可用；演奏会按排练模式走完时间轴',
    };
  } else if (isSerial) {
    checkConclusion = { tone: 'warn', title: '串口硬件输出尚未启用', hint: '改用模拟按键注入或排练模式' };
  } else if (isRehearsal) {
    checkConclusion = { tone: 'ok', title: '排练模式就绪：只走时间轴，不发送按键' };
  } else if (!inputCheck.helperAvailable) {
    checkConclusion = {
      tone: 'danger',
      title: '按键桥接组件不可用',
      hint: '重启应用或重新安装；排练模式仍可使用',
    };
  } else if (!settings.input.targetWindowHandle) {
    checkConclusion = {
      tone: 'warn',
      title: '按键桥接可用 · 尚未选择目标窗口',
      hint: '开始演奏前先在上方选择「三角洲行动」窗口',
    };
  } else {
    checkConclusion = {
      tone: 'ok',
      title: `按键桥接可用 · 目标窗口：${targetTitle ?? '已选择'}`,
    };
  }

  const checkFacts: CheckFact[] = [];
  if (inputCheck) {
    if (!canInject) {
      checkFacts.push({
        label: '平台',
        value: `${capabilities?.label ?? inputCheck.platform}${appInfo?.arch ? ` · ${appInfo.arch}` : ''}`,
        tone: 'muted',
      });
      checkFacts.push({ label: '游戏注入', value: '不支持（仅 Windows）', tone: 'warn' });
      checkFacts.push({ label: '排练 / 练习', value: '可用', tone: 'ok' });
    } else {
      checkFacts.push({
        label: '按键桥接',
        value: inputCheck.helperAvailable ? '可用' : '不可用',
        tone: inputCheck.helperAvailable ? 'ok' : 'danger',
      });
      if (isRehearsal) {
        checkFacts.push({ label: '目标窗口', value: '排练模式不需要', tone: 'muted' });
      } else if (settings.input.targetWindowHandle) {
        checkFacts.push({ label: '目标窗口', value: targetTitle ?? '已选择', tone: 'ok' });
      } else {
        checkFacts.push({ label: '目标窗口', value: '未选择', tone: 'warn' });
      }
    }
  }

  // 提权相关与重复信息不再进自检明细，只在结论右侧保留一个短徽标
  const checkWarnings = (inputCheck?.warnings ?? []).filter(
    (warning) => !DUPLICATED_CHECK_PATTERNS.some((pattern) => pattern.test(warning)),
  );
  const showElevationBadge = Boolean(inputCheck) && canInject && !elevated && !isRehearsal && !isSerial;

  /** 渲染某个动作的注册状态徽标 */
  const renderHotkeyStatus = (action: HotkeyAction): JSX.Element => {
    if (hotkeyStatusError) return <span className="badge badge--warn">状态未知</span>;
    const status = statusByAction.get(action);
    if (!status) return <span className="badge">{hotkeyStatusLoading ? '检测中' : '未检测'}</span>;
    if (status.registered) return <span className="badge badge--ok">已生效</span>;
    return (
      <>
        <span className="badge badge--danger">注册失败</span>
        {status.error ? <span className="settings-hotkey__error">{status.error}</span> : null}
      </>
    );
  };

  /* ---------------- Tab 键盘导航（Tablist 规范：左右方向键切换，Home / End 跳到首尾） ---------------- */

  const focusTab = (index: number) => {
    setTab(TABS[index].id);
    tabRefs.current[index]?.focus();
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TABS.findIndex((item) => item.id === tab);
    if (currentIndex < 0) return;
    let nextIndex: number;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    focusTab(nextIndex);
  };

  /* ============================================================
     Tab 1：输入与权限
     ============================================================ */
  const inputTab = (
    <div className="settings-columns">
      <SettingsCard title="输入通道">
        <div className="settings-rows">
          <SettingRow label="输入方式" description={currentBackend?.description} htmlFor="settings-input-backend">
            <select
              id="settings-input-backend"
              className="select"
              value={settings.input.backend}
              aria-describedby="settings-input-backend-desc"
              onChange={(event) => {
                const backend = event.target.value as InputBackend;
                const option = INPUT_BACKEND_OPTIONS.find((item) => item.id === backend);
                patchInput({ backend }, `输入方式已切换为「${option?.label ?? backend}」`);
              }}
            >
              {backendOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow
            label="目标游戏窗口"
            description={
              canInject
                ? '先在 Windows 打开游戏并刷新列表；未选择时只能排练或试听。'
                : `${capabilities?.label ?? '当前平台'} 版不支持游戏注入：目标窗口仅在 Windows 版可用。`
            }
            htmlFor="settings-target-window"
          >
            <select
              id="settings-target-window"
              className="select grow"
              value={settings.input.targetWindowHandle ?? 0}
              disabled={!canInject}
              aria-describedby="settings-target-window-desc"
              onChange={(event) => {
                const handle = Number(event.target.value);
                const info = windows.find((item) => item.handle === handle);
                if (!handle) {
                  patchInput({ targetWindowHandle: null, targetWindowTitle: null }, '已清除目标窗口');
                  return;
                }
                patchInput(
                  { targetWindowHandle: handle, targetWindowTitle: info?.title ?? null },
                  `目标窗口已设为「${info?.title ?? handle}」`,
                );
              }}
            >
              <option value={0}>未选择（仅排练 / 试听）</option>
              {windows.map((item) => (
                <option key={item.handle} value={item.handle}>
                  {`${item.title}${item.looksLikeGame ? ' · 疑似游戏' : ''}${item.isForeground ? ' · 前台' : ''}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--icon"
              title={canInject ? '刷新窗口列表' : '当前平台不支持游戏注入'}
              aria-label="刷新窗口列表"
              disabled={refreshingWindows || !canInject}
              onClick={() => void handleRefreshWindows()}
            >
              <Icon name="refresh" size={15} />
            </button>
          </SettingRow>
        </div>

        <hr className="divider" />

        <div className="settings-check">
          <div className="settings-check__head">
            <h3 className="settings-check__title">自检结果</h3>
            <div className="inline-actions">
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                title={canInject ? '在应用窗口内实际发送一次按键，验证 SendInput 注入链路' : '当前平台不支持按键注入，无法自检'}
                disabled={!canInject}
                onClick={() => setSelfTestOpen(true)}
              >
                <Icon name="activity" size={13} /> 注入测试
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void handleRefreshCheck()}
                disabled={refreshingCheck}
              >
                <Icon name="refresh" size={13} /> {refreshingCheck ? '检查中…' : '重新检查'}
              </button>
            </div>
          </div>

          <div className={`settings-check__conclusion is-${checkConclusion.tone}`} aria-live="polite">
            <span className="settings-check__conclusion-icon" aria-hidden="true">
              <Icon name={checkIcon(checkConclusion.tone)} size={15} />
            </span>
            <div className="settings-check__conclusion-text">
              <strong>{checkConclusion.title}</strong>
              {checkConclusion.hint ? <span className="settings-check__hint">{checkConclusion.hint}</span> : null}
            </div>
            {showElevationBadge ? <span className="badge badge--warn">待提权</span> : null}
          </div>

          {checkFacts.length > 0 ? (
            <div className="settings-facts">
              {checkFacts.map((fact) => (
                <div key={fact.label} className={`settings-fact is-${fact.tone}`}>
                  <Icon name={checkIcon(fact.tone)} size={13} />
                  <span className="settings-fact__label">{fact.label}</span>
                  <span className="settings-fact__value" title={fact.value}>
                    {fact.value}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {checkWarnings.length > 0 ? (
            <ul className="settings-notes">
              {checkWarnings.map((warning, index) => (
                <li key={`${warning}-${index}`} className="settings-note is-warn">
                  <Icon name="warning" size={13} />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {inputCheck?.helperPath ? <p className="settings-check__path">桥接组件：{inputCheck.helperPath}</p> : null}
        </div>
      </SettingsCard>

      <SettingsCard title="演奏安全">
        <div className="settings-rows">
          <ToggleRow
            id="settings-focus-guard"
            label="焦点保护"
            description="目标窗口失去焦点时立即停止并释放所有按键"
            checked={settings.input.focusGuard}
            onChange={(checked) => patchInput({ focusGuard: checked }, checked ? '焦点保护已开启' : '焦点保护已关闭')}
          />
          <ToggleRow
            id="settings-auto-focus"
            label="自动聚焦目标窗口"
            description="开始演奏前把目标窗口切到前台，避免按键发到错误窗口"
            checked={settings.input.autoFocusTarget}
            onChange={(checked) => patchInput({ autoFocusTarget: checked }, checked ? '自动聚焦已开启' : '自动聚焦已关闭')}
          />
          <ToggleRow
            id="settings-modifier-combos"
            label="允许「八度 + 半音」组合"
            description="开启后可吹出全部半音；实机半音异常时关闭，按兼容模式排键"
            checked={settings.input.allowModifierCombos}
            onChange={(checked) =>
              patchInput(
                { allowModifierCombos: checked },
                checked ? '已允许八度 + 半音组合' : '已关闭组合键，使用兼容模式排键',
              )
            }
          />
          <SettingRow
            label="开始前倒计时"
            description="给切回游戏窗口留出准备时间；「不等待」会立即开始"
            htmlFor="settings-countdown"
          >
            <select
              id="settings-countdown"
              className="select"
              value={settings.input.countdownSeconds}
              aria-describedby="settings-countdown-desc"
              onChange={(event) => {
                const seconds = Number(event.target.value);
                patchInput(
                  { countdownSeconds: seconds },
                  seconds === 0 ? '已关闭开始前倒计时' : `开始前倒计时已设为 ${seconds} 秒`,
                );
              }}
            >
              <option value={0}>不等待</option>
              <option value={1}>1 秒</option>
              <option value={3}>3 秒</option>
              <option value={5}>5 秒</option>
            </select>
          </SettingRow>
        </div>
      </SettingsCard>
    </div>
  );

  /* ============================================================
     Tab 2：演奏时序
     ============================================================ */
  const timingTab = (
    <div className="settings-columns settings-columns--split">
      <SettingsCard
        title="演奏时序"
        actions={
          <button type="button" className="btn btn--quiet btn--sm" onClick={resetTiming}>
            <Icon name="reset" size={13} /> 恢复默认
          </button>
        }
      >
        <div className="chip-row">
          <span className="chip">
            <span className="chip-label">开头留白</span>
            <span className="chip-value">{timing.leadInMs} ms</span>
          </span>
          <span className="settings-flow__arrow" aria-hidden="true">
            →
          </span>
          <span className="chip">
            <span className="chip-label">修饰键稳定</span>
            <span className="chip-value">{timing.modifierSettleMs} ms</span>
          </span>
          <span className="settings-flow__arrow" aria-hidden="true">
            →
          </span>
          <span className="chip">
            <span className="chip-label">音符键保持</span>
            <span className="chip-value">≥ {timing.minNoteHoldMs} ms</span>
          </span>
          <span className="settings-flow__arrow" aria-hidden="true">
            →
          </span>
          <span className="chip">
            <span className="chip-label">释放间隔</span>
            <span className="chip-value">{timing.transitionGapMs} ms</span>
          </span>
          <span className="settings-flow__arrow" aria-hidden="true">
            →
          </span>
          <span className="chip">
            <span className="chip-label">修饰键切换</span>
            <span className="chip-value">{timing.modifierReleaseGapMs} ms</span>
          </span>
        </div>

        <div className="settings-rows">
          {TIMING_FIELDS.map((field) => (
            <NumberField
              key={field.key}
              id={`settings-timing-${field.key}`}
              label={field.label}
              description={field.hint}
              value={timing[field.key]}
              min={field.min}
              max={field.max}
              step={field.step}
              onCommit={(value) => {
                const patch: Partial<TimingSettings> = {};
                patch[field.key] = value;
                patchTiming(patch, `${field.label}已设为 ${value} ms`);
              }}
            />
          ))}
        </div>

        <p className="settings-hint">
          默认值：{DEFAULT_TIMING.modifierSettleMs} / {DEFAULT_TIMING.transitionGapMs} /{' '}
          {DEFAULT_TIMING.minNoteHoldMs} / {DEFAULT_TIMING.modifierReleaseGapMs} / {DEFAULT_TIMING.leadInMs} ms
          （依次为稳定 / 间隔 / 保持 / 切换 / 留白）
        </p>
      </SettingsCard>

      <SettingsCard title="调参建议">
        <ul className="fact-list">
          <li>
            <Icon name="bulb" size={13} />
            <span>
              <strong>经常漏掉修饰音</strong>：把「修饰键稳定时间」调到 30–40 ms。
            </span>
          </li>
          <li>
            <Icon name="bulb" size={13} />
            <span>
              <strong>连音粘连 / 吞音</strong>：适当调大「相邻音释放间隔」，或稍微降低演奏速度。
            </span>
          </li>
          <li>
            <Icon name="bulb" size={13} />
            <span>
              <strong>快速音符听不清</strong>：调大「最短音符保持」，但过快的段落会被压缩。
            </span>
          </li>
          <li>
            <Icon name="bulb" size={13} />
            <span>
              <strong>八度 / 半音切换不跟手</strong>：调小「修饰键切换间隔」（过低可能丢修饰）。
            </span>
          </li>
          <li>
            <Icon name="bulb" size={13} />
            <span>
              <strong>第一个音被吞</strong>：调大「开头留白」，或在「输入与权限」里开启倒计时。
            </span>
          </li>
          <li>
            <Icon name="bulb" size={13} />
            <span>修改后先到演奏台用排练模式（不发送按键）确认节奏，再进游戏。</span>
          </li>
        </ul>
      </SettingsCard>
    </div>
  );

  /* ============================================================
     Tab 3：快捷键
     ============================================================ */
  const hotkeysTab = (
    <SettingsCard
      title="全局快捷键"
      actions={
        <>
          {hotkeySummaryBadge}
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => void refreshHotkeyStatuses()}
            disabled={hotkeyStatusLoading}
          >
            <Icon name="refresh" size={13} /> 刷新状态
          </button>
          <button type="button" className="btn btn--quiet btn--sm" onClick={resetHotkeys}>
            <Icon name="reset" size={13} /> 恢复默认
          </button>
        </>
      }
    >
      <div className="settings-hotkeys">
        {HOTKEY_ACTIONS.map((action) => {
          const meta = HOTKEY_META[action];
          const conflict = hotkeyConflicts[action] ?? null;
          const isOtherRecording = recordingAction !== null && recordingAction !== action;
          return (
            <div key={action} className="settings-hotkey">
              <div className="settings-hotkey__text">
                <span className="settings-hotkey__label">{meta.label}</span>
                <p className="settings-hotkey__desc">{meta.description}</p>
                <span className="settings-hotkey__default">默认 {formatAccelerator(meta.defaultAccelerator)}</span>
              </div>
              <HotkeyRecorder
                value={settings.hotkeys[action]}
                conflict={conflict}
                disabled={isOtherRecording}
                onChange={(accelerator) => handleRecordChange(action, accelerator)}
                onRecordingChange={(recording) => handleRecordingChange(action, recording)}
              />
              <div className="settings-hotkey__status">
                {conflict ? <span className="badge badge--warn">冲突</span> : null}
                {renderHotkeyStatus(action)}
              </div>
            </div>
          );
        })}
      </div>

      <hr className="divider" />

      <p className="settings-hint">
        「已生效」表示主进程已注册成功；「注册失败」多是被系统或其他软件占用，换一个组合后再刷新状态。
        建议给「紧急停止」保留独立、易按的按键。
      </p>
    </SettingsCard>
  );

  /* ============================================================
     Tab 4：悬浮窗与外观
     ============================================================ */
  const overlayTab = (
    <div className="settings-columns">
      <SettingsCard title="悬浮控制窗">
        <div className="settings-rows">
          <SettingRow label="悬浮窗显示" description="显示后可用鼠标拖动到合适位置；隐藏不影响全局快捷键">
            <button type="button" className="btn btn--sm" onClick={() => void handleToggleOverlay()}>
              <Icon name="overlay" size={13} />
              {overlayVisible ? '隐藏悬浮窗' : '显示悬浮窗'}
            </button>
          </SettingRow>

          <RangeField
            id="settings-overlay-opacity"
            label="不透明度"
            description="0.3 最淡，1 完全不透明"
            value={settings.overlay.opacity}
            min={0.3}
            max={1}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            onCommit={(value) =>
              patchOverlay({ opacity: value }, `悬浮窗不透明度已保存：${Math.round(value * 100)}%`)
            }
          />

          <ToggleRow
            id="settings-overlay-top"
            label="保持置顶"
            description="始终显示在游戏画面之上；关闭后可能被游戏窗口遮挡"
            checked={settings.overlay.alwaysOnTop}
            onChange={(checked) =>
              patchOverlay({ alwaysOnTop: checked }, checked ? '悬浮窗保持置顶已开启' : '悬浮窗保持置顶已关闭')
            }
          />
          <ToggleRow
            id="settings-overlay-hint"
            label="显示快捷键提示"
            description="在悬浮窗底部显示当前全局快捷键，方便游戏内查看"
            checked={settings.overlay.showHotkeyHint}
            onChange={(checked) =>
              patchOverlay(
                { showHotkeyHint: checked },
                checked ? '悬浮窗快捷键提示已开启' : '悬浮窗快捷键提示已关闭',
              )
            }
          />

          <SettingRow label="重置位置" description="移回屏幕右下角默认位置；重启应用后生效">
            <button type="button" className="btn btn--quiet btn--sm" onClick={handleResetOverlayPosition}>
              <Icon name="target" size={13} /> 重置位置
            </button>
          </SettingRow>
        </div>
      </SettingsCard>

      <SettingsCard title="试听音色">
        <div className="settings-rows">
          <SettingRow
            label="试听音色"
            description="口琴为 VCSL Hohner Special 20 真实簧片采样；钢琴为 Salamander 三角钢琴采样，便于核对音高与节奏"
          >
            <div className="segmented" role="group" aria-label="试听音色">
              {PREVIEW_INSTRUMENTS.map((instrument) => (
                <button
                  key={instrument.id}
                  type="button"
                  className="segmented__item"
                  aria-pressed={settings.preview.instrument === instrument.id}
                  onClick={() => patchPreview({ instrument: instrument.id }, `试听音色已切换为「${instrument.name}」`)}
                >
                  {instrument.name}
                </button>
              ))}
            </div>
          </SettingRow>

          <RangeField
            id="settings-preview-volume"
            label="试听音量"
            description="底部播放条、演奏台与编辑器共用这一音量"
            value={settings.preview.volume}
            min={0}
            max={1}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            onCommit={(value) => patchPreview({ volume: value }, `试听音量已保存：${Math.round(value * 100)}%`)}
          />
        </div>
      </SettingsCard>
    </div>
  );

  /* ============================================================
     Tab 5：音频分析
     ============================================================ */
  const audioTab = (
    <div className="settings-columns">
      <SettingsCard
        title="主旋律提取"
        actions={
          <button type="button" className="btn btn--quiet btn--sm" onClick={resetAudio}>
            <Icon name="reset" size={13} /> 恢复默认
          </button>
        }
      >
        <div className="settings-rows">
          <SettingRow
            label="提取模式"
            description="自动判断复音程度；清唱 / 独奏选单声部，带伴奏歌曲选复音"
          >
            <div className="segmented" role="group" aria-label="提取模式">
              {MELODY_MODE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="segmented__item"
                  aria-pressed={settings.audio.melodyMode === option.id}
                  onClick={() => patchAudio({ melodyMode: option.id }, `分析模式已切换为「${option.name}」`)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </SettingRow>

          <RangeField
            id="settings-pitch-min"
            label="音域下限"
            description="低于下限的旋律会被丢弃或折返"
            value={settings.audio.pitchMin}
            min={PITCH_MIN}
            max={settings.audio.pitchMax}
            step={1}
            format={(value) => `${midiToName(value)}（${value}）`}
            onCommit={(value) => patchAudio({ pitchMin: value }, `主旋律音域下限已设为 ${midiToName(value)}`)}
          />
          <RangeField
            id="settings-pitch-max"
            label="音域上限"
            description="高于上限的旋律会被丢弃或折返"
            value={settings.audio.pitchMax}
            min={settings.audio.pitchMin}
            max={PITCH_MAX}
            step={1}
            format={(value) => `${midiToName(value)}（${value}）`}
            onCommit={(value) => patchAudio({ pitchMax: value }, `主旋律音域上限已设为 ${midiToName(value)}`)}
          />

          <SettingRow
            label="常用音域"
            description={`默认 ${midiToName(PITCH_PRESETS[0].min)} – ${midiToName(PITCH_PRESETS[0].max)}；一键套用后仍可单独微调上下限`}
          >
            <div className="segmented" role="group" aria-label="常用音域">
              {PITCH_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="segmented__item"
                  aria-pressed={settings.audio.pitchMin === preset.min && settings.audio.pitchMax === preset.max}
                  onClick={() =>
                    patchAudio(
                      { pitchMin: preset.min, pitchMax: preset.max },
                      `主旋律音域已设为 ${midiToName(preset.min)} – ${midiToName(preset.max)}`,
                    )
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <ToggleRow
            id="settings-audio-hpss"
            label="伴奏抑制（HPSS）"
            description="用谐波 / 打击分离削弱鼓点与伴奏；带伴奏歌曲建议开启"
            checked={settings.audio.suppressAccompaniment}
            onChange={(checked) =>
              patchAudio(
                { suppressAccompaniment: checked },
                checked ? '伴奏抑制已开启' : '伴奏抑制已关闭',
              )
            }
          />
          <ToggleRow
            id="settings-audio-autokey"
            label="自动检测调性"
            description="转谱时自动判断大调 / 小调并写入简谱调号"
            checked={settings.audio.autoKey}
            onChange={(checked) =>
              patchAudio({ autoKey: checked }, checked ? '自动检测调性已开启' : '自动检测调性已关闭')
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard title="扒谱细节">
        <div className="settings-rows">
          <NumberField
            id="settings-audio-min-note"
            label="最短音符"
            description="短于该时长的音会被过滤：调大可去掉颤音碎片，过大会丢快速音符"
            value={settings.audio.minNoteMs}
            min={30}
            max={300}
            step={5}
            onCommit={(value) => patchAudio({ minNoteMs: value }, `最短音符已设为 ${value} ms`)}
          />

          <SettingRow
            label="谱面密度（音频）"
            description="音频转谱的“可演奏化”程度：宽松每拍最多 1 音；标准合并同音碎片、每拍最多 2 音；精细保留 1/16 细节"
          >
            <div className="segmented" role="group" aria-label="谱面密度">
              {([
                { id: 'loose', name: '宽松' },
                { id: 'normal', name: '标准' },
                { id: 'fine', name: '精细' },
              ] as const).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="segmented__item"
                  aria-pressed={settings.audio.melodyDensity === option.id}
                  onClick={() =>
                    patchAudio({ melodyDensity: option.id }, `谱面密度已设为「${option.name}」`)
                  }
                >
                  {option.name}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            label="MIDI 量化网格"
            description="MIDI 导入时音符起点对齐到节拍网格：1/16 更精细，1/8 更简单；音频转谱由「谱面密度」控制"
            htmlFor="settings-quantize"
          >
            <select
              id="settings-quantize"
              className="select"
              value={settings.audio.quantizeGrid}
              aria-describedby="settings-quantize-desc"
              onChange={(event) => {
                const grid = Number(event.target.value);
                patchAudio({ quantizeGrid: grid }, `量化网格已设为 ${QUANTIZE_LABEL[grid] ?? grid}`);
              }}
            >
              <option value={0.125}>1/32（精细）</option>
              <option value={0.25}>1/16（推荐）</option>
              <option value={0.5}>1/8（简化）</option>
            </select>
          </SettingRow>
        </div>

        <hr className="divider" />

        <p className="settings-note is-warn">
          <Icon name="warning" size={13} />
          <span>带伴奏歌曲请用「自动判断 / 复音」并开启伴奏抑制，否则低音与和弦会被当成主旋律。</span>
        </p>
      </SettingsCard>
    </div>
  );

  /* ============================================================
     Tab 6：风险与关于
     ============================================================ */
  const aboutTab = (
    <div className="settings-columns">
      <SettingsCard title="风险声明">
        <p className="settings-callout">
          <Icon name="warning" size={15} />
          <span>
            <strong>游戏官方已把「第三方软件 / 脚本 / 鼠标宏自动操作」列为违规，最高封禁 10 年。</strong>
            本软件是非官方工具，与腾讯 / 天美工作室群无关。
          </span>
        </p>
        <ul className="fact-list">
          <li>
            <Icon name="shield" size={13} />
            <span>只调用 Windows 标准 SendInput 模拟键鼠，不注入游戏进程、不读写游戏内存、不安装驱动、不做任何反检测。</span>
          </li>
          <li>
            <Icon name="warning" size={13} />
            <span>账号处罚风险由使用者自行承担，建议不要在排位 / 竞技对局中长时间使用。</span>
          </li>
          <li>
            <Icon name="users" size={13} />
            <span>仅供个人练习与录制娱乐；继续使用即表示你已阅读并接受首次启动时的免责声明。</span>
          </li>
        </ul>

        <hr className="divider" />

        <div className="settings-links">
          <span className="section-label">官方公告与处罚说明</span>
          <ul>
            {OFFICIAL_LINKS.map((link) => (
              <li key={link.url}>
                <button type="button" className="link-button" onClick={() => openExternal(link.url)}>
                  <Icon name="external" size={12} /> {link.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </SettingsCard>

      <SettingsCard title="版本与本机数据">
        <div className="chip-row">
          <Chip label="版本" value={`v${appInfo?.version ?? '0.0.0'}`} />
          <Chip label="Electron" value={appInfo?.electronVersion ?? '—'} />
          <Chip label="Chromium" value={appInfo?.chromeVersion ?? '—'} />
          <Chip label="Node" value={appInfo?.nodeVersion ?? '—'} />
          <Chip
            label="平台"
            value={`${appInfo?.capabilities.label ?? appInfo?.platform ?? '—'}${appInfo?.arch ? ` · ${appInfo.arch}` : ''}`}
          />
          <Chip label="运行模式" value={appInfo?.isPackaged ? '安装版' : '开发版'} />
        </div>

        <div className="settings-datapath">
          <span className="field-label">数据目录</span>
          <code className="settings-path">{appInfo?.userDataPath ?? '加载中…'}</code>
        </div>

        <hr className="divider" />

        <details className="settings-details">
          <summary>游戏内口琴键位表</summary>
          <div className="settings-keysheet">
            <div className="settings-keysheet__row">
              {DEFAULT_HARMONICA.noteKeys.map((key) => (
                <div key={key.id} className="settings-key">
                  <kbd>{key.label}</kbd>
                  <span className="settings-key__degree">{key.degree === 8 ? '高音 1' : String(key.degree)}</span>
                </div>
              ))}
            </div>
            <div className="settings-keysheet__mouse">
              <span>鼠标左键 · 降八度</span>
              <span>鼠标中键 · 升半音</span>
              <span>鼠标右键 · 升八度</span>
            </div>
            <p className="settings-hint">音域 C3 – C#6（约 3 个八度、38 个半音），单音演奏；游戏改过键位时以实机为准。</p>
          </div>
        </details>
      </SettingsCard>
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
    <div className="page">
      <PageHeader
        title="设置与校准"
        subtitle="修改即时保存"
        actions={
          <button type="button" className="btn btn--sm" onClick={openUserData}>
            <Icon name="folder" size={14} /> 打开数据目录
          </button>
        }
      />

      {!canInject ? (
        <Notice tone="signal" icon={<Icon name="info" size={15} />} title={`${capabilities?.label ?? '当前平台'} 版：游戏注入不可用`}>
          编辑、导入、练习、试听与宏导出可正常使用；向游戏发送按键需要 Windows 版。输入与权限中的注入相关选项已置灰，演奏会按排练模式走时间轴。
        </Notice>
      ) : elevated ? (
        <Notice tone="ok" icon={<Icon name="shield" size={15} />} title="已以管理员权限运行">
          向游戏注入按键不会被 Windows UIPI 拦截；排练模式与试听不依赖权限，随时可用。
        </Notice>
      ) : (
        <Notice
          tone="warn"
          icon={<Icon name="warning" size={15} />}
          title="尚未以管理员权限运行"
          actions={
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void handleRelaunch()}
              disabled={elevating}
            >
              <Icon name="shield" size={13} /> {elevating ? '正在请求…' : '以管理员重启'}
            </button>
          }
        >
          向游戏注入按键会被 Windows 静默丢弃；排练模式与试听不受影响。
        </Notice>
      )}

      <div className="tabs settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={handleTabKeyDown}>
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`settings-tab-${item.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section
        className="settings-panel"
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tabContent[tab]}
      </section>
    </div>
  );
}

/* ============================================================
   页面内复用的小组件
   ============================================================ */

/** 页面卡片：标题 + 一句说明 + 右侧操作；一个 tab 最多两张 */
function SettingsCard({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="card settings-block" aria-label={title}>
      <div className="card-title-row">
        <div className="settings-block__heading">
          <h2 className="card-title">{title}</h2>
        </div>
        {actions ? <div className="inline-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** 统一设置行：左侧标签 + 说明，右侧控件；不画行分隔线，分组之间用 .divider */
function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        {htmlFor ? (
          <label className="settings-row__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row__label">{label}</span>
        )}
        {description ? (
          <p className="settings-row__desc" id={htmlFor ? `${htmlFor}-desc` : undefined}>
            {description}
          </p>
        ) : null}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

/** 行式开关：可见标签在左列，开关本体通过 htmlFor 关联，读屏可读出名称与状态 */
function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const descriptionId = `${id}-desc`;
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <label className="settings-row__label" htmlFor={id}>
          {label}
        </label>
        <p className="settings-row__desc" id={descriptionId}>
          {description}
        </p>
      </div>
      <div className="settings-row__control">
        <label className="switch">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-describedby={descriptionId}
            onChange={(event) => onChange(event.target.checked)}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * 毫秒数字输入：编辑态用本地草稿，失焦 / 回车时钳制范围并提交，
 * 避免直接受控导致输入中间值被立即裁剪（例如先输 1 再输 0 变成 4）。
 */
function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  unit = 'ms',
  onCommit,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  const descriptionId = `${id}-desc`;

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
    <div className="settings-row">
      <div className="settings-row__text">
        <label className="settings-row__label" htmlFor={id}>
          {label}
        </label>
        <p className="settings-row__desc" id={descriptionId}>
          {description}
        </p>
      </div>
      <div className="settings-row__control">
        <input
          id={id}
          className="input number"
          type="number"
          min={min}
          max={max}
          step={step}
          title={`${min} – ${max} ${unit}`}
          value={draft}
          aria-describedby={descriptionId}
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
        <span className="settings-unit">{unit}</span>
      </div>
    </div>
  );
}

/**
 * 滑杆：拖动时本地实时显示，停顿 260ms 或卸载时提交并 toast，
 * 避免连续拖动触发大量 settings IPC 写入。
 */
function RangeField({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const valueRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);
  const descriptionId = `${id}-desc`;

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

  // 轨道左侧实心部分 = 当前值在原范围内的比例（令牌配色见 components.css 的 .range）
  const fillPercent = max > min ? Math.min(100, Math.max(0, ((draft - min) / (max - min)) * 100)) : 0;

  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <label className="settings-row__label" htmlFor={id}>
          {label}
        </label>
        <p className="settings-row__desc" id={descriptionId}>
          {description}
        </p>
      </div>
      <div className="settings-row__control">
        <input
          id={id}
          className="range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-describedby={descriptionId}
          style={{ '--range-fill': `${fillPercent}%` } as CSSProperties}
          onChange={(event) => handleChange(Number(event.target.value))}
        />
        <span className="settings-range__value">{format(draft)}</span>
      </div>
    </div>
  );
}
