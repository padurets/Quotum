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
  /** Owners of the devices that measure this source. */
  owners: string[];
  /** How the dashboard names the source (set by the client from the whole board). */
  title?: string;
};

export type Overview = {
  board: {id: string; name: string; personal: boolean; role: 'owner' | 'member'};
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
  /** [cell start, remaining percent, line segment] */
  points: [number, number, number][];
};

export type History = {
  /** Set by the client: which board the history was read for. */
  board?: string;
  range: string;
  now: number;
  since: number;
  /** Width of the shared time grid every series is placed on. */
  cellMs: number;
  historyStart: number;
  series: HistorySeries[];
};

/** Preferences and chart series are keyed by source + window, never by provider. */
export const windowKey = (sourceId: string, windowId: string) => `${sourceId}/${windowId}`;
