/** Shared subscription refresh state. Times are the hub's epoch milliseconds. */
export type Refresh = {
  unavailable: 'no_device' | 'unsupported' | 'silent' | 'paused' | null;
  availableAt: number | null;
  retryAt: number | null;
  request: RefreshRequest | null;
};

export type RefreshRequest = {
  requestedAt: number;
  notBefore: number;
  dispatchAt: number | null;
  deadline: number;
  status: 'queued' | 'waiting' | 'updated' | 'failed' | 'unavailable' | 'no_result';
  finishedAt: number | null;
};

export const REFRESH_WAIT_MS = 300_000;
export const REFRESH_KEEP_MS = 60_000;
