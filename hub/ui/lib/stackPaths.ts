import type {PlotGroup} from './historyPlot';

type GroupPath = {bars: Map<number, Corners>; order: number[]; path: string};

type Corners = {low: number; high: number; top: [string, string]; bottom: [string, string]; topY: string; bottomY: string};

/** Formats only changed bars; its cache holds only the current bounded plot. */
export class StackPaths {
  private geometry = '';
  private groups = new Map<string, GroupPath>();

  draw(groups: readonly {group: PlotGroup}[], origin: number, perMs: number, barMs: number, height: number, max: number) {
    const geometry = `${origin}:${perMs}:${barMs}:${height}:${max}`;
    if (geometry !== this.geometry) {this.geometry = geometry; this.groups.clear();}
    const base = new Map<number, number>();
    const gap = perMs * barMs >= 8 ? .5 : 0;
    const fixed = (value: number) => value.toFixed(1);
    const y = (value: number) => 12 + (1 - value / max) * (height - 40);
    const retained = new Set<string>();
    const paths = groups.map(({group}) => {
      retained.add(group.key);
      let cache = this.groups.get(group.key);
      if (!cache) {cache = {bars: new Map(), order: [], path: ''}; this.groups.set(group.key, cache);}
      const kept = new Set<number>();
      let changed = cache.order.length !== group.cells.length;
      let index = 0;
      for (const [at, ms] of group.cells) {
        kept.add(at);
        const low = base.get(at) ?? 0, high = low + ms;
        base.set(at, high);
        if (cache.order[index++] !== at) changed = true;
        let corners = cache.bars.get(at);
        if (!corners || corners.low !== low || corners.high !== high) {
          const x0 = fixed((at - origin) * perMs + gap), x1 = fixed((at + barMs - origin) * perMs - gap);
          const top = fixed(y(high)), bottom = fixed(y(low));
          corners = {low, high, top: [`${x0},${top}`, `${x1},${top}`], bottom: [`${x0},${bottom}`, `${x1},${bottom}`], topY: top, bottomY: bottom};
          cache.bars.set(at, corners);
          changed = true;
        }
      }
      for (const at of cache.bars.keys()) if (!kept.has(at)) cache.bars.delete(at);
      if (!changed) return cache.path;
      const runs: string[] = [];
      let tops: string[] = [], bottoms: string[] = [], previous: number | null = null;
      let topY: string | null = null, bottomY: string | null = null;
      const finish = () => {
        if (tops.length) runs.push(`M${tops.join('L')}L${bottoms.reverse().join('L')}Z`);
        tops = []; bottoms = []; topY = bottomY = null;
      };
      for (const [at] of group.cells) {
        const corners = cache.bars.get(at)!;
        if (gap || previous !== at - barMs) finish();
        // Equal adjacent heights have one straight boundary, with no extra vertices
        // for the SVG parser. Steps and unread holes retain all their corners.
        if (topY === corners.topY) tops[tops.length - 1] = corners.top[1];
        else tops.push(...corners.top);
        if (bottomY === corners.bottomY) bottoms[bottoms.length - 1] = corners.bottom[1];
        else bottoms.push(...corners.bottom);
        topY = corners.topY; bottomY = corners.bottomY; previous = at;
      }
      finish();
      cache.order = group.cells.map(([at]) => at);
      return cache.path = runs.join('');
    });
    for (const key of this.groups.keys()) if (!retained.has(key)) this.groups.delete(key);
    return paths;
  }
}
