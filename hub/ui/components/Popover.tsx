import {useEffect, useRef, useState, type ReactNode} from 'react';

/** A button with an anchored panel; closes on outside click and Escape. */
export function Popover({
  label,
  icon,
  trigger,
  badge,
  children,
  open: controlled,
  onOpenChange,
  align = 'right',
}: {
  label: string;
  icon?: ReactNode;
  /** A text trigger instead of an icon button. */
  trigger?: ReactNode;
  badge?: number;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'left' | 'right';
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setOwn(next));
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Focus inside the panel would fall to the page's start; it goes back to the button.
      if (box.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        className={trigger ? 'text-button' : 'icon-button'}
        aria-expanded={open}
        ref={button}
        aria-label={trigger ? undefined : label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        {trigger ?? icon}
        {!!badge && <i className="badge">{badge}</i>}
      </button>
      {open && (
        <div className={`popover glass ${align === 'left' ? 'is-left' : ''}`} role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A labelled on/off row for popovers. */
export function SwitchRow({on, onChange, children, value, className = ''}: {on: boolean; onChange: (on: boolean) => void; children: ReactNode; value?: ReactNode; className?: string}) {
  return (
    <button type="button" className={`popover-row ${className}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <i className={`switch ${on ? 'on' : ''}`} />
      <span>{children}</span>
      {value !== undefined && <b>{value}</b>}
    </button>
  );
}

export const SlidersIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M2 4.5h6M11.5 4.5H14M2 11.5h2.5M8 11.5h6" />
    <circle cx="9.75" cy="4.5" r="1.75" />
    <circle cx="6.25" cy="11.5" r="1.75" />
  </svg>
);

/** The last row of a widget's menu, for the board's owner: hides the widget (its data stays). */
export function HideRow({children, onHide}: {children: ReactNode; onHide: () => void}) {
  return (
    <div className="popover-section">
      <button type="button" className="popover-row" onClick={onHide}>
        <EyeOffIcon />
        <span>{children}</span>
      </button>
    </div>
  );
}

/** Taking a shared widget off the board: the data stays with whoever measures it. */
export const TakeOffIcon = () => (
  <svg className="row-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M9.5 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h5M7 8h7M11.5 5.5 14 8l-2.5 2.5" />
  </svg>
);

export const EyeOffIcon = () => (
  <svg className="row-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M2 8s2.2-4 6-4c1 0 1.9.3 2.7.7M14 8s-2.2 4-6 4c-1 0-1.9-.3-2.7-.7M6.6 9.4a2 2 0 0 1 2.8-2.8M2.5 13.5l11-11" />
  </svg>
);
