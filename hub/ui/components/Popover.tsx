import {useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode} from 'react';
import {barsOf, coverOf, crampedOf, roomOf, shiftOf, sideOf} from '../lib/place';
import {settler} from '../lib/settle';

/** A button with an anchored panel; closes on outside click, Escape, focus moving out and its button going out of sight. */
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
  // a text trigger is taller than an icon. It is placed again as its content changes, keeping to
  // the side it is on while it has room there, and as the page is laid out anew: the window or
  // the page's content changes size, the board lays itself out again after a resize, in as many
  // passes as it takes, its widgets change size, trade places or slide to new ones. Only ever from
  // its button in sight: while the page is laid out it follows the button, hidden where that is
  // out of sight, past the window's edge or under the bars, and once the page is still, a button
  // out of sight closes it. Not placed again as the page scrolls, it goes along with its button,
  // and a scroll that takes the button out of sight closes it, as placed from where the button
  // went it would stand wrong by the time its reader scrolled back. A list of it that scrolls on
  // its own while the rest stays (`.popover-scroll`) has at least the room it asks for
  // (`--least`), or the whole panel scrolls, the list with it (`is-cramped`).
  const [side, setSide] = useState<{up: boolean; cap: number | null; cramped: boolean} | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = button.current;
    const picker = box.current;
    if (!open || !element || !trigger || !picker) return setSide(null);
    // The side it stands on, once placed.
    let upwards: boolean | null = null;
    // The bars are found again as the page is laid out, not at every scroll.
    let bars = barsOf();
    // The panel's size as it was placed: its observer telling of that is no news, as a panel cut
    // anew as its button moves would be cut again and again; only its content changing it is.
    let size = {width: 0, height: 0};
    const seen = () => {
      const at = picker.getBoundingClientRect();
      return at.bottom > coverOf(at.bottom, trigger, bars) && at.top < innerHeight;
    };
    // Focus in the panel goes back to the button, as on Escape, without scrolling the page to it.
    const unfocus = () => {
      if (element.contains(document.activeElement)) trigger.focus({preventScroll: true});
    };
    const close = () => {
      unfocus();
      setOpen(false);
    };
    const place = () => {
      element.style.display = '';
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
      const {above, below} = roomOf(at, at.top - rect.bottom, coverOf(at.bottom, trigger, bars), innerHeight);
      const {up: next, cap} = sideOf(rect.height, above, below, upwards ?? up, upwards !== null);
      const least = list ? parseFloat(getComputedStyle(list).getPropertyValue('--least')) || 0 : 0;
      const cramped = !!list && crampedOf(cap, rect.height - list.getBoundingClientRect().height, least);
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
      size = {width: placed.width, height: placed.height};
      const shift = shiftOf(placed.left, placed.right, (trigger.closest<HTMLElement>('.overlay') ?? document.documentElement).clientWidth);
      if (shift) element.style.translate = `${shift}px 0`;
      setSide(same => (same?.up === next && same.cap === cap && same.cramped === cramped ? same : {up: next, cap, cramped}));
    };
    const hide = () => {
      unfocus();
      element.style.display = 'none';
      size = {width: 0, height: 0};
    };
    const follow = () => (seen() ? place() : hide());
    // Opened out of sight, from the keyboard (its focus under the bars, or left on it as its panel
    // closed), the button comes into sight first, 8 under the bars or above the window's bottom:
    // its reader asked for the panel. Not to the nearest edge, as a button under the bars is in
    // the window for the browser; the panel, not placed yet, hidden meanwhile so as not to widen
    // the page; and again if other bars stick at the top once the page has moved.
    if (!seen()) {
      element.style.display = 'none';
      const block = picker.getBoundingClientRect().top >= innerHeight ? 'end' : 'start';
      let margin = NaN;
      for (let pass = 0; pass < 3; pass++) {
        const next = coverOf(Infinity, trigger, bars) + 8;
        if (next === margin) break;
        margin = next;
        trigger.style.scrollMargin = `${margin}px 0 8px`;
        trigger.scrollIntoView({block});
      }
      trigger.style.scrollMargin = '';
      if (!trigger.getAttribute('style')) trigger.removeAttribute('style');
    }
    place();
    // As the page is laid out anew the panel follows its button, and is settled once the page is
    // still (`settler`): a frame goes by with nothing laid out anew, and nothing around the button
    // sliding to a new place (a widget moved, or dropped from a finger: the button is measured
    // where it slides from), an animation that moves it; nor the button's widget held by the
    // reader, dragged or resized, which the panel goes along with, placed once it is let go and has
    // slid into place. Decided at each step the page takes, it would be decided wrong: the board
    // passes through layouts that take the button out of sight and bring it back, and scrolls the
    // page as it does (keeping what is focused, or what is in sight, in its place), as the reader
    // would. Only what comes to an end is waited for.
    const sliding = () =>
      document.getAnimations().some(animation => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect) || animation.playState !== 'running' || effect.getTiming().iterations === Infinity) return false;
        return !!effect.target?.contains(trigger) && effect.getKeyframes().some(frame => 'transform' in frame || 'translate' in frame);
      });
    const held = () => !!trigger.closest('.widget.is-lifted, .widget.is-resizing');
    const page = settler(
      () => (seen() ? place() : close()),
      () => held() || sliding(),
    );
    const moved = () => {
      bars = barsOf();
      if (!held()) follow();
      page.stir();
    };
    // What is watched: the panel, as its content changes; the page's content (the body, at least as
    // tall as the window, would not tell on a short board); the widgets, each of which a new layout
    // may give another size; the dialog the button is in, whose content may move it; and the
    // widgets' places (the style that sets them) and their number, as they may trade places keeping
    // their size, and the style of the button's own widget's body, which a finger drags and drops.
    const observer = new ResizeObserver(entries => {
      const placed = (entry: ResizeObserverEntry) => {
        const [box] = entry.borderBoxSize;
        return entry.target === element && Math.abs(box.inlineSize - size.width) < 0.5 && Math.abs(box.blockSize - size.height) < 0.5;
      };
      if (!entries.every(placed)) moved();
    });
    const shifts = new MutationObserver(moved);
    const widgets = document.querySelectorAll('.widget');
    for (const watched of [element, document.getElementById('root')!, ...widgets, trigger.closest('.dialog')]) {
      if (watched) observer.observe(watched);
    }
    for (const moving of [...widgets, trigger.closest('.widget-body')]) {
      if (moving) shifts.observe(moving, {attributes: true, attributeFilter: ['style']});
    }
    const grid = document.querySelector('.widgets');
    if (grid) shifts.observe(grid, {childList: true});
    // Any scroll but the panel's own. While the page is laid out, likely one of its own: the panel
    // hides if its button is out of sight, and is placed as the page settles, not at each scroll.
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      if (seen()) return;
      if (page.moving()) hide();
      else close();
    };
    addEventListener('resize', moved);
    addEventListener('scroll', scrolled, {capture: true, passive: true});
    return () => {
      page.stop();
      observer.disconnect();
      shifts.disconnect();
      removeEventListener('resize', moved);
      removeEventListener('scroll', scrolled, {capture: true});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
