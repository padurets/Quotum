/** One measuring preference for a subscription, wherever the hub shows it. */
export const MEASURE_INTERVAL = {auto: null, one: 60_000, two: 120_000, five: 300_000, fifteen: 900_000} as const;
export type MeasureIntervalMs = (typeof MEASURE_INTERVAL)[keyof typeof MEASURE_INTERVAL];

export function validFrequency(body: unknown): body is {intervalMs: MeasureIntervalMs} {
  return body !== null && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).length === 1 && 'intervalMs' in body &&
    Object.values(MEASURE_INTERVAL).some(value => value === body.intervalMs);
}
