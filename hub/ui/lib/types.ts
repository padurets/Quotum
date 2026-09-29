export type {Refresh, RefreshRequest} from '../../server/domain/refresh';
/** A window's length as the agent classifies it. */
export type Kind = 'session' | 'weekly' | 'other';

/** The kinds of windows the analytics show, one at a time on the chart and in the table; `other` only on cards. */
export const ANALYTICS_KINDS: Kind[] = ['weekly', 'session'];

export type Win = {
  id: string;
  kind: Kind;
  /** The model pool the window covers ("Fable", "Gemini"), when the provider names one. */
  label: string | null;
  used: number;
  remaining: number;
  resetAt: number | null;
  minutes: number | null;
};

/** How many free resets expire when. */
export type Expiring = {count: number; expiresAt: number | null};
/** `expiring` is left out of what a hub older than 0.4 stored, and those resets have no time given. */
export type FreeResets = {available: number; expiring?: Expiring[]};

/**
 * A source as its card shows it (spec/dashboard-v1.md: `card`): its state, the people on
 * the board whose devices measure it, and whether its numbers are too old, as the hub says.
 */
export type Card = {
  id: string;
  provider: string;
  plan: string;
  successAt: number | null;
  error: string | null;
  stale: boolean;
  windows: Win[];
  resets: FreeResets | null;
  owners: string[];
  staleAfterMs: number | null;
};

/** When a source is measured next and why, while the hub sets the pace of the device measuring it; `next` may have passed. */
export type Pace = {next: number; why: CadenceWhy} | null;

/** Why the next measurement comes when it does: little left, in use, numbers that just changed or stay the same, a reset. */
export type CadenceWhy = 'low' | 'inUse' | 'changed' | 'idle' | 'reset';

/** A coding agent running on a machine, spending the subscription of its card. */
export type LiveSession = {
  device: {id: string; name: string};
  /** A terminal; an editor or the provider's app, which run one client per window. */
  origin: 'terminal' | 'editor' | 'app';
  /** Its project, as its person named it. */
  project: string | null;
  /** The folder it works in, where that is not its project (a worktree, a folder inside the repository). */
  folder: string | null;
  startedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
};

/**
 * How a board is arranged, the same for everyone on it; its owner changes it. Widgets
 * are `source:<id>` cards, the `agents` list, and the analytics: `activity`, the `history`
 * chart and the `forecast` table.
 */
export type View = {
  layout: import('./grid').Layout;
  /** Boards arranged before the grid: the page translates these; POST never saves them. */
  order?: string[];
  sizes?: Record<string, number>;
  /** Names the board's owner gave cards, by source id. */
  names: Record<string, string>;
  hidden: string[];
  /** Widgets off until the owner turns them on (the list of running agents), turned on. */
  shown: string[];
  /** `windowKey`s of windows hidden from cards and the chart. */
  windows: string[];
  /** Weekly spending plans by source id; absent means the default. */
  plans: Record<string, number[]>;
  /** Source ids whose plan is switched off on this board. */
  unplanned: string[];
  /** Colours given to cards, by source id, instead of the provider's. */
  colors: Record<string, string>;
  /** Columns hidden in a widget's table, by widget id. */
  columns: Record<string, string[]>;
  /** Columns off by default that the owner turned on, by widget id. */
  shownColumns: Record<string, string[]>;
};

export type HistorySeries = {
  sourceId: string;
  provider: string;
  windowId: string;
  kind: Kind;
  label: string | null;
  minutes: number | null;
  consumed: number;
  coveredMs: number;
  samples: number;
  /** What was left at the first and the last measurement of the period. */
  remainingAtStart: number | null;
  remainingAtEnd: number | null;
  /** How long its last value holds without a newer one before a gap begins. */
  staleAfterMs: number;
  /** [cell start, remaining percent, line segment] */
  points: [number, number, number][];
  /** How agents worked on its subscription meanwhile (null for a hidden card). */
  work: SeriesWork | null;
};

/**
 * How agents worked on a window's subscription over a period, and what the window spent
 * meanwhile, all from `from` on, since when that is known: `ms`, how long any of them
 * worked (null when nothing of the period is known); `consumed`, what the window spent
 * over the steps between measurements the hub can prove; `coveredMs`, how long agents
 * worked during those steps; `duringWork`, what those of the steps agents worked in spent
 * (an upper bound: a step work touches counts whole).
 */
export type SeriesWork = {from: number; ms: number | null; consumed: number; coveredMs: number; duringWork: number};

export type ActivityDimension = 'source' | 'project' | 'device';

/**
 * A subscription, project or machine agents worked on: how long its own agents worked
 * (`ms`, overlaps counted once) and its part of each bar's work ([bar start, ms], only
 * bars it has a part in); `name` is null for a subscription (named from the board) and
 * for no project. Every one the period has is a group of its own, the longest first.
 */
export type ActivityGroup = {key: string; name: string | null; ms: number; cells: [number, number][]};

/**
 * How the agents the board shows worked over the period: since when that is known on the
 * board, the part of the period that is (null when none), how long any of them worked, all
 * of them together, and how many different agents did, in all and bar by bar (`barMs`
 * long: [bar start, work, agent time, agents], only bars with work), and split by
 * subscription, project and machine. Each moment is split evenly among the agents working
 * then, so a bar's parts add up to its work.
 */
export type Activity = {
  since: number;
  known: {from: number; to: number} | null;
  barMs: number;
  workMs: number;
  agentMs: number;
  agents: number;
  cells: [number, number, number, number][];
  by: Record<ActivityDimension, ActivityGroup[]>;
};

export type History = {
  /** Set by the client: which board the history was read for. */
  board?: string;
  /** A period ending now ('1h' … '30d', lib/periods.ts), or `from-to` of a span selected on the chart. */
  range: string;
  now: number;
  since: number;
  /** Where the period ends: now for a range, the end of a span. */
  to: number;
  /** Width of the shared time grid every series is placed on. */
  cellMs: number;
  historyStart: number;
  series: HistorySeries[];
  events: SourceEvent[];
  activity: Activity;
  /** A newer answer is ready in this long: the board has newer data than a costly one, or work up to the end of a range is still to be credited. */
  refreshInMs: number | null;
};

/** What happened to a source besides its values: limits back before their reset, or free resets granted. */
export type SourceEvent =
  | {sourceId: string; at: number; kind: 'early_reset'; windows: string[]}
  | {sourceId: string; at: number; kind: 'resets_granted'; count: number};

/** The last six hours ran `times` as fast as usual; at that pace the window runs out at `zero`. */
export type Burst = {times: number; zero: number};

/**
 * What a weekly window's forecast goes by: hours of history, under a day of them (`cold`),
 * what the subscription usually spends a day, the last day against that (null for a
 * straight line) and a burst of the last hours.
 */
export type ForecastBasis = {hours: number; cold: boolean; usualPerDay: number; lastDay: number | null; burst: Burst | null};

/**
 * Where the recent pace of a weekly window leads, as the hub works it out (spec/dashboard-v1.md:
 * `forecast`), as of `asOf`, about the window resetting at `resetAt`. Its line is
 * [minutes from the anchor, left]; `lib/forecast.ts` reads it.
 */
export type SeriesForecast = {
  state: 'none' | 'needData' | 'usedUp' | 'awaiting' | 'runsOut' | 'lasts';
  failed?: true;
  asOf: number;
  resetAt: number | null;
  anchor: {at: number; left: number} | null;
  F: number | null;
  zero: number | null;
  shownZero: number | null;
  shownLeft: number | null;
  comfy: boolean;
  points: [number, number][] | null;
  basis: ForecastBasis | {hours: number} | null;
};

/** A source's forecasts, by the id of each of its weekly windows. */
export type SourceForecast = Record<string, SeriesForecast>;

/** Hidden windows and chart series are keyed by source + window, never by provider. */
export const windowKey = (sourceId: string, windowId: string) => `${sourceId}/${windowId}`;
