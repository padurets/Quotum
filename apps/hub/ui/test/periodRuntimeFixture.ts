import {plotTarget, plotBar} from '../lib/historyPlot';
import {targetOf} from '../../server/domain/history';
import {workChange} from '../lib/workChanges';
import {projectColorBindings} from './projectColorBindings';
import * as periodValueClockBindings from '../../server/domain/periodValues';
import {WorkCalendar} from '../lib/workCalendar';
import {AGENT_HOURS_HEATMAP} from '../../server/domain/widgets';
import * as filterModelBindings from '../../server/domain/dataFilters';
import * as filterRuntimeBindings from '../lib/filterSelection';
import * as filterCurveBindings from '../../server/domain/periodCurves';
import * as retention from '../../server/domain/periodRetention';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodTransport, type PeriodIntent} from '../lib/periodTransport';
import type {boardPeriod} from '../lib/period';

type SafeBag = Record<string, any>;
type NonNullMap<K, V> = Omit<Map<K, V>, 'get'> & {get(key: K): V};
export type FixtureTransport = Omit<PeriodTransport, never> & {
  receive: (...args: any[]) => any;
  send: (...args: any[]) => Promise<PeriodReply>;
  adopt: (...args: any[]) => Promise<boolean>;
  flights: Set<SafeBag>;
  queue: SafeBag[];
  cursors: NonNullMap<string, string>;
  metadata: NonNullMap<string, SafeBag>;
  baselineParts: Set<string>;
  baselineKey: string;
  completed: string;
  failed: string;
  resetEpoch: number;
};
export type FixturePeriod = Omit<
  typeof boardPeriod,
  | 'get'
  | 'getValue'
  | 'getFacets'
  | 'calendar'
  | 'transport'
  | 'captureActivity'
  | 'retainActivity'
  | 'activityValid'
  | 'quotaAt'
  | 'quotaSpendingAt'
  | 'quotaOrderAt'
  | 'moneyAt'
  | 'moneyWorkAt'
  | 'rangeAt'
  | 'projectionState'
  | 'projectionChangesAt'
  | 'activityProjectionState'
  | 'activityAt'
  | 'activityRangeAt'
  | 'activitySummaryAt'
  | 'activityFrameAt'
  | 'project'
  | 'refreshWorkClock'
  | 'subscribeProjection'
> & {
  get: () => {
    value: Omit<NonNullable<ReturnType<(typeof boardPeriod)['get']>['value']>, 'packed'> & {
      packed: NonNullable<NonNullable<ReturnType<(typeof boardPeriod)['get']>['value']>['packed']>;
    } & SafeBag;
    basis: PeriodReply['basis'] & SafeBag;
    rows: any[];
    loading: boolean;
    error: string | null;
    evidence: number;
  };
  getValue: (...args: any[]) => {
    value: NonNullable<ReturnType<(typeof boardPeriod)['getValue']>['value']> & SafeBag;
    basis: PeriodReply['basis'] & SafeBag;
    loading: boolean;
    error: string | null;
  };
  getFacets: () => {value: SafeBag; loading: boolean; error: string | null};
  calendar: WorkCalendar;
  transport: FixtureTransport;
  refreshWorkClock: () => any;
  subscribeProjection: (...args: any[]) => () => void;
  projectionChangesAt: (...args: any[]) => number | null;
  activityRangeAt: (...args: any[]) => {from: number; to: number};
  captureActivity: (
    ...args: any[]
  ) => NonNullable<ReturnType<(typeof boardPeriod)['captureActivity']>>;
  retainActivity: (...args: any[]) => ReturnType<(typeof boardPeriod)['retainActivity']>;
  activityValid: (...args: any[]) => boolean;
  quotaAt: (...args: any[]) => Omit<
    ReturnType<(typeof boardPeriod)['quotaAt']>,
    'selectedWork' | 'work' | 'current' | 'resetAt'
  > & {
    selectedWork: {ms: number; agentMs: number; from: number} & SafeBag;
    work: NonNullable<ReturnType<(typeof boardPeriod)['quotaAt']>['work']> & SafeBag;
    current: any;
    resetAt: number;
  } & SafeBag;
  quotaSpendingAt: (...args: any[]) => ReturnType<(typeof boardPeriod)['quotaSpendingAt']>;
  quotaOrderAt: (...args: any[]) => ReturnType<(typeof boardPeriod)['quotaOrderAt']>;
  moneyAt: (...args: any[]) => ReturnType<(typeof boardPeriod)['moneyAt']> & SafeBag;
  moneyWorkAt: (...args: any[]) => Omit<
    NonNullable<ReturnType<(typeof boardPeriod)['moneyWorkAt']>>,
    'selectedWork'
  > & {
    selectedWork: NonNullable<
      NonNullable<ReturnType<(typeof boardPeriod)['moneyWorkAt']>>['selectedWork']
    >;
  };
  rangeAt: (...args: any[]) => {from: number; to: number} & SafeBag;
  projectionState: (...args: any[]) => ReturnType<(typeof boardPeriod)['projectionState']>;
  activityProjectionState: (
    ...args: any[]
  ) => ReturnType<(typeof boardPeriod)['activityProjectionState']>;
  activityAt: (...args: any[]) => NonNullable<ReturnType<(typeof boardPeriod)['activityAt']>>;
  activitySummaryAt: (...args: any[]) => Omit<
    NonNullable<ReturnType<(typeof boardPeriod)['activitySummaryAt']>>,
    'known' | 'by'
  > & {
    known: {from: number; to: number};
    by: Record<'source' | 'project' | 'device', any[]>;
  } & SafeBag;
  activityFrameAt: (
    ...args: any[]
  ) => NonNullable<ReturnType<(typeof boardPeriod)['activityFrameAt']>>;
  project: (...args: any[]) => Omit<
    NonNullable<ReturnType<typeof useHistory>['history']>,
    'activity' | 'series' | 'meterSeries'
  > & {
    activity: Omit<
      NonNullable<NonNullable<ReturnType<typeof useHistory>['history']>['activity']>,
      'by'
    > & {by: Record<'source' | 'project' | 'device', any[]>};
    series: any[];
    meterSeries: any[];
  } & SafeBag;
  cellBasis: (...args: any[]) => SafeBag;
  active: boolean;
  retiring: boolean;
  retirementPreparing: boolean;
  retirementAt: number;
  bytes: number;
  cacheKey: string;
  resourceGeneration: number;
  workEvidence: number;
  generation: number;
  revision: number;
  proofEpoch: number;
  workProofEpoch: number;
  valuesProofEpoch: number;
  validBefore: number;
  dirtyScopes: Set<string>;
  evaluatedAt: number;
  nativeDue: number;
  identity: string;
  sourceIds: string[];
  workRows: any[];
  watch: SafeBag;
  workRangeKey: string;
  selection: SafeBag;
  workSelection: SafeBag;
  workNeeded: boolean;
  valuesNeeded: boolean;
  wantsWork: boolean;
  facetsNeeded: boolean;
  facetsDemand: number;
  sourceTape: SafeBag;
  sourceCurves: SafeBag;
  sourceCursor: string;
  sourceEpoch: number;
  valueCache: NonNullMap<string, SafeBag>;
  values: NonNullMap<string, SafeBag>;
  work: SafeBag;
  index: Omit<PeriodIndex, never> & SafeBag;
  activity: Omit<PeriodActivity, never> & SafeBag;
  activityFrames: WeakMap<object, SafeBag>;
  activitySizes: WeakMap<object, number>;
  activityLeases: NonNullMap<any, {count: number; bytes: number}>;
  projectFrames: SafeBag;
  projectionRevision: {quota: number; budget: number; funds: number};
  tapes: NonNullMap<
    string,
    SafeBag & {
      accounting: any;
      tape: any;
      selection: SafeBag;
      rangeKey: string;
    }
  >;
  projectionErrors: SafeBag;
  storage: NonNullMap<object, number>;
  restoring: Set<SafeBag>;
  retained: NonNullMap<string, SafeBag>;
  queries: (...args: any[]) => SafeBag;
  intent: () => PeriodIntent & {facetGeneration: number; resourceGeneration: number};
  receive: (...args: any[]) => Promise<void>;
  applyReply: (...args: any[]) => Promise<void>;
  adoptReply: (...args: any[]) => Promise<boolean>;
  retireWork: () => void;
  retireExpired: (...args: any[]) => any;
  measureBytes: () => any;
  noEvidence: (...args: any[]) => boolean;
  clear: () => void;
  tick: (fromClock?: boolean) => void;
};
import {HistoryPool} from '../lib/historyPool';
import type {drain} from '../lib/prepare';
import {prepareAsync, type Preparations} from '../lib/prepare';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {evaluatedRange, periodKey} from '../../server/domain/period';
import {planEventsAt, planEventsDeadline, cellOf} from '../../server/domain/history';
import {PERIOD_SCOPES, type PeriodRequest, type PeriodReply} from '../../server/domain/periodRead';
import {
  packWorkPrepared,
  workPreparationBytes,
  mergeWorkPrepared,
} from '../../server/domain/periodWork';
import {
  retainSamplesPrepared,
  sampleBytes,
  mergeTapePrepared,
} from '../../server/domain/periodTape';
import {hasPeriodValue, periodValueAt} from '../../server/domain/periodValues';
import {canShift, shifted} from '../../server/domain/periodShift';
import {periodOf} from '../lib/periods';
import {moneyReadSelection, DEFAULT_MONEY} from '../lib/moneySelection';
import {subscriptionSelection} from '../lib/subscription';
import {sameJson, shallowEqual} from '../lib/store';
import {EMPTY_VIEW} from '../../server/domain/view';
import {
  AGENTS,
  ACTIVITY,
  QUOTA_WIDGETS,
  BUDGET_WIDGETS,
  SUBSCRIPTION_FUNDS,
  widgetVisible,
} from '../../server/domain/widgets';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {Events, type Frame} from '../../server/events';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {ResetFeed} from '../../server/resets';
import {HistoryTiles} from '../../server/history';
import {PeriodReader} from '../../server/periodRead';
import {expandPeriod} from '../../server/domain/periodWire';
import {createStore} from '../lib/store';
import {periodTextChangesAt} from '../lib/periodClock';
import {reduce, INITIAL, type HubEvent} from '../lib/board';
import {PageClock} from '../lib/clock';
import {Pan} from '../lib/pan';
import {Live} from '../lib/live';
import {timeRangeKey} from '../lib/timeRange';

import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import type {Hub} from '../../server/api';
export const NOW = 1_800_000_000_000,
  H = 3_600_000,
  M = 60_000;
export const flush = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve();
};

/** A held HTTP boundary settles on cancellation, even before its producer releases it. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, {once: true});
    pending.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Actual producer, wire JSON boundary, page reducer, transport and bounded server reader. */
export async function fixture({
  heatmap = false,
  activityOnly = false,
  personal = false,
  ownerDevice = false,
  transportLive = false,
  privateWork = false,
  unknown = false,
  current = false,
  stable = true,
  fixed = false,
  tableOnly = false,
  periodName = '1h',
  creditFrom = NOW - 3 * M,
  creditTo = NOW - 2 * M,
  clocked = false,
  sessionMs = 24 * H,
  initialFilters = null as filterModelBindings.DataFilters | null,
  initialFailure = false,
  periodSource = undefined as string | undefined,
} = {}) {
  let selectedRange = fixed ? {from: NOW - H, to: NOW} : null;
  const start = NOW - Math.max(3 * H, periodOf(periodName).ms + H);
  const store = new Store(':memory:', start),
    directory = new Directory(store.db);
  const alice = directory.createUser('a@example.com', 'Alice', 'unused', start),
    bob = directory.createUser('b@example.com', 'Bob', 'unused', start);
  const board = personal
    ? directory.boards(alice.id)[0].id
    : directory.createBoard('Shared', alice.id, start).id;
  if (!personal) directory.addMember(board, bob.id, start);
  directory.saveView(
    board,
    {
      ...EMPTY_VIEW,
      shown: [
        AGENTS,
        ...(activityOnly ? [ACTIVITY] : ['quota-history']),
        ...(heatmap ? [AGENT_HOURS_HEATMAP] : []),
      ],
      hidden: activityOnly ? [...QUOTA_WIDGETS] : [ACTIVITY],
    },
    alice.id,
    start,
  );
  const source = store.source('codex', 'a'.repeat(24), start);
  store.hold(source, alice.id, start);
  store.hold(source, bob.id, start);
  if (tableOnly)
    directory.saveView(
      board,
      {
        ...EMPTY_VIEW,
        shown: [AGENTS],
        enabledWhenEmpty: [AGENTS],
        hidden: [
          ACTIVITY,
          'quota-history',
          'quota-session-history',
          'quota-table',
          'quota-session-table',
          'subscription-funds',
          'budget-history',
          'budget-table',
          'source:' + source,
        ],
      },
      alice.id,
      start,
    );
  if (!personal) store.share(board, source, alice.id, start);
  store.record(source, {
    observedAt: NOW - 2 * M,
    plan: '',
    resets: null,
    staleAfterMs: H,
    windows: [
      {
        id: 'w',
        kind: 'weekly',
        label: null,
        minutes: 10080,
        used: 17,
        remaining: 83,
        resetAt: NOW + H,
      },
    ],
  });
  const owner = personal || ownerDevice ? alice.id : bob.id;
  const device = directory.saveDevice(
    {
      userId: owner,
      machine: {id: 'machine-0123456789', name: 'Work laptop', os: 'linux', arch: 'x86_64'},
      agent: 'quotum/0.6.0',
      tokenId: null,
    },
    start,
  ).id;
  const funding = privateWork
    ? unknown
      ? null
      : store.source('codex', 'b'.repeat(24), start)
    : source;
  const credit = (from = creditFrom, to = creditTo) =>
    store.creditWork(device, from, to, [
      {
        accountBy: funding ? 'login' : null,
        source: funding,
        origin: 'terminal',
        startedAt: start,
        project: 'Work project',
        folder: 'Private folder',
        client: 'codex',
        identity: stable
          ? {kind: 'stable', sessionId: 'c'.repeat(32)}
          : {kind: 'legacy', ordinal: 0},
      },
    ]);
  credit();
  const hub: Hub = {
    store,
    directory,
    ingest: new Ingest(store, directory, new Duty(), new Cadence()),
    resets: new ResetFeed(undefined, () => {}),
    pairing: new Pairing(directory),
    setup: new Setup(false, null),
    local: null,
  };
  let now = NOW;
  const live = (working = false) => ({
    accountBy: funding ? ('login' as const) : null,
    source: funding,
    clientId: 'codex',
    sessionId: stable ? 'c'.repeat(32) : null,
    device: {id: device, name: 'Work laptop'},
    origin: 'terminal' as const,
    project: 'Work project',
    folder: 'Private folder',
    startedAt: start,
    sentStartedAt: start,
    lastWorkedAt: NOW - 2 * M,
    working,
  });
  if (current) hub.ingest.live.report(device, owner, [live()], NOW);
  const timers = new Map<object, {at: number; run: () => void}>();
  const eventClock = {
    now: () => now,
    after: (ms: number, run: () => void) => {
      const token = {};
      timers.set(token, {at: now + ms, run});
      return () => {
        timers.delete(token);
      };
    },
  };
  let events = new Events(hub, undefined, eventClock, null);
  const tiles = new HistoryTiles(store);
  let reader = new PeriodReader(hub, tiles, events);
  const attach = () => {
    events.onHistory = (source, since, scopes, work) => {
      tiles.touch(source, since, scopes);
      reader.touch(source, since, scopes, work);
    };
    events.onClientHistory = (user, since, device) => {
      tiles.touchClient(user, since, device);
      reader.touchClient(user, since, device);
    };
    events.attach();
  };
  attach();
  const page = createStore(reduce, INITIAL),
    frames: Frame[] = [],
    requests: PeriodRequest[] = [],
    pool = new HistoryPool();
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let period: FixturePeriod | null = null;
  const connection = transportLive
    ? new Live({
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: controller => {
                stream = controller;
              },
            }),
            {headers: {'content-type': 'text/event-stream'}},
          ),
        now: () => now,
        setTimeout: (run, ms) => {
          const token = {};
          timers.set(token, {at: now + ms, run});
          return token;
        },
        clearTimeout: token => {
          timers.delete(token as object);
        },
        random: () => 0.5,
        visible: () => true,
        hubNow: () => now,
        heard: () => {},
        workFreshness: stamp => period?.acceptWorkFreshness(stamp),
        dispatch: event => page.dispatch(event),
        unauthorized: () => {},
        gone: () => {},
        epochChanged: () => {},
        script: null,
        reload: () => {},
        storage: () => ({getItem: () => null, setItem: () => {}}),
      })
    : null;
  connection?.open(board);
  const feed = (batch: Frame[]) => {
    frames.push(...batch);
    if (connection) {
      stream!.enqueue(
        new TextEncoder().encode(
          batch.map(frame => `event: ${frame.type}\ndata: ${frame.data}\n\n`).join(''),
        ),
      );
      return;
    }
    for (const frame of batch) {
      const data = JSON.parse(frame.data) as Record<string, any>;
      if (frame.type === 'ping') {
        if (data.workStamp) period?.acceptWorkFreshness(data.workStamp);
        continue;
      }
      if (frame.type === 'bye') {
        period?.acceptWorkFreshness(null);
        continue;
      }
      if (frame.type === 'snapshot')
        page.dispatch({type: 'connection', status: 'live', lostAt: null});
      page.dispatch({type: 'hub', event: {type: frame.type, data} as unknown as HubEvent});
      if (frame.type === 'snapshot' && data.workStamp) period?.acceptWorkFreshness(data.workStamp);
    }
  };
  const secret = 'fixture-session';
  directory.createSession(secret, alice.id, NOW - 3 * H, sessionMs);
  const initial = events.open({
    user: alice.id,
    secret,
    board,
    kind: 'stream',
    send: feed,
    end: () => {},
  });
  if (!initial || initial === 'limit') throw new Error('stream did not open');
  let opened = initial;
  feed(opened.frames);
  if (connection) await flush();
  const settings = {range: periodName, kind: 'session', money: DEFAULT_MONEY, funds: DEFAULT_MONEY};
  const code = periodSource ?? readFileSync(new URL('../lib/period.ts', import.meta.url), 'utf8');
  let wait: {promise: Promise<void>; signal?: AbortSignal; reply?: PeriodReply} | null = null,
    preparer: Preparations | null = null,
    failInitial = initialFailure;
  const pageClock = new PageClock({
    now: () => now,
    visible: () => true,
    setTimeout: (run, ms) => {
      const token = {};
      timers.set(token, {at: now + ms, run});
      return token;
    },
    clearTimeout: token => {
      timers.delete(token as object);
    },
  });
  const pan = new Pan({
    now: () => now,
    commit: () => {},
    requestFrame: run => {
      run();
      return null;
    },
    cancelFrame: () => {},
    setTimeout: () => null,
    clearTimeout: () => {},
  });
  const context = {
    workChange,
    exports: {} as {BoardPeriod?: new () => FixturePeriod},
    hubNow: clocked ? pageClock.hubNow : () => now,
    retention,
    historyPool: pool,
    clock: clocked ? pageClock : {watch: () => ({}), subscribe: () => {}, due: () => {}},
    PeriodTransport,
    fetchPeriod: async (_board: string, body: PeriodRequest, signal: AbortSignal) => {
      signal.throwIfAborted();
      requests.push(body);
      if (failInitial) {
        failInitial = false;
        throw new Error('initial transport unavailable');
      }
      const reply = expandPeriod(
          JSON.parse(
            reader.read(board, alice.id, JSON.parse(JSON.stringify(body)) as PeriodRequest),
          ),
        ),
        pending = wait;
      wait = null;
      if (pending) {
        pending.signal = signal;
        pending.reply = reply;
        await abortable(pending.promise, signal);
      }
      signal.throwIfAborted();
      return reply;
    },
    periodTextChangesAt,
    page,
    pan,
    preparations: () => preparer,
    prepareAsync: (owner: object, work: Parameters<typeof drain>[0], valid: () => boolean) =>
      prepareAsync(owner, work, valid, preparer),
    evaluatedRange,
    periodKey,
    PeriodAccounting,
    PeriodIndex,
    PeriodActivity,
    packWorkPrepared,
    workPreparationBytes,
    mergeWorkPrepared,
    retainSamplesPrepared,
    sampleBytes,
    mergeTapePrepared,
    canShift,
    shifted,
    hasPeriodValue,
    periodValueAt,
    empty: () => ({value: null, basis: null, loading: false, error: null}),
    sameJson,
    WorkCalendar,
    AGENT_HOURS_HEATMAP,
    timeRange: () => selectedRange,
    prefs: () => settings,
    periodOf,
    cellOf,
    moneyReadSelection,
    subscriptionSelection,
    PERIOD_SCOPES,
    QUOTA_WIDGETS,
    BUDGET_WIDGETS,
    SUBSCRIPTION_FUNDS,
    ACTIVITY,
    AGENTS,
    widgetVisible,
    noSessions: [],
    noValue: {},
  };
  runInNewContext(
    ts.transpileModule(
      code
        .slice(code.indexOf('class BoardPeriod'), code.indexOf('export const boardPeriod'))
        .replace('class BoardPeriod', 'export class BoardPeriod'),
      {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}},
    ).outputText,
    Object.assign(
      context,
      {workChange},
      periodValueClockBindings,
      filterModelBindings,
      filterRuntimeBindings,
      filterCurveBindings,
    ),
  );
  if (initialFilters) filterRuntimeBindings.publishDataFilters(initialFilters);
  const activePeriod = new context.exports.BoardPeriod!();
  period = activePeriod;
  pan.onPhase(() => activePeriod.refreshWorkClock());
  page.listen((event, state) => activePeriod.changed(event, state));
  activePeriod.activate(true);
  await flush();
  const limited = !!initialFilters && !filterModelBindings.executableWorkFilters(initialFilters);
  assert.equal(
    activePeriod.get().error,
    limited ? 'filters_limit' : initialFailure ? 'unavailable' : null,
  );
  assert.equal(activePeriod.get().rows.length, limited || initialFailure ? 0 : 1);
  const initialRequests = requests.slice();
  requests.length = 0;
  frames.length = 0;
  const advance = (at: number) => {
    for (let count = 0; ; count++) {
      assert.ok(count < 10000);
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > at) break;
      now = Math.max(now, next[1].at);
      timers.delete(next[0]);
      next[1].run();
      events.flush();
    }
    now = Math.max(now, at);
    if (!clocked) activePeriod.tick();
  };
  const jump = (at: number) => {
    now = at;
    for (const [token, timer] of [...timers])
      if (timer.at <= at) {
        timers.delete(token);
        timer.run();
      }
    events.flush();
    if (clocked) pageClock.wakeDue();
    else activePeriod.tick();
  };
  const consumers = new Set<() => void>();
  return {
    onClose: (stop: () => void) => {
      consumers.add(stop);
      return () => consumers.delete(stop);
    },
    hub,
    device,
    owner,
    advance,
    jump,
    elapse: (ms: number) => {
      now += ms;
    },
    elapseTo: (at: number) => {
      now = at;
    },
    pan,
    selectedRange: () => selectedRange,
    selectRange: (range: typeof selectedRange) => {
      selectedRange = range;
      activePeriod.changed();
    },
    clock: pageClock,
    initialRequests,
    prepareWith: (value: Preparations | null) => {
      preparer = value;
    },
    settings,
    pool,
    get reader() {
      return reader;
    },
    store,
    directory,
    board,
    alice,
    bob,
    source,
    credit,
    get events() {
      return events;
    },
    period: activePeriod,
    page,
    frames,
    requests,
    report: (working = false, at = NOW) => {
      now = at;
      hub.ingest.sessions(
        {kind: 'device', device: directory.deviceById(device)!},
        {
          version: 1,
          agent: 'quotum/0.6.0',
          machine: {id: 'machine-0123456789', name: 'Work laptop', os: 'linux', arch: 'x86_64'},
          sentAt: new Date(at).toISOString(),
          sessions: [
            {
              provider: 'codex',
              ...(funding ? {account: (privateWork ? 'b' : 'a').repeat(24)} : {}),
              sessionId: stable ? 'c'.repeat(32) : null,
              origin: 'terminal',
              project: 'Work project',
              folder: 'Private folder',
              startedAt: new Date(start).toISOString(),
              lastWorkedAt: new Date(NOW - 2 * M).toISOString(),
              working,
            },
          ],
        },
        at,
      );
      events.flush();
    },
    endIdle: () => {
      hub.ingest.sessions(
        {kind: 'device', device: directory.deviceById(device)!},
        {
          version: 1,
          agent: 'quotum/0.6.0',
          machine: {id: 'machine-0123456789', name: 'Work laptop', os: 'linux', arch: 'x86_64'},
          sentAt: new Date(NOW).toISOString(),
          sessions: [],
        },
        NOW,
      );
      events.flush();
    },
    event: (event: HubEvent) => page.dispatch({type: 'hub', event}),
    hold: () => {
      let release!: () => void, reject!: (error: Error) => void;
      const held: {promise: Promise<void>; signal?: AbortSignal; reply?: PeriodReply} = {
        promise: new Promise<void>((yes, no) => {
          release = yes;
          reject = no;
        }),
      };
      wait = held;
      return {
        release,
        reject,
        get signal() {
          return held.signal;
        },
        get reply() {
          return held.reply;
        },
      };
    },
    disconnect: () => {
      opened.close();
      activePeriod.acceptWorkFreshness(null);
      page.dispatch({type: 'connection', status: 'retrying', lostAt: now});
    },
    reconnect: () => {
      page.dispatch({type: 'connection', status: 'connecting', lostAt: now});
      opened = events.open({
        user: alice.id,
        secret,
        board,
        kind: 'stream',
        send: feed,
        end: () => {},
      }) as typeof initial;
      feed(opened.frames);
    },
    remove: () => {
      directory.removeMember(board, bob.id);
      store.unshareOrphans(board);
      events.flush();
    },
    restart: () => {
      opened.close();
      events.close();
      now++;
      events = new Events(hub, undefined, eventClock, null);
      reader = new PeriodReader(hub, tiles, events);
      attach();
      opened = events.open({
        user: alice.id,
        secret,
        board,
        kind: 'stream',
        send: feed,
        end: () => {},
      }) as typeof initial;
      const baseline = opened.frames.filter(frame => frame.type !== 'hello');
      feed(opened.frames.filter(frame => frame.type === 'hello'));
      return () => feed(baseline);
    },
    fresh: () =>
      expandPeriod(
        JSON.parse(
          reader.read(board, alice.id, {
            version: 1,
            selection: {mode: 'live', periodMs: H},
            evaluatedAt: NOW,
            sessions: {},
          }),
        ),
      ) as PeriodReply,
    close: async () => {
      for (const stop of [...consumers]) stop();
      activePeriod.activate(false);
      connection?.close();
      stream?.close();
      opened.close();
      events.close();
      await new Promise(resolve => setImmediate(resolve));
      store.close();
      assert.equal(pool.estimatedBytes, 0);
      assert.equal(pool.activeFlights, 0);
    },
  };
}

import * as React from 'react';
import {preparationFixture} from './preparationFixture';
import {activityScale, activityEmpty, groupColors, activitySeriesKey} from '../lib/activity';
import {plotGroupsPrepared} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {groupRegistry} from '../lib/plotRegistry';
import {cellStart} from '../../server/domain/history';
import {niceTicks, timeTickWords} from '../lib/periods';
import {navigationKey} from '../lib/axisNavigation';
import {cardId, isHidden} from '../lib/view';

export function consumer(
  h: any,
  options: {
    now?: () => number;
    focus?: {get: () => string | null; subscribe: (run: () => void) => () => void};
  } = {},
) {
  const parent = preparationFixture(),
    child = preparationFixture();
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const axis = {
    box: {current: null},
    svg: {current: null},
    width: 400,
    scale: 1,
    hover: null,
    drag: null,
    clip: 'c',
    handlers: {},
    basis: {from: NOW - H, to: NOW, end: NOW},
    active: false,
    visualGeometry: () => axis.basis,
    presentation: () => axis.basis,
    screenX: (at: number) => 48 + ((at - (NOW - H)) / H) * 340,
    commitDrawing: () => {},
  };
  const EMPTY_ACTIVITY = {
    since: 0,
    known: null,
    barMs: 60_000,
    activeMs: 0,
    agentMs: 0,
    agents: 0,
    cells: [],
    by: {source: [], project: [], device: []},
  };
  const titles = Object.fromEntries(
    Object.values(
      (h.page.get().board!.cards ?? {}) as Record<string, {id: string; provider: string}>,
    ).map(c => [c.id, {provider: c.provider, title: 'Shared source'}]),
  );
  let panning: number | null = null;
  const focus = options.focus ?? {get: () => null, subscribe: () => () => {}};
  const prefs = {range: '1h', activityBy: 'project'};
  const context = {
    ...projectColorBindings(h.page),
    ACTIVITY,
    boardPeriod: h.period as Record<string, any>,
    exports: {} as {Activity?: (props: Record<string, any>) => React.ReactElement<any>},
    React,
    ...parent,
    memo: <T>(f: T) => f,
    useMemo: <T>(f: () => T, deps: unknown[]): T => {
      const slot = parent.useRef(null) as {current: {deps: unknown[]; value: T} | null};
      if (!slot.current || deps.some((v, i) => !Object.is(v, slot.current!.deps[i])))
        slot.current = {deps, value: f()};
      return slot.current.value;
    },
    useSyncExternalStore: <T>(_subscribe: unknown, get: () => T): T => get(),
    useEffect: () => {},
    useSeriesFocus: () => focus,
    seriesFocusStyle: () => ({}),
    useId: () => 'c',
    useActivityHistory: () => h.renderActivity(),
    useHistoryPlot: (activity = false) =>
      activity ? h.loader.getActivityPlot() : h.loader.getPlot(),
    usePlot: () => ({plot: undefined, onBase: () => {}}),
    useLineup: () => h.page.get().board!.lineup,
    usePersonalBoard: () => false,
    useTitles: () => titles,
    usePref: (key: keyof typeof prefs) => prefs[key],
    useLocale: () => 'en',
    useTimeRange: () => h.selectedRange(),
    useBoardId: () => h.board,
    axisNavigation: () => ({context: 'b', range: '1h'}),
    useClock: () => options.now?.() ?? NOW,
    usePanning: () => panning,
    pan: {get: () => null, active: () => null, subscribe: () => () => {}, onStop: () => () => {}},
    useHistoryBegins: () => 0,
    frameOf: () => ({from: (options.now?.() ?? NOW) - H, to: options.now?.() ?? NOW, live: true}),
    measuredTo: () => options.now?.() ?? NOW,
    activityEmpty,
    groupColors,
    groupRegistry,
    activitySeriesKey,
    plotGroupsPrepared,
    StackPaths,
    stacksHeight: () => 160,
    activityScale,
    niceTicks,
    timeTickWords,
    cellStart,
    plotBar,
    plotTarget,
    targetOf,
    MINUTE: 60_000,
    EMPTY_ACTIVITY,
    groupName: (g: any) => g.name ?? g.key,
    cardId,
    isHidden,
    t: (s: any) => s,
    quotaHistory: {retry: () => h.loader.retry()},
    AnalyticsPanel: () => null,
    ActivitySettings: () => null,
    Totals: () => null,
    LegendItem: () => null,
    setTimeRange: () => {},
    timeRangeKey,
    navigationKey,
    useTimeAxis: () => axis,
    useTip: () => ({tip: {current: null}, style: {}}),
    PlotLayer: () => null,
    PlotOverlay: () => null,
    Tooltip: () => null,
    clock: () => '',
    shortDay: () => '',
    workHours: () => '',
    stamp: () => '',
    CSS: {escape: (id: any) => id},
    Stacks: null as unknown as (props: Record<string, any>) => React.ReactElement<any>,
    StackArtwork: null as unknown as (props: Record<string, any>) => React.ReactElement<any>,
  };
  runInNewContext(
    ts.transpileModule(
      source.slice(source.indexOf('export const Activity =')) +
        '\nglobalThis.Stacks=Stacks;globalThis.StackArtwork=StackArtwork;',
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.React,
        },
      },
    ).outputText,
    Object.assign(
      context,
      {workChange},
      periodValueClockBindings,
      filterModelBindings,
      filterRuntimeBindings,
      filterCurveBindings,
    ),
  );
  function find(node: unknown, type: unknown): React.ReactElement<Record<string, any>> | null {
    if (Array.isArray(node)) return node.map(n => find(n, type)).find(Boolean) ?? null;
    if (!React.isValidElement(node)) return null;
    if (node.type === type) return node as React.ReactElement<Record<string, any>>;
    return find((node.props as Record<string, any>).children, type);
  }
  const pathsOf = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(pathsOf);
    if (!React.isValidElement(node)) return [];
    const p = node.props as Record<string, any>;
    if (node.type === context.StackArtwork) return pathsOf(context.StackArtwork(p));
    return p.className === 'activity-stack' && p.d !== undefined
      ? [p.d as string]
      : pathsOf(p.children);
  };
  let latestParent: React.ReactElement<any> = null!,
    latestChild: React.ReactElement<any> = null!;
  const renderParent = (): Record<string, any> => {
    Object.assign(context, parent);
    parent.begin();
    latestParent = context.exports.Activity!({
      arrange: {view: (h.page.get().board as Record<string, any>).view as unknown},
    });
    return find(latestParent, context.Stacks)!.props;
  };
  const renderChild = (props: Record<string, any>) => {
    Object.assign(context, child);
    child.begin();
    latestChild = context.Stacks(props);
    return pathsOf(latestChild);
  };

  const names = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(names);
    if (!React.isValidElement(node)) return [];
    const props = node.props as Record<string, any>;
    return node.type === context.LegendItem ? [props.name as string] : names(props.children);
  };
  const render = () => {
    const props = renderParent();
    parent.commit();
    const paths = renderChild(props);
    child.commit();
    const legend = (node: unknown): Record<string, any>[] => {
      if (Array.isArray(node)) return node.flatMap(legend);
      if (!React.isValidElement(node)) return [];
      const p = node.props as Record<string, any>;
      return node.type === context.LegendItem ? [p] : legend(p.children);
    };
    const result = {paths, names: names(latestChild), ready: Boolean(props.prepared)};
    return Object.defineProperties(result, {
      entries: {value: legend(latestChild)},
      tree: {value: latestChild},
      totals: {value: find(latestChild, context.Totals)?.props},
      incomingFrame: {value: props.detailFrame as Record<string, any> | null},
      retry: {value: find(latestParent, context.AnalyticsPanel)?.props.retry as () => void},
    }) as typeof result & {
      entries: Record<string, any>[];
      tree: React.ReactElement<any>;
      totals: Record<string, any>;
      incomingFrame: Record<string, any>;
      retry: () => void;
    };
  };
  const settle = () => {
    for (let i = 0; i < 4; i++) {
      render();
      parent.finish();
      child.finish();
    }
    return render();
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unregister();
    parent.dispose();
    child.dispose();
  };
  const unregister = (h.onClose as (stop: () => void) => () => void)(close);
  return {
    render,
    settle,
    queuedParent: () => parent.scheduler.size,
    queuedChild: () => child.scheduler.size,
    finishParent: parent.finish,
    finishChild: child.finish,
    close,
    pan: () => {
      panning = 1;
      axis.active = true;
    },
  };
}

import {HistoryStore, follow, type HistoryEnv, type useHistory} from '../lib/history';
import {expandHistory} from '../../server/domain/history';

export async function drawings(
  h: Record<string, any>,
  activity = true,
  scope: 'quota' | 'budget' = 'quota',
) {
  const scheduled = new Map<object, {run: () => void; ms: number}>();
  const source = readFileSync(new URL('../lib/history.ts', import.meta.url), 'utf8');
  const read = source.slice(
      source.indexOf('      read: ('),
      source.indexOf('\n      now: hubNow,'),
    ),
    retry = source.slice(
      source.indexOf('      retry: '),
      source.indexOf('\n    },\n    STORED_BYTES,'),
    );
  assert.ok(read);
  assert.ok(retry);
  const adapter = source.slice(
    source.indexOf('const selectedMeters ='),
    source.indexOf('function activeReaders('),
  );
  const workKey = source.slice(
    source.indexOf('const selectedWorkKey ='),
    source.indexOf('\nif (typeof window'),
  );
  assert.ok(workKey);
  const readerContext = {
    read: null as unknown as HistoryEnv['read'],
    retry: null as unknown as HistoryEnv['retry'],
    selected: null as unknown as (...args: any[]) => Parameters<HistoryStore['setMeters']>[0],
    workKey: null as unknown as (...args: any[]) => string,
    boardPeriod: h.period as Record<string, any>,
    scope,
    family: 'budget',
    pan: h.pan as Record<string, any>,
    expandHistory,
    prefs: () => h.settings as Record<string, any>,
    subscriptionSelection,
    moneyReadSelection,
    ...filterModelBindings,
    ...filterRuntimeBindings,
  };
  runInNewContext(
    ts.transpileModule(
      adapter +
        '\n' +
        workKey +
        '\nglobalThis.read=({' +
        read +
        '}).read;globalThis.retry=({' +
        retry +
        '}).retry;globalThis.selected=selectedMeters;globalThis.workKey=selectedWorkKey;',
      {compilerOptions: {target: ts.ScriptTarget.ES2022}},
    ).outputText,
    readerContext,
  );
  const env: HistoryEnv = {
    sharedTransport: true,
    workInPresentation: scope !== 'budget',
    now: () => NOW,
    preparations: null,
    read: readerContext.read,
    retry: readerContext.retry,
    setTimeout: (run, ms) => {
      const token = {};
      scheduled.set(token, {run, ms});
      return token;
    },
    clearTimeout: token => {
      scheduled.delete(token as object);
    },
    dropTimeRange: () => {},
  };
  const loader = new HistoryStore(env, undefined, scope, h.pool as HistoryPool);
  const stop = follow(loader, h.page);
  loader.setActivityActive(activity);
  loader.choose(h.settings.range, h.selectedRange());
  loader.open(h.board);
  loader.setWorkFilter(
    readerContext.workKey(h.page.get()),
    filterRuntimeBindings.effectiveFilters() ?? undefined,
  );
  loader.hello(h.events.epoch);
  loader.setMeters(readerContext.selected(h.page.get(), scope));
  const board = h.page.get().board as Record<string, any>;
  loader.snapshot(
    board.lineup,
    Object.values(board.cards as Record<string, {id: string; windows: {id: string}[]}>).flatMap(c =>
      c.windows.map(w => `${c.id} ${w.id}`),
    ),
    board.historyStart,
    board.workAuthority,
  );
  await flush();
  const selectedSlots: unknown[] = [],
    financialSlots: unknown[] = [],
    activitySlots: unknown[] = [],
    forecastSlots: unknown[] = [];
  let slots = selectedSlots,
    cursor = 0;
  const useRef = <T>(current: T): {current: T} =>
    (slots[cursor++] ?? (slots[cursor - 1] = {current})) as {current: T};
  const useMemo = <T>(read: () => T, deps: unknown[]): T => {
    const box = useRef<{deps: unknown[]; value: T} | null>(null);
    if (!box.current || deps.some((v, i) => !Object.is(v, box.current!.deps[i])))
      box.current = {deps, value: read()};
    return box.current.value;
  };
  const context = {
    useRef,
    useMemo,
    useSyncExternalStore: <T>(_s: unknown, read: () => T): T => read(),
    pan: {active: () => null, onPhase: () => () => {}},
    hubNow: () => NOW,
    planEventsAt,
    planEventsDeadline,
    shallowEqual,
    useClock: () => NOW,
    fundsHistory: {},
    page: h.page as Record<string, any>,
    timeRange: h.selectedRange as () => {from: number; to: number} | null,
    timeRangeKey,
    prefs: () => h.settings as Record<string, any>,
    boardPeriod: h.period as Record<string, any>,
    read: null as unknown as (
      loader: HistoryStore,
      rolling?: boolean,
      financial?: boolean,
      activityOnly?: boolean,
    ) => Omit<ReturnType<typeof useHistory>, 'history' | 'drawing'> & {
      history: Omit<
        NonNullable<ReturnType<typeof useHistory>['history']>,
        'activity' | 'series' | 'meterSeries'
      > & {
        activity: Omit<
          NonNullable<NonNullable<ReturnType<typeof useHistory>['history']>['activity']>,
          'by'
        > & {by: Record<'source' | 'project' | 'device', any[]>};
        series: any[];
        meterSeries: any[];
      } & SafeBag;
      drawing: NonNullable<ReturnType<typeof useHistory>['drawing']> & SafeBag;
    },
  };
  runInNewContext(
    ts.transpileModule(
      source.slice(
        source.indexOf('function usePeriodHistory('),
        source.indexOf('export function useHistory('),
      ) + '\nglobalThis.read=usePeriodHistory;',
      {compilerOptions: {target: ts.ScriptTarget.ES2022}},
    ).outputText,
    Object.assign(
      context,
      {workChange},
      periodValueClockBindings,
      filterModelBindings,
      filterRuntimeBindings,
      filterCurveBindings,
    ),
  );
  const render = () => {
    slots = selectedSlots;
    cursor = 0;
    return context.read(loader, true);
  };
  const renderFinancial = () => {
    slots = financialSlots;
    cursor = 0;
    return context.read(loader, false, true);
  };
  const renderActivity = () => {
    slots = activitySlots;
    cursor = 0;
    return context.read(loader, true, false, true);
  };
  const renderForecast = () => {
    slots = forecastSlots;
    cursor = 0;
    return context.read(loader, false);
  };
  return {
    loader,
    render,
    renderFinancial,
    renderActivity,
    renderForecast,
    prepareWith: (value: Preparations | null) => {
      env.preparations = value;
    },
    syncFilters: () => {
      loader.setWorkFilter(
        readerContext.workKey(h.page.get()),
        filterRuntimeBindings.effectiveFilters() ?? undefined,
      );
      loader.setMeters(readerContext.selected(h.page.get(), scope));
    },
    runScheduled: () => {
      const timers = [...scheduled];
      for (const [token, timer] of timers) {
        scheduled.delete(token);
        timer.run();
      }
      return timers.map(([, timer]) => timer.ms);
    },
    close: () => {
      stop();
      loader.close();
    },
  };
}
import {subscriptionLinesOf} from '../lib/subscription';
import {lineWork, workText} from '../lib/work';
export function quotaCells(
  h: Record<string, any>,
  d: {render: () => ReturnType<typeof useHistory>},
) {
  const history = d.render().history,
    board = h.page.get().board as Record<string, any>;
  if (!history) return {work: {content: '—'}, agenthours: {content: '—'}};
  const [line] = subscriptionLinesOf(history, Object.values(board.cards), board.view, 'weekly');
  if (!line) return {work: {content: '—'}, agenthours: {content: '—'}};
  const period = h.period as Omit<typeof boardPeriod, never>;
  const value = period.quotaAt(line, NOW, history.range),
    cells = lineWork(value, false, NOW + H, NOW);
  const since = period.rangeAt('quota', NOW, history.range)?.from ?? history.since;
  return Object.fromEntries(
    (['work', 'agenthours'] as const).map(column => [
      column,
      cells && value.work
        ? workText(column, cells[column], value.work, since, NOW + H, null)
        : {content: '—'},
    ]),
  );
}
