/** A window's length as the agent classifies it. */
export type Kind = 'session' | 'weekly' | 'other';

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

export type FreeResets = {available: number; expiresAt: number | null};

export type SourceState = {
  id: string;
  provider: string;
  plan: string;
  successAt: number | null;
  error: string | null;
  stale: boolean;
  windows: Win[];
  /** Free resets of the limits the account holds, when its client reports them. */
  resets: FreeResets | null;
  /** The people on the board whose devices measure this source. */
  owners: string[];
  /** Measured by the reader's own devices: theirs to take off a shared board. */
  mine: boolean;
  /** How the dashboard names the source (set by the client from the whole board). */
  title?: string;
};

/**
 * How a board is arranged, the same for everyone on it; its owner changes it. Widgets
 * are `source:<id>` cards, the `history` chart and the `forecast` table.
 */
export type View = {
  /** Widget ids in order; widgets missing here come after, in the board's order. */
  order: string[];
  /** Columns of the twelve a widget spans, where not its default. */
  sizes: Record<string, number>;
  /** Names the board's owner gave cards, by source id. */
  names: Record<string, string>;
  hidden: string[];
  /** `windowKey`s of windows hidden from cards and the chart. */
  windows: string[];
  /** Weekly spending plans by source id; absent means the default. */
  plans: Record<string, number[]>;
  /** Source ids whose plan is switched off on this board. */
  unplanned: string[];
  /** Colours given to cards, by source id, instead of the provider's. */
  colors: Record<string, string>;
};

export type Overview = {
  board: {id: string; name: string; personal: boolean; role: 'owner' | 'member'};
  view: View;
  historyStart: number;
  /** Changes whenever the board's data changes. */
  revision: number;
  sources: SourceState[];
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
};

export type History = {
  /** Set by the client: which board the history was read for. */
  board?: string;
  /** '24h', '7d', '30d', or `from-to` of a span selected on the chart. */
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
  /** The board has newer data than this answer; a newer answer is ready in this long. */
  refreshInMs: number | null;
};

/** What happened to a source besides its values: limits back before their reset, or free resets granted. */
export type SourceEvent =
  | {sourceId: string; at: number; kind: 'early_reset'; windows: string[]}
  | {sourceId: string; at: number; kind: 'resets_granted'; count: number};

/** Hidden windows and chart series are keyed by source + window, never by provider. */
export const windowKey = (sourceId: string, windowId: string) => `${sourceId}/${windowId}`;
