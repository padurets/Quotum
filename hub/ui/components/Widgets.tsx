import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {t} from '../i18n';
import {pixels, same, SizingContext, type Report, type Size} from './sizing';
import {WidgetSizing} from '../lib/widgetSizing';
import {
  cellOf,
  edgeScroll,
  GAP,
  pastClick,
  heightIntent,
  landed,
  leftWidths,
  narrowed,
  nearest,
  ordered,
  placesOf,
  reading,
  ROW,
  rowsFor,
  rowsOf,
  samePlaces,
  settle,
  stepped,
  widened,
  widenedLeft,
  widths,
  type Height,
  type Item,
  type Layout,
  type Place,
  type Spot,
} from '../lib/grid';

export type Widget = {id: string; name: string; content: ReactNode};
type Point = {x: number; y: number};
/**
 * What a gesture changes: the place (by the head), the width (by the left or the right
 * edge, the other one staying), the height (by the bottom edge) or both (by a bottom corner).
 */
type Kind = 'drag' | 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right';
/** The handles that take the keyboard: the left edge and the corners are the pointer's only. */
type Handle = 'move' | 'right' | 'bottom';
type Gesture = {
  id: string;
  kind: Kind;
  signature: string;
  origin: Spot[];
  items: Item[];
  /** How many rows the widget took when it began, and the height it asks for since: none keeps the one it had. */
  rows: number;
  intent: number | undefined;
  /** How far the gesture scrolled the page by itself (CSS pixels): as much a pull as the pointer's way. */
  scrolled: number;
  /** By the left edge: where the right one stays, and how wide the widget is drawn meanwhile (CSS pixels). */
  edge: {right: number; px: number} | null;
  start: Point;
  pointer: Point;
  grab: Point;
  offset: Point;
  active: boolean;
  /** Whether the pointer has gone further than a click's jitter (`pastClick`): a drag begins then, and the page may scroll. */
  moved: boolean;
  cell: Point;
  frame: number;
  stop: () => void;
};
const SLIDE = {duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)'};
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const tall = (kind: Kind) => kind.startsWith('bottom');
const wide = (kind: Kind) => kind !== 'drag' && kind !== 'bottom';
const leftward = (kind: Kind) => kind === 'left' || kind === 'bottom-left';
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

/**
 * A widget's part of the board's sizing, made of its own numbers and the board's columns
 * only: a neighbour's height renders nothing of it, neither the widget nor this (the same
 * content, the same numbers).
 */
const Sized = memo(function Sized({id, manual, geometry, width, report, children}: {id: string; manual: boolean; geometry: WidgetSizing; width: string; report: (id: string, size: Report | null) => void; children: ReactNode}) {
  const allocated=useSyncExternalStore(useCallback(listener=>geometry.subscribe(id,listener),[geometry,id]),()=>geometry.allocated(id));
  const bound = useCallback((size: Report | null) => report(id, size), [id, report]);
  const value = useMemo(() => ({manual, allocated, width, report: bound}), [manual, allocated, width, bound]);
  return <SizingContext.Provider value={value}>{children}</SizingContext.Provider>;
});

/**
 * Places, the heights their owner chose and measured content determine the grid: a widget
 * takes the rows its content needs, or the rows chosen for it where the least its content
 * can show fits them.
 * A gesture only changes its intended order, width and height.
 */
export function Widgets({
  widgets,
  layout,
  movable: editable,
  onPlaces,
}: {
  widgets: Widget[];
  layout: Layout;
  movable: boolean;
  /** Places to save, all with the heights chosen before but for `height`'s, which it sets or (null) takes away. */
  onPlaces: (places: Record<string, Place>, height?: Height) => void;
}) {
  const columns = useColumns();
  const movable = editable && columns === 6;
  const grid = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<string, HTMLDivElement>());
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const handles = useRef(new Map<string, HTMLElement>());
  const gesture = useRef<Gesture | null>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  const refocus = useRef<{id: string; handle: Handle} | null>(null);
  /** Whether each of the last two presses on a handle saved a size or was given up: a double click after two that did neither fits the content. */
  const presses = useRef<boolean[]>([]);
  const [geometry]=useState(()=>new WidgetSizing(same));
  // How many gestures on each widget's side have ended: its width followed the pointer until then, and it takes the grid's.
  const [released, setReleased] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<{id: string; kind: Kind; items: Item[]; intent?: number} | null>(null);
  const [said, say] = useState<string[]>([]);
  const hint = useId();
  const ids = widgets.map(widget => widget.id);
  const base = ordered(layout, ids);
  const saved = (id: string) => layout.places[id]?.h;
  const sizeOf = (id: string, measured = geometry.heights): Size | undefined => {
    const size = geometry.sizes[id], shown = measured[id];
    if (!size) return shown === undefined ? undefined : {min: shown, natural: shown};
    // Following its content, a chart or the list of agents shows all of itself, and the board measures that as soon as
    // styles change it (at a breakpoint), before the widget renders. Stretched to a height, or measured on a gesture's
    // release before it has drawn itself at the width it snapped to, it is what it tells, in the frame its least comes from.
    return measured === geometry.heights && intended(id) === undefined && shown !== undefined ? {min: size.min, natural: shown} : size;
  };
  /** How few rows a widget can take, and how many it takes with the height it has, at its width and content now. */
  const bounds = (id: string, measured = geometry.heights) => {
    const size = sizeOf(id, measured);
    return {min: size ? rowsOf(size.min) : 1, baseline: rowsFor(size, saved(id))};
  };
  const signature = JSON.stringify(base.map(({id, x, w}) => [id, x, w, saved(id) ?? 0]));
  const activePreview = movable && gesture.current?.signature === signature ? preview : null;
  const intended = (id: string) => (activePreview?.id === id && activePreview.intent !== undefined ? activePreview.intent : saved(id));
  const positions=()=>{
    const items = (activePreview?.items ?? base).map(item => ({...item, h: rowsFor(sizeOf(item.id), intended(item.id))}));
    return columns === 6 ? settle(items, layout.columns) : narrowed(items, columns as 1 | 2, layout.columns);
  };
  const spots=positions();
  const byId = new Map(widgets.map(widget => [widget.id, widget]));
  // The widths the board gives, not a gesture's preview: meanwhile the width follows the pointer, which a chart hears after it shows.
  const given = new Map(base.map(item => [item.id, `${columns} ${item.w} ${released[item.id] ?? 0}`]));
  const latest = useRef({spots, onPlaces, bounds, sizeOf, saved});
  latest.current = {spots, onPlaces, bounds, sizeOf, saved};
  const place=useRef(()=>{});
  place.current=()=>{
    const spots=reading(positions()),allocations=new Map<string,number>();
    latest.current.spots=spots;
    let previous:HTMLElement|null=null;
    for(const spot of spots){
      const node=places.current.get(spot.id);if(!node||!grid.current)continue;
      const allocated=spot.h*(ROW-geometry.short)-GAP;
      const fill=geometry.heights[spot.id]===undefined?0:Math.max(0,allocated-geometry.heights[spot.id]);
      const column=`${spot.x+1} / span ${spot.w}`,row=`${spot.y+1} / span ${spot.h}`;
      if(node.style.gridColumn!==column)node.style.gridColumn=column;
      if(node.style.gridRow!==row)node.style.gridRow=row;
      if(node.style.getPropertyValue('--fill')!==`${fill}px`)node.style.setProperty('--fill',`${fill}px`);
      // Keep keyboard reading order in step with geometry, including after React
      // reconciles a changed set of widgets against its earlier child order.
      const next:Element|null=previous?previous.nextElementSibling:grid.current.firstElementChild;
      if(next!==node){
        const focused=document.activeElement instanceof HTMLElement&&node.contains(document.activeElement)?document.activeElement:null;
        const parent=grid.current as HTMLDivElement&{moveBefore?:(node:Node,child:Node|null)=>void};
        if(parent.moveBefore)parent.moveBefore(node,next);
        else {grid.current.insertBefore(node,next);focused?.focus({preventScroll:true});}
      }
      previous=node;
      allocations.set(spot.id,intended(spot.id)!==undefined?allocated:0);
    }
    geometry.allocate(allocations);
  };
  const report = useCallback((id: string, size: Report | null) => {
    // What it shows is what the board measures of it, told as it lays itself out anew, before that paints; the later of the two holds.
    if(geometry.report(id,size))place.current();
  }, [geometry]);
  // Height changes and our preview never invalidate the frozen origin. External placement changes do.
  const remember = () => {
    before.current = new Map([...places.current].map(([id, node]) => [id, node.getBoundingClientRect()]));
  };
  const pitch = () => (grid.current!.clientWidth + GAP) / layout.columns;

  /** What every widget shows, kept for the next render, but on a gesture's `release` what the charts and the list show: they draw themselves at a new width only later, and tell it then. */
  const measure = (release = false) => {
    const next: Record<string, number> = {};
    let tallest = {rows: 0, px: 0};
    const spans = new Map(latest.current.spots.map(spot => [spot.id, spot.h]));
    for (const [id, body] of bodies.current) {
      const root = body.querySelector<HTMLElement>(':scope > .card, :scope > .panel');
      const place = places.current.get(id)!;
      if (!root) continue;
      const fill = parseFloat(getComputedStyle(place).getPropertyValue('--fill')) || 0;
      next[id] = Math.round((root.getBoundingClientRect().height - fill) * 64) / 64;
      const rows = spans.get(id);
      const px = pixels(place.getBoundingClientRect().height);
      if (rows !== undefined && rows > tallest.rows) tallest = {rows, px};
    }
    // The same for every row, so the tallest widget tells it best; a change of it that no widget would show within a pixel of the screen is none.
    const row = tallest.rows ? Math.max(0, (tallest.rows * ROW - GAP - tallest.px) / tallest.rows) : 0;
    if(geometry.measure(next,row,release))place.current();
    return next;
  };
  // Before paint on the first render; later one observer measures content, never the row's stretched box.
  useLayoutEffect(() => {
    measure();
    place.current();
  });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure());
    for (const body of bodies.current.values()) {
      const root = body.querySelector(':scope > .card, :scope > .panel');
      if (root) observer.observe(root);
    }
    return () => observer.disconnect();
  }, [ids.join()]);

  const show = (current: Gesture) => {
    remember();
    setPreview({id: current.id, kind: current.kind, items: current.items, intent: current.intent});
  };
  /**
   * The height the pointer asks for now, as `heightIntent` takes it: rows the pointer moved
   * down the window, with the page the gesture scrolled under it, against what the widget
   * needs at its width and content now. Whether that changed what the gesture asks for.
   */
  const aim = (current: Gesture, measured?: Record<string, number>) => {
    const {min, baseline} = latest.current.bounds(current.id, measured);
    // Nothing else pulls: not a wheel, a key or a glide from before the press, nor the grid moving
    // down the page as what is above it grows, nor the browser keeping its place meanwhile.
    const pulled = current.pointer.y - current.start.y + current.scrolled;
    const intent = heightIntent(current.rows, baseline, current.rows + Math.round(pulled / ROW), min);
    if (intent === current.intent) return false;
    current.intent = intent;
    return true;
  };
  const follow = () => {
    const current = gesture.current;
    const node = current && places.current.get(current.id);
    const body = current && bodies.current.get(current.id);
    if (!current?.active || !node || !body) return;
    const rect = node.getBoundingClientRect();
    // Drawn from where its right edge stays, however its place moved meanwhile.
    if (current.edge) body.style.transform = `translateX(${current.edge.right - current.edge.px - rect.left}px)`;
    if (current.kind !== 'drag') return;
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
    show(current);
  };
  /** How far down the window the bars stuck over this grid reach: the page's, and over the analytics their head. */
  const cover = () => {
    const bars = [document.querySelector<HTMLElement>('.topbar'), grid.current!.closest('.analytics')?.querySelector<HTMLElement>('.analytics-head')];
    return Math.max(0, ...bars.map(bar => (bar && bar.getBoundingClientRect().top <= parseFloat(getComputedStyle(bar).top) + 1 ? bar.getBoundingClientRect().bottom : 0)));
  };
  // The page scrolls under a pointer taken to the window's bottom or under the bars at its top, so a widget goes where the window does not reach.
  const frame = () => {
    const current = gesture.current;
    if (!current?.active || (current.kind !== 'drag' && !tall(current.kind))) return;
    const scroll = edgeScroll({y: current.pointer.y, from: current.start.y, top: cover(), bottom: innerHeight, moved: current.moved, sideways: current.kind !== 'bottom', pixel: 1 / devicePixelRatio});
    if (scroll) {
      const before = scrollY;
      window.scrollBy(0, scroll / 4);
      // What the gesture scrolls the page by is a pull: the edge goes on with the pointer held at the window's.
      current.scrolled += scrollY - before;
    }
    if (current.kind === 'drag') {
      retarget();
      follow();
    } else if (aim(current)) show(current);
    current.frame = requestAnimationFrame(frame);
  };
  const finish = (drop: boolean) => {
    const current = gesture.current;
    if (!current) return;
    if (drop) retarget();
    gesture.current = null;
    current.stop();
    cancelAnimationFrame(current.frame);
    document.body.classList.remove('is-dragging', 'is-resizing', `is-resizing-${current.kind}`);
    const body = bodies.current.get(current.id);
    const target = current.items.find(item => item.id === current.id)!;
    if (body) {
      body.style.transform = '';
      body.style.width = drop && wide(current.kind) ? `${target.w * pitch() - GAP}px` : '';
    }
    let wrote = false;
    if (current.active && drop) {
      // Measure after removing the smooth resize width, at the final snapped width: the cards
      // and the table need what that shows; the charts and the list tell theirs when they can.
      const measured = measure(true);
      const {sizeOf, saved, onPlaces} = latest.current;
      if (tall(current.kind)) aim(current, measured);
      const height = current.intent === undefined ? undefined : {id: current.id, rows: current.intent};
      const rows = (id: string) => rowsFor(sizeOf(id, measured), id === current.id ? (current.intent ?? saved(id)) : saved(id));
      const result = settle(
        current.items.map(item => ({...item, h: rows(item.id)})),
        layout.columns,
      );
      const intention = (items: Item[]) => JSON.stringify(items.map(({id, x, w}) => [id, x, w]));
      const placed = intention(current.items) !== intention(current.origin);
      if (placed || height) {
        onPlaces(placesOf(result), height);
        wrote = true;
        const name = byId.get(current.id)?.name ?? '';
        if (current.kind !== 'drag')
          say([
            ...(placed ? [t('widgets.resized', {name, span: target.w, count: layout.columns})] : []),
            ...(height ? [t('widgets.rows', {name, count: rows(current.id)})] : []),
          ]);
      }
      if (body && current.kind === 'drag' && !still())
        body.animate([{transform: `translate(${current.offset.x}px, ${current.offset.y}px)`}, {transform: 'none'}], SLIDE);
    }
    if (body) body.style.width = '';
    if (wide(current.kind) && current.moved) setReleased(old => ({...old, [current.id]: (old[current.id] ?? 0) + 1}));
    presses.current = [...presses.current, wrote || !drop].slice(-2);
    setPreview(null);
  };
  useLayoutEffect(() => {
    if (!movable) finish(false);
  }, [movable]);
  useLayoutEffect(() => {
    finish(false);
  }, [signature]);
  useLayoutEffect(() => () => finish(false), []);

  const begin = (id: string, kind: Kind, event: ReactPointerEvent<HTMLElement>) => {
    if (!movable || !event.isPrimary || event.button !== 0 || gesture.current) return;
    const body = bodies.current.get(id)!;
    const rect = places.current.get(id)!.getBoundingClientRect();
    const pointer = {x: event.clientX, y: event.clientY};
    const origin = reading(latest.current.spots);
    const item = origin.find(item => item.id === id)!;
    const allowed = leftward(kind) ? leftWidths(layout.columns, item.x + item.w) : widths(layout.columns, item.x);
    const width = (w: number) => w * pitch() - GAP;
    const rightGrab = pointer.x - body.getBoundingClientRect().right;
    const leftGrab = pointer.x - body.getBoundingClientRect().left;
    if (kind !== 'drag') {
      event.preventDefault();
      // Its release, and the second click of a double one, come back to the handle however far the pointer went.
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const move = (e: PointerEvent) => {
      const current = gesture.current;
      if (!current || e.pointerId !== event.pointerId) return;
      current.pointer = {x: e.clientX, y: e.clientY};
      current.moved ||= pastClick(e.clientX - pointer.x, e.clientY - pointer.y, 1 / devicePixelRatio);
      if (kind === 'drag') {
        if (!current.active && current.moved) {
          current.active = true;
          document.body.classList.add('is-dragging');
          setPreview({id, kind, items: current.items});
          current.frame = requestAnimationFrame(frame);
        }
        return;
      }
      let changed = false;
      if (wide(kind)) {
        const drawn = leftward(kind) ? rect.right - (e.clientX - leftGrab) : e.clientX - rightGrab - rect.left;
        const px = Math.max(width(allowed[0]), Math.min(width(allowed.at(-1)!), drawn));
        body.style.width = `${px}px`;
        if (current.edge) current.edge.px = px;
        const w = nearest(allowed, (px + GAP) / pitch());
        if (current.items.find(item => item.id === id)!.w !== w) {
          // Back at its width, the layout is the one it started from, in its order too, so there is nothing to save.
          current.items = w === item.w ? origin : leftward(kind) ? widenedLeft(origin, id, w, layout.columns) : widened(origin, id, w, layout.columns);
          changed = true;
        }
        follow();
      }
      if (tall(kind)) changed = aim(current) || changed;
      if (changed) show(current);
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
    const current: Gesture = {
      id,
      kind,
      signature,
      origin,
      items: origin,
      rows: item.h,
      intent: undefined,
      scrolled: 0,
      edge: leftward(kind) ? {right: rect.right, px: rect.width} : null,
      start: pointer,
      pointer,
      grab: {x: pointer.x - rect.left, y: pointer.y - rect.top},
      offset: {x: 0, y: 0},
      active: kind !== 'drag',
      moved: false,
      cell: {x: item.x, y: item.y},
      frame: 0,
      stop: () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', escape);
      },
    };
    gesture.current = current;
    if (kind !== 'drag') {
      document.body.classList.add('is-resizing', `is-resizing-${kind}`);
      setPreview({id, kind, items: origin});
      // Each frame follows the pointer and the page as it scrolls (`aim`): a click stays a click, however the page glides meanwhile.
      if (tall(kind)) current.frame = requestAnimationFrame(frame);
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
  /** Gives a widget back the height of its content; from the keyboard, the handle keeps the focus. */
  const fit = (id: string, handle?: Handle) => {
    if (!movable || gesture.current || saved(id) === undefined) return;
    const next = settle(
      reading(latest.current.spots).map(spot => (spot.id === id ? {...spot, h: rowsFor(sizeOf(id), undefined)} : spot)),
      layout.columns,
    );
    remember();
    if (handle) refocus.current = {id, handle};
    onPlaces(placesOf(next), {id, rows: null});
    say([t('widgets.fitted', {name: byId.get(id)!.name})]);
  };
  // Two presses make a double click whatever the pointer did between them (a tap and a drag on a touchpad): only two clicks fit.
  const twice = (id: string) => {
    const clicks = presses.current.length === 2 && !presses.current.some(Boolean);
    presses.current = [];
    if (clicks) fit(id);
  };
  const key = (id: string, handle: Handle) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!movable || gesture.current) return;
    const origin = reading(latest.current.spots);
    const item = origin.find(item => item.id === id)!;
    const name = byId.get(id)!.name;
    let next: Spot[];
    let height: Height | undefined;
    let lines: string[];
    if (handle === 'right') {
      const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[event.key];
      if (!step) return;
      event.preventDefault();
      const allowed = widths(layout.columns, item.x);
      const w = allowed[allowed.indexOf(item.w) + step];
      if (w === undefined) return;
      next = widened(origin, id, w, layout.columns);
      lines = [t('widgets.resized', {name, span: w, count: layout.columns})];
    } else if (handle === 'bottom') {
      const step = {ArrowUp: -1, ArrowDown: 1}[event.key];
      if (!step) return;
      event.preventDefault();
      const {min} = bounds(id);
      const rows = heightIntent(item.h, item.h, item.h + step, min);
      if (rows === undefined) return;
      height = {id, rows};
      next = settle(
        origin.map(spot => (spot.id === id ? {...spot, h: Math.max(rows, min)} : spot)),
        layout.columns,
      );
      lines = [t('widgets.rows', {name, count: Math.max(rows, min)})];
    } else {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      next = stepped(origin, id, event.key, layout.columns);
      const moved = next.find(item => item.id === id)!;
      lines = [
        t('widgets.moved', {name, position: reading(next).findIndex(item => item.id === id) + 1, count: next.length}),
        t('widgets.movedColumn', {column: moved.x + 1, columns: layout.columns}),
      ];
    }
    if (!height && samePlaces(next, origin)) return;
    remember();
    refocus.current = {id, handle};
    onPlaces(placesOf(next), height);
    say(lines);
  };

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    // A step can move the widget in the reading order, and its node with it: the handle takes the focus back, in sight.
    const again = refocus.current;
    refocus.current = null;
    // Stepped by an edge, the widget stands where it went at once, so bringing its handle into sight sees it there.
    const stays = again && again.handle !== 'move' ? again.id : null;
    if (was && !still())
      for (const [id, node] of places.current) {
        const from = was.get(id);
        if (!from || id === gesture.current?.id) continue;
        for (const animation of node.getAnimations()) animation.cancel();
        if (id === stays) continue;
        const to = node.getBoundingClientRect();
        const dx = from.left - to.left,
          dy = from.top - to.top;
        if (Math.abs(dx) + Math.abs(dy) > 1) node.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'none'}], SLIDE);
      }
    follow();
    const handle = again && handles.current.get(`${again.id}/${again.handle}`);
    if (handle) {
      handle.focus();
      if (again.handle !== 'move') handle.scrollIntoView({block: 'nearest'});
    }
  });
  const handleRef = (id: string, handle: Handle) => (node: HTMLElement | null) => {
    if (node) handles.current.set(`${id}/${handle}`, node);
    else handles.current.delete(`${id}/${handle}`);
  };

  return (
    <div className={`widgets ${movable ? 'is-movable' : ''}`} ref={grid} style={{'--columns': columns} as CSSProperties}>
      {reading(spots).map(spot => {
        const widget = byId.get(spot.id)!;
        const allocated = spot.h * (ROW - geometry.short) - GAP;
        const fill = geometry.heights[spot.id] === undefined ? 0 : Math.max(0, allocated - geometry.heights[spot.id]);
        const manual = intended(spot.id) !== undefined;
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
                  onKeyDown={key(spot.id, 'move')}
                  ref={handleRef(spot.id, 'move')}
                >
                  <svg viewBox="0 0 20 8" width="20" height="8" aria-hidden="true">
                    {[3, 8, 13].map(x => [2, 6].map(y => <circle key={`${x}-${y}`} cx={x + 2} cy={y} r="1.1" />))}
                  </svg>
                </button>
              )}
              <Sized id={spot.id} manual={manual} geometry={geometry} width={given.get(spot.id)!} report={report}>
                {widget.content}
              </Sized>
              {movable && (
                <>
                  <span className="resize-handle is-left" aria-hidden="true" title={t('widgets.leftHint')} onPointerDown={e => begin(spot.id, 'left', e)} />
                  <button
                    type="button"
                    className="resize-handle is-right"
                    aria-label={t('widgets.resize', {name: widget.name})}
                    title={t('widgets.resizeHint')}
                    onPointerDown={e => begin(spot.id, 'right', e)}
                    onKeyDown={key(spot.id, 'right')}
                    ref={handleRef(spot.id, 'right')}
                  />
                  <button
                    type="button"
                    className="resize-handle is-bottom"
                    aria-label={t('widgets.height', {name: widget.name})}
                    title={t('widgets.heightHint')}
                    onPointerDown={e => begin(spot.id, 'bottom', e)}
                    onKeyDown={key(spot.id, 'bottom')}
                    // Enter and Space, and a screen reader's own activation: a click with no count and no pointer (some browsers count no tap that began a gesture).
                    onClick={e => e.detail === 0 && !(e.nativeEvent as PointerEvent).pointerType && fit(spot.id, 'bottom')}
                    onDoubleClick={() => twice(spot.id)}
                    ref={handleRef(spot.id, 'bottom')}
                  />
                  {(['bottom-left', 'bottom-right'] as const).map(corner => (
                    <span
                      key={corner}
                      className={`resize-handle is-${corner}`}
                      aria-hidden="true"
                      title={t('widgets.cornerHint')}
                      onPointerDown={e => begin(spot.id, corner, e)}
                      onDoubleClick={() => twice(spot.id)}
                    />
                  ))}
                </>
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
