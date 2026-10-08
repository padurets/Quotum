export const COLUMNS = 6;
/** The tallest a board's owner makes a widget, in rows; the hub holds a height to it too. */
export const MAX_ROWS = 200;
/** Where a widget stands, and the height in rows its owner chose for it; none: as tall as its content. */
export type Place = {x: number; y: number; w: number; h?: number};
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
  // The chosen height stays in the layout: what a widget takes is worked out from it and its content.
  const saved = visible.filter(id => Object.hasOwn(layout.places, id)).map(id => ({id, x: layout.places[id].x, y: layout.places[id].y, w: layout.places[id].w}));
  const items: Omit<Item, 'h'>[] = reading(saved);
  visible.forEach((id, i) => {
    if (items.some(item => item.id === id)) return;
    const prev = items.find(item => item.id === visible[i - 1]);
    const w = defaultWidth(id, layout.columns);
    const x = prev ? (starts(layout.columns, w).find(x => x >= prev.x + prev.w) ?? 0) : 0;
    items.splice(prev ? items.indexOf(prev) + 1 : 0, 0, {id, x, w});
  });
  return items;
}


export type Stored = {layout?: Layout; order?: string[]; sizes?: Record<string, number>};
export function withPlaces<T extends Stored>(view: T, places: Record<string, Place>): Omit<T, 'order' | 'sizes' | 'layout'> & {layout: Layout} {
  const {order, sizes, layout, ...rest} = view;
  return {...rest, layout: {columns: layout?.columns ?? COLUMNS, places: {...layout?.places, ...places}}};
}


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
