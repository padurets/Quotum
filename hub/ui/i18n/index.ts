import {createElement, Fragment, useSyncExternalStore, type ReactNode} from 'react';
import {en} from './en';
import {ru} from './ru';
import type {Message} from './types';

export type {Message};
export type Key = keyof typeof en;
/** A translation: every key of the English catalog, no more and no less. */
export type Catalog = Record<Key, Message>;

/**
 * The languages of the dashboard. Adding one takes a catalog file next to `en.ts`
 * and a line here; `npm test` checks that it translates every key with the same
 * placeholders and has the plural forms its language needs.
 */
export const LOCALES = {
  en: {name: 'English', catalog: en as Catalog},
  ru: {name: 'Русский', catalog: ru as Catalog},
} satisfies Record<string, {name: string; catalog: Catalog}>;

export type Locale = keyof typeof LOCALES;

const STORAGE_KEY = 'quotum.locale';
const isLocale = (value: unknown): value is Locale => typeof value === 'string' && Object.hasOwn(LOCALES, value);
const browserTags = (): readonly string[] => (typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]));

/** The language chosen in this browser, else the first supported one it prefers, else English. */
function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* no storage: fall back to the browser's languages */
  }
  const preferred = browserTags()
    .map(tag => tag.toLowerCase().split('-')[0])
    .find(isLocale);
  return preferred ?? 'en';
}

let locale: Locale = detect();
let plurals = new Intl.PluralRules(locale);
const listeners = new Set<() => void>();

/**
 * Dates and numbers follow the browser's own variant of the chosen language when it
 * has one (en-GB gets a 24-hour clock), else the language itself.
 */
export const formatLocale = () => browserTags().find(tag => tag.toLowerCase().split('-')[0] === locale) ?? locale;

function apply() {
  plurals = new Intl.PluralRules(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}
apply();

export function setLocale(next: Locale) {
  locale = next;
  apply();
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice lasts until the tab closes */
  }
  for (const listener of listeners) listener();
}

/** The current language; a component that calls it re-renders when the language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => locale,
    () => locale,
  );
}

type Params = Record<string, string | number>;

function pick(message: Message, count: unknown): string {
  if (typeof message === 'string') return message;
  return (typeof count === 'number' ? message[plurals.select(count)] : undefined) ?? message.other;
}

function fill(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : placeholder));
}

const lookup = (key: Key) => LOCALES[locale].catalog[key] ?? en[key];

/** The text of a message in the current language, with its placeholders filled in. */
export function t(key: Key, params?: Params): string {
  return fill(pick(lookup(key), params?.count), params);
}

/** Like `t`, for messages with elements inside (links, code): `{name}` placeholders take nodes. */
export function rich(key: Key, nodes: Record<string, ReactNode>, params?: Params): ReactNode[] {
  return fill(pick(lookup(key), params?.count), params)
    .split(/\{(\w+)\}/g)
    .map((piece, i) => (i % 2 ? createElement(Fragment, {key: i}, nodes[piece] ?? `{${piece}}`) : piece));
}

/** Whether a key built at run time (from an error code, say) has a message. */
export const known = (key: string): key is Key => Object.hasOwn(en, key);
