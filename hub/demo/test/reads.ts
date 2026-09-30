import {fromClaudeResets, fromCodexResets} from '../../server/domain/resets.js';
import {outlook, outlookText, type Context} from '../../ui/lib/forecast.js';
import type {Resets} from '../../ui/lib/resets.js';
import type {ForecastBasis, SeriesForecast, Win} from '../../ui/lib/types.js';
import {SCENES} from '../catalogue.js';
import {HOLDS, HOUR, MIN, spanOf, type Card, type DemoSet, type Machine, type Scene, type Span} from '../model.js';

/** How often the tests measure: a minute at first and on the sleeping machine, then up to five (eco: its quarter of an hour). */
export const cadence = (card: Card, machine: Machine, t: number) => (card.eco ? 15 * MIN : machine.sleeps || t < 30 * MIN ? MIN : 5 * MIN);

/** Where the tests look: every hour, and where every code's span begins, is halfway and ends. */
export function points(set: DemoSet): number[] {
  const found = Array.from({length: HOLDS / HOUR + 1}, (_, hour) => hour * HOUR);
  for (const entry of [...set.entries, ...SCENES]) {
    for (const check of entry.expect as Span[]) {
      const {from, to} = spanOf(entry, check);
      found.push(from, (from + to) / 2, to);
    }
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/**
 * Where a window leads, in the codes of `CardCheck`, as the table's cell puts it
 * (components/Forecast.tsx): its outlook, the tone and the unit of the countdown when it
 * runs out, whether a burst marks it, whether it goes by under a day of history, and why
 * there is none yet.
 */
export function forecastCodes(live: Win, measuredAt: number | null, now: number, ahead: SeriesForecast | null, context: Context) {
  const said = outlook(live, measuredAt, now, ahead, context);
  const basis = ahead?.basis && 'cold' in ahead.basis ? (ahead.basis as ForecastBasis) : null;
  return {
    outlook: said.key,
    tone: said.tone,
    unit: said.key === 'runsOut' ? (said.inMs < HOUR ? 'm' : said.inMs < 48 * HOUR ? 'h' : 'd') : undefined,
    burst: outlookText(said, live, ahead, context, null).burst,
    cold: basis?.cold,
    why: said.key === 'needData' ? said.why : undefined,
  };
}

/** What a hub answers of resets for everyone at `now`, its trackers telling what `scene` has them tell. */
export function resetsOf(scene: Scene, start: number, now: number): Resets {
  const at = (t: number) => new Date(start + t).toISOString();
  const [codex, claude] = [scene.codex(at), scene.claude(at)];
  const resets: Record<string, unknown> = {};
  if (typeof claude === 'object' && 'json' in claude) Object.assign(resets, {claude: fromClaudeResets(claude.json, 'claude'), codex: fromClaudeResets(claude.json, 'codex')});
  if (typeof codex === 'object' && 'json' in codex) resets.codex = fromCodexResets(codex.json, now);
  return resets as Resets;
}
