import type {View} from './view.js';

export const AGENTS = 'agents', ACTIVITY = 'activity';
export const QUOTA_HISTORY = 'quota-history', BUDGET_HISTORY = 'budget-history';
export const SUBSCRIPTION_FUNDS = 'subscription-funds';
export const QUOTA_TABLE = 'quota-table', BUDGET_TABLE = 'budget-table';
export const QUOTA_SESSION_HISTORY = 'quota-session-history', QUOTA_SESSION_TABLE = 'quota-session-table';
// The earlier migrations retain the released catalogue and its default order.
export const LEGACY_QUOTA_WIDGETS = [QUOTA_HISTORY, QUOTA_TABLE] as const;
export const LEGACY_BUDGET_WIDGETS = [BUDGET_HISTORY, BUDGET_TABLE] as const;
export const LEGACY_ANALYTICS = [ACTIVITY, QUOTA_HISTORY, SUBSCRIPTION_FUNDS, BUDGET_HISTORY, QUOTA_TABLE, BUDGET_TABLE];
export const LEGACY_WIDGETS = [AGENTS, ...LEGACY_ANALYTICS];
export const QUOTA_WIDGETS = [QUOTA_SESSION_HISTORY, QUOTA_SESSION_TABLE, ...LEGACY_QUOTA_WIDGETS] as const;
export const BUDGET_WIDGETS = LEGACY_BUDGET_WIDGETS;
export const ANALYTICS = [ACTIVITY, ...QUOTA_WIDGETS, SUBSCRIPTION_FUNDS, ...BUDGET_WIDGETS];
export const WIDGETS = [AGENTS, ACTIVITY, QUOTA_SESSION_HISTORY, QUOTA_SESSION_TABLE, QUOTA_HISTORY, QUOTA_TABLE, SUBSCRIPTION_FUNDS, BUDGET_HISTORY, BUDGET_TABLE] as const;
export type WidgetId = typeof WIDGETS[number];
export const splitWidget = (id: string) => id === SUBSCRIPTION_FUNDS || [...QUOTA_WIDGETS, ...BUDGET_WIDGETS].includes(id as typeof QUOTA_WIDGETS[number] | typeof BUDGET_WIDGETS[number]);
export const widgetHidden = (view: Omit<View,'version'>, id: string) => view.hidden.includes(id) || ((id === AGENTS || splitWidget(id)) && !view.shown.includes(id));
export const widgetVisible = (view: Omit<View,'version'>, id: string, sources: number) => (id.startsWith('source:') || WIDGETS.includes(id as WidgetId)) && !widgetHidden(view, id) && (splitWidget(id) || sources > 0 || (view.enabledWhenEmpty ?? []).includes(id));

/** Explicit placement stays after the last source or selected series disappears. */
export function showWidgets<T extends Omit<View, 'version'>>(view: T, ids: string[]): T {
  return {...view, hidden: view.hidden.filter(id => !ids.includes(id)),
    shown: [...new Set([...view.shown, ...ids.filter(id => id === AGENTS || splitWidget(id))])],
    enabledWhenEmpty: [...new Set([...(view.enabledWhenEmpty ?? []), ...ids.filter(id => id === AGENTS || id === ACTIVITY)])]};
}
