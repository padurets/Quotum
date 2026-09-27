import {sseParser} from '../ui/lib/live.js';

/**
 * The benchmark's own reader of a board's events (spec/dashboard-v1.md), asked for as the
 * page asks: what the hub tells a reader of the board, counted by type. While the board
 * stands still it must tell nothing but `ping`.
 */
export type Heard = {
  counts(): Record<string, number>;
  reset(): void;
  close(): void;
};

export async function hear(base: string, cookie: string, board: string): Promise<Heard> {
  const stop = new AbortController();
  const response = await fetch(`${base}/api/events?board=${encodeURIComponent(board)}`, {headers: {cookie, 'quotum-stream': '1'}, signal: stop.signal});
  if (response.status !== 200 || !response.body) throw new Error(`the board's events: HTTP ${response.status}`);
  let counts: Record<string, number> = {};
  const push = sseParser(type => void (counts[type] = (counts[type] ?? 0) + 1));
  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  void (async () => {
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        push(decoder.decode(value, {stream: true}));
      }
    } catch {
      // Closed by `close`.
    }
  })();
  return {
    counts: () => ({...counts}),
    reset: () => void (counts = {}),
    close: () => stop.abort(),
  };
}
