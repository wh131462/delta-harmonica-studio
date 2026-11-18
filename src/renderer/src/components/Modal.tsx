import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 弹窗基元：Esc 关闭、焦点回到触发元素、Tab 焦点循环、读取 title 作为无障碍名称。
 */
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
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closable) {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null,
      );
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const activeNode = document.activeElement;
      if (event.shiftKey && (activeNode === first || activeNode === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeNode === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      restoreFocusRef.current?.focus?.();
    };
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
      <div
        className={`modal-panel ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
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
  const iconName = kind === 'success' ? 'check' : kind === 'error' || kind === 'warning' ? 'warning' : 'info';
  return (
    <div className={`toast toast-${kind}`} role="status" aria-live="polite">
      <Icon name={iconName} size={15} />
      <span>{text}</span>
    </div>
  );
}
