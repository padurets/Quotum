/** Content fills whole rows; the last row has no gap below it. */
export const COLUMNS = 6;
export const ROW = 48;
export const GAP = 16;
export const rowsOf = (px: number) => Math.max(1, Math.ceil((px + GAP) / ROW));
export type Place = {x: number; y: number; w: number};
export type Layout = {columns: number; places: Record<string, Place>};
export type Item = {id: string; x: number; w: number; h: number};
export type Spot = Item & {y: number};
export const widths = (columns: number, x = 0) => [columns / 3, columns / 2, (columns * 2) / 3, columns].filter(w => x + w <= columns);
export const starts = (columns: number, w: number) => [0, columns / 3, columns / 2, (columns * 2) / 3].filter(x => x + w <= columns);
export const defaultWidth = (id: string, columns: number) => (id.startsWith('source:') ? columns / 2 : columns);
export const reading = <T extends Place>(items: T[]): T[] => [...items].sort((a, b) => a.y - b.y || a.x - b.x);
export const nearest = (values: number[], target: number) => values.reduce((best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best));

/** Only columns underneath a widget support it; it never passes a preceding widget. */
export function settle(items: Item[], columns: number): Spot[] {
  const skyline = Array<number>(columns).fill(0);
  return items.map(item => {
    const y = Math.max(...skyline.slice(item.x, item.x + item.w));
    skyline.fill(y + item.h, item.x, item.x + item.w);
    return {...item, y};
  });
}

/** New widgets follow their natural neighbour, even on an already arranged board. */
export function ordered(layout: Layout, ids: string[], hidden: string[] = []): Omit<Item, 'h'>[] {
  const visible = ids.filter(id => !hidden.includes(id));
  const items = reading(visible.filter(id => Object.hasOwn(layout.places, id)).map(id => ({id, ...layout.places[id]}))) as Omit<Item, 'h'>[];
  visible.forEach((id, i) => {
    if (items.some(item => item.id === id)) return;
    const prev = items.find(item => item.id === visible[i - 1]);
    const w = defaultWidth(id, layout.columns);
    const x = prev ? (starts(layout.columns, w).find(x => x >= prev.x + prev.w) ?? 0) : 0;
    items.splice(prev ? items.indexOf(prev) + 1 : 0, 0, {id, x, w});
  });
  return items;
}

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

/** Reading order may change without moving anything, for example Home on the top-right card. */
export function samePlaces(a: Spot[], b: Spot[]): boolean {
  const places = placesOf(a);
  return a.length === b.length && b.every(({id, x, y, w}) => {
    const place = places[id];
    return place?.x === x && place.y === y && place.w === w;
  });
}

type Stored = {layout?: Layout; order?: string[]; sizes?: Record<string, number>};
export function withPlaces<T extends Stored>(view: T, places: Record<string, Place>): Omit<T, 'order' | 'sizes' | 'layout'> & {layout: Layout} {
  const {order, sizes, layout, ...rest} = view;
  return {...rest, layout: {columns: layout?.columns ?? COLUMNS, places: {...layout?.places, ...places}}};
}

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
export function legacyLayout<T extends Stored>(view: T, areas: {cards: string[]; analytics: string[]}, hidden: string[]) {
  // Keep a current server view intact: useView compares its saved acknowledgement with this value.
  if (view.layout && !view.order && !view.sizes) return view as Omit<T, 'order' | 'sizes' | 'layout'> & {layout: Layout};
  if (Object.keys(view.layout?.places ?? {}).length || (!view.order && !view.sizes)) return withPlaces(view, {});
  const saved = new Set([...(view.order ?? []), ...Object.keys(view.sizes ?? {})]);
  const columns = view.layout?.columns ?? COLUMNS;
  const places: Record<string, Place> = {};
  const areaOf = (id: string) =>
    areas.cards.includes(id) ? 'cards' : areas.analytics.includes(id) ? 'analytics' : id.startsWith('source:') || id === 'agents' ? 'cards' : 'analytics';
  for (const area of ['cards', 'analytics'] as const) {
    const ids = areas[area];
    const order = (view.order ?? []).filter(id => areaOf(id) === area);
    ids.forEach((id, i) => {
      if (order.includes(id)) return;
      const prev = ids
        .slice(0, i)
        .reverse()
        .find(other => order.includes(other));
      order.splice(prev === undefined ? 0 : order.indexOf(prev) + 1, 0, id);
    });
    order.push(...[...saved].filter(id => areaOf(id) === area && !order.includes(id)).sort());
    let visibleCursor = 0;
    let fullCursor = 0;
    order.forEach((id, y) => {
      const span = Math.max(4, Math.min(12, view.sizes?.[id] ?? (id.startsWith('source:') ? 6 : 12)));
      // Reversing the candidates makes an exact tie choose the wider one.
      const w = nearest(widths(columns).reverse(), (span * columns) / 12);
      const fullX = starts(columns, w).find(x => x >= fullCursor) ?? 0;
      fullCursor = fullX + w;
      let x = fullX;
      if (ids.includes(id) && !hidden.includes(id)) {
        x = starts(columns, w).find(x => x >= visibleCursor) ?? 0;
        visibleCursor = x + w;
      }
      if (saved.has(id)) places[id] = {x, y, w};
    });
  }
  return withPlaces(view, places);
}
