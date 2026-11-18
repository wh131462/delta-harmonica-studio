import type { ReactNode } from 'react';

/**
 * 页面头：所有页面统一使用，保证「标题 / 说明 / 操作区」的位置与字号一致。
 * 标题固定为 h1；actions 放在右侧，主操作最多一个（且通常下沉到播放条）。
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Chip({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'danger';
}): JSX.Element {
  return (
    <span className={`chip chip-${tone}`}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </span>
  );
}

/**
 * 内联提示条：替代页面里散落的彩色横幅。
 * tone 决定图标与底色，文字永远保持高对比。
 */
export function Notice({
  tone = 'signal',
  title,
  children,
  icon,
  actions,
}: {
  tone?: 'ok' | 'warn' | 'danger' | 'signal';
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="notice__icon" aria-hidden="true">
        {icon ?? <span className="status-dot" />}
      </div>
      <div className="notice__body">
        <strong className="notice__title">{title}</strong>
        {children ? <span className="notice__desc">{children}</span> : null}
      </div>
      {actions ? <div className="notice__actions">{actions}</div> : null}
    </div>
  );
}
