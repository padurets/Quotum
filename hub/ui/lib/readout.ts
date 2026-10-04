import {valueIn, type PlotLine as Line} from './lines';
import type {Coverage} from './historyPlot';
import {PLAN_TOLERANCE} from './plan';

/** The spending plan of one weekly window, drawn as a faint dotted line in its colour; `lines` are the keys of the lines it plans. */
export type PlanLine = {key: string; lines: string[]; color: string; runs: [number, number][][]; until?: number};

/**
 * Where a window leads, drawn from its last value in its line's colour and dash; `key` and
 * `name` are its line's. When the table says it runs out, `zero` is where the line reaches
 * zero (past the right edge, the chart says so there, and stretches to it within reach)
 * and `at` the moment the table says, which the words there tell.
 */
export type ForecastLine = {key: string; name: string; color: string; dash: string; points: [number, number][]; zero: number | null; at: number | null; until?: number};

/**
 * Where the chart stretches to on `auto` for its forecasts: the last zero of a line within
 * `reach`, or 0 for none. The line's zero, not the moment the table says, which moves only
 * past a dead band: the chart shows where the line goes.
 */
export const lastRunOut = (forecasts: Pick<ForecastLine, 'zero'>[], reach: number): number => Math.max(0, ...forecasts.map(f => (f.zero !== null && f.zero <= reach ? f.zero : 0)));

/**
 * The forecasts pointed at from the right edge `to`: those whose line reaches zero past it,
 * each said at the moment the table says (`at`).
 */
export const runOutPast = (forecasts: ForecastLine[], to: number): {key: string; name: string; color: string; at: number}[] =>
  forecasts.flatMap(f => (f.zero === null || f.at === null || f.zero <= to ? [] : [{key: f.key, name: f.name, color: f.color, at: f.at}]));

/**
 * When the chart reads otherwise with nothing new but the time, besides its next cell: a
 * strong marker past its right edge `to` comes due, and a forecast is drawn no more
 * (`until`), wherever it is: past the edge, that is the moment the table says it runs out,
 * which its label there tells.
 */
export const chartMoments = (markers: {at: number; strong?: boolean; past?: boolean}[], drawn: {until: number}[], to: number): number[] => [
  ...markers.filter(m => m.strong && !m.past && m.at > to).map(m => m.at),
  ...drawn.map(d => d.until),
];

/** Value of a piecewise-linear run at time `at`, or undefined outside it. */
export function valueAt(runs: [number, number][][], at: number) {
  for (const run of runs) {
    if (at < run[0][0] || at > run.at(-1)![0]) continue;
    for (let i = 1; i < run.length; i++) {
      const [t0, v0] = run[i - 1];
      const [t1, v1] = run[i];
      if (at <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (at - t0)) / (t1 - t0);
    }
  }
  return undefined;
}

/**
 * A line in the chart's tooltip: what it had left in the cell (`value`, where its point
 * is drawn), and as read, in whole percent: that, its plan and the gap between them
 * (left − plan), so the three always add up; ahead of now, where its pace leads
 * (`forecast`). Null where there is none.
 */
export type ReadoutRow = {line: Line; value: number | null; left: number | null; plan: number | null; gap: number | null; forecast: number | null};

/** The tooltip's columns of values, after each line's swatch and name; none, and it has no grid of lines. */
export type Columns = {left: boolean; plan: boolean; gap: boolean; forecast: boolean};

/**
 * The chart's tooltip over the cell that starts at `cell`: a row for every line drawn, in
 * the legend's order, whether or not it has a value there, so the rows stay put as the
 * pointer moves. A plan is read beside the lines it plans. Up to the cell holding now the
 * columns are what is left, and the plan with the gap when the chart draws a plan
 * somewhere in the period, so they stay put too. In a cell wholly ahead of now
 * a line has no value of its own: its plan, and where its pace leads until its window
 * runs out, each a column only where the cell reads one.
 */
export function readout(lines: Line[], plans: PlanLine[], cell: number, cellMs: number, now: number, to: number, forecasts: ForecastLine[] = [], coverage?: Coverage): {rows: ReadoutRow[]; columns: Columns} {
  const at = Math.min(to, cell + cellMs / 2);
  const rows = lines.map(line => {
    const value = (line.capCells?line.capCells.find(p=>p.at===cell&&cell>=p.from&&cell<p.to)?.value:valueIn(line.points, cell, now, Math.max(cellMs, line.staleAfterMs), coverage)) ?? null;
    const runs = plans.find(plan => plan.lines.includes(line.key))?.runs;
    const planned = runs ? valueAt(runs, at) : undefined;
    const left = value === null ? null : Math.round(value);
    const plan = planned === undefined ? null : Math.round(planned);
    const points = cell > now ? forecasts.find(forecast => forecast.key === line.key)?.points : undefined;
    const foreseen = points?.length ? valueAt([points], at) : undefined;
    // `|| 0`: never a negative zero.
    return {line, value, left, plan, gap: left !== null && plan !== null ? left - plan || 0 : null, forecast: foreseen === undefined ? null : Math.round(foreseen) || 0};
  });
  const planned = plans.some(plan => plan.runs.length > 0);
  const columns =
    cell > now
      ? {left: false, plan: rows.some(row => row.plan !== null), gap: false, forecast: rows.some(row => row.forecast !== null)}
      : {left: true, plan: planned, gap: planned, forecast: false};
  return {rows, columns};
}

/** A gap as it reads: "+7", "−8" with a true minus, "0". */
export const gapText = (gap: number) => (gap > 0 ? `+${gap}` : gap < 0 ? `−${-gap}` : '0');

/** Coloured as the table colours the same number (Forecast.tsx): spent ahead of the plan by a notable margin. */
export const gapTone = (gap: number) => (gap <= -PLAN_TOLERANCE ? 'v-warn' : '');
