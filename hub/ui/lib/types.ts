export type Kind = 'session' | 'weekly' | 'other';

export type Win = {
  id: string;
  label: string;
  used: number;
  remaining: number;
  resetAt: number | null;
  minutes: number | null;
};

export type SourceState = {
  id: string;
  provider: string;
  plan: string;
  successAt: number | null;
  attemptAt: number;
  error: string | null;
  stale: boolean;
  windows: Win[];
  /** Owners of the devices that measure this source. */
  owners?: string[];
  /** How the dashboard names the source (set by the client from the whole board). */
  title?: string;
};

export type Overview = {
  board: {id: string; name: string; personal: boolean; role: string};
  now: number;
  collectionStart: number;
  /** Changes whenever the data changes. */
  revision: number;
  sources: SourceState[];
};

export type HistorySeries = {
  sourceId: string;
  provider: string;
  bucket: string;
  label: string;
  minutes: number | null;
  kind: Kind;
  consumed: number;
  coveredMs: number;
  samples: number;
  points: [number, number, number][];
};

export type History = {
  /** Set by the client: which board the history was read for. */
  board?: string;
  range: string;
  now: number;
  since: number;
  /** Width of the shared time grid every series is placed on. */
  bucketMs: number;
  collectionStart: number;
  series: HistorySeries[];
};

/** Preferences and chart series are keyed by source + window, never by provider. */
export const windowKey = (sourceId: string, bucket: string) => `${sourceId}/${bucket}`;
