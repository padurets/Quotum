export const PERIODS = ['24h', '30d'] as const;
export const PAN_INITIATORS = ['quota', 'session', 'activity', 'budget', 'funds'] as const;
export const ACTIVITY_CASES = ['emphasis', 'historical gesture and Back preparation', 'isolated', 'burst before dispatch', 'news during response', 'cancelled A to B to A', 'through upper bound', 'outside range'] as const;
const activityKeys = ['emphasis', 'historical-gesture', 'isolated', 'burst', 'news-during-response', 'cancelled-a-b-a', 'upper-bound', 'outside-range'] as const;
export type Suite = 'updates' | 'panning' | 'history';
export const BENCH_SCOPES = ['all','history','dashboard','updates','panning'] as const;
export type BenchScope = typeof BENCH_SCOPES[number];
type Period = typeof PERIODS[number];
type Day = '1d' | '30d';
type Cohort = `${Day}/${'history' | 'activity'}/${0 | 100 | 400}ms/${'0.5' | '0.04'}`;
export type ScenarioId =
  | 'updates/idle' | 'updates/retirement-before' | 'updates/retirement-after'
  | `updates/quota/${number}` | `updates/work/${'ordinary' | 'observed' | 'private'}` | 'updates/frequency'
  | `updates/credits/${number}` | `updates/wallet/${number}` | 'updates/wallet-heartbeat' | 'updates/inventory' | 'updates/currencies' | 'updates/linked-wallet' | 'updates/money-view'
  | `updates/activity/${Period}/${typeof activityKeys[number] | 'pool'}`
  | `updates/disclosure/${'en' | 'ru'}/${390 | 900}/${'fresh' | 'stale' | 'missing' | 'live'}`
  | `panning/${typeof PAN_INITIATORS[number]}/${Period}`
  | `history/controlled/${Cohort}` | `history/browser/${Cohort}/${'all-accounting' | 'quota' | 'budget' | 'funds'}`
  | `history/cancel/controlled/${Day}/${'before-headers' | 'during-staging' | 'reversal'}`
  | `history/cancel/browser/${Day}/${'before-headers' | 'after-delivery' | 'reversal'}`;

type Requirement = {scenarioId: ScenarioId; suite: Suite; minimumSamples: number};
const row = (scenarioId: ScenarioId, suite: Suite, minimumSamples = 1): Requirement => ({scenarioId, suite, minimumSamples});
/** These requirements describe the workload, independently of the reports it happens to return. */
export const REQUIRED_COVERAGE: readonly Requirement[] = [
  ...(['idle', 'retirement-before', 'retirement-after'] as const).map(id => row(`updates/${id}`, 'updates')),
  ...Array.from({length: 20}, (_, i) => row(`updates/quota/${i + 1}`, 'updates')),
  ...(['ordinary', 'observed', 'private'] as const).map(id => row(`updates/work/${id}`, 'updates', 3)),
  row('updates/frequency', 'updates'),
  ...Array.from({length: 4}, (_, i) => row(`updates/credits/${i + 1}`, 'updates')),
  ...Array.from({length: 6}, (_, i) => row(`updates/wallet/${i + 1}`, 'updates')),
  ...(['wallet-heartbeat', 'inventory', 'currencies', 'linked-wallet', 'money-view'] as const).map(id => row(`updates/${id}`, 'updates', id === 'linked-wallet' ? 3 : 1)),
  ...PERIODS.flatMap(period => [...activityKeys, 'pool' as const].map(key => row(`updates/activity/${period}/${key}`, 'updates'))),
  ...(['en', 'ru'] as const).flatMap(locale => ([390, 900] as const).flatMap(width => (['fresh', 'stale', 'missing', 'live'] as const).map(status => row(`updates/disclosure/${locale}/${width}/${status}`, 'updates')))),
  ...PAN_INITIATORS.flatMap(initiator => PERIODS.map(period => row(`panning/${initiator}/${period}`, 'panning', 30))),
  ...(['1d', '30d'] as const).flatMap(day => (['history', 'activity'] as const).flatMap(kind => ([0, 100, 400] as const).flatMap(delay => (['0.5', '0.04'] as const).flatMap(fraction => {
    const cohort: Cohort = `${day}/${kind}/${delay}ms/${fraction}`;
    return [row(`history/controlled/${cohort}`, 'history'), ...(['all-accounting', 'quota', 'budget', 'funds'] as const).map(family => row(`history/browser/${cohort}/${family}`, 'history'))];
  })))),
  ...(['1d', '30d'] as const).flatMap(day => [
    ...(['before-headers', 'during-staging', 'reversal'] as const).map(mode => row(`history/cancel/controlled/${day}/${mode}`, 'history')),
    ...(['before-headers', 'after-delivery', 'reversal'] as const).map(mode => row(`history/cancel/browser/${day}/${mode}`, 'history')),
  ]),
];
export const SCENARIO_IDS = new Set<string>(REQUIRED_COVERAGE.map(row => row.scenarioId));
export function suitesFor(scope: BenchScope): readonly Suite[] {return scope === 'all' ? ['history', 'updates', 'panning'] : scope === 'dashboard' ? ['updates', 'panning'] : [scope];}
export function activityScenario(period: Period, name: typeof ACTIVITY_CASES[number]): ScenarioId {return `updates/activity/${period}/${activityKeys[ACTIVITY_CASES.indexOf(name)]}`;}

export type CoverageSummary = ReturnType<Coverage['summary']>;
/** Call only after the checker and its postconditions, including owned cleanup, have returned. */
export class Coverage {
  private stopped = false;
  private readonly expected: readonly Requirement[];
  private readonly observed: {scenarioId: ScenarioId; outcome: 'passed' | 'failed'; samples: number}[] = [];
  constructor(readonly scope: BenchScope, private readonly diagnostic = false, private readonly save?: (value: CoverageSummary, classification?: 'budget' | 'coverage') => void) {
    this.expected = REQUIRED_COVERAGE.filter(row => suitesFor(scope).includes(row.suite));
  }
  record(scenarioId: ScenarioId, problems: readonly unknown[] = [], samples = 1) {
    const requirement = this.expected.find(row => row.scenarioId === scenarioId);
    if (!requirement) throw Error('Unexpected benchmark coverage scenario');
    const classification = problems.length ? 'budget' : !Number.isInteger(samples) || samples < requirement.minimumSamples || this.observed.some(row => row.scenarioId === scenarioId) ? 'coverage' : undefined;
    this.observed.push({scenarioId, outcome: classification ? 'failed' : 'passed', samples});
    this.save?.(this.summary(), classification);
  }
  stop() {this.stopped = true;this.save?.(this.summary());}
  summary() {
    const expected = this.expected.map(row => row.scenarioId);
    const missing = expected.filter(id => !this.observed.some(row => row.scenarioId === id));
    const duplicates = expected.filter(id => this.observed.filter(row => row.scenarioId === id).length > 1);
    const incomplete = this.observed.filter(row => row.outcome !== 'passed').map(row => row.scenarioId);
    return {schemaVersion: 1, scope: this.scope, diagnostic: this.diagnostic, status: !this.stopped && !this.diagnostic && !missing.length && !duplicates.length && !incomplete.length ? 'passed' as const : 'incomplete' as const,
      expected, observed: [...this.observed], missing, duplicates, incomplete};
  }
}

/** Attempt numbers are bounded invalidations, never part of a terminal scenario identity. */
export function historyScenario(name: string): ScenarioId {
  let match = /^(browser\/)?((?:1|30)d\/(?:history|activity)\/(?:0|100|400)ms\/(?:0\.5|0\.04))\/take[1-3](?:\/(all-accounting|quota|budget|funds))?$/.exec(name);
  if (match && (!!match[1] === !!match[3])) return `history/${match[1] ? 'browser' : 'controlled'}/${match[2]}${match[3] ? '/' + match[3] : ''}` as ScenarioId;
  match = /^(controlled|browser)\/((?:1|30)d)\/(before-headers|during-staging|after-delivery|reversal)\/take[1-3]$/.exec(name);
  const id = match && `history/cancel/${match[1]}/${match[2]}/${match[3]}`;
  if (id && SCENARIO_IDS.has(id)) return id as ScenarioId;
  throw Error('Unknown benchmark history scenario');
}
