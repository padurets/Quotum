import type {Kind, SourceState} from './types';
import {known, t} from '../i18n';
import {PROVIDERS} from './providers';
import {duration} from './format';

export type Level = 'ok' | 'warn' | 'crit';

/** Canonical traffic light on the remaining share of a quota. */
export const level = (remaining: number): Level => (remaining < 10 ? 'crit' : remaining <= 30 ? 'warn' : 'ok');

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

export const sourceLabel = (source: {provider: string; title?: string}) =>
  source.title ?? PROVIDERS[source.provider]?.name ?? source.provider;

/**
 * Names every source of a board: the provider, plus whose it is when the board is
 * several people's, plus a number when that still leaves two alike (two accounts of one
 * person). The board's owner can give any card a name of its own instead.
 */
export function titled<T extends {id: string; provider: string; owners?: string[]}>(sources: T[], names: Record<string, string> = {}): (T & {title: string})[] {
  const people = new Set(sources.flatMap(s => s.owners ?? []));
  const automatic = sources.map(source => {
    const name = PROVIDERS[source.provider]?.name ?? source.provider;
    const owners = source.owners ?? [];
    return people.size > 1 && owners.length ? `${name} · ${owners.join(', ')}` : name;
  });
  const seen = new Map<string, number>();
  return sources.map((source, i) => {
    const count = (seen.get(automatic[i]) ?? 0) + 1;
    seen.set(automatic[i], count);
    return {...source, title: names[source.id] ?? (count > 1 ? `${automatic[i]} ${count}` : automatic[i])};
  });
}

/**
 * A series' name in the analytics: the source, and the scope of the window when it has one
 * (Fable, Gemini). Whether the windows are weekly or 5-hour is said once, above them.
 */
export const seriesName = (source: {provider: string; title?: string}, w: {kind: Kind; label: string | null; minutes: number | null}) =>
  [sourceLabel(source), w.kind === 'other' ? windowName(w) : w.label].filter(Boolean).join(' · ');

/** What a source's error code means, in the reader's language. */
export function errorText(code: string) {
  const key = `error.${code}`;
  return t(known(key) ? key : 'error.failed');
}

export const problemOf = (source: SourceState) => (source.error && source.error !== 'waiting' ? errorText(source.error) : null);

/** A measurement this recent is news: the card's dot pulses. */
export const PULSE_FOR = 30_000;
/** How long the dot takes to fade from fresh to grey after that. */
const FADE_FOR = 5 * 60_000;
/** The fade goes in this many steps, one every half a minute: in between, nothing on the page changes. */
const FADE_STEPS = 10;

/**
 * How fresh a source's numbers are, from 1 (just measured) to 0 (a while ago). It only
 * says how old they are, not that anything is wrong: in eco mode a quiet subscription
 * is measured every quarter of an hour, and that is fine. Trouble has its own colour.
 */
export function freshness(age: number): number {
  if (age <= PULSE_FOR) return 1;
  const left = Math.ceil((1 - (age - PULSE_FOR) / FADE_FOR) * FADE_STEPS) / FADE_STEPS;
  return left <= 0 ? 0 : left * left;
}
