import {hourShift} from '../server/forecasts.js';
import type {Snapshot} from '../server/projection.js';
import {FADE_FOR, PULSE_FOR} from '../ui/lib/quota.js';

const HOUR = 3_600_000;

/**
 * What the benchmark reads of a card to tell whether the board stands still, with its
 * forecasts by window, which `/api/overview` keeps beside the cards rather than in them
 * (`stillCards`). None when the card has no weekly window.
 */
export type StillCard = {id: string; successAt: number | null; staleAfterMs: number | null; windows: {resetAt: number | null}[]; forecast: Record<string, {asOf: number}> | undefined};

/** The cards of `/api/overview`, each with its forecasts. */
export const stillCards = (overview: Pick<Snapshot, 'sources' | 'forecast'>): StillCard[] =>
  overview.sources.map(card => ({...card, forecast: overview.forecast[card.id]}));

/**
 * A moment this close to the window counts as in it: the hub works forecasts out when its
 * timer fires, a little after the moment, and the window's ends are read a little apart.
 */
export const MARGIN_MS = 5_000;

/** After the page opens, it settles for at least this long before anything is counted. */
export const SETTLE_MS = 30_000;
/** A card's dot stops changing this long after its last measurement: it pulsed and faded out (ui/lib/quota.ts), with some to spare. */
export const DOT_STILL_AFTER = PULSE_FOR + FADE_FOR + 30_000;

/** When the page may be counted: every dot has faded out, and it has been open `SETTLE_MS`. */
export function warmUntil(cards: StillCard[], opened: number): number {
  const last = Math.max(0, ...cards.map(card => card.successAt ?? 0));
  return Math.max(last + DOT_STILL_AFTER, opened + SETTLE_MS);
}

/**
 * When the hub works a card's forecasts out again by itself: at the card's own hour after
 * a measurement they have not taken in (server/forecasts.ts), or never.
 */
export function foreseenAt(card: StillCard): number | null {
  const behind = Object.values(card.forecast ?? {})
    .map(f => f.asOf)
    .filter(asOf => card.successAt !== null && card.successAt > asOf);
  return behind.length ? Math.floor(Math.min(...behind) / HOUR) * HOUR + HOUR + hourShift(card.id) : null;
}

/**
 * Where a window of `length` may begin, at `from` or later, with no card's forecasts
 * worked out again in it or within `MARGIN_MS` of it: past each such moment by
 * `SETTLE_MS`. A still hub works them out once more at most, up to ten minutes past the hour.
 */
export function stillFrom(cards: StillCard[], from: number, length: number): number {
  let begin = from;
  const moments = cards.map(foreseenAt).filter((at): at is number => at !== null);
  for (const at of moments.sort((a, b) => a - b)) if (at >= begin - MARGIN_MS && at <= begin + length + MARGIN_MS) begin = at + SETTLE_MS;
  return begin;
}

/**
 * What would change on the board by itself during `[from, to]`, when it should change
 * only with the clock: a card going stale, a dot still fading, a limit resetting, its
 * forecasts worked out again. The benchmark stops on any of these: its numbers would not
 * be of a still board.
 */
export function stillProblems(cards: StillCard[], from: number, to: number): string[] {
  const within = (at: number) => at >= from && at <= to;
  const found: string[] = [];
  for (const card of cards) {
    if (card.successAt === null) continue;
    if (card.staleAfterMs !== null && within(card.successAt + card.staleAfterMs)) found.push(`${card.id} goes stale`);
    // The dot changes from the measurement until it has faded out: any of that within the window.
    if (card.successAt <= to && card.successAt + PULSE_FOR + FADE_FOR >= from) found.push(`${card.id}'s dot still fades`);
    if (card.windows.some(w => w.resetAt !== null && within(w.resetAt))) found.push(`${card.id} has a limit that resets`);
    const foreseen = foreseenAt(card);
    if (foreseen !== null && foreseen >= from - MARGIN_MS && foreseen <= to + MARGIN_MS) found.push(`${card.id} has its forecasts worked out again`);
  }
  return found;
}
