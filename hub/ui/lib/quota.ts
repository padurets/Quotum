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

export const sourceLabel = (source: {provider: string; title?: string}) =>
  source.title ?? PROVIDERS[source.provider]?.name ?? source.provider;

/**
 * Names every source of a board: the provider, plus whose it is when that is not
 * obvious — several accounts of one provider, or a board of several people.
 */
export function titled<T extends {provider: string; owners?: string[]}>(sources: T[]): (T & {title: string})[] {
  const people = new Set(sources.flatMap(s => s.owners ?? []));
  return sources.map(source => {
    const name = PROVIDERS[source.provider]?.name ?? source.provider;
    const siblings = sources.filter(s => s.provider === source.provider).length;
    const owners = source.owners ?? [];
    const whose = (people.size > 1 || siblings > 1) && owners.length ? ` · ${owners.join(', ')}` : '';
    return {...source, title: name + whose};
  });
}

/** Fully qualified series name: source, then the window. */
export const seriesName = (source: {provider: string; title?: string}, w: {kind: Kind; label: string | null; minutes: number | null}) =>
  `${sourceLabel(source)} · ${w.kind === 'other' ? windowName(w) : [w.label, kindText(w.kind)].filter(Boolean).join(' · ')}`;

/** What a source's error code means, in the reader's language. */
export function errorText(code: string) {
  const key = `error.${code}`;
  return t(known(key) ? key : 'error.failed');
}

export const problemOf = (source: SourceState) => (source.error && source.error !== 'waiting' ? errorText(source.error) : null);
