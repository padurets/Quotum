import type {SessionRoute} from './ingest.js';
import type {AccountBy} from './sessionEvidence.js';
import {catalogue, providerOf} from './providers.js';

export type LinkRoute = {class: SessionRoute['class']; provider: string | null};
export type ClientLink = {id: string; clientId: string; deviceId: string | null; route: LinkRoute | null; sourceId: string; from: number; to: number | null; createdAt: number};
export type LinkInput = Omit<ClientLink, 'id' | 'createdAt'>;
export type Attribution = {source: string | null; by: 'link' | 'account' | 'none'; active: boolean; route: LinkRoute | null; linkId?: string; otherGateway?: boolean; disagreement?: 'account' | 'provider' | 'subscription'; accountBy: AccountBy | null};
export type LinkContext = {links: readonly ClientLink[]; held: ReadonlyMap<string, string>; routeEnabled: boolean};
export type AttributionInput = {clientId: string; deviceId: string; source: string | null; route?: SessionRoute | null; accountBy?: AccountBy | null};

/** Only catalogue endpoints and session evidence identify a provider. */
export function safeRoute(raw: SessionRoute | null | undefined, enabled = true): {route: LinkRoute | null; otherGateway: boolean} {
  if (!enabled || !raw) return {route: null, otherGateway: false};
  if (raw.by !== 'session') return {route: {class: raw.class, provider: null}, otherGateway: false};
  const named = raw.provider && providerOf(raw.provider) ? raw.provider : null;
  const host = catalogue.find(p => 'routeHosts' in p && (p.routeHosts as readonly string[]).includes(raw.host ?? ''))?.id ?? null;
  const provider = named && host && named !== host ? null : named ?? host;
  return {route: {class: raw.class, provider}, otherGateway: !!(raw.provider && !named || raw.host && !host)};
}

export function matches(link: ClientLink, input: AttributionInput, route: LinkRoute | null, at: number): boolean {
  return link.clientId === input.clientId && (link.deviceId === null || link.deviceId === input.deviceId)
    && link.from <= at && (link.to === null || at < link.to)
    && (link.route === null || route !== null && link.route.class === route.class && (link.route.provider === null || link.route.provider === route.provider));
}

/** Device scope precedes condition specificity; an inactive winner still decides. */
export function resolveLink(input: AttributionInput, context: LinkContext, at: number): Attribution {
  return resolve(input, context, at, safeRoute(input.route, context.routeEnabled));
}

function resolve(input: AttributionInput, context: LinkContext, at: number, {route, otherGateway}: ReturnType<typeof safeRoute>): Attribution {
  let winner: ClientLink | undefined, rank = -1;
  for (const link of context.links) {
    if (!matches(link, input, route, at)) continue;
    const candidate = (link.deviceId === null ? 0 : 3) + (link.route === null ? 0 : link.route.provider === null ? 1 : 2);
    if (candidate > rank) {winner = link; rank = candidate;}
    else if (candidate === rank) throw new Error('ambiguous_links');
  }
  const base = {route, accountBy: input.accountBy ?? null, ...(otherGateway ? {otherGateway: true} : {})};
  if (winner) {
    const active = context.held.has(winner.sourceId), provider = context.held.get(winner.sourceId);
    const native = providerOf(provider ?? '');
    const disagreement = input.source && input.source !== winner.sourceId ? 'account'
      : route?.provider && provider && route.provider !== provider ? 'provider'
      : route?.class === 'api' && native && 'clientId' in native && native.clientId === input.clientId ? 'subscription' : undefined;
    return {...base, source: active ? winner.sourceId : null, by: 'link', active, linkId: winner.id, ...(disagreement ? {disagreement} : {})};
  }
  const source = route?.class === 'api' || route?.class === 'unknown' ? null : input.source;
  const held = source !== null && context.held.has(source);
  return {...base, source: held ? source : null, by: held ? 'account' : 'none', active: held};
}

/** Display cuts leave the raw ledger and its distinct agent identity untouched. */
export function splitLinks(input: AttributionInput, context: LinkContext, from: number, to: number, reserve?:(bytes:number)=>void): {source: string | null; from: number; to: number}[] {
  const evidence = safeRoute(input.route, context.routeEnabled), {route} = evidence;
  // Scope and route cannot change within a retained context. Select their rules
  // once rather than testing unrelated conditions again at every time boundary.
  const links = context.links.filter(link => link.clientId === input.clientId && (link.deviceId === null || link.deviceId === input.deviceId)
    && (link.route === null || route !== null && link.route.class === route.class && (link.route.provider === null || link.route.provider === route.provider)));
  const selected = {...context, links};
  const bounds = new Set([from, to]);
  for (const link of links) {
    if (link.from > from && link.from < to) bounds.add(link.from);
    if (link.to !== null && link.to > from && link.to < to) bounds.add(link.to);
  }
  const times = [...bounds].sort((a, b) => a - b), result: {source: string | null; from: number; to: number}[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const source = resolve(input, selected, times[i], evidence).source, last = result.at(-1);
    if (last && last.source === source) last.to = times[i + 1];
    else {reserve?.(192);result.push({source, from: times[i], to: times[i + 1]});}
  }
  return result;
}

export function suggestion(input: AttributionInput, context: LinkContext, now: number, startedAt: number): LinkInput | null {
  const result = resolveLink(input, context, now);
  if (result.by === 'link' || result.route?.class !== 'api' || !result.route.provider) return null;
  const sources = [...context.held].filter(([, provider]) => provider === result.route!.provider);
  if (sources.length !== 1) return null;
  let from = Math.max(0, Math.min(startedAt, now)), to: number | null = null;
  for (const link of context.links) {
    if (link.clientId !== input.clientId || link.deviceId !== input.deviceId || link.route?.class !== result.route.class || link.route.provider !== result.route.provider) continue;
    if (link.to !== null && link.to <= now) from = Math.max(from, link.to);
    if (link.from > now) to = to === null ? link.from : Math.min(to, link.from);
  }
  return {clientId: input.clientId, deviceId: input.deviceId, route: result.route, sourceId: sources[0][0], from, to};
}
