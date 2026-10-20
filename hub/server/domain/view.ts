import {isValidPlan} from './plan.js';
export type {Place, Layout} from './layout.js';
import type {Place, Layout} from './layout.js';

/** `h`: the height in rows the board's owner chose; none while a widget is as tall as its content. */


/**
 * How a board is arranged: the places of its widgets (a card per source, the history
 * chart, the table and agent activity), how wide each is, the names given to cards, the hidden widgets,
 * the weekly spending plan per source (or none) and the
 * colours given to cards. The owner
 * arranges it and everyone on the board sees it this way. Nothing here changes what is
 * measured or stored.
 */
export type View = {
  version: 5;
  layout: Layout;
  /** Boards arranged before the grid: the hub migrates these; POST never saves them. */
  order?: string[];
  sizes?: Record<string, number>;
  /** Card names the board's owner gave, by source id, instead of the automatic one. */
  names: Record<string, string>;
  hidden: string[];
  /** Widgets off by default. */
  shown: string[];
  /** Reserved for compatibility; v5 always leaves it empty. */
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
export type FixedView = Omit<View, 'version'> & {version: 4};
export type SplitView = Omit<View, 'version'> & {version: 2};
export type UnifiedView = Omit<View, 'version'> & {version: 3};
export const VIEW_VERSION = 5;
export const VIEW_VERSION_HEADER = 'X-Quotum-View-Version';
// A pre-grid view may materialize 200 ordered and 200 separately sized places.
export const VIEW_BODY_LIMIT = 80 * 1024;
export const VIEW_KEEPALIVE_LIMIT = 64 * 1024;
export const VIEW_DECODED_LIMIT = 132 * 1024;

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
function parseFields(body: unknown, version: 2 | 3 | 4 | 5): View | FixedView | UnifiedView | SplitView | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  if (input.version !== version) return null;
  const layout = parseLayout(input.layout);
  const extra = version >= 4 ? 11 : 4;
  const hidden = ids(input.hidden ?? [], LIMITS.widgets + extra);
  const shown = ids(input.shown ?? [], LIMITS.widgets + (version >= 4 ? 15 : version === 3 ? 11 : 4));
  const windows = ids(input.windows ?? [], LIMITS.windows);
  if (version === 5 && (windows?.length || shown?.some(id => id.includes('/key:')))) return null;
  const names = byId(input.names, isName);
  const plans = byId(input.plans, isValidPlan);
  const unplanned = ids(input.unplanned ?? [], LIMITS.widgets);
  const colors = byId(input.colors, isColor);
  const columns = byId(input.columns, isColumns, LIMITS.widgets + extra);
  const shownColumns = byId(input.shownColumns, isColumns, LIMITS.widgets + extra);
  const enabledWhenEmpty = ids(input.enabledWhenEmpty ?? [], 2);
  if (!layout || !hidden || !shown || !windows || !names || !plans || !unplanned || !colors || !columns || !shownColumns || !enabledWhenEmpty || enabledWhenEmpty.some(id => !['agents', 'activity'].includes(id))) return null;
  const uniqueColumns = (map: Record<string, string[]>) => Object.fromEntries(Object.entries(map).map(([id, list]) => [id, [...new Set(list)]]));
  const builtins = version >= 4 ? BUILTIN_WIDGETS : V3_WIDGETS;
  if (version >= 3 && shown.filter(id => !builtins.includes(id)).length > LIMITS.widgets + 4) return null;
  return {version, layout, names, hidden, shown, windows, plans, unplanned, colors, columns: uniqueColumns(columns), shownColumns: uniqueColumns(shownColumns), enabledWhenEmpty};
}

export const parseView = (body: unknown) => parseFields(body, 5) as View | null;
export const parseFixedView = (body: unknown) => parseFields(body, 4) as FixedView | null;
export const parseUnifiedView = (body: unknown) => parseFields(body, 3) as UnifiedView | null;
export const parseSplitView = (body: unknown) => parseFields(body, 2) as SplitView | null;

// These positions are the persisted v3 codec, independent of the catalogue's order.
const V3_WIDGETS: readonly string[] = ['agents', 'activity', 'quota-history', 'budget-history', 'quota-table', 'budget-table', 'subscription-funds'];
// Preview v4 spending slots stay reserved; the active catalogue never offers them.
const BUILTIN_WIDGETS = [...V3_WIDGETS, 'quota-session-history', 'quota-session-table', 'budget-spending-history', 'budget-spending-table'];
const GEOMETRY = [[0,2],[0,3],[0,4],[0,6],[2,2],[2,3],[2,4],[3,2],[3,3],[4,2]] as const;
const FIELDS = ['names','hidden','shown','windows','plans','unplanned','colors','columns','shownColumns','enabledWhenEmpty'] as const;
type EncodedFields = [3 | 4 | 5, ([string | number, number] | [string | number, number, number])[], number, ...unknown[]];
export type EncodedView = [5, EncodedFields[1], number, ...unknown[]];

/** Storage and every writer use this same lossless representation and byte count. */
function encodeFields(view: View | FixedView | UnifiedView): EncodedFields {
  const builtins = view.version >= 4 ? BUILTIN_WIDGETS : V3_WIDGETS;
  const encodeId = (id: string) => builtins.includes(id) ? builtins.indexOf(id) : id;
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
    fields.push(key === 'shown' ? [builtins.reduce((bits,id,j) => bits | (view.shown.includes(id) ? 1 << j : 0),0), ...view.shown.filter(id => !builtins.includes(id))] : value);
  });
  return [view.version, places, mask, ...fields];
}

export const encodeView = (view: View): EncodedView => encodeFields(view) as EncodedView;
export const encodeFixedView = (view: FixedView) => encodeFields(view) as [4, EncodedFields[1], number, ...unknown[]];
export const encodeUnifiedView = (view: UnifiedView) => encodeFields(view) as [3, EncodedFields[1], number, ...unknown[]];

/** A wire draft has no implicit object fields, duplicate ids or unknown mask bits. */
function decodeFields(input: unknown, version: 3 | 4 | 5): View | FixedView | UnifiedView | null {
  const builtins = version >= 4 ? BUILTIN_WIDGETS : V3_WIDGETS;
  if (!Array.isArray(input) || input[0] !== version || !Array.isArray(input[1]) || !Number.isInteger(input[2]) || input[2] < 0 || input[2] >= 1 << FIELDS.length) return null;
  const places: [string, Place][] = [], seen = new Set<string>();
  for (const tuple of input[1]) {
    if (!Array.isArray(tuple) || tuple.length < 2 || tuple.length > 3) return null;
    const [alias,g,h] = tuple;
    const id = typeof alias === 'number' && Number.isInteger(alias) ? builtins[alias] : alias;
    if (typeof id !== 'string' || !id || id.length > LIMITS.id || seen.has(id) || !Number.isInteger(g) || !GEOMETRY[g as number]) return null;
    if (typeof alias === 'string' && builtins.includes(alias)) return null;
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
      if (!Array.isArray(value) || !Number.isInteger(value[0]) || value[0] < 0 || value[0] >= 1 << builtins.length) return null;
      const other = ids(value.slice(1), LIMITS.widgets + 4);
      if (!other || other.length !== value.length - 1 || other.some(id => builtins.includes(id))) return null;
      value = [...builtins.filter((_,j) => value[0] & 1 << j), ...other];
    }
    fields[FIELDS[i]] = value;
  }
  if (at !== input.length) return null;
  const view = parseFields({...fields,version,layout:{columns:COLUMNS,places:Object.fromEntries(places)}},version) as View | FixedView | UnifiedView | null;
  return view && new TextEncoder().encode(JSON.stringify(view)).byteLength <= (version >= 4 ? VIEW_DECODED_LIMIT : 128 * 1024) ? view : null;
}

export const decodeView = (input: unknown) => decodeFields(input, 5) as View | null;
export const decodeFixedView = (input: unknown) => decodeFields(input, 4) as FixedView | null;
export const decodeUnifiedView = (input: unknown) => decodeFields(input, 3) as UnifiedView | null;

export const viewBytes = (view: View) => new TextEncoder().encode(JSON.stringify(encodeView(view))).byteLength;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => [key,canonical(v)])) : value;
export const sameView = (a: View, b: View) => JSON.stringify(canonical(encodeView(a))) === JSON.stringify(canonical(encodeView(b)));
