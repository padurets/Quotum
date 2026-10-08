import {legacyLayout, ordered} from './layout.js';
import {EMPTY_VIEW, type View} from './view.js';
import {providerOf, supportsBudget, supportsQuota} from './providers.js';
import {ACTIVITY, QUOTA_HISTORY, QUOTA_TABLE, BUDGET_HISTORY, BUDGET_TABLE, QUOTA_WIDGETS, BUDGET_WIDGETS, showWidgets} from './widgets.js';

export type AnalyticsResources = {id: string; provider: string}[];
type LegacyView = Omit<View, 'version' | 'layout'> & {version?: 1; layout?: View['layout']};
const families = (resources: AnalyticsResources) => ({quota: resources.some(s => supportsQuota(providerOf(s.provider))), budget: resources.some(s => supportsBudget(providerOf(s.provider)))});
const legacyIds = ['history', 'forecast'];

/** The server applies defaults once; hidden and placed widgets never depend on a reader. */
export function reconcileAnalytics(view: View, resources: AnalyticsResources): View {
  const {quota, budget} = families(resources);
  const add = [...(quota ? QUOTA_WIDGETS : []), ...(budget ? BUDGET_WIDGETS : [])].filter(id => !view.shown.includes(id) && !view.hidden.includes(id));
  if (!add.length) return view;
  const next = showWidgets(view, add), places = {...view.layout.places};
  // Existing anchors keep their coordinates. Newly applicable panels use free trailing rows.
  let y = Math.max(-1, ...Object.entries(places).filter(([id]) => !id.startsWith('source:') && id !== 'agents').map(([,p]) => p.y)) + 1;
  for (const id of add) if (!places[id]) places[id] = {x: 0, y: y++, w: 6};
  return {...next, layout: {...view.layout, places}};
}

export function legacyWidgetTargets(id: string, resources: AnalyticsResources, emptyExplicit = false): string[] {
  if (!legacyIds.includes(id)) return [id];
  const {quota, budget} = families(resources), chart = id === 'history';
  return [...(quota || emptyExplicit ? [chart ? QUOTA_HISTORY : QUOTA_TABLE] : []), ...(budget || emptyExplicit ? [chart ? BUDGET_HISTORY : BUDGET_TABLE] : [])];
}

/** Lossless, deterministic conversion; neither local modes nor current values are inputs. */
export function migrateAnalytics(input: Partial<LegacyView> | View | undefined, resources: AnalyticsResources): View {
  if (input?.version === 2) return input as View;
  if (input?.version !== undefined && input.version !== 1) throw new Error('Unsupported board view version');
  const old = {...EMPTY_VIEW, ...input} as LegacyView;
  const areas = {cards: [...resources.map(s => 'source:' + s.id), 'agents'], analytics: [ACTIVITY, ...legacyIds]};
  const normalized = legacyLayout(old, areas, [...old.hidden, ...(old.shown.includes('agents') ? [] : ['agents'])]);
  const places = {...normalized.layout.places};
  // Materialize the previous reading order before adding a second analytics family.
  const previous = ordered(normalized.layout, areas.analytics);
  let cursor = 0;
  for (const item of previous) {
    if (!places[item.id]) places[item.id] = {x: item.x, w: item.w, y: cursor};
    cursor = places[item.id].y + 1;
  }
  let end = Math.max(-1, ...Object.entries(places).filter(([id]) => !id.startsWith('source:') && id !== 'agents').map(([,p]) => p.y)) + 1;
  const {quota, budget} = families(resources);
  const hidden = old.hidden.filter(id => !legacyIds.includes(id)), shown = old.shown.filter(id => !legacyIds.includes(id));
  const columns = {...old.columns}, shownColumns = {...old.shownColumns};
  for (const legacy of legacyIds) {
    const chart = legacy === 'history', q = chart ? QUOTA_HISTORY : QUOTA_TABLE, b = chart ? BUDGET_HISTORY : BUDGET_TABLE;
    const explicit = !resources.length && !!old.enabledWhenEmpty?.includes(legacy);
    const inherited = budget && !quota ? b : q;
    places[inherited] = places[legacy]; delete places[legacy];
    const targets = legacyWidgetTargets(legacy, resources, explicit);
    if (old.hidden.includes(legacy)) hidden.push(q, b);
    else shown.push(...targets);
    for (const id of targets) if (!places[id]) places[id] = {x: 0, y: end++, w: 6};
    for (const map of [columns, shownColumns]) {
      const tokens = map[legacy]; delete map[legacy];
      if (!tokens) continue;
      if (chart) {map[q] = tokens; continue;}
      const money = new Set(['value', 'spending', 'topup']);
      const quotas = tokens.filter(c => !money.has(c)), budgets = tokens.filter(c => money.has(c));
      if (quotas.length) map[q] = quotas;
      if (budgets.length) map[b] = budgets;
    }
  }
  return {...normalized, version: 2, layout: {...normalized.layout, places}, hidden: [...new Set(hidden)], shown: [...new Set(shown)], columns, shownColumns,
    enabledWhenEmpty: (old.enabledWhenEmpty ?? []).filter(id => id === 'agents' || id === ACTIVITY)};
}
