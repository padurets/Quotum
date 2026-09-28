import {useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {t} from '../i18n';
import {Popover, SwitchRow} from './Popover';
import {isOffByDefault} from '../lib/view';
import {
  cellOf,
  GAP,
  landed,
  narrowed,
  nearest,
  ordered,
  placesOf,
  reading,
  ROW,
  rowsOf,
  settle,
  stepped,
  widened,
  widths,
  type Item,
  type Layout,
  type Place,
  type Spot,
} from '../lib/grid';

export type Widget = {id: string; name: string; content: ReactNode};
type Point = {x: number; y: number};
type Gesture = {
  id: string;
  kind: 'drag' | 'resize';
  signature: string;
  origin: Spot[];
  items: Item[];
  start: Point;
  pointer: Point;
  grab: Point;
  offset: Point;
  active: boolean;
  cell: Point;
  frame: number;
  stop: () => void;
};
const DRAG_AFTER = 4;
const EDGE = 72;
const SLIDE = {duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)'};
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Keep these breakpoints with the loading grid in style.css.
const mode = () => (matchMedia('(max-width: 680px)').matches ? 1 : matchMedia('(max-width: 1000px)').matches ? 2 : 6);
function useColumns() {
  const [columns, setColumns] = useState(mode);
  useLayoutEffect(() => {
    const queries = [matchMedia('(max-width: 680px)'), matchMedia('(max-width: 1000px)')];
    const changed = () => setColumns(mode());
    queries.forEach(query => query.addEventListener('change', changed));
    return () => queries.forEach(query => query.removeEventListener('change', changed));
  }, []);
  return columns;
}

/** Places and measured content heights determine the grid; a gesture only changes its intended order. */
export function Widgets({
  widgets,
  layout,
  movable: editable,
  onPlaces,
}: {
  widgets: Widget[];
  layout: Layout;
  movable: boolean;
  onPlaces: (places: Record<string, Place>) => void;
}) {
  const columns = useColumns();
  const movable = editable && columns === 6;
  const grid = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<string, HTMLDivElement>());
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const gesture = useRef<Gesture | null>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  const refocus = useRef<string | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<{id: string; kind: Gesture['kind']; items: Item[]} | null>(null);
  const [said, say] = useState<string[]>([]);
  const hint = useId();
  const ids = widgets.map(widget => widget.id);
  const base = ordered(layout, ids);
  const withHeights = (items: Omit<Item, 'h'>[]) => items.map(item => ({...item, h: rowsOf(heights[item.id] ?? 224)}));
  const signature = JSON.stringify(base.map(({id, x, w}) => [id, x, w]));
  const activePreview = movable && gesture.current?.signature === signature ? preview : null;
  const items = withHeights(activePreview?.items ?? base);
  const spots = columns === 6 ? settle(items, layout.columns) : narrowed(items, columns as 1 | 2, layout.columns);
  const byId = new Map(widgets.map(widget => [widget.id, widget]));
  const latest = useRef({spots, heights, onPlaces});
  latest.current = {spots, heights, onPlaces};
  // Height changes and our preview never invalidate the frozen origin. External placement changes do.
  const remember = () => {
    before.current = new Map([...places.current].map(([id, node]) => [id, node.getBoundingClientRect()]));
  };
  const pitch = () => (grid.current!.clientWidth + GAP) / layout.columns;

  const measure = () => {
    const next: Record<string, number> = {};
    for (const [id, body] of bodies.current) {
      const root = body.querySelector<HTMLElement>(':scope > .card, :scope > .panel');
      if (!root) continue;
      const fill = parseFloat(getComputedStyle(places.current.get(id)!).getPropertyValue('--fill')) || 0;
      next[id] = Math.round((root.getBoundingClientRect().height - fill) * 64) / 64;
    }
    setHeights(old => (Object.keys(next).length === Object.keys(old).length && Object.entries(next).every(([id, h]) => old[id] === h) ? old : next));
    return next;
  };
  // Before paint on the first render; later one observer measures content, never the row's stretched box.
  useLayoutEffect(() => {
    measure();
  });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure());
    for (const body of bodies.current.values()) {
      const root = body.querySelector(':scope > .card, :scope > .panel');
      if (root) observer.observe(root);
    }
    return () => observer.disconnect();
  }, [ids.join()]);

  const follow = () => {
    const current = gesture.current;
    if (!current?.active || current.kind !== 'drag') return;
    const node = places.current.get(current.id);
    const body = bodies.current.get(current.id);
    if (!node || !body) return;
    const rect = node.getBoundingClientRect();
    current.offset = {x: current.pointer.x - current.grab.x - rect.left, y: current.pointer.y - current.grab.y - rect.top};
    body.style.transform = `translate(${current.offset.x}px, ${current.offset.y}px)`;
  };
  const retarget = () => {
    const current = gesture.current;
    if (!current?.active || current.kind !== 'drag') return;
    const box = grid.current!.getBoundingClientRect();
    const w = current.origin.find(item => item.id === current.id)!.w;
    const cell = cellOf({x: current.pointer.x - current.grab.x - box.left, y: current.pointer.y - current.grab.y - box.top}, pitch(), w, layout.columns);
    if (cell.x === current.cell.x && cell.y === current.cell.y) return;
    current.cell = cell;
    current.items = landed(current.origin, current.id, cell, layout.columns);
    remember();
    setPreview({id: current.id, kind: current.kind, items: current.items});
  };
  const frame = () => {
    const current = gesture.current;
    if (!current?.active || current.kind !== 'drag') return;
    const y = current.pointer.y;
    const scroll = y < EDGE ? y - EDGE : y > innerHeight - EDGE ? y - innerHeight + EDGE : 0;
    if (scroll) window.scrollBy(0, scroll / 4);
    retarget();
    follow();
    current.frame = requestAnimationFrame(frame);
  };
  const finish = (drop: boolean) => {
    const current = gesture.current;
    if (!current) return;
    if (drop) retarget();
    gesture.current = null;
    current.stop();
    cancelAnimationFrame(current.frame);
    document.body.classList.remove('is-dragging', 'is-resizing');
    const body = bodies.current.get(current.id);
    if (body) {
      body.style.transform = '';
      body.style.width = drop && current.kind === 'resize' ? `${current.items.find(item => item.id === current.id)!.w * pitch() - GAP}px` : '';
    }
    if (current.active && drop) {
      // Measure after removing the smooth resize width, at the final snapped width.
      const measured = measure();
      const result = settle(
        current.items.map(item => ({...item, h: rowsOf(measured[item.id] ?? latest.current.heights[item.id] ?? 224)})),
        layout.columns,
      );
      const intention = (items: Item[]) => JSON.stringify(items.map(({id, x, w}) => [id, x, w]));
      if (intention(current.items) !== intention(current.origin)) latest.current.onPlaces(placesOf(result));
      if (body && current.kind === 'drag' && !still())
        body.animate([{transform: `translate(${current.offset.x}px, ${current.offset.y}px)`}, {transform: 'none'}], SLIDE);
    }
    if (body) body.style.width = '';
    setPreview(null);
  };
  useLayoutEffect(() => {
    if (!movable) finish(false);
  }, [movable]);
  useLayoutEffect(() => {
    finish(false);
  }, [signature]);
  useLayoutEffect(() => () => finish(false), []);

  const begin = (id: string, kind: Gesture['kind'], event: ReactPointerEvent<HTMLElement>) => {
    if (!movable || !event.isPrimary || event.button !== 0 || gesture.current) return;
    const body = bodies.current.get(id)!;
    const rect = places.current.get(id)!.getBoundingClientRect();
    const pointer = {x: event.clientX, y: event.clientY};
    const origin = reading(latest.current.spots);
    const item = origin.find(item => item.id === id)!;
    const allowed = widths(layout.columns, item.x);
    const width = (w: number) => w * pitch() - GAP;
    const rightGrab = pointer.x - body.getBoundingClientRect().right;
    if (kind === 'resize') event.preventDefault();
    const move = (e: PointerEvent) => {
      const current = gesture.current;
      if (!current || e.pointerId !== event.pointerId) return;
      current.pointer = {x: e.clientX, y: e.clientY};
      if (kind === 'resize') {
        const px = Math.max(width(allowed[0]), Math.min(width(allowed.at(-1)!), e.clientX - rightGrab - rect.left));
        body.style.width = `${px}px`;
        const w = nearest(allowed, (px + GAP) / pitch());
        if (current.items.find(item => item.id === id)!.w !== w) {
          current.items = widened(origin, id, w, layout.columns);
          remember();
          setPreview({id, kind, items: current.items});
        }
      } else if (!current.active && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > DRAG_AFTER) {
        current.active = true;
        document.body.classList.add('is-dragging');
        setPreview({id, kind, items: current.items});
        current.frame = requestAnimationFrame(frame);
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      move(e);
      finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === event.pointerId) finish(false);
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape);
    gesture.current = {
      id,
      kind,
      signature,
      origin,
      items: origin,
      start: pointer,
      pointer,
      grab: {x: pointer.x - rect.left, y: pointer.y - rect.top},
      offset: {x: 0, y: 0},
      active: kind === 'resize',
      cell: {x: item.x, y: item.y},
      frame: 0,
      stop: () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', escape);
      },
    };
    if (kind === 'resize') {
      document.body.classList.add('is-resizing');
      setPreview({id, kind, items: origin});
    }
  };
  const press = (id: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const handle = target.closest('.drag-handle');
    if (
      !handle &&
      (!target.closest('.card-head, .panel-head') ||
        target.closest('button, a, input, select, textarea, label, summary, [role="button"], [role="menuitem"], [contenteditable]'))
    )
      return;
    // Popovers may be children of the head but are never drag surfaces.
    if (target.closest('.popover, [role="dialog"]')) return;
    begin(id, 'drag', event);
  };
  const key =
    (id: string, resize = false) =>
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!movable || gesture.current) return;
      const origin = reading(spots);
      const item = origin.find(item => item.id === id)!;
      let next: Spot[];
      if (resize) {
        const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[event.key];
        if (!step) return;
        event.preventDefault();
        const allowed = widths(layout.columns, item.x);
        const w = allowed[allowed.indexOf(item.w) + step];
        if (w === undefined) return;
        next = widened(origin, id, w, layout.columns);
      } else {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        next = stepped(origin, id, event.key, layout.columns);
      }
      if (JSON.stringify(placesOf(next)) === JSON.stringify(placesOf(origin))) return;
      remember();
      refocus.current = resize ? null : id;
      onPlaces(placesOf(next));
      const moved = next.find(item => item.id === id)!;
      say(
        resize
          ? [t('widgets.resized', {name: byId.get(id)!.name, span: moved.w, count: layout.columns})]
          : [
              t('widgets.moved', {name: byId.get(id)!.name, position: reading(next).findIndex(item => item.id === id) + 1, count: next.length}),
              t('widgets.movedColumn', {column: moved.x + 1, columns: layout.columns}),
            ],
      );
    };

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (was && !still())
      for (const [id, node] of places.current) {
        const from = was.get(id);
        if (!from || id === gesture.current?.id) continue;
        for (const animation of node.getAnimations()) animation.cancel();
        const to = node.getBoundingClientRect();
        const dx = from.left - to.left,
          dy = from.top - to.top;
        if (Math.abs(dx) + Math.abs(dy) > 1) node.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'none'}], SLIDE);
      }
    follow();
    if (refocus.current) handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const bottom = Math.max(1, ...spots.map(item => item.y + item.h));
  return (
    <div className={`widgets ${movable ? 'is-movable' : ''}`} ref={grid} style={{'--columns': columns} as CSSProperties}>
      {activePreview && (
        <div className="grid-columns" aria-hidden="true" style={{gridColumn: '1 / -1', gridRow: `1 / span ${bottom}`}}>
          {Array.from({length: columns}, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      {reading(spots).map(spot => {
        const widget = byId.get(spot.id)!;
        const fill = heights[spot.id] === undefined ? 0 : Math.max(0, spot.h * ROW - GAP - heights[spot.id]);
        return (
          <div
            key={spot.id}
            data-widget={spot.id}
            className={`widget ${activePreview?.id === spot.id ? (activePreview.kind === 'drag' ? 'is-lifted' : 'is-resizing') : ''}`}
            style={{gridColumn: `${spot.x + 1} / span ${spot.w}`, gridRow: `${spot.y + 1} / span ${spot.h}`, '--fill': `${fill}px`} as CSSProperties}
            ref={node => {
              if (node) places.current.set(spot.id, node);
              else places.current.delete(spot.id);
            }}
          >
            <div
              className="widget-body"
              onPointerDown={press(spot.id)}
              ref={node => {
                if (node) bodies.current.set(spot.id, node);
                else bodies.current.delete(spot.id);
              }}
            >
              {movable && (
                <button
                  type="button"
                  className="drag-handle"
                  aria-label={t('widgets.move', {name: widget.name})}
                  aria-describedby={hint}
                  title={t('widgets.moveHint')}
                  onKeyDown={key(spot.id)}
                  ref={node => {
                    if (node) handles.current.set(spot.id, node);
                    else handles.current.delete(spot.id);
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
                  onPointerDown={e => begin(spot.id, 'resize', e)}
                  onKeyDown={key(spot.id, true)}
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
            {said.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
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
 * The owner brings hidden widgets back here, found by group: the cards, the lists of
 * the current state, the analytics.
 */
export function WidgetsMenu({
  groups,
  hidden,
  locked,
  onShow,
  onLock,
}: {
  groups: {title: string; widgets: {id: string; name: string}[]}[];
  hidden: string[];
  locked: boolean;
  onShow: (id: string, shown: boolean) => void;
  onLock: (locked: boolean) => void;
}) {
  // Widgets off by default are not missing from the board: only what the owner hid is counted.
  const count = groups.flatMap(group => group.widgets).filter(widget => hidden.includes(widget.id) && !isOffByDefault(widget.id)).length;
  return (
    // One icon whether locked or not: the button opens the same menu, and a changing icon
    // reads as another button. Whether it is locked is in its name and in the menu.
    <Popover label={t(locked ? 'widgets.titleLocked' : 'widgets.title')} icon={<LayoutIcon />} badge={count}>
      <div className="popover-title">{t('widgets.title')}</div>
      <SwitchRow className="is-lock" on={locked} onChange={onLock}>
        <LockIcon open={!locked} />
        {t('widgets.lock')}
      </SwitchRow>
      {groups
        .filter(group => group.widgets.length)
        .map(group => (
          <div role="group" aria-label={group.title} key={group.title}>
            <div className="popover-sep" />
            <div className="popover-title is-group">{group.title}</div>
            {group.widgets.map(widget => (
              <SwitchRow key={widget.id} on={!hidden.includes(widget.id)} onChange={on => onShow(widget.id, on)}>
                {widget.name}
              </SwitchRow>
            ))}
          </div>
        ))}
    </Popover>
  );
}
