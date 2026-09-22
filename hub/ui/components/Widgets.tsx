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
  /** The widget's shift from its place in the grid. */
  offset: Point;
  active: boolean;
  order: string[];
  /** The widget just swapped with: not a target again until the pointer leaves it. */
  skip: string | null;
  frame: number;
  stop: () => void;
};

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
const inside = (rect: DOMRect, p: Point) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;

/**
 * The board's widgets on a grid, in the board's order. Its owner moves them by the
 * handle at the top of each: with a pointer, the page scrolling near its edges, or with
 * the arrow keys. The others slide to their new places.
 */
export function Widgets({widgets, movable, onMove}: {widgets: Widget[]; movable: boolean; onMove: (order: string[]) => void}) {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  /** Where every widget was before the order changed, to slide them from there. */
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
    before.current = new Map([...nodes.current].map(([id, node]) => [id, node.getBoundingClientRect()]));
  };

  /** Keeps the dragged widget under the pointer, wherever the grid has put its place. */
  const follow = () => {
    const current = drag.current;
    const node = current && nodes.current.get(current.id);
    if (!current || !node) return;
    const rect = node.getBoundingClientRect();
    const x = current.pointer.x - current.grab.x - (rect.left - current.offset.x);
    const y = current.pointer.y - current.grab.y - (rect.top - current.offset.y);
    current.offset = {x, y};
    node.style.transform = `translate(${x}px, ${y}px)`;
  };

  /** Moves the dragged widget into the place of the one under the pointer. */
  const retarget = () => {
    const current = drag.current!;
    let over: string | null = null;
    for (const [id, node] of nodes.current) {
      if (id !== current.id && inside(node.getBoundingClientRect(), current.pointer)) over = id;
    }
    if (current.skip && over !== current.skip) current.skip = null;
    if (!over || over === current.skip) return;
    current.order = moved(current.order, current.id, current.order.indexOf(over));
    current.skip = over;
    remember();
    setPreview({id: current.id, order: current.order});
  };

  const frame = () => {
    const current = drag.current;
    if (!current?.active) return;
    const {y} = current.pointer;
    const scroll = y < EDGE ? y - EDGE : y > innerHeight - EDGE ? y - innerHeight + EDGE : 0;
    if (scroll) window.scrollBy(0, scroll / 4);
    follow();
    retarget();
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
    const node = nodes.current.get(current.id);
    const {widgets, onMove} = latest.current;
    if (drop) {
      // It lands in the place it has been shown in all along.
      if (node) {
        node.style.transform = '';
        if (!still()) node.animate([{transform: `translate(${current.offset.x}px, ${current.offset.y}px)`}, {transform: 'none'}], SLIDE);
      }
      if (current.order.join() !== widgets.map(widget => widget.id).join()) onMove(current.order);
    } else {
      // Everything, the dragged one too, slides back from where it is.
      remember();
      if (node) node.style.transform = '';
    }
    setPreview(null);
  };

  const press = (id: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    const rect = nodes.current.get(id)!.getBoundingClientRect();
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
      skip: null,
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
      for (const [id, node] of nodes.current) {
        const from = was.get(id);
        if (!from || id === drag.current?.id) continue;
        // `from` is where it is seen now, mid-slide or not; `to` is its place without any slide.
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
    <div className="widgets">
      {order.map(id => {
        const widget = byId.get(id)!;
        return (
          <div
            key={id}
            className={`widget ${widget.wide ? 'is-wide' : ''} ${preview?.id === id ? 'is-lifted' : ''}`}
            ref={node => {
              if (node) nodes.current.set(id, node);
              else nodes.current.delete(id);
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
