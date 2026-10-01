import {catalogue} from './providers.js';

/** Identity and visibility shared by the board and its background reader. */
export const providerNames: Record<string, string> = Object.fromEntries(catalogue.map(p => [p.id, p.name]));
export const cardId = (source: string) => `source:${source}`;
export const windowKey = (source: string, window: string) => `${source}/${window}`;
export const isWindowHidden = (view: {windows: string[]}, source: string, window: string) => view.windows.includes(windowKey(source, window));
export const sourceHidden = (view: {hidden: string[]}, source: string) => view.hidden.includes(cardId(source));

export function titled<T extends {id: string; provider: string; owners?: string[]}>(sources: T[], names: Record<string, string> = {}): (T & {title: string})[] {
  const people = new Set(sources.flatMap(s => s.owners ?? []));
  const automatic = sources.map(source => {
    const name = providerNames[source.provider] ?? source.provider;
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
