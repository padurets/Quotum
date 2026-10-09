import {isValidPlan} from './plan.js';
export type {Place, Layout} from './layout.js';
import type {Place, Layout} from './layout.js';

/** `h`: the height in rows the board's owner chose; none while a widget is as tall as its content. */


/**
 * How a board is arranged: the places of its widgets (a card per source, the history
 * chart, the table and agent activity), how wide each is, the names given to cards, the hidden widgets,
 * the windows hidden inside cards, the weekly spending plan per source (or none) and the
 * colours given to cards. The owner
 * arranges it and everyone on the board sees it this way. Nothing here changes what is
 * measured or stored.
 */
export type View = {
  version: 3;
  layout: Layout;
  /** Boards arranged before the grid: the hub migrates these; POST never saves them. */
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

/** The released two-grid shape is read only by its migration. */
export type SplitView = Omit<View, 'version'> & {version: 2};
export const VIEW_VERSION = 3;
export const VIEW_VERSION_HEADER = 'X-Quotum-View-Version';
// A pre-grid view may materialize 200 ordered and 200 separately sized places.
export const VIEW_BODY_LIMIT = 76 * 1024;
export const VIEW_KEEPALIVE_LIMIT = 64 * 1024;
export const VIEW_DECODED_LIMIT = 128 * 1024;

export const EMPTY_VIEW: View = {
  version: VIEW_VERSION,
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
    (p.y as number) < 100004
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
function parseFields(body: unknown, version: 2 | 3): View | SplitView | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  if (input.version !== version) return null;
  const layout = parseLayout(input.layout);
  const hidden = ids(input.hidden ?? [], LIMITS.widgets + 4);
  const shown = ids(input.shown ?? [], LIMITS.widgets + (version === 3 ? 10 : 4));
  const windows = ids(input.windows ?? [], LIMITS.windows);
  const names = byId(input.names, isName);
  const plans = byId(input.plans, isValidPlan);
  const unplanned = ids(input.unplanned ?? [], LIMITS.widgets);
  const colors = byId(input.colors, isColor);
  const columns = byId(input.columns, isColumns, LIMITS.widgets + 4);
  const shownColumns = byId(input.shownColumns, isColumns, LIMITS.widgets + 4);
  const enabledWhenEmpty = ids(input.enabledWhenEmpty ?? [], 2);
  if (!layout || !hidden || !shown || !windows || !names || !plans || !unplanned || !colors || !columns || !shownColumns || !enabledWhenEmpty || enabledWhenEmpty.some(id => !['agents', 'activity'].includes(id))) return null;
  const uniqueColumns = (map: Record<string, string[]>) => Object.fromEntries(Object.entries(map).map(([id, list]) => [id, [...new Set(list)]]));
  if (version === 3 && shown.filter(id => !BUILTIN_WIDGETS.includes(id)).length > LIMITS.widgets + 4) return null;
  return {version, layout, names, hidden, shown, windows, plans, unplanned, colors, columns: uniqueColumns(columns), shownColumns: uniqueColumns(shownColumns), enabledWhenEmpty};
}

export const parseView = (body: unknown) => parseFields(body, 3) as View | null;
export const parseSplitView = (body: unknown) => parseFields(body, 2) as SplitView | null;

// These positions are the persisted v3 codec, independent of the catalogue's order.
const BUILTIN_WIDGETS: readonly string[] = ['agents', 'activity', 'quota-history', 'budget-history', 'quota-table', 'budget-table'];
const GEOMETRY = [[0,2],[0,3],[0,4],[0,6],[2,2],[2,3],[2,4],[3,2],[3,3],[4,2]] as const;
const FIELDS = ['names','hidden','shown','windows','plans','unplanned','colors','columns','shownColumns','enabledWhenEmpty'] as const;
export type EncodedView = [3, ([string | number, number] | [string | number, number, number])[], number, ...unknown[]];
const encodeId = (id: string) => BUILTIN_WIDGETS.includes(id) ? BUILTIN_WIDGETS.indexOf(id) : id;

/** Storage and every writer use this same lossless representation and byte count. */
export function encodeView(view: View): EncodedView {
  const places: EncodedView[1] = Object.entries(view.layout.places)
    .sort(([a,p],[b,q]) => p.y - q.y || p.x - q.x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id,p]) => {
      const geometry = GEOMETRY.findIndex(([x,w]) => x === p.x && w === p.w);
      if (geometry < 0) throw new Error('Invalid board geometry');
      return p.h === undefined ? [encodeId(id), geometry] : [encodeId(id), geometry, p.h];
    });
  let mask = 0;
  const fields: unknown[] = [];
  FIELDS.forEach((key,i) => {
    const value = view[key];
    if (!value || !Object.keys(value).length) return;
    mask |= 1 << i;
    fields.push(key === 'shown' ? [BUILTIN_WIDGETS.reduce((bits,id,j) => bits | (view.shown.includes(id) ? 1 << j : 0),0), ...view.shown.filter(id => !BUILTIN_WIDGETS.includes(id))] : value);
  });
  return [VIEW_VERSION, places, mask, ...fields];
}

/** A wire draft has no implicit object fields, duplicate ids or unknown mask bits. */
export function decodeView(input: unknown): View | null {
  if (!Array.isArray(input) || input[0] !== VIEW_VERSION || !Array.isArray(input[1]) || !Number.isInteger(input[2]) || input[2] < 0 || input[2] >= 1 << FIELDS.length) return null;
  const places: [string, Place][] = [], seen = new Set<string>();
  for (const tuple of input[1]) {
    if (!Array.isArray(tuple) || tuple.length < 2 || tuple.length > 3) return null;
    const [alias,g,h] = tuple;
    const id = typeof alias === 'number' && Number.isInteger(alias) ? BUILTIN_WIDGETS[alias] : alias;
    if (typeof id !== 'string' || !id || id.length > LIMITS.id || seen.has(id) || !Number.isInteger(g) || !GEOMETRY[g as number]) return null;
    if (typeof alias === 'string' && BUILTIN_WIDGETS.includes(alias)) return null;
    const [x,w] = GEOMETRY[g as number];
    const place = {x,w,y:places.length,...(tuple.length === 3 ? {h} : {})};
    if (!isPlace(place)) return null;
    places.push([id,place]); seen.add(id);
  }
  const fields: Record<string, unknown> = {};
  let at = 3;
  for (let i = 0; i < FIELDS.length; i++) if (input[2] & 1 << i) {
    if (at >= input.length) return null;
    let value = input[at++];
    if (FIELDS[i] === 'shown') {
      if (!Array.isArray(value) || !Number.isInteger(value[0]) || value[0] < 0 || value[0] > 63) return null;
      const other = ids(value.slice(1), LIMITS.widgets + 4);
      if (!other || other.length !== value.length - 1 || other.some(id => BUILTIN_WIDGETS.includes(id))) return null;
      value = [...BUILTIN_WIDGETS.filter((_,j) => value[0] & 1 << j), ...other];
    }
    fields[FIELDS[i]] = value;
  }
  if (at !== input.length) return null;
  const view = parseView({...fields,version:VIEW_VERSION,layout:{columns:COLUMNS,places:Object.fromEntries(places)}});
  return view && new TextEncoder().encode(JSON.stringify(view)).byteLength <= VIEW_DECODED_LIMIT ? view : null;
}

export const viewBytes = (view: View) => new TextEncoder().encode(JSON.stringify(encodeView(view))).byteLength;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => [key,canonical(v)])) : value;
export const sameView = (a: View, b: View) => JSON.stringify(canonical(encodeView(a))) === JSON.stringify(canonical(encodeView(b)));
