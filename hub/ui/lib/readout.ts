import {valueIn, type Line} from './lines';
import {PLAN_TOLERANCE} from './plan';

/** The spending plan of one weekly window, drawn as a faint dotted line in its colour; `lines` are the keys of the lines it plans. */
export type PlanLine = {key: string; lines: string[]; color: string; runs: [number, number][][]};

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
 * (left − plan), so the three always add up. Null where there is none.
 */
export type ReadoutRow = {line: Line; value: number | null; left: number | null; plan: number | null; gap: number | null};

/**
 * The chart's tooltip over the cell that starts at `cell`: a row for every line drawn, in
 * the legend's order, whether or not it has a value there, so the rows stay put as the
 * pointer moves. A plan is read beside the lines it plans, and its columns are there when
 * the chart draws a plan somewhere in the period (`planned`).
 */
export function readout(lines: Line[], plans: PlanLine[], cell: number, cellMs: number, now: number, to: number): {rows: ReadoutRow[]; planned: boolean} {
  const at = Math.min(to, cell + cellMs / 2);
  const rows = lines.map(line => {
    const value = valueIn(line.points, cell, now, Math.max(cellMs, line.staleAfterMs)) ?? null;
    const runs = plans.find(plan => plan.lines.includes(line.key))?.runs;
    const planned = runs ? valueAt(runs, at) : undefined;
    const left = value === null ? null : Math.round(value);
    const plan = planned === undefined ? null : Math.round(planned);
    // `|| 0`: never a negative zero.
    return {line, value, left, plan, gap: left !== null && plan !== null ? left - plan || 0 : null};
  });
  return {rows, planned: plans.some(plan => plan.runs.length > 0)};
}

/** A gap as it reads: "+7", "−8" with a true minus, "0". */
export const gapText = (gap: number) => (gap > 0 ? `+${gap}` : gap < 0 ? `−${-gap}` : '0');

/** Coloured as the table colours the same number (Forecast.tsx): spent ahead of the plan by a notable margin. */
export const gapTone = (gap: number) => (gap <= -PLAN_TOLERANCE ? 'v-warn' : '');
