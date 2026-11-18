/** 轻量 SVG 图标集（线性风格，随 currentColor 着色） */
export type IconName =
  | 'play'
  | 'stop'
  | 'edit'
  | 'import'
  | 'library'
  | 'settings'
  | 'music'
  | 'refresh'
  | 'warning'
  | 'check'
  | 'star'
  | 'trash'
  | 'download'
  | 'window'
  | 'shield'
  | 'chevron'
  | 'close'
  | 'folder'
  | 'sparkle'
  | 'clock'
  | 'target'
  | 'headphones'
  | 'overlay'
  | 'pause'
  | 'volume'
  | 'plus';

const PATHS: Record<IconName, JSX.Element> = {
  play: <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />,
  edit: (
    <>
      <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0-3-3L5.2 17 4 20Z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  import: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 17.5v2h15v-2" />
    </>
  ),
  library: (
    <>
      <rect x="4" y="4" width="6.5" height="16" rx="1.2" />
      <rect x="13.5" y="4" width="6.5" height="16" rx="1.2" />
      <path d="M7.2 8h0.1M16.7 8h0.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" />
    </>
  ),
  music: (
    <>
      <path d="M9 17.5V6.2l9-2v11.3" />
      <ellipse cx="6.8" cy="17.6" rx="2.8" ry="2.1" />
      <ellipse cx="15.8" cy="15.6" rx="2.8" ry="2.1" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M19.5 4.5V9H15" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4 21 20H3L12 4Z" />
      <path d="M12 9.5v5M12 17.2h0.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
  star: <path d="m12 4 2.5 5.2 5.5.8-4 3.9.9 5.6L12 16.8l-4.9 2.7.9-5.6-4-3.9 5.5-.8L12 4Z" />,
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7" />
      <path d="M10.2 11v5M13.8 11v5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10" />
      <path d="m7.5 10 4.5 4.5 4.5-4.5" />
      <path d="M5 19h14" />
    </>
  ),
  window: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17M7 7h0.01M9.6 7h0.01" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.2-7 9-4.1-1.8-7-4.8-7-9V6L12 3.5Z" />
      <path d="m9 11.8 2.1 2.2 4-4.2" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  folder: (
    <>
      <path d="M4 6.5h5l2 2.5h9v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12Z" />
      <path d="M4 9h16" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5Z" />
      <path d="M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2" />
    </>
  ),
  headphones: (
    <>
      <path d="M4.5 13v-1a7.5 7.5 0 0 1 15 0v1" />
      <rect x="3.5" y="12.5" width="4" height="6.5" rx="1.6" />
      <rect x="16.5" y="12.5" width="4" height="6.5" rx="1.6" />
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
  pause: (
    <>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  volume: (
    <>
      <path d="M4 10v4h3l4.5 3.5v-11L7 10H4Z" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 7a7 7 0 0 1 0 10" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
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
