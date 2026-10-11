import {migrateAnalytics, reconcileAnalytics, type AnalyticsResources} from './analyticsView.js';
import {ordered, type Place} from './layout.js';
import {VIEW_VERSION, type View} from './view.js';
import {ANALYTICS, WIDGETS, widgetVisible} from './widgets.js';

/** Freeze the old visible sequences before weaving in hidden saved intent. */
export function migrateUnified(input: Parameters<typeof migrateAnalytics>[0] | View, resources: AnalyticsResources): View {
  if (input?.version === VIEW_VERSION) return input;
  const split = reconcileAnalytics(migrateAnalytics(input, resources), resources);
  const cards = [...resources.map(source => 'source:' + source.id), 'agents'];
  const areas = [cards, ANALYTICS];
  const saved = split.layout.places;
  const entries: [string, Place][] = [], used = new Set<string>();
  const compare = ([a,p]: [string,Place], [b,q]: [string,Place]) => p.y - q.y || p.x - q.x || (a < b ? -1 : a > b ? 1 : 0);
  const add = (id: string, place: Place) => {if (!used.has(id)) {used.add(id); entries.push([id,{...place,y:entries.length}]);}};
  for (const [i,ids] of areas.entries()) {
    const visible = ids.filter(id => widgetVisible(split, id, resources.length));
    const sequence = ordered(split.layout, visible);
    const hidden = Object.entries(saved).filter(([id]) => !visible.includes(id) && (i === 0 ? id.startsWith('source:') || id === 'agents' : ANALYTICS.includes(id))).sort(compare);
    const before = new Map<string, [string,Place][]>(), tail: [string,Place][] = [];
    for (const entry of hidden) {
      const next = Object.entries(saved).filter(([id]) => visible.includes(id) && compare(entry,[id,saved[id]]) < 0).sort(compare)[0];
      if (next) {const list = before.get(next[0]) ?? []; list.push(entry); before.set(next[0],list);}
      else tail.push(entry);
    }
    for (const item of sequence) {
      for (const [id,p] of before.get(item.id) ?? []) add(id,p);
      // Sources with no chosen place still follow their natural source neighbour.
      if (saved[item.id] || (WIDGETS as readonly string[]).includes(item.id)) add(item.id,saved[item.id] ?? {x:item.x,w:item.w,y:0});
    }
    for (const [id,p] of tail) add(id,p);
  }
  for (const [id,p] of Object.entries(saved).filter(([id]) => !used.has(id)).sort(compare)) add(id,p);
  return {...split,version:VIEW_VERSION,layout:{columns:6,places:Object.fromEntries(entries)}};
}
