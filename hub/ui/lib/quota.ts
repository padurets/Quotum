import type {Kind, SourceState} from './types';
import {PROVIDERS} from './providers';
import {kindOf} from './kind';

export {kindOf};

export type Level = 'ok' | 'warn' | 'crit';

/** Canonical traffic light on the remaining share of a quota. */
export const level = (remaining: number): Level => (remaining < 10 ? 'crit' : remaining <= 30 ? 'warn' : 'ok');

export const KIND_TEXT: Record<Kind, string> = {session: '5 часов', weekly: 'Неделя', other: ''};


/** The model pool a window covers, when the provider splits its quota. */
export function scopeOf(bucket: string, label: string) {
  if (bucket === 'session' || bucket === 'weekly') return '';
  if (/gemini/i.test(bucket)) return 'Gemini';
  if (/-3p-/.test(bucket)) return 'Claude / GPT';
  if (/spark/i.test(bucket)) return 'Spark';
  const scoped = bucket.match(/scoped-([a-z0-9]+)/i);
  if (scoped) return scoped[1][0].toUpperCase() + scoped[1].slice(1);
  return label.replace(/\b(5[- ]hour|weekly|only)\b/gi, '').trim();
}

/** "Неделя" or "Gemini · неделя" — how a window is named inside its own card. */
export function windowName(bucket: string, label: string, minutes: number | null) {
  const kind = kindOf(minutes, label);
  const scope = scopeOf(bucket, label);
  if (kind === 'other') return scope || label;
  return scope ? `${scope} · ${KIND_TEXT[kind].toLowerCase()}` : KIND_TEXT[kind];
}

export const sourceLabel = (source: {provider: string; accountKey: string; title?: string}) =>
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
export function seriesName(source: {provider: string; accountKey: string}, bucket: string, label: string, minutes: number | null) {
  const kind = kindOf(minutes, label);
  const parts = [sourceLabel(source), scopeOf(bucket, label), kind === 'other' ? '' : KIND_TEXT[kind].toLowerCase()];
  return parts.filter(Boolean).join(' · ') || label;
}

export const ERRORS: Record<string, string> = {
  waiting: 'Ждём первое измерение',
  stale_source: 'Источник вернул устаревшие данные',
  identity_changed: 'Сменилась авторизация',
  source_unavailable: 'Источник недоступен',
  provider_unavailable: 'Провайдер не ответил',
  limits_unavailable: 'Лимиты не пришли',
  invalid_response: 'Непонятный ответ источника',
  missing_provider: 'Источник не вернул провайдера',
  agent_not_logged_in: 'Клиент агента не авторизован',
  agent_unsupported: 'Клиент агента не сообщает лимиты',
  agent_timeout: 'Клиент агента не ответил вовремя',
  agent_invalid_output: 'Непонятный ответ клиента агента',
  agent_failed: 'Клиент агента не смог получить лимиты',
};

export const problemOf = (source: SourceState) =>
  source.error && source.error !== 'waiting' ? (ERRORS[source.error] ?? 'Источник недоступен') : null;
