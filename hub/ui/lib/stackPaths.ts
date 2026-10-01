import type {PlotGroup} from './historyPlot';

type Corners = {low: number; high: number; top: string; bottom: string};

/** Formats only changed bars; its cache holds only the current bounded plot. */
export class StackPaths {
  private geometry = '';
  private groups = new Map<string, Map<number, Corners>>();

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
      if (!cache) {cache = new Map(); this.groups.set(group.key, cache);}
      const kept = new Set<number>();
      const runs: string[] = [];
      let tops: string[] = [], bottoms: string[] = [], previous: number | null = null;
      const finish = () => {
        if (tops.length) runs.push(`M${tops.join('L')}L${bottoms.reverse().join('L')}Z`);
        tops = []; bottoms = [];
      };
      for (const [at, ms] of group.cells) {
        kept.add(at);
        const low = base.get(at) ?? 0, high = low + ms;
        base.set(at, high);
        let corners = cache.get(at);
        if (!corners || corners.low !== low || corners.high !== high) {
          const x0 = fixed((at - origin) * perMs + gap), x1 = fixed((at + barMs - origin) * perMs - gap);
          const top = fixed(y(high)), bottom = fixed(y(low));
          corners = {low, high, top: `${x0},${top}L${x1},${top}`, bottom: `${x1},${bottom}L${x0},${bottom}`};
          cache.set(at, corners);
        }
        if (gap || previous !== at - barMs) finish();
        tops.push(corners.top); bottoms.push(corners.bottom); previous = at;
      }
      finish();
      for (const at of cache.keys()) if (!kept.has(at)) cache.delete(at);
      return runs.join('');
    });
    for (const key of this.groups.keys()) if (!retained.has(key)) this.groups.delete(key);
    return paths;
  }
}
