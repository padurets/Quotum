import type {CadenceWhy, Card, Kind, Pace} from './types';
import {known, t} from '../i18n';
import {PROVIDERS} from './providers';
import {duration, durationUntilChangesAt} from './format';

export {level, type Level} from '../../server/domain/attention';
export {titled} from '../../server/domain/presentation';

/** A kind inside a longer name: "Gemini · weekly". */
const kindText = (kind: Exclude<Kind, 'other'>) => t(kind === 'session' ? 'kind.session' : 'kind.weekly');
/** A kind on its own: "Weekly". */
const kindTitle = (kind: Exclude<Kind, 'other'>) => t(kind === 'session' ? 'kind.title.session' : 'kind.title.weekly');

/** "Weekly", "Gemini · weekly" or "1h" — how a window is named inside its own card. */
export function windowName(w: {kind: Kind; label: string | null; minutes: number | null}) {
  if (w.kind === 'other') return [w.label, w.minutes ? duration(w.minutes * 60_000) : ''].filter(Boolean).join(' · ');
  return w.label ? `${w.label} · ${kindText(w.kind)}` : kindTitle(w.kind);
}

/** What a card says under a limit about its reset: in how long, that the time has passed, or that it is not known. */
export type ResetLine = {key: 'resetsIn'; inMs: number} | {key: 'resetPassed'} | {key: 'resetUnknown'};

export const resetLine = (w: {resetAt: number | null}, now: number): ResetLine =>
  w.resetAt ? (w.resetAt > now ? {key: 'resetsIn', inMs: w.resetAt - now} : {key: 'resetPassed'}) : {key: 'resetUnknown'};

/** When the line under a limit reads otherwise: the time left, rounded as `duration` rounds it, runs down, or the reset passes. */
export function resetLineChangesAt(w: {resetAt: number | null}, now: number): number | null {
  if (!w.resetAt || w.resetAt <= now) return null;
  return Math.min(w.resetAt, durationUntilChangesAt(w.resetAt, now) ?? w.resetAt);
}

export const sourceLabel = (source: {provider: string; title?: string}) =>
  source.title ?? PROVIDERS[source.provider]?.name ?? source.provider;

/**
 * A series' name in the analytics: the source, and the scope of the window when it has one
 * (Fable, Gemini). Whether the windows are weekly or 5-hour is said once, above them.
 */
export const seriesName = (source: {provider: string; title?: string}, w: {kind: Kind; label: string | null; minutes: number | null}) =>
  [sourceLabel(source), w.kind === 'other' ? windowName(w) : w.label].filter(Boolean).join(' · ');

/** What a source's error code means, in the reader's language. */
export function errorText(code: string) {
  const connector=code.startsWith('connector_'),key=`${connector?'api':'error'}.${code}`;
  return t(known(key)?key:connector?'api.unknown':'error.failed');
}

export const problemOf = (source: Pick<Card, 'error'>) => (source.error && source.error !== 'waiting' ? errorText(source.error) : null);

/** A measurement this recent is news: the card's dot pulses. */
export const PULSE_FOR = 30_000;
/** How long the dot takes to fade from fresh to grey after that. */
export const FADE_FOR = 5 * 60_000;
/** The fade goes in this many steps, one every half a minute: in between, nothing on the page changes. */
const FADE_STEPS = 10;
const FADE_STEP = FADE_FOR / FADE_STEPS;

export type Dot = {warn: true} | {warn: false; pulsing: boolean; fresh: number};

/**
 * The dot by a card's logo: trouble (numbers gone stale, a failure) in its own colour;
 * otherwise from the age of the numbers, pulsing while they are news, then fading (`freshness`).
 */
export function dotOf(source: Pick<Card, 'stale' | 'error' | 'successAt'>, now: number): Dot {
  if (source.stale || problemOf(source)) return {warn: true};
  const age = source.successAt === null ? Infinity : now - source.successAt;
  return {warn: false, pulsing: age < PULSE_FOR, fresh: freshness(age)};
}

/** Within this of the next measurement, or past it, the card says it comes any moment. */
export const SOON = 15_000;

export type Cadence = {when: 'nextIn' | 'nextSoon'; next: number; why: CadenceWhy};

/** A card with the pace the hub sets for it. */
export type Paced = Pick<Card, 'stale' | 'error' | 'successAt'> & {cadence: Pace};

/**
 * When the next measurement comes and why, for the dot's tooltip: while the hub sets the
 * pace. Stale numbers can still have a real future plan.
 */
export function cadenceOf(source: Paced, now: number): Cadence | null {
  if (!source.cadence || problemOf(source)) return null;
  const {next, why} = source.cadence;
  return {when: next - now <= SOON ? 'nextSoon' : 'nextIn', next, why};
}

/** When the dot looks otherwise: it stops pulsing, or fades a step. Trouble does not pass with time: the hub says when it does. */
export function dotChangesAt(source: Pick<Card, 'stale' | 'error' | 'successAt'>, now: number): number | null {
  if (source.stale || problemOf(source) || source.successAt === null) return null;
  const age = now - source.successAt;
  if (age < PULSE_FOR) return source.successAt + PULSE_FOR;
  const step = Math.floor((age - PULSE_FOR) / FADE_STEP) + 1;
  return step > FADE_STEPS ? null : source.successAt + PULSE_FOR + step * FADE_STEP;
}

/** When `cadenceOf` reads otherwise: the next measurement comes within `SOON`. How soon it says is `countdownChangesAt`. */
export function cadenceChangesAt(source: Paced, now: number): number | null {
  const cadence = cadenceOf(source, now);
  return cadence?.when === 'nextIn' ? cadence.next - SOON : null;
}

/**
 * How fresh a source's numbers are, from 1 (just measured) to 0 (a while ago). It only
 * says how old they are, not that anything is wrong: a quiet subscription
 * is measured every quarter of an hour, and that is fine. Trouble has its own colour.
 */
export function freshness(age: number): number {
  if (age <= PULSE_FOR) return 1;
  // Whole steps counted in whole milliseconds: the dot changes exactly when `dotChangesAt` says.
  const left = (FADE_STEPS - Math.floor((age - PULSE_FOR) / FADE_STEP)) / FADE_STEPS;
  return left <= 0 ? 0 : left * left;
}
