import {isValidPlan} from './plan.js';

/** `h`: the height in rows the board's owner chose; none while a widget is as tall as its content. */
export type Place = {x: number; y: number; w: number; h?: number};
export type Layout = {columns: number; places: Record<string, Place>};

/**
 * How a board is arranged: the places of its widgets (a card per source, the history
 * chart, the table and agent activity), how wide each is, the names given to cards, the hidden widgets,
 * the windows hidden inside cards, the weekly spending plan per source (or none) and the
 * colours given to cards. The owner
 * arranges it and everyone on the board sees it this way. Nothing here changes what is
 * measured or stored.
 */
export type View = {
  layout: Layout;
  /** Boards arranged before the grid: the page translates these; POST never saves them. */
  order?: string[];
  sizes?: Record<string, number>;
  /** Card names the board's owner gave, by source id, instead of the automatic one. */
  names: Record<string, string>;
  hidden: string[];
  /** Widgets off by default and explicitly enabled key scales beyond the card preview. */
  shown: string[];
  /** Hidden windows (`source/window`) and card key scales (`source/key:opaque-id`). */
  windows: string[];
  plans: Record<string, number[]>;
  /** Source ids whose plan is switched off on this board. */
  unplanned: string[];
  /** Colours given to cards, by source id, instead of the provider's. */
  colors: Record<string, string>;
  /** Columns hidden in a widget's table, by widget id. */
  columns: Record<string, string[]>;
  /** Columns off by default that the owner turned on, by widget id. */
  shownColumns: Record<string, string[]>;
  enabledWhenEmpty?: string[];
};

export const EMPTY_VIEW: View = {
  layout: {columns: 6, places: {}},
  names: {},
  hidden: [],
  shown: [],
  windows: [],
  plans: {},
  unplanned: [],
  colors: {},
  columns: {},
  shownColumns: {},
  enabledWhenEmpty: [],
};

const COLUMNS = 6;
/** The tallest a widget is made, in rows (ui/lib/grid.ts has the same). */
export const MAX_ROWS = 200;
const LIMITS = {widgets: 200, windows: 500, id: 120, name: 60, columns: 20};

const ids = (value: unknown, max: number): string[] | null =>
  Array.isArray(value) && value.length <= max && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id)
    ? [...new Set(value as string[])]
    : null;

/** A map by widget or source id whose every value passes `valid`; null when anything is off. */
function byId<T>(value: unknown, valid: (entry: unknown) => entry is T, limit = LIMITS.widgets): Record<string, T> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limit || entries.some(([id, entry]) => !id || id.length > LIMITS.id || !valid(entry))) return null;
  return Object.fromEntries(entries) as Record<string, T>;
}

const isPlace = (value: unknown): value is Place => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p).sort().join();
  return (
    (keys === 'w,x,y' || (keys === 'h,w,x,y' && Number.isInteger(p.h) && (p.h as number) >= 1 && (p.h as number) <= MAX_ROWS)) &&
    ['x', 'y', 'w'].every(key => Number.isInteger(p[key])) &&
    [0, 2, 3, 4].includes(p.x as number) &&
    [2, 3, 4, 6].includes(p.w as number) &&
    (p.x as number) + (p.w as number) <= COLUMNS &&
    (p.y as number) >= 0 &&
    (p.y as number) < 100000
  );
};
const parseLayout = (value: unknown): Layout | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.columns !== COLUMNS || input.places === undefined) return null;
  // New visible neighbours need places too; the view route bounds their total by bytes.
  const places = byId(input.places, isPlace, Infinity);
  return places ? {columns: COLUMNS, places} : null;
};
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= LIMITS.name;
const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
const isColumns = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= LIMITS.columns && value.every(id => typeof id === 'string' && /^[a-z]{1,20}$/.test(id));

/** A view as a page sent it, or null when anything in it is off. */
export function parseView(body: unknown): View | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  const layout = parseLayout(input.layout);
  const hidden = ids(input.hidden ?? [], LIMITS.widgets);
  const shown = ids(input.shown ?? [], LIMITS.widgets);
  const windows = ids(input.windows ?? [], LIMITS.windows);
  const names = byId(input.names, isName);
  const plans = byId(input.plans, isValidPlan);
  const unplanned = ids(input.unplanned ?? [], LIMITS.widgets);
  const colors = byId(input.colors, isColor);
  const columns = byId(input.columns, isColumns);
  const shownColumns = byId(input.shownColumns, isColumns);
  const enabledWhenEmpty = ids(input.enabledWhenEmpty ?? [], 4);
  if (!layout || !hidden || !shown || !windows || !names || !plans || !unplanned || !colors || !columns || !shownColumns || !enabledWhenEmpty || enabledWhenEmpty.some(id => !['agents', 'activity', 'history', 'forecast'].includes(id))) return null;
  const uniqueColumns = (map: Record<string, string[]>) => Object.fromEntries(Object.entries(map).map(([id, list]) => [id, [...new Set(list)]]));
  return {layout, names, hidden, shown, windows, plans, unplanned, colors, columns: uniqueColumns(columns), shownColumns: uniqueColumns(shownColumns), enabledWhenEmpty};
}
