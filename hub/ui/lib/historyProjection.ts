import type {Frame} from './periods';
import type {Prefs} from './prefs';

/** Ready future facts are cheap to place in any newly requested time frame. */
export type ProjectionHints = {plan: boolean; forecast: boolean; announced: number | null; zeros: readonly (number | null)[]};

export function historyProjection(frame: Frame, measured: number, prefs: Pick<Prefs, 'horizon' | 'showPlan' | 'showForecast'>, hints: ProjectionHints | null, lookAhead?: number): number {
  if (lookAhead !== undefined) return measured + lookAhead;
  if (!frame.live || !hints || !(hints.plan && prefs.showPlan || hints.forecast && prefs.showForecast)) return measured;
  if (prefs.horizon !== 'auto') return measured + frame.future;
  const reach = measured + (measured - frame.from) * .75;
  let runOut = 0;
  if (hints.forecast && prefs.showForecast) for (const zero of hints.zeros) if (zero !== null && zero <= reach) runOut = Math.max(runOut, zero);
  const announced = hints.announced;
  return Math.max(announced && announced > measured && announced + frame.future * .25 > measured + frame.future ? Math.min(reach, announced + frame.future * .25) : measured + frame.future, runOut);
}
