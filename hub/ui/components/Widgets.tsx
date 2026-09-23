import {useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {t} from '../i18n';
import {Popover, SwitchRow} from './Popover';
import {COLUMNS, MIN_SPAN} from '../lib/view';

/** A widget on the grid: `span` columns of the twelve wide; its height follows its content. */
export type Widget = {id: string; name: string; span: number; content: ReactNode};

type Point = {x: number; y: number};

/** A drag in progress; kept outside React state, it changes on every frame. */
type Drag = {
  id: string;
  start: Point;
  pointer: Point;
  /** Where the widget was grabbed, from its top-left corner. */
  grab: Point;
  /** How far the dragged widget is from its place in the grid. */
  offset: Point;
  active: boolean;
  order: string[];
  frame: number;
  stop: () => void;
};

/** A widget's place in the grid, in the grid's coordinates; slides of other widgets do not move it. */
type Place = {id: string; left: number; top: number; right: number; bottom: number; full: boolean};

/** A press becomes a drag after moving this far, so a click on the handle is not a drag. */
const DRAG_AFTER = 4;
/** Near the viewport's top or bottom edge the page scrolls under the dragged widget. */
const EDGE = 72;
const SLIDE = {duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)'};

const moved = (order: string[], id: string, to: number) => {
  const next = order.filter(other => other !== id);
  next.splice(to, 0, id);
  return next;
};
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Where a dragged widget goes among the others, which are laid out in rows. Next to a
 * row that is one widget as wide as the grid (the chart, or any card on a phone), or
 * when the dragged widget is that wide itself, it goes before or after the whole row,
 * by the half of the row the pointer is in; it never takes one card's place in a row of
 * three. Inside a row of cards it goes before the first card whose middle is right of
 * the pointer. The pointer between or beyond rows counts for the nearest one.
 */
export function dropIndex(others: Place[], pointer: Point, wide: boolean): number {
  const rows: {top: number; bottom: number; items: Place[]}[] = [];
  for (const place of others) {
    const row = rows.at(-1);
    if (row && !place.full && !row.items[0].full && Math.abs(row.top - place.top) < 2) {
      row.items.push(place);
      row.bottom = Math.max(row.bottom, place.bottom);
    } else rows.push({top: place.top, bottom: place.bottom, items: [place]});
  }
  if (!rows.length) return 0;
  const away = (row: {top: number; bottom: number}) => Math.max(row.top - pointer.y, pointer.y - row.bottom, 0);
  const row = rows.reduce((best, next) => (away(next) < away(best) ? next : best));
  const first = others.indexOf(row.items[0]);
  const last = others.indexOf(row.items.at(-1)!);
  if (wide || row.items[0].full || away(row) > 0) return pointer.y < (row.top + row.bottom) / 2 ? first : last + 1;
  const next = row.items.find(place => pointer.x < (place.left + place.right) / 2);
  return next ? others.indexOf(next) : last + 1;
}

/**
 * The board's widgets on a twelve-column grid, in the board's order. Its owner moves
 * them by the handle at the top of each: with a pointer (the place it will land stays
 * outlined, the page scrolls near its edges, Escape puts it back) or with the arrow
 * keys; the others slide to their new places. The owner also makes a widget wider or
 * narrower by its right edge: it follows the pointer, and its place snaps to whole
 * columns, from a third of the grid to its right edge. Its height always follows its
 * content, so nothing scrolls inside a widget.
 */
export function Widgets({
  widgets,
  movable,
  onMove,
  onResize,
}: {
  widgets: Widget[];
  movable: boolean;
  onMove: (order: string[]) => void;
  onResize: (id: string, span: number) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  /** Each widget's place in the grid; it slides as a whole when the order changes. */
  const places = useRef(new Map<string, HTMLDivElement>());
  /** What is dragged: the widget's content, while its place stays outlined. */
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  /** Where every widget was seen before the order changed, to slide them from there. */
  const before = useRef<Map<string, DOMRect> | null>(null);
  const refocus = useRef<string | null>(null);
  const [preview, setPreview] = useState<{id: string; order: string[]} | null>(null);
  /** A widget being resized, at the width it would have now. */
  const [resizing, setResizing] = useState<{id: string; span: number} | null>(null);
  const resized = useRef<string | null>(null);
  const [said, say] = useState('');
  const hint = useId();
  // Handlers attached to the window for a drag read the latest props from here.
  const latest = useRef({widgets, onMove, onResize});
  latest.current = {widgets, onMove, onResize};

  const byId = new Map(widgets.map(widget => [widget.id, widget]));
  const order = preview ? preview.order.filter(id => byId.has(id)) : widgets.map(widget => widget.id);

  const remember = () => {
    before.current = new Map([...places.current].map(([id, node]) => [id, node.getBoundingClientRect()]));
  };

  const placeOf = (id: string): Place => {
    const node = places.current.get(id)!;
    const full = node.offsetWidth >= grid.current!.clientWidth - 1;
    return {id, left: node.offsetLeft, top: node.offsetTop, right: node.offsetLeft + node.offsetWidth, bottom: node.offsetTop + node.offsetHeight, full};
  };

  /** Keeps the dragged content under the pointer, wherever the grid has put its place. */
  const follow = () => {
    const current = drag.current;
    const place = current && places.current.get(current.id);
    const body = current && bodies.current.get(current.id);
    if (!current || !place || !body) return;
    const rect = place.getBoundingClientRect();
    const x = current.pointer.x - current.grab.x - rect.left;
    const y = current.pointer.y - current.grab.y - rect.top;
    current.offset = {x, y};
    body.style.transform = `translate(${x}px, ${y}px)`;
  };

  /** Moves the dragged widget's place to where the pointer says. */
  const retarget = () => {
    const current = drag.current!;
    const box = grid.current!.getBoundingClientRect();
    const others = current.order.filter(id => id !== current.id).map(placeOf);
    const to = dropIndex(others, {x: current.pointer.x - box.left, y: current.pointer.y - box.top}, placeOf(current.id).full);
    if (current.order.indexOf(current.id) === to) return;
    current.order = moved(current.order, current.id, to);
    remember();
    setPreview({id: current.id, order: current.order});
  };

  const frame = () => {
    const current = drag.current;
    if (!current?.active) return;
    const {y} = current.pointer;
    const scroll = y < EDGE ? y - EDGE : y > innerHeight - EDGE ? y - innerHeight + EDGE : 0;
    if (scroll) window.scrollBy(0, scroll / 4);
    retarget();
    follow();
    current.frame = requestAnimationFrame(frame);
  };

  const finish = (drop: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.stop();
    cancelAnimationFrame(current.frame);
    document.body.classList.remove('is-dragging');
    if (!current.active) return;
    const body = bodies.current.get(current.id);
    const {widgets, onMove} = latest.current;
    if (body) {
      // It settles into its outlined place from where it was let go.
      body.style.transform = '';
      if (!still()) body.animate([{transform: `translate(${current.offset.x}px, ${current.offset.y}px)`}, {transform: 'none'}], SLIDE);
    }
    if (drop) {
      if (current.order.join() !== widgets.map(widget => widget.id).join()) onMove(current.order);
    } else remember();
    setPreview(null);
  };

  const press = (id: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    const rect = places.current.get(id)!.getBoundingClientRect();
    const pointer = {x: event.clientX, y: event.clientY};
    // The grid reorders the page's nodes under the pointer, which ends a pointer
    // capture: the window follows the drag instead.
    const move = (e: PointerEvent) => {
      const current = drag.current;
      if (!current || e.pointerId !== event.pointerId) return;
      current.pointer = {x: e.clientX, y: e.clientY};
      if (!current.active && Math.hypot(e.clientX - current.start.x, e.clientY - current.start.y) > DRAG_AFTER) {
        current.active = true;
        document.body.classList.add('is-dragging');
        setPreview({id, order: current.order});
        current.frame = requestAnimationFrame(frame);
      }
    };
    const up = (e: PointerEvent) => e.pointerId === event.pointerId && finish(true);
    const cancel = (e: PointerEvent) => e.pointerId === event.pointerId && finish(false);
    const escape = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape);
    drag.current = {
      id,
      start: pointer,
      pointer,
      grab: {x: pointer.x - rect.left, y: pointer.y - rect.top},
      offset: {x: 0, y: 0},
      active: false,
      order,
      frame: 0,
      stop: () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', escape);
      },
    };
  };

  const key = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = order.indexOf(id);
    const targets: Record<string, number> = {ArrowLeft: index - 1, ArrowUp: index - 1, ArrowRight: index + 1, ArrowDown: index + 1, Home: 0, End: order.length - 1};
    const to = targets[event.key] as number | undefined;
    if (to === undefined) return;
    event.preventDefault();
    if (to < 0 || to >= order.length || to === index) return;
    remember();
    refocus.current = id;
    onMove(moved(order, id, to));
    say(t('widgets.moved', {name: byId.get(id)!.name, position: to + 1, count: order.length}));
  };

  /**
   * The grid's columns as a widget sees them: how wide `span` columns are, the span a
   * width comes closest to, and how many columns there are from the widget's left edge
   * to the grid's right one (a widget grows only that far, as in Grafana).
   */
  const columns = (id: string) => {
    const box = grid.current!;
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
    const column = (box.clientWidth - gap * (COLUMNS - 1)) / COLUMNS;
    const from = places.current.get(id)!.getBoundingClientRect().left - box.getBoundingClientRect().left;
    const room = Math.max(MIN_SPAN, Math.min(COLUMNS, Math.round((box.clientWidth - from + gap) / (column + gap))));
    const width = (span: number) => span * column + (span - 1) * gap;
    const nearest = (px: number) => Math.max(MIN_SPAN, Math.min(room, Math.round((px + gap) / (column + gap))));
    return {room, width, nearest};
  };

  /**
   * Resizing by the right edge: the widget follows the pointer smoothly, its place in
   * the grid (outlined) snaps to whole columns and the others make room for it; let go,
   * it settles into its place.
   */
  const resizeStart = (id: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    event.preventDefault();
    const body = bodies.current.get(id)!;
    const {room, width, nearest} = columns(id);
    const left = body.getBoundingClientRect().left;
    // Where on the handle it was taken, so the edge does not jump to the pointer.
    const grab = event.clientX - body.getBoundingClientRect().right;
    const start = byId.get(id)!.span;
    let span = start;
    let px = body.getBoundingClientRect().width;
    document.body.classList.add('is-resizing');
    resized.current = id;
    body.style.width = `${px}px`;
    setResizing({id, span});
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      px = Math.max(width(MIN_SPAN), Math.min(width(room), e.clientX - grab - left));
      body.style.width = `${px}px`;
      const next = nearest(px);
      if (next === span) return;
      remember();
      setResizing({id, span: (span = next)});
    };
    const end = (e: PointerEvent, keep: boolean) => {
      if (e.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('is-resizing');
      resized.current = null;
      const final = keep ? span : start;
      body.style.width = '';
      if (!still()) body.animate([{width: `${px}px`}, {width: `${width(final)}px`}], SLIDE);
      if (final !== span) remember();
      setResizing(null);
      if (keep && span !== start) latest.current.onResize(id, span);
    };
    const up = (e: PointerEvent) => end(e, true);
    const cancel = (e: PointerEvent) => end(e, false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const resizeKey = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[event.key as string];
    if (!step) return;
    event.preventDefault();
    const widget = byId.get(id)!;
    const span = Math.max(MIN_SPAN, Math.min(columns(id).room, widget.span + step));
    if (span === widget.span) return;
    remember();
    onResize(id, span);
    say(t('widgets.resized', {name: widget.name, span, count: COLUMNS}));
  };

  // After the order changed: the others slide from where they were, the dragged one
  // stays under the pointer, and a widget moved with the keyboard keeps the focus.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (was && !still()) {
      for (const [id, node] of places.current) {
        const from = was.get(id);
        if (!from || id === drag.current?.id || id === resized.current) continue;
        // `from` is where it was seen, mid-slide or not; `to` is its place without any slide.
        for (const animation of node.getAnimations()) animation.cancel();
        const to = node.getBoundingClientRect();
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (Math.abs(dx) + Math.abs(dy) > 1) node.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'none'}], SLIDE);
      }
    }
    follow();
    if (refocus.current) handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [order.join(), resizing?.span, widgets.map(widget => widget.span).join()]);

  useLayoutEffect(() => () => finish(false), []);

  return (
    <div className="widgets" ref={grid}>
      {order.map(id => {
        const widget = byId.get(id)!;
        const span = resizing?.id === id ? resizing.span : widget.span;
        // On narrower screens the grid shows half or whole widths only.
        const style = {'--span': span, '--span-md': span <= COLUMNS / 2 ? COLUMNS / 2 : COLUMNS} as CSSProperties;
        return (
          <div
            key={id}
            className={`widget ${preview?.id === id ? 'is-lifted' : ''} ${resizing?.id === id ? 'is-resizing' : ''}`}
            style={style}
            ref={node => {
              if (node) places.current.set(id, node);
              else places.current.delete(id);
            }}
          >
            <div
              className="widget-body"
              ref={node => {
                if (node) bodies.current.set(id, node);
                else bodies.current.delete(id);
              }}
            >
              {movable && (
                <button
                  type="button"
                  className="drag-handle"
                  aria-label={t('widgets.move', {name: widget.name})}
                  aria-describedby={hint}
                  title={t('widgets.moveHint')}
                  onPointerDown={press(id)}
                  onKeyDown={key(id)}
                  ref={node => {
                    if (node) handles.current.set(id, node);
                    else handles.current.delete(id);
                  }}
                >
                  <svg viewBox="0 0 20 8" width="20" height="8" aria-hidden="true">
                    {[3, 8, 13].map(x => [2, 6].map(y => <circle key={`${x}-${y}`} cx={x + 2} cy={y} r="1.1" />))}
                  </svg>
                </button>
              )}
              {widget.content}
              {movable && (
                <button
                  type="button"
                  className="resize-handle"
                  aria-label={t('widgets.resize', {name: widget.name})}
                  title={t('widgets.resizeHint')}
                  onPointerDown={resizeStart(id)}
                  onKeyDown={resizeKey(id)}
                />
              )}
            </div>
          </div>
        );
      })}
      {movable && (
        <>
          <p id={hint} className="sr-only">
            {t('widgets.moveHint')}
          </p>
          <div className="sr-only" aria-live="polite">
            {said}
          </div>
        </>
      )}
    </div>
  );
}

const LayoutIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <rect x="2" y="2" width="5" height="5" rx="1.2" />
    <rect x="9" y="2" width="5" height="5" rx="1.2" />
    <rect x="2" y="9" width="12" height="5" rx="1.2" />
  </svg>
);

const LockIcon = ({open = false}: {open?: boolean}) => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="1.6" />
    <path d={open ? 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'} />
  </svg>
);

/**
 * Which widgets the board shows, and whether they stay in place: locked, they have no
 * handles to move or resize them, so a pointer passing over the board catches nothing.
 * The owner brings hidden widgets back here.
 */
export function WidgetsMenu({
  widgets,
  hidden,
  shared,
  locked,
  onShow,
  onLock,
}: {
  widgets: {id: string; name: string}[];
  hidden: string[];
  shared: boolean;
  locked: boolean;
  onShow: (id: string, shown: boolean) => void;
  onLock: (locked: boolean) => void;
}) {
  const count = widgets.filter(widget => hidden.includes(widget.id)).length;
  return (
    <Popover label={t(locked ? 'widgets.titleLocked' : 'widgets.title')} icon={locked ? <LockIcon /> : <LayoutIcon />} badge={count}>
      <div className="popover-title">{t('widgets.title')}</div>
      <SwitchRow className="is-lock" on={locked} onChange={onLock}>
        <LockIcon open={!locked} />
        {t('widgets.lock')}
      </SwitchRow>
      <div className="popover-sep" />
      {widgets.map(widget => (
        <SwitchRow key={widget.id} on={!hidden.includes(widget.id)} onChange={on => onShow(widget.id, on)}>
          {widget.name}
        </SwitchRow>
      ))}
      <div className="popover-note">{t(shared ? 'widgets.sharedNote' : 'widgets.note')}</div>
    </Popover>
  );
}
