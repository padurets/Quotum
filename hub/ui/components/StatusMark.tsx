import type {ReactNode} from 'react';
import {Popover} from './Popover';

export function WarningIcon() {
  return (
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="m12 3 10 18H2Z" />
      <path d="M12 9v5m0 3h.01" />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 9 9m-5-5 3-3m-1 5 3-3" />
    </svg>
  );
}

/** Card news shares the same trigger, panel and status tokens. */
export function StatusMark({
  label,
  trigger,
  tone,
  className,
  align = 'left',
  children,
}: {
  label: string;
  trigger: ReactNode;
  tone?: 'warn' | 'crit';
  className?: string;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const classes = ['tray-pill', tone && `is-${tone}`, className].filter(Boolean).join(' ');

  return (
    <Popover label={label} trigger={trigger} triggerClass={classes} align={align} up>
      <div className="tray-panel">{children}</div>
    </Popover>
  );
}
