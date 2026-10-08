import type {View} from './view.js';

export const AGENTS = 'agents', ACTIVITY = 'activity';
export const QUOTA_HISTORY = 'quota-history', BUDGET_HISTORY = 'budget-history';
export const QUOTA_TABLE = 'quota-table', BUDGET_TABLE = 'budget-table';
export const QUOTA_WIDGETS = [QUOTA_HISTORY, QUOTA_TABLE] as const;
export const BUDGET_WIDGETS = [BUDGET_HISTORY, BUDGET_TABLE] as const;
export const ANALYTICS = [ACTIVITY, QUOTA_HISTORY, BUDGET_HISTORY, QUOTA_TABLE, BUDGET_TABLE];
export const WIDGETS = [AGENTS, ACTIVITY, QUOTA_HISTORY, BUDGET_HISTORY, QUOTA_TABLE, BUDGET_TABLE] as const;
export type WidgetId = typeof AGENTS | typeof ACTIVITY | typeof QUOTA_WIDGETS[number] | typeof BUDGET_WIDGETS[number];
export const splitWidget = (id: string) => [...QUOTA_WIDGETS, ...BUDGET_WIDGETS].includes(id as typeof QUOTA_WIDGETS[number] | typeof BUDGET_WIDGETS[number]);
export const widgetHidden = (view: View, id: string) => view.hidden.includes(id) || ((id === AGENTS || splitWidget(id)) && !view.shown.includes(id));
export const widgetVisible = (view: View, id: string, sources: number) => !widgetHidden(view, id) && (splitWidget(id) || sources > 0 || (view.enabledWhenEmpty ?? []).includes(id));

/** Explicit placement stays after the last source or selected series disappears. */
export function showWidgets(view: View, ids: string[]): View {
  return {...view, hidden: view.hidden.filter(id => !ids.includes(id)),
    shown: [...new Set([...view.shown, ...ids.filter(id => id === AGENTS || splitWidget(id))])],
    enabledWhenEmpty: [...new Set([...(view.enabledWhenEmpty ?? []), ...ids.filter(id => id === AGENTS || id === ACTIVITY)])]};
}
