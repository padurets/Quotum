import {drain, type Preparation} from './prepare';
import type {PlotGroup} from './historyPlot';

type GroupPath = {bars: Map<number, Corners>; order: number[]; path: string; dirty: boolean};

type Corners = {low: number; high: number; top: [string, string]; bottom: [string, string]; topY: string; bottomY: string};

/** Formats only changed bars; its cache holds only the current bounded plot. */
export class StackPaths {
  private geometry = '';
  private groups = new Map<string, GroupPath>();

  *drawPrepared(groups: readonly {group: PlotGroup}[], origin: number, perMs: number, barMs: number, height: number, max: number): Preparation<string[]> {
    const geometry = `${origin}:${perMs}:${barMs}:${height}:${max}`;
    if (geometry !== this.geometry) {this.geometry = geometry; this.groups.clear();}
    const base = new Map<number, {value: number; edge?: [string, string]; y?: string}>();
    const gap = perMs * barMs >= 8 ? .5 : 0;
    const fixed = (value: number) => value.toFixed(1);
    const y = (value: number) => 12 + (1 - value / max) * (height - 40);
    const positions = new Map<number, [string, string]>();
    const levels = new Map<number, string>();
    const position = (at: number) => {
      let pair = positions.get(at);
      if (!pair) {pair = [fixed((at - origin) * perMs + gap), fixed((at + barMs - origin) * perMs - gap)]; positions.set(at, pair);}
      return pair;
    };
    const level = (value: number) => {
      let text = levels.get(value);
      // Whole cells repeat a few levels; varied values need no growing format cache.
      if (text === undefined) {text = fixed(y(value)); if (levels.size < 128) levels.set(value, text);}
      return text;
    };
    const retained = new Set<string>();
    for (const {group} of groups) {retained.add(group.key); yield;}
    for (const key of this.groups.keys()) {if (!retained.has(key)) this.groups.delete(key); yield;}
    const paths: string[] = [];
    for (const {group} of groups) {
      let cache = this.groups.get(group.key);
      if (!cache) {cache = {bars: new Map(), order: [], path: '', dirty: true}; this.groups.set(group.key, cache);}
      const kept = new Set<number>();
      cache.dirty ||= cache.order.length !== group.cells.length;
      let index = 0;
      for (const [at, ms] of group.cells) {
        yield;
        kept.add(at);
        let state = base.get(at);
        if (!state) {state = {value: 0}; base.set(at, state);}
        const low = state.value, high = low + ms;
        state.value = high;
        if (cache.order[index++] !== at) cache.dirty = true;
        let corners = cache.bars.get(at);
        if (!corners || corners.low !== low || corners.high !== high) {
          const [x0, x1] = position(at);
          const top = level(high), bottom = state.y ?? level(low);
          // The preceding group's top is this group's bottom at the same bar.
          corners = {low, high, top: [`${x0},${top}`, `${x1},${top}`], bottom: state.edge ?? [`${x0},${bottom}`, `${x1},${bottom}`], topY: top, bottomY: bottom};
          cache.bars.set(at, corners);
          cache.dirty = true;
        }
        state.edge = corners.top; state.y = corners.topY;
      }
      for (const at of cache.bars.keys()) {if (!kept.has(at)) {cache.dirty = true; cache.bars.delete(at);} yield;}
      if (!cache.dirty) {paths.push(cache.path); continue;}
      const runs: string[] = [];
      let tops: string[] = [], bottoms: string[] = [], previous: number | null = null;
      let topY: string | null = null, bottomY: string | null = null;
      const finish = function* (): Preparation<void> {
        if (tops.length) {
          let run = 'M';
          for (let i = 0; i < tops.length; i++) {run += `${i ? 'L' : ''}${tops[i]}`; yield;}
          for (let i = bottoms.length - 1; i >= 0; i--) {run += `L${bottoms[i]}`; yield;}
          runs.push(`${run}Z`);
        }
        tops = []; bottoms = []; topY = bottomY = null;
      };
      for (const [at] of group.cells) {
        yield;
        const corners = cache.bars.get(at)!;
        if (gap || previous !== at - barMs) yield* finish();
        // Equal adjacent heights have one straight boundary, with no extra vertices
        // for the SVG parser. Steps and unread holes retain all their corners.
        if (topY === corners.topY) tops[tops.length - 1] = corners.top[1];
        else tops.push(...corners.top);
        if (bottomY === corners.bottomY) bottoms[bottoms.length - 1] = corners.bottom[1];
        else bottoms.push(...corners.bottom);
        topY = corners.topY; bottomY = corners.bottomY; previous = at;
      }
      yield* finish();
      const order: number[] = [];
      for (const [at] of group.cells) {order.push(at); yield;}
      let path = '';
      for (const run of runs) {path += run; yield;}
      cache.order = order; cache.path = path; cache.dirty = false;
      paths.push(path);
    }
    return paths;
  }
  draw(...args: Parameters<StackPaths['drawPrepared']>): string[] {return drain(this.drawPrepared(...args));}
}
