import {isValidPlan} from './plan.js';

/**
 * How a board is arranged: the order of its widgets (a card per source, the history
 * chart and the table), how wide each is, the names given to cards, the hidden widgets,
 * the windows hidden inside cards, and the weekly spending plan per source. The owner
 * arranges it and everyone on the board sees it this way. Nothing here changes what is
 * measured or stored.
 */
export type View = {
  /** Widget ids in order: `source:<id>`, `history`, `forecast`; widgets missing here come after. */
  order: string[];
  /** Columns of the twelve a widget spans, where not its default. */
  sizes: Record<string, number>;
  /** Card names the board's owner gave, by source id, instead of the automatic one. */
  names: Record<string, string>;
  hidden: string[];
  /** `<source id>/<window id>` of windows hidden from cards and the chart. */
  windows: string[];
  plans: Record<string, number[]>;
};

export const EMPTY_VIEW: View = {order: [], sizes: {}, names: {}, hidden: [], windows: [], plans: {}};

/** The grid has twelve columns; a widget spans a quarter of it at least. */
export const COLUMNS = 12;
export const MIN_SPAN = 3;
const LIMITS = {widgets: 200, windows: 500, id: 120, name: 60};

const ids = (value: unknown, max: number): string[] | null =>
  Array.isArray(value) && value.length <= max && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id)
    ? [...new Set(value as string[])]
    : null;

/** A map by widget or source id whose every value passes `valid`; null when anything is off. */
function byId<T>(value: unknown, valid: (entry: unknown) => entry is T): Record<string, T> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > LIMITS.widgets || entries.some(([id, entry]) => !id || id.length > LIMITS.id || !valid(entry))) return null;
  return Object.fromEntries(entries) as Record<string, T>;
}

const isSpan = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= MIN_SPAN && (value as number) <= COLUMNS;
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= LIMITS.name;

/** A view as a page sent it, or null when anything in it is off. */
export function parseView(body: unknown): View | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  const order = ids(input.order ?? [], LIMITS.widgets);
  const hidden = ids(input.hidden ?? [], LIMITS.widgets);
  const windows = ids(input.windows ?? [], LIMITS.windows);
  const sizes = byId(input.sizes, isSpan);
  const names = byId(input.names, isName);
  const plans = byId(input.plans, isValidPlan);
  if (!order || !hidden || !windows || !sizes || !names || !plans) return null;
  return {order, sizes, names, hidden, windows, plans};
}
