import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  className = '',
  closable = true,
  dismissOnOverlay = true,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closable?: boolean;
  dismissOnOverlay?: boolean;
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closable) onClose?.();
    };
    window.addEventListener('keydown', handler);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', handler);
  }, [open, closable, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // 只响应鼠标左键，且默认不允许误触关闭（自检/免责声明弹窗需要）
        if (event.button !== 0) return;
        if (event.target === event.currentTarget && closable && dismissOnOverlay) onClose?.();
      }}
    >
      <div className={`modal-panel ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          {closable ? (
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
              <Icon name="close" />
            </button>
          ) : null}
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Toast({
  kind,
  text,
}: {
  kind: 'info' | 'success' | 'error' | 'warning';
  text: string;
}): JSX.Element {
  const iconName = kind === 'success' ? 'check' : kind === 'error' || kind === 'warning' ? 'warning' : 'sparkle';
  return (
    <div className={`toast toast-${kind}`} role="status">
      <Icon name={iconName} size={16} />
      <span>{text}</span>
    </div>
  );
}
