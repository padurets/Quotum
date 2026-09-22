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
  accountKey: string;
  plan: string;
  confidence: string;
  successAt: number | null;
  attemptAt: number;
  error: string | null;
  stale: boolean;
  windows: Win[];
};

export type Overview = {
  now: number;
  collectionStart: number;
  collecting: boolean;
  nextAt: number;
  cycle: number;
  intervalMs: number;
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
