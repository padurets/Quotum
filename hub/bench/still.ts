import {hourShift} from '../server/forecasts.js';
import type {Snapshot} from '../server/projection.js';
import {FADE_FOR, PULSE_FOR} from '../ui/lib/quota.js';
import {snapshot, DAY, MIN, type Card} from '../demo/model.js';
import {STILL_FOR} from '../demo/setup.js';
import {cellOf} from '../server/domain/history.js';

const HOUR = 3_600_000;
const IDLE_CHARTS = ['quota-history', 'quota-session-history', 'activity', 'budget-history', 'subscription-funds'] as const;
const QUOTA_LEAD_MS = 50_000;

/** Keep regular quota retirement and a later grid transition inside the existing duration. */
export function idleWindow(readyAt: number, seconds: number, cellMs: number) {
  const duration = seconds * 1000;
  const minute = 60_000, margin = 5_000;
  if (!Number.isFinite(readyAt) || !Number.isFinite(cellMs) || !Number.isFinite(duration) || cellMs <= 0 || duration <= 0 || duration > cellMs) throw new Error('invalid idle phase');
  if (duration < minute + 2 * margin || cellMs % minute !== 0) throw new Error('unsupported idle phase');
  // A fixed midpoint can skip a complete eligible window and wait almost a whole cell.
  let boundary = Math.ceil((readyAt + margin) / cellMs) * cellMs;
  for (;;) {
    let from = Math.max(readyAt, boundary - duration + margin);
    for (;;) {
      const phases = [from, from + duration].map(at => ((at % minute) + minute) % minute);
      const unsafe = phases.find(phase => phase < margin || phase > minute - margin);
      if (unsafe === undefined) break;
      from += unsafe < margin ? margin - unsafe : minute + margin - unsafe;
    }
    if (from <= boundary - QUOTA_LEAD_MS - margin) return {from, to: from + duration, boundary, quotaBoundary: boundary - QUOTA_LEAD_MS + 1, cellMs, expectedTransitions: 1};
    boundary += cellMs;
  }
}

export type IdlePhase = {from: number; to: number; monotonicFrom: number; monotonicTo: number; cellMs: number; starts: number[]; ends: number[]; transitions: number[]};
export function idlePhaseProblems(phase: IdlePhase, boundary: number, quotaBoundary?: number): string[] {
  const errors: string[] = [];
  if (!(phase.from < boundary && boundary < phase.to) || Math.floor(phase.to / phase.cellMs) - Math.floor(phase.from / phase.cellMs) !== 1) errors.push('idle phase did not span exactly one grid boundary');
  if (quotaBoundary !== undefined && !(phase.from < quotaBoundary && quotaBoundary < phase.to)) errors.push('idle phase did not include regular quota retirement before the grid boundary');
  if (Math.abs((phase.to - phase.from) - (phase.monotonicTo - phase.monotonicFrom)) > 1000) errors.push('idle phase clock changed during measurement');
  if (phase.transitions.length !== IDLE_CHARTS.length || phase.transitions.some(count => count !== 1)) errors.push('idle phase did not observe one transition in each chart');
  if (phase.starts.length !== IDLE_CHARTS.length || phase.ends.length !== IDLE_CHARTS.length || phase.starts.some(value => value !== Math.floor(phase.from / phase.cellMs)) || phase.ends.some(value => value !== Math.floor(phase.to / phase.cellMs))) errors.push('idle chart grid disagrees with the measurement clock');
  return errors;
}

/** Observe production axis changes; no timer or artificial clock drives the page. */
export function idlePhaseScript(cellMs: number): string {
  return `(() => {
    const axes = ${JSON.stringify(IDLE_CHARTS)}.map(widget => document.querySelector('[data-widget="'+widget+'"] [data-axis-end]'));
    if(axes.some(axis=>!axis))throw new Error('idle phase requires all five chart axes');
    const cell = axis => Math.floor(Number(axis.dataset.axisEnd)/${cellMs});
    const starts=axes.map(cell),last=[...starts],transitions=axes.map(()=>0);
    const from=Date.now(),monotonicFrom=performance.now();
    const observer=new MutationObserver(()=>{axes.forEach((axis,i)=>{const next=cell(axis);if(next!==last[i]){transitions[i]++;last[i]=next;}});});
    for(const axis of axes)observer.observe(axis,{attributes:true,attributeFilter:['data-axis-end']});
    window.__quotumIdlePhase={read:()=>({from,to:Date.now(),monotonicFrom,monotonicTo:performance.now(),cellMs:${cellMs},starts,ends:axes.map(cell),transitions:[...transitions]}),stop:()=>observer.disconnect()};
  })()`;
}

/** Later measurements keep the seeded still stand's deadline, so they cannot expire in another phase. */
export function stillSnapshot(card: Card, start: number, observedAt: number) {
  const t = observedAt - start;
  return {...snapshot(card, start, t, STILL_FOR), staleAfterMs: STILL_FOR - t};
}

/**
 * What the benchmark reads of a card to tell whether the board stands still, with its
 * forecasts by window, which `/api/overview` keeps beside the cards rather than in them
 * (`overviewCards`); empty or none when the card has no weekly window.
 */
type StillCard = {id: string; successAt: number | null; staleAfterMs: number | null; windows: {resetAt: number | null}[]; forecast: Record<string, {asOf: number}> | undefined};

/** A board's cards as `/api/overview` tells them (`get` asks the hub), each with its forecasts. */
export async function overviewCards(get: (path: string) => Promise<Snapshot>, board: string): Promise<(StillCard & Snapshot['sources'][number])[]> {
  const {sources, forecast} = await get(`/api/overview?board=${encodeURIComponent(board)}`);
  return sources.map(card => ({...card, forecast: forecast[card.id]}));
}

/**
 * A moment this close to the window counts as in it: the hub works forecasts out when its
 * timer fires, a little after the moment, and the window's ends are read a little apart.
 */
export const MARGIN_MS = 5_000;

/** After the page opens, it settles for at least this long before anything is counted. */
export const SETTLE_MS = 30_000;
/** A card's dot stops changing this long after its last measurement: it pulsed and faded out (ui/lib/quota.ts), with some to spare. */
export const DOT_STILL_AFTER = PULSE_FOR + FADE_FOR + 30_000;

/** Separate quota retirement from the axis while admitting the original warm deadline. */
export function fixtureTiming(now:number) {
  const seededAt=Math.floor(now/MIN)*MIN,cell=cellOf(DAY);
  return {start:Math.floor((now+QUOTA_LEAD_MS)/cell)*cell-QUOTA_LEAD_MS,warmAt:seededAt+DOT_STILL_AFTER};
}

/** When the page may be counted: every dot has faded out, and it has been open `SETTLE_MS`. */
export function warmUntil(cards: StillCard[], opened: number): number {
  const last = Math.max(0, ...cards.map(card => card.successAt ?? 0));
  return Math.max(last + DOT_STILL_AFTER, opened + SETTLE_MS);
}

/**
 * When the hub works a card's forecasts out again by itself: at the card's own hour after
 * a measurement they have not taken in (server/forecasts.ts), or never. A still hub has
 * taken in every one since its first forecasts, which stand on the latest: never there.
 */
export function foreseenAt(card: StillCard): number | null {
  const behind = Object.values(card.forecast ?? {})
    .map(f => f.asOf)
    .filter(asOf => card.successAt !== null && card.successAt > asOf);
  return behind.length ? Math.floor(Math.min(...behind) / HOUR) * HOUR + HOUR + hourShift(card.id) : null;
}

/** Qualify the interval before measurement, including the forecast timer's grace. */
export function quietAfter(cards:StillCard[],from:number,to:number) {
  const resets=cards.flatMap(card=>card.windows.map(window=>window.resetAt)).filter((at):at is number=>at!==null&&at>=from&&at<=to);
  const forecasts=cards.map(foreseenAt).filter((at):at is number=>at!==null&&at>=from-MARGIN_MS&&at<=to+MARGIN_MS);
  return resets.length||forecasts.length?{resets,forecasts,until:Math.max(...resets,...forecasts)+MARGIN_MS+1}:null;
}

/**
 * What would change on the board by itself during `[from, to]`, when it should change
 * only with the clock: a card going stale, a dot still fading, a limit resetting, its
 * forecasts worked out again. The benchmark stops on any of these: its numbers would not
 * be of a still board.
 * A measured card may restart its own dot; its quota and forecast deadlines still apply.
 * Credit updates may admit dot clocks, bounded by their per-update render checks.
 */
export function stillProblems(cards: StillCard[], from: number, to: number, fadingCard?: string, {allowDotClock=false}: {allowDotClock?:boolean}={}): string[] {
  const within = (at: number) => at >= from && at <= to;
  const found: string[] = [];
  for (const card of cards) {
    if (card.successAt === null) continue;
    if (card.staleAfterMs !== null && within(card.successAt + card.staleAfterMs)) found.push(`${card.id} goes stale`);
    // The dot changes from the measurement until it has faded out: any of that within the window.
    if (!allowDotClock && card.id !== fadingCard && card.successAt <= to && card.successAt + PULSE_FOR + FADE_FOR >= from) found.push(`${card.id}'s dot still fades`);
    if (card.windows.some(w => w.resetAt !== null && within(w.resetAt))) found.push(`${card.id} has a limit that resets`);
    const foreseen = foreseenAt(card);
    if (foreseen !== null && foreseen >= from - MARGIN_MS && foreseen <= to + MARGIN_MS) found.push(`${card.id} has its forecasts worked out again`);
  }
  return found;
}
