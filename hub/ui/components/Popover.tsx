import React, {useEffect, useRef, useState, type ReactNode} from 'react';

/** An icon button with an anchored panel; closes on outside click and Escape. */
export function Popover({label, icon, badge, children}: {label: string; icon: ReactNode; badge?: number; children: ReactNode}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="picker" ref={box}>
      <button className="icon-button" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
        {icon}
        {!!badge && <i className="badge">{badge}</i>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A labelled on/off row for popovers. */
export function SwitchRow({on, onChange, children, value}: {on: boolean; onChange: (on: boolean) => void; children: ReactNode; value?: ReactNode}) {
  return (
    <button className="popover-row" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
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

export const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style={{strokeWidth: 1.6}}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
