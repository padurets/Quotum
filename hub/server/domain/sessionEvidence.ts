import type {SessionRoute} from './ingest.js';

export type AccountBy = 'login' | 'inferred' | 'legacy';
export type SessionEvidence = {accountBy?: AccountBy | null; route?: SessionRoute | null};
const strength = {legacy: 1, inferred: 2, login: 3};

/** Attribution evidence strengthens a context; conflicting route evidence stays unknown. */
export function mergeEvidence(before: SessionEvidence, next: SessionEvidence): {accountBy: AccountBy | null; route: SessionRoute | null} {
  const accountBy = (next.accountBy ? strength[next.accountBy] : 0) > (before.accountBy ? strength[before.accountBy] : 0) ? next.accountBy! : before.accountBy ?? null;
  let route = before.route ?? null;
  if (next.route) {
    if (!route || (next.route.by === 'session' && route.by === 'machine')) route = next.route;
    else if (route.by === next.route.by) {
      if (route.class !== next.route.class || route.provider !== next.route.provider) route = {class: 'unknown', by: route.by, host: null, provider: null};
      else if (route.host !== next.route.host) route = {...route, host: null};
    }
  }
  return {accountBy, route};
}
