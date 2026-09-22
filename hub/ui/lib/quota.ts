import type {Kind, SourceState} from './types';
import {known, t} from '../i18n';
import {PROVIDERS} from './providers';
import {kindOf} from './kind';
import {duration} from './format';

export {kindOf};

export type Level = 'ok' | 'warn' | 'crit';

/** Canonical traffic light on the remaining share of a quota. */
export const level = (remaining: number): Level => (remaining < 10 ? 'crit' : remaining <= 30 ? 'warn' : 'ok');

/** A kind inside a longer name: "Gemini · weekly". */
const kindText = (kind: Exclude<Kind, 'other'>) => t(kind === 'session' ? 'kind.session' : 'kind.weekly');
/** A kind on its own: "Weekly". */
const kindTitle = (kind: Exclude<Kind, 'other'>) => t(kind === 'session' ? 'kind.title.session' : 'kind.title.weekly');

/** The model pool a window covers, when the provider splits its quota. */
export function scopeOf(bucket: string, label: string) {
  if (bucket === 'session' || bucket === 'weekly') return '';
  if (/gemini/i.test(bucket)) return 'Gemini';
  if (/-3p-/.test(bucket)) return 'Claude / GPT';
  if (/spark/i.test(bucket)) return 'Spark';
  const scoped = bucket.match(/scoped-([a-z0-9]+)/i);
  if (scoped) return scoped[1][0].toUpperCase() + scoped[1].slice(1);
  // Labels that only name the window's kind or length are no scope.
  return label.replace(/\b(5[- ]hours?|weekly|only|window|\d+ min)\b/gi, '').trim();
}

/** "Weekly" or "Gemini · weekly" — how a window is named inside its own card. */
export function windowName(bucket: string, label: string, minutes: number | null) {
  const kind = kindOf(minutes, label);
  const scope = scopeOf(bucket, label);
  if (kind === 'other') return scope || (minutes ? duration(minutes * 60_000) : label);
  return scope ? `${scope} · ${kindText(kind)}` : kindTitle(kind);
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

/** Fully qualified series name: source, model pool, window length. */
export function seriesName(source: {provider: string; title?: string}, bucket: string, label: string, minutes: number | null) {
  const kind = kindOf(minutes, label);
  const parts = [sourceLabel(source), scopeOf(bucket, label), kind === 'other' ? '' : kindText(kind)];
  return parts.filter(Boolean).join(' · ') || label;
}

/** What a source's error code means, in the reader's language. */
export function errorText(code: string) {
  const key = `error.${code}`;
  return t(known(key) ? key : 'error.failed');
}

export const problemOf = (source: SourceState) => (source.error && source.error !== 'waiting' ? errorText(source.error) : null);
