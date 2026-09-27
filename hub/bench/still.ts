import {FADE_FOR, PULSE_FOR} from '../ui/lib/quota.js';

/** What the benchmark reads of a card in `/api/overview` to tell whether the board stands still. */
export type StillCard = {id: string; successAt: number | null; staleAfterMs: number | null; windows: {resetAt: number | null}[]};

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
 * What would change on the board by itself during `[from, to]`, when it should change
 * only with the clock: a card going stale, a dot still fading, a limit resetting. The
 * benchmark stops on any of these: its numbers would not be of a still board.
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
  }
  return found;
}
