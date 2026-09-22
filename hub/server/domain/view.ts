import {isValidPlan} from './plan.js';

/**
 * How a board is arranged: the order of its widgets (a card per source, and the history
 * chart), the hidden widgets, the windows hidden inside cards, and the weekly spending
 * plan per source. The owner arranges it and everyone on the board sees it this way.
 * Nothing here changes what is measured or stored.
 */
export type View = {
  /** Widget ids in order: `source:<id>` and `history`; widgets missing here come last. */
  order: string[];
  hidden: string[];
  /** `<source id>/<window id>` of windows hidden from cards and the chart. */
  windows: string[];
  plans: Record<string, number[]>;
};

export const EMPTY_VIEW: View = {order: [], hidden: [], windows: [], plans: {}};

const LIMITS = {widgets: 200, windows: 500, id: 120};

const ids = (value: unknown, max: number): string[] | null =>
  Array.isArray(value) && value.length <= max && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id)
    ? [...new Set(value as string[])]
    : null;

/** A view as a page sent it, or null when anything in it is off. */
export function parseView(body: unknown): View | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  const order = ids(input.order ?? [], LIMITS.widgets);
  const hidden = ids(input.hidden ?? [], LIMITS.widgets);
  const windows = ids(input.windows ?? [], LIMITS.windows);
  const plans = input.plans ?? {};
  if (!order || !hidden || !windows || !plans || typeof plans !== 'object' || Array.isArray(plans)) return null;
  const entries = Object.entries(plans as Record<string, unknown>);
  if (entries.length > LIMITS.widgets || entries.some(([id, plan]) => id.length > LIMITS.id || !isValidPlan(plan))) return null;
  return {order, hidden, windows, plans: Object.fromEntries(entries) as Record<string, number[]>};
}
