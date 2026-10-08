import {MAX_ROWS, reading, nearest, starts, widths, settle, withPlaces, type Stored, type Place, type Layout, type Item, type Spot} from '../../server/domain/layout.js';
export * from '../../server/domain/layout.js';

/** Content fills whole rows; the last row has no gap below it. */
export const ROW = 48;
export const GAP = 16;
export const rowsOf = (px: number) => Math.max(1, Math.ceil((px + GAP) / ROW));

export function cellOf(corner: {x: number; y: number}, pitch: number, w: number, columns: number) {
  return {x: nearest(starts(columns, w), corner.x / pitch), y: Math.max(0, Math.round(corner.y / ROW))};
}

/** The origin, including its heights, stays frozen for the whole gesture. */
export function landed(origin: Spot[], id: string, cell: {x: number; y: number}, columns: number): Spot[] {
  const item = origin.find(item => item.id === id)!;
  const moving = {...item, x: cell.x};
  const others = reading(origin.filter(item => item.id !== id));
  const before = others.filter(item => item.y < cell.y);
  const tied = others.filter(item => item.y === cell.y);
  const after = others.filter(item => item.y > cell.y);
  for (let j = 0; j <= tied.length; j++) {
    const result = settle([...before, ...tied.slice(0, j), moving, ...tied.slice(j), ...after], columns);
    if (result.find(item => item.id === id)!.y >= cell.y || j === tied.length) return result;
  }
  return origin;
}

export const widened = (origin: Spot[], id: string, w: number, columns: number) =>
  settle(
    origin.map(item => (item.id === id ? {...item, w} : item)),
    columns,
  );

/** Widths a widget can take by its left edge, its right one staying at `right`. */
export const leftWidths = (columns: number, right: number) => widths(columns).filter(w => w <= right && starts(columns, w).includes(right - w));

/**
 * Wider or narrower by its left edge: its right edge stays, and it keeps its row, the
 * widgets of that row it now covers going after it, as the right edge sends its neighbour
 * down. It cannot pass the widgets above it.
 */
export function widenedLeft(origin: Spot[], id: string, w: number, columns: number): Spot[] {
  const item = origin.find(item => item.id === id)!;
  return landed(
    origin.map(other => (other.id === id ? {...other, w} : other)),
    id,
    {x: item.x + item.w - w, y: item.y},
    columns,
  );
}

export function stepped(origin: Spot[], id: string, key: string, columns: number): Spot[] {
  const item = origin.find(item => item.id === id)!;
  const bottom = Math.max(...origin.map(item => item.y + item.h));
  if (key === 'Home' || key === 'End') return landed(origin, id, {x: item.x, y: key === 'Home' ? 0 : bottom + 1}, columns);
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const xs = starts(columns, item.w);
    const x = xs[xs.indexOf(item.x) + (key === 'ArrowLeft' ? -1 : 1)];
    return x === undefined ? origin : landed(origin, id, {x, y: item.y}, columns);
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return origin;
  const down = key === 'ArrowDown';
  const ys = new Set([0, ...origin.filter(other => other.id !== id).flatMap(other => [other.y, other.y + 1, other.y + other.h + 1])]);
  let best = origin;
  let distance = Infinity;
  for (const y of ys) {
    const next = landed(origin, id, {x: item.x, y}, columns);
    const delta = (next.find(other => other.id === id)!.y - item.y) * (down ? 1 : -1);
    if (delta > 0 && delta < distance) {
      best = next;
      distance = delta;
    }
  }
  return best;
}

export const placesOf = (spots: Spot[]): Record<string, Place> => Object.fromEntries(spots.map(({id, x, y, w}) => [id, {x, y, w}]));

/**
 * The rows a widget takes: as many as its content needs, or as many as its owner chose
 * (`requested`), never fewer than the least it can show (`min`, in pixels). Before its
 * content is first measured, a chosen height is taken as it is.
 */
export const rowsFor = (size: {min: number; natural: number} | undefined, requested: number | undefined) =>
  requested === undefined ? rowsOf(size?.natural ?? 224) : Math.max(requested, size ? rowsOf(size.min) : 1);

/**
 * The height a widget's owner chose by a gesture or a key, in rows, or undefined when
 * nothing is to be saved. `start` is how many rows it took when they began, `requested` how
 * many they asked for; `baseline` how many it takes now with the height it had (its content
 * may have changed meanwhile), `min` how few it can take. A widget pushed below its least
 * stops there; one already there, or asked for what it already shows, keeps its height,
 * whether chosen or its content's; one that would only follow its content against the way
 * it was pulled does too.
 */
export function heightIntent(start: number, baseline: number, requested: number, min: number): number | undefined {
  if (requested === start || min > MAX_ROWS) return undefined;
  const rows = Math.min(MAX_ROWS, Math.max(1, min, requested));
  if (rows === baseline || Math.sign(rows - baseline) !== Math.sign(requested - start)) return undefined;
  return rows;
}

/** How near an edge of the window a gesture's pointer scrolls the page, in CSS pixels. */
export const EDGE = 72;
/** How far toward that edge the pointer goes, at most, before it does: half a row, past a hand's or a finger's drift. */
export const PULL = 24;

/**
 * Whether a pointer has gone further than a click's jitter (`dx`, `dy` in CSS pixels): four of
 * the screen's pixels, which zoomed out (`pixel`, one of them in CSS pixels) are more CSS
 * pixels, and never fewer than four CSS pixels, as on a dense screen or zoomed in.
 */
export const pastClick = (dx: number, dy: number, pixel = 1) => Math.hypot(dx, dy) > 4 * Math.max(1, pixel);

/**
 * How deep a gesture's pointer is in the band along an edge of the window, in CSS pixels
 * (negative at the top), or 0 where the page stays: `y` is the pointer and `from` where it
 * was pressed, `top` where the bars stuck at the top of the window end and `bottom` the
 * window's height. The page scrolls under a pointer that has gone past a click's jitter
 * (`moved`) and toward that edge: half a row, or, from a press nearer to it than that, to
 * the edge itself, its last two pixels or, zoomed out, the last pixel of the screen
 * (`pixel`, in CSS pixels). A gesture that also goes sideways (a corner, a widget carried by
 * its head) goes a pixel toward the edge at least, so moving along it scrolls nothing.
 */
export function edgeScroll({y, from, top, bottom, moved, sideways, pixel = 1}: {y: number; from: number; top: number; bottom: number; moved: boolean; sideways: boolean; pixel?: number}) {
  if (!moved) return 0;
  // The screen's pixel comes in floating point (at a third, a hair under 3 CSS pixels: 2.99999991): up to a 64th, as the page lays out.
  const edge = Math.max(2, Math.ceil(pixel * 64) / 64);
  const toward = (room: number) => Math.min(PULL, sideways ? Math.max(1, room - edge) : room - edge);
  if (y < top + EDGE && y <= from - toward(from)) return y - top - EDGE;
  if (y > bottom - EDGE && y >= from + toward(bottom - from)) return y - bottom + EDGE;
  return 0;
}

/** A height chosen for one widget, in rows; null gives it back the height of its content. */
export type Height = {id: string; rows: number | null};

/**
 * Places a gesture or a key put widgets in, with every chosen height carried over from the
 * layout they change (the latest, not yet saved one); only `height` changes one.
 */
export function withHeights(saved: Record<string, Place>, places: Record<string, Place>, height?: Height) {
  return Object.fromEntries(
    Object.entries(places).map(([id, {x, y, w}]) => {
      const h = height?.id === id ? height.rows : saved[id]?.h;
      return [id, h == null ? {x, y, w} : {x, y, w, h}];
    }),
  ) as Record<string, Place>;
}

/** Reading order may change without moving anything, for example Home on the top-right card. */
export function samePlaces(a: Spot[], b: Spot[]): boolean {
  const places = placesOf(a);
  return a.length === b.length && b.every(({id, x, y, w}) => {
    const place = places[id];
    return place?.x === x && place.y === y && place.w === w;
  });
}

/** What a gesture or a key does to the view: applied to the latest one, saved or not yet, so the chosen heights come from it. */
export const withArranged = <T extends Stored & {layout: Layout}>(view: T, places: Record<string, Place>, height?: Height) =>
  withPlaces(view, withHeights(view.layout.places, places, height));

export function narrowed(items: Item[], columns: 2 | 1, wideColumns: number): Spot[] {
  const skyline = Array<number>(columns).fill(0);
  return items.map(item => {
    const w = columns === 1 || item.w > wideColumns / 2 ? columns : 1;
    const center = item.x + item.w / 2;
    const x = w === columns ? 0 : center < wideColumns / 2 ? 0 : center > wideColumns / 2 ? 1 : skyline[0] <= skyline[1] ? 0 : 1;
    const y = Math.max(...skyline.slice(x, x + w));
    skyline.fill(y + item.h, x, x + w);
    return {...item, x, w, y};
  });
}

/** Translate every saved id, including hidden and absent widgets, without reserving visible space for them. */
