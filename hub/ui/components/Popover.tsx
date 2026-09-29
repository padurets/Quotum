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
  // A panel never scrolls the page, lengthens it nor widens it: it opens whole in the window,
  // under the bars stuck at its top, on the side of its button that `sideOf` picks, cut to the
  // room there and scrolling inside, and moves sideways as far as keeps it on the screen (from a
  // card at the edge of a narrow one) or in its dialog. Where it stands is read, not assumed, as
  // a text trigger is taller than an icon. It is measured again as its content changes, keeping
  // to the side it is on while it fits there, and as the window or the page's content changes
  // size: the board lays itself out again after a resize, a widget above grows. Not as the page
  // scrolls: it goes with its button, and while that is out of the window it stays as it was,
  // measured again once the button is back if its content or the window changed meanwhile. A
  // list of it that scrolls on its own while the rest stays (`.popover-scroll`) has at least the
  // room it asks for (`--least`), or the whole panel scrolls, the list with it (`is-cramped`).
  const [side, setSide] = useState<{up: boolean; cap: number | null; cramped: boolean} | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = button.current;
    const picker = box.current;
    if (!open || !element || !trigger || !picker) return setSide(null);
    let upwards = up;
    // A change it has to answer (its content, the window), not one of the page it goes along with.
    let missed = false;
    const fit = (own = true) => {
      const seen = picker.getBoundingClientRect();
      if (seen.bottom <= 0 || seen.top >= innerHeight) {
        missed ||= own;
        return;
      }
      missed = false;
      const list = element.querySelector<HTMLElement>('.popover-scroll');
      // Measuring takes the cut off, and what scrolls may change: its reader keeps their place in
      // the list where there is one (at its top, the panel's top, the title in sight), or its end.
      const scroller = list && !element.classList.contains('is-cramped') ? list : element;
      const end = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const read = !list ? element.scrollTop : scroller === element ? element.scrollTop - list.offsetTop : list.scrollTop || -list.offsetTop;
      element.style.maxHeight = '';
      element.style.translate = '';
      element.classList.remove('is-capped', 'is-cramped');
      // Measured above its button only, where it cannot lengthen the page as it is measured; the
      // stylesheet sets it as far below its button as above.
      element.classList.add('is-up');
      const rect = element.getBoundingClientRect();
      const at = picker.getBoundingClientRect();
      const gap = at.top - rect.bottom;
      const cover = coverOf(at.top, trigger);
      const {up: next, cap} = sideOf(rect.height, rect.bottom - cover - 8, innerHeight - 8 - (at.bottom + gap), upwards);
      const least = list ? parseFloat(getComputedStyle(list).getPropertyValue('--least')) || 0 : 0;
      const cramped = cap !== null && !!list && cap - (rect.height - list.getBoundingClientRect().height) < least;
      upwards = next;
      // Set here as well as through state, so what is measured next is what shows.
      element.classList.toggle('is-up', next);
      element.classList.toggle('is-capped', cap !== null);
      element.classList.toggle('is-cramped', cramped);
      element.style.maxHeight = cap === null ? '' : `${cap}px`;
      const scrolls = list && !cramped ? list : element;
      scrolls.scrollTop = end ? scrolls.scrollHeight : list && scrolls === element ? read + list.offsetTop : read;
      // Sideways as it now stands, a cut panel wider by its scrollbar, within the width of the page
      // or of its dialog, either without its own scrollbar.
      const placed = element.getBoundingClientRect();
      const width = (trigger.closest<HTMLElement>('.overlay') ?? document.documentElement).clientWidth;
      const shift = placed.left < 8 ? 8 - placed.left : placed.right > width - 8 ? width - 8 - placed.right : 0;
      if (shift) element.style.translate = `${shift}px 0`;
      setSide(same => (same?.up === next && same.cap === cap && same.cramped === cramped ? same : {up: next, cap, cramped}));
    };
    fit();
    // A refit may change the cap and wake the observer once more; then the panel stays as it is.
    // The page's content changes size as the board lays itself out anew, in as many passes as it
    // takes (the body, at least as tall as the window, would not tell on a short board).
    const observer = new ResizeObserver(entries => fit(entries.some(entry => entry.target === element)));
    observer.observe(element);
    observer.observe(document.getElementById('root') ?? document.body);
    const back = new IntersectionObserver(entries => {
      if (entries.at(-1)?.isIntersecting && missed) fit();
    });
    back.observe(picker);
    const resized = () => fit();
    addEventListener('resize', resized);
    return () => {
      observer.disconnect();
      back.disconnect();
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
