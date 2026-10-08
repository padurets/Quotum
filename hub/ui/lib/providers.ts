import {catalogue} from '../../server/domain/providers';

/**
 * Identity colours come from the provider catalogue. Status colours stay in the
 * shared UI tokens, independently of a provider's branding.
 * Their logos are in components/logos.ts.
 */
export const PROVIDERS: Record<string, {name: string; color: string}> = Object.fromEntries(catalogue.map(p => [p.id, {name: p.name, color: p.color}]));

export const hasSubscriptionCaps=(id:string)=>catalogue.some(p=>p.id===id&&'quotaMeters' in p&&p.quotaMeters.length>0);

/** The colour of a series whose provider has none. */
export const FALLBACK_COLOR = '#8b90b5';

/**
 * Colours a board's owner can give cards, so subscriptions of one provider can be told
 * apart: a few hues, each in five steps of OKLCH lightness from light to dark, the
 * middle one the hue itself (Codex's blue and Claude's orange among them). The hues are
 * clear of the status ones and tell apart on the dark chart surface; a fifth, Antigravity's
 * pink, would be too close to the purple. Every step keeps 3:1 contrast with the surface.
 */
export const MIDDLE_STEP = 2;
export const CARD_COLORS: string[][] = [
  ['#b1ccfe', '#88b1ff', '#6897f0', '#5481d9', '#406bc1'],
  ['#7ae0d4', '#5fc6ba', '#43aca1', '#27968c', '#008077'],
  ['#ffa8fa', '#e48fdf', '#c976c5', '#b261ae', '#9b4c98'],
  ['#febaa4', '#fa9473', '#de7b5b', '#c66646', '#af5031'],
  ['#d5d9ec', '#bbbfd2', '#a2a6b8', '#8c91a2', '#787c8d'],
];

/** Windows of one source are distinguished by dash pattern within its colour. */
export const DASHES = ['', '7 5', '2 4', '10 3 2 3'];

/**
 * Colours of projects and machines on the activity widget, by their rank in the period:
 * first hues no provider has (teal, violet, lime), then the rest. Every one stands clear
 * of the status colours (ΔE2000 at least 20 from --ok, --warn and --crit) and of the
 * providers' own (14), 17 at least from each other and from the neutral of the rest
 * (--other in style.css), and keeps 3:1 contrast with the surface; ui/test/activity.test.ts
 * checks all of it.
 */
export const CATEGORY_COLORS = ['#67cfe3', '#cd93ff', '#75a322', '#0593bf', '#97854b', '#3f8f7f', '#eab0d1'];
