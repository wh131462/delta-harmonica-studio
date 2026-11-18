/** 轻量 SVG 图标集（线性风格，随 currentColor 着色） */
export type IconName =
  // 播放与音频
  | 'play'
  | 'stop'
  | 'pause'
  | 'record'
  | 'volume'
  | 'headphones'
  | 'waveform'
  | 'panic'
  // 文件与编辑
  | 'edit'
  | 'import'
  | 'download'
  | 'save'
  | 'folder'
  | 'file-music'
  | 'copy'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'plus'
  | 'check'
  | 'checkbox'
  | 'checkbox-blank'
  | 'close'
  // 导航
  | 'keyboard'
  | 'library'
  | 'settings'
  | 'overlay'
  | 'window'
  // 状态与系统
  | 'refresh'
  | 'reset'
  | 'warning'
  | 'info'
  | 'bulb'
  | 'activity'
  | 'users'
  | 'target'
  | 'shield'
  | 'clock'
  | 'star'
  | 'music'
  | 'search'
  | 'grid'
  | 'list'
  | 'more'
  | 'filter'
  | 'external'
  | 'chevron'
  | 'chevron-down'
  | 'expand'
  | 'collapse';

const PATHS: Record<IconName, JSX.Element> = {
  play: <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  volume: (
    <>
      <path d="M4 10v4h3l4.5 3.5v-11L7 10H4Z" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 7a7 7 0 0 1 0 10" />
    </>
  ),
  headphones: (
    <>
      <path d="M4.5 13v-1a7.5 7.5 0 0 1 15 0v1" />
      <rect x="3.5" y="12.5" width="4" height="6.5" rx="1.6" />
      <rect x="16.5" y="12.5" width="4" height="6.5" rx="1.6" />
    </>
  ),
  /** 波形：音频 / MIDI 分析的信号形态 */
  waveform: <path d="M4.4 10.5v3M8.2 7.6v8.8M12 4.6v14.8M15.8 8.2v7.6M19.6 10.8v2.4" />,
  /** 急停：八角停车标志 */
  panic: (
    <>
      <path d="M9 3.8h6l5.2 5.2v6l-5.2 5.2H9l-5.2-5.2V9L9 3.8Z" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),

  edit: (
    <>
      <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0-3-3L5.2 17 4 20Z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  /** 导入：文件接收箭头（与「下载 / 导出」的箭头+托底线区分） */
  import: (
    <>
      <path d="M13.4 3.7H7.2a1.8 1.8 0 0 0-1.8 1.8v13a1.8 1.8 0 0 0 1.8 1.8h9.6a1.8 1.8 0 0 0 1.8-1.8V8.6l-5.2-4.9Z" />
      <path d="M13.2 3.9v4.6h5.2" />
      <path d="M12 10.8v5.8" />
      <path d="m9.6 14.2 2.4 2.4 2.4-2.4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10" />
      <path d="m7.5 10 4.5 4.5 4.5-4.5" />
      <path d="M5 19h14" />
    </>
  ),
  /** 保存：软盘（写入方案库 / 保存修改） */
  save: (
    <>
      <path d="M5.7 4.5h8.9l4.9 4.9v9.1a1.9 1.9 0 0 1-1.9 1.9H5.7a1.9 1.9 0 0 1-1.9-1.9V6.4a1.9 1.9 0 0 1 1.9-1.9Z" />
      <path d="M8.3 4.5v5.1h6.2V4.5" />
      <path d="M8.3 20.4v-5.4h7.4v5.4" />
    </>
  ),
  folder: (
    <path d="M3.9 7.3a2 2 0 0 1 2-2h3.6l2.1 2.4h6.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.9a2 2 0 0 1-2-2V7.3Z" />
  ),
  'file-music': (
    <>
      <path d="M6 3.5h7l5 5v12H6Z" />
      <path d="M13 3.5v5h5" />
      <path d="M10.2 17v-4l3.4-.8V16" />
      <circle cx="9.1" cy="17.2" r="1.3" />
      <circle cx="12.5" cy="16.4" r="1.3" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M5.5 15.5v-10a2 2 0 0 1 2-2h10" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7" />
      <path d="M10.2 11v5M13.8 11v5" />
    </>
  ),
  undo: (
    <>
      <path d="M9.2 6.2 4.4 11l4.8 4.8" />
      <path d="M4.8 11h9.4a5.2 5.2 0 0 1 0 10.4H11" />
    </>
  ),
  redo: (
    <>
      <path d="m14.8 6.2 4.8 4.8-4.8 4.8" />
      <path d="M19.2 11H9.8a5.2 5.2 0 0 0 0 10.4H13" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
  /** 已选择：带勾选方框 */
  checkbox: (
    <>
      <rect x="4.2" y="4.2" width="15.6" height="15.6" rx="4" />
      <path d="m8.3 12.2 2.7 2.6 4.8-5.4" />
    </>
  ),
  /** 未选择：空白方框 */
  'checkbox-blank': <rect x="4.2" y="4.2" width="15.6" height="15.6" rx="4" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,

  /** 练习：键盘（跟谱击键） */
  keyboard: (
    <>
      <rect x="2.6" y="6.2" width="18.8" height="11.6" rx="2.2" />
      <path d="M6.2 9.9h1.2M10 9.9h1.2M13.8 9.9h1.2M17.6 9.9h1.2" />
      <path d="M6.2 13.1h1.2M10 13.1h1.2M13.8 13.1h1.2M17.6 13.1h1.2" />
      <path d="M8.4 16.3h7.2" />
    </>
  ),
  /** 方案库：摊开的谱本 */
  library: (
    <>
      <path d="M12 6.6C10.7 5.3 8.7 4.7 6.1 4.7H3.7v13.1h2.4c2.6 0 4.6.6 5.9 1.9 1.3-1.3 3.3-1.9 5.9-1.9h2.4V4.7h-2.4c-2.6 0-4.6.6-5.9 1.9Z" />
      <path d="M12 6.6v13.1" />
    </>
  ),
  /** 设置：齿轮（齿与齿圈、轴孔同一描边） */
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <circle cx="12" cy="12" r="6.4" />
      <path d="M12 3.4v2.3M12 18.3v2.3M3.4 12h2.3M18.3 12h2.3M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6" />
    </>
  ),
  overlay: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
      <path d="M3.5 8h17" />
      <rect x="12" y="12" width="9" height="7.5" rx="1.8" fill="currentColor" fillOpacity="0.18" />
      <path d="M14 14h5M14 16.4h3.2" />
    </>
  ),
  window: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17M7 7h0.01M9.6 7h0.01" />
    </>
  ),

  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M19.5 4.5V9H15" />
    </>
  ),
  /** 恢复默认 / 重新开始：逆时针回转箭头 */
  reset: (
    <>
      <path d="M5 12a7 7 0 1 0 2.1-5" />
      <path d="M4.5 4.5V9H9" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4 21 20H3L12 4Z" />
      <path d="M12 9.5v5M12 17.2h0.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 16.4v-4.7" />
      <path d="M12 8.2h0.01" />
    </>
  ),
  /** 建议：灯泡 */
  bulb: (
    <>
      <path d="M9.5 18.4h5M10.6 20.9h2.8" />
      <path d="M12 3.1a6.1 6.1 0 0 0-3.6 11l.6.5v3.8h6v-3.8l.6-.5A6.1 6.1 0 0 0 12 3.1Z" />
    </>
  ),
  /** 链路活动：输入通道 / 自检 */
  activity: <path d="M3.4 12.2h3.7l2.6-7.2 4.6 14.4 2.4-7.2h3.9" />,
  users: (
    <>
      <circle cx="9.2" cy="8.4" r="3.4" />
      <path d="M2.9 20v-1.6a3.9 3.9 0 0 1 3.9-3.9h4.8a3.9 3.9 0 0 1 3.9 3.9V20" />
      <path d="M16.2 4.9a3.4 3.4 0 0 1 0 6.6" />
      <path d="M17.6 14.6a3.9 3.9 0 0 1 3.5 3.9V20" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.2-7 9-4.1-1.8-7-4.8-7-9V6L12 3.5Z" />
      <path d="m9 11.8 2.1 2.2 4-4.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  star: <path d="m12 4 2.5 5.2 5.5.8-4 3.9.9 5.6L12 16.8l-4.9 2.7.9-5.6-4-3.9 5.5-.8L12 4Z" />,
  music: (
    <>
      <path d="M9 17.5V6.2l9-2v11.3" />
      <ellipse cx="6.8" cy="17.6" rx="2.8" ry="2.1" />
      <ellipse cx="15.8" cy="15.6" rx="2.8" ry="2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.4 15.4 4.6 4.6" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.6" height="6.6" rx="1.4" />
      <rect x="13.4" y="4" width="6.6" height="6.6" rx="1.4" />
      <rect x="4" y="13.4" width="6.6" height="6.6" rx="1.4" />
      <rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.4" />
    </>
  ),
  list: (
    <>
      <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" />
      <circle cx="4.6" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="17.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  more: (
    <>
      <circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  filter: <path d="M4 6h16l-6.2 7.4V20l-3.6-2v-4.6L4 6Z" />,
  external: (
    <>
      <path d="M13.5 4.5H20v6.5" />
      <path d="M20 4.5 11 13.5" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  'chevron-down': <path d="m6 9.5 6 6 6-6" />,
  /** 全屏：四角向外 */
  expand: (
    <>
      <path d="M9.5 4.5h-5v5" />
      <path d="M14.5 4.5h5v5" />
      <path d="M14.5 19.5h5v-5" />
      <path d="M9.5 19.5h-5v-5" />
    </>
  ),
  /** 退出全屏：四角向内 */
  collapse: (
    <>
      <path d="M4.5 9.5h5v-5" />
      <path d="M19.5 9.5h-5v-5" />
      <path d="M19.5 14.5h-5v5" />
      <path d="M4.5 14.5h5v5" />
    </>
  ),
};

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
