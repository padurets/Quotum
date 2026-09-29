import {useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode} from 'react';
import {coverOf, sideOf} from '../lib/place';

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
  /** Opens above the button (from the bottom of a card) rather than below it, where there is room. */
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

  // A panel never scrolls the page nor lengthens it: it opens whole in the window, under the
  // bars stuck at its top, on the side of its button that `sideOf` picks, cut to the room
  // there and scrolling inside. Where it stands on either side is read, not assumed, as a text
  // trigger is taller than an icon. It is measured again as its content changes, keeping to
  // the side it is on while it fits there, and once the board has been laid out for a resized
  // window; not as the page scrolls: it goes with its button. A list of it that scrolls on its
  // own while the rest stays (`.popover-scroll`) has at least the room it asks for (`--least`),
  // or the whole panel scrolls, the list with it (`is-cramped`).
  const [side, setSide] = useState<{up: boolean; cap: number | null; cramped: boolean} | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = button.current;
    if (!open || !element || !trigger) return setSide(null);
    let upwards = up;
    const fit = () => {
      const list = element.querySelector<HTMLElement>('.popover-scroll');
      // Measuring takes the cut off, which would lose how far its reader had scrolled.
      const scrolled = [element.scrollTop, list?.scrollTop ?? 0];
      element.style.maxHeight = '';
      element.classList.remove('is-capped', 'is-cramped', 'is-up');
      const below = element.getBoundingClientRect();
      element.classList.add('is-up');
      const above = element.getBoundingClientRect();
      const cover = coverOf(trigger.getBoundingClientRect().top, trigger);
      const {up: next, cap} = sideOf(below.height, above.bottom - cover - 8, innerHeight - 8 - below.top, upwards);
      const least = list ? parseFloat(getComputedStyle(list).getPropertyValue('--least')) || 0 : 0;
      const cramped = cap !== null && !!list && cap - (below.height - list.getBoundingClientRect().height) < least;
      upwards = next;
      // Set here as well as through state, so what is measured next is what shows.
      element.classList.toggle('is-up', next);
      element.classList.toggle('is-capped', cap !== null);
      element.classList.toggle('is-cramped', cramped);
      element.style.maxHeight = cap === null ? '' : `${cap}px`;
      element.scrollTop = scrolled[0];
      if (list) list.scrollTop = scrolled[1];
      setSide(same => (same?.up === next && same.cap === cap && same.cramped === cramped ? same : {up: next, cap, cramped}));
    };
    fit();
    // A refit may change the cap and wake the observer once more; then the panel stays as it is.
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    // The board takes its new columns after the resize is told (they follow a media query):
    // the panel is measured once it has, in the frame that shows it.
    let frame = 0;
    const resized = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    addEventListener('resize', resized);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      removeEventListener('resize', resized);
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
          className={`popover glass ${align === 'left' ? 'is-left' : ''} ${(side?.up ?? up) ? 'is-up' : ''} ${side?.cap != null ? 'is-capped' : ''} ${side?.cramped ? 'is-cramped' : ''}`}
          style={side?.cap != null ? {maxHeight: side.cap} : undefined}
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
