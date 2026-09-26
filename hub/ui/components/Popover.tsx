import {useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode} from 'react';

/** A button with an anchored panel; closes on outside click, Escape and focus moving out. */
export function Popover({
  label,
  icon,
  trigger,
  badge,
  children,
  open: controlled,
  onOpenChange,
  align = 'right',
  triggerClass,
  up = false,
}: {
  label: string;
  icon?: ReactNode;
  /** A text trigger instead of an icon button. */
  trigger?: ReactNode;
  /** How a text trigger looks, when not as plain text; such a trigger is named by `label`, not by what it shows. */
  triggerClass?: string;
  /** Opens above the button (from the bottom of a card), or below it when there is no room above. */
  up?: boolean;
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
  const panel = useRef<HTMLDivElement>(null);
  // Measured once it is open (below): a panel opening upwards opens downwards instead when
  // it does not fit above and there is more room below.
  const [down, setDown] = useState(false);
  // The panel moves sideways to stay on the screen (from a card at the edge of a narrow
  // one), again when the window turns or is resized; the page's width leaves out its scrollbar.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    const place = () => {
      element.style.translate = '';
      const rect = element.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const edge = 8;
      const shift = rect.left < edge ? edge - rect.left : rect.right > width - edge ? width - edge - rect.right : 0;
      if (shift) element.style.translate = `${shift}px 0`;
    };
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [open]);

  // A panel is as tall as its content and scrolls only when that is taller than the screen
  // under the top bar: a large screen shows it whole. One opening upwards does so only where
  // it fits whole, as nothing shows it past the top bar; otherwise it opens downwards, where
  // the page scrolls to the rest of it. It is measured again as its content changes.
  const [cap, setCap] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = button.current;
    if (!open || !element || !trigger) {
      setDown(false);
      return setCap(null);
    }
    const fit = () => {
      element.style.maxHeight = '';
      element.classList.remove('is-capped');
      const natural = element.getBoundingClientRect().height;
      const at = trigger.getBoundingClientRect();
      const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
      const screen = innerHeight - bar - 16;
      const upwards = up && natural <= at.top - bar - 14;
      const capped = natural > screen ? screen : null;
      // Set here as well as through state, so what is measured next is what shows.
      element.style.maxHeight = capped === null ? '' : `${capped}px`;
      element.classList.toggle('is-capped', capped !== null);
      setDown(up && !upwards);
      setCap(capped);
    };
    fit();
    // A refit may change the cap and wake the observer once more; then the panel stays as it is.
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      removeEventListener('resize', fit);
    };
  }, [open, up]);

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

  // Focus moving on to something outside closes the panel as a click there would, so Tab
  // from one mark of a tray to the next never leaves two panels open. Focus going nowhere
  // (a click on the panel's text, the focused control gone, another window) leaves it open.
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (open && next instanceof Node && !box.current?.contains(next)) setOpen(false);
  };

  return (
    <div className="picker" ref={box} onBlur={leave}>
      <button
        type="button"
        className={trigger ? `text-button ${triggerClass ?? ''}` : 'icon-button'}
        aria-expanded={open}
        ref={button}
        aria-label={trigger && !triggerClass ? undefined : label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        {trigger ?? icon}
        {!!badge && <i className="badge">{badge}</i>}
      </button>
      {open && (
        <div
          className={`popover glass ${align === 'left' ? 'is-left' : ''} ${up && !down ? 'is-up' : ''} ${cap !== null ? 'is-capped' : ''}`}
          style={cap !== null ? {maxHeight: cap} : undefined}
          role="dialog"
          aria-label={label}
          ref={panel}
        >
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
