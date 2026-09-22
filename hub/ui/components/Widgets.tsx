import {useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {t} from '../i18n';
import {Popover, SwitchRow} from './Popover';

export type Widget = {id: string; name: string; wide?: boolean; content: ReactNode};

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
 * The board's widgets on a grid, in the board's order. Its owner moves them by the
 * handle at the top of each: with a pointer (the place it will land stays outlined, the
 * page scrolls near its edges, Escape puts it back) or with the arrow keys. The others
 * slide to their new places.
 */
export function Widgets({widgets, movable, onMove}: {widgets: Widget[]; movable: boolean; onMove: (order: string[]) => void}) {
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
  const [said, say] = useState('');
  const hint = useId();
  // Handlers attached to the window for a drag read the latest props from here.
  const latest = useRef({widgets, onMove});
  latest.current = {widgets, onMove};

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

  // After the order changed: the others slide from where they were, the dragged one
  // stays under the pointer, and a widget moved with the keyboard keeps the focus.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (was && !still()) {
      for (const [id, node] of places.current) {
        const from = was.get(id);
        if (!from || id === drag.current?.id) continue;
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
  }, [order.join()]);

  useLayoutEffect(() => () => finish(false), []);

  return (
    <div className="widgets" ref={grid}>
      {order.map(id => {
        const widget = byId.get(id)!;
        return (
          <div
            key={id}
            className={`widget ${widget.wide ? 'is-wide' : ''} ${preview?.id === id ? 'is-lifted' : ''}`}
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

/** Which widgets the board shows; the owner brings hidden ones back here. */
export function WidgetsMenu({widgets, hidden, shared, onShow}: {widgets: {id: string; name: string}[]; hidden: string[]; shared: boolean; onShow: (id: string, shown: boolean) => void}) {
  const count = widgets.filter(widget => hidden.includes(widget.id)).length;
  return (
    <Popover label={t('widgets.title')} icon={<LayoutIcon />} badge={count}>
      <div className="popover-title">{t('widgets.title')}</div>
      {widgets.map(widget => (
        <SwitchRow key={widget.id} on={!hidden.includes(widget.id)} onChange={on => onShow(widget.id, on)}>
          {widget.name}
        </SwitchRow>
      ))}
      <div className="popover-note">{t(shared ? 'widgets.sharedNote' : 'widgets.note')}</div>
    </Popover>
  );
}
