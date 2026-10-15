import {EMPTY_VIEW, type UnifiedView, type View, type Place} from './view.js';
import {reconcileAnalytics, type AnalyticsResources} from './analyticsView.js';
import {QUOTA_HISTORY, QUOTA_TABLE, QUOTA_SESSION_HISTORY, QUOTA_SESSION_TABLE} from './widgets.js';

const siblings = new Map([
  [QUOTA_HISTORY, QUOTA_SESSION_HISTORY], [QUOTA_TABLE, QUOTA_SESSION_TABLE],
]);

/** A reader's old modes never determine the owner's fixed widget layout. */
export function migrateFixed(input: UnifiedView | View | undefined, resources: AnalyticsResources): View {
  if (!input) return reconcileAnalytics({...EMPTY_VIEW, layout:{columns:6,places:{}}}, resources);
  if (input.version === 4) return input;
  const hidden = new Set(input.hidden), shown = new Set(input.shown);
  const entries: [string, Place][] = [];
  for (const [id, place] of Object.entries(input.layout.places).sort(([a,p],[b,q]) => p.y-q.y || p.x-q.x || a.localeCompare(b))) {
    entries.push([id, {...place, y:entries.length}]);
    const sibling = siblings.get(id);
    if (sibling && !input.layout.places[sibling]) entries.push([sibling, {...place,y:entries.length}]);
  }
  const columns = {...input.columns}, shownColumns = {...input.shownColumns};
  for (const [id, sibling] of siblings) {
    if (input.hidden.includes(id)) hidden.add(sibling);
    if (input.shown.includes(id)) shown.add(sibling);
    if (id === QUOTA_TABLE) {
      for (const map of [columns, shownColumns]) if (map[id] && !map[sibling]) map[sibling] = [...map[id]];
    }
  }
  return {...input,version:4,layout:{columns:6,places:Object.fromEntries(entries)},hidden:[...hidden],shown:[...shown],columns,shownColumns};
}

export const fixedWidgetTargets = (ids: readonly string[]) => [...new Set(ids.flatMap(id => siblings.has(id) ? [id, siblings.get(id)!] : [id]))];
