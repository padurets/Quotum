type Panel = {
  index: number; kind: string; loading: boolean; error: boolean; rangeMatch: boolean | null;
  ready: boolean | null; panning: boolean | null; panEnd: number | null; from: number | null; to: number | null;
};

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stamp = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** The page already captured this state at its deadline; never query it again or retain its text. */
export function panningSettlement(error: unknown): {status: 'available'; panels: Panel[]; flights: number} | {status: 'unavailable'} {
  const unavailable = {status: 'unavailable'} as const;
  if (!(error instanceof Error) || error.message.length > 16_384) return unavailable;
  const marker = 'charts and complete totals did not settle: ', start = error.message.indexOf(marker);
  if (start < 0) return unavailable;
  try {
    const detail = object(JSON.parse(error.message.slice(start + marker.length).split('\n')[0]));
    if (!detail || typeof detail.wanted !== 'string' || detail.wanted.length > 96 || !Array.isArray(detail.panels) || detail.panels.length > 8 || !Array.isArray(detail.flights) || detail.flights.length > 32) return unavailable;
    const panels: Panel[] = [];
    for (const [index, value] of detail.panels.entries()) {
      const panel = object(value);
      if (!panel || typeof panel.class !== 'string' || panel.class.length > 512) return unavailable;
      const plot = object(panel.plot);
      const classes = panel.class.split(/\s+/);
      panels.push({index, kind: ['history', 'activity', 'budget-history', 'subscription-funds', 'forecast', 'budget-table'].find(kind => classes.includes(kind)) ?? 'unknown',
        loading: classes.includes('is-loading'), error: typeof panel.error === 'string' && panel.error.length > 0,
        rangeMatch: typeof panel.range === 'string' ? panel.range === detail.wanted : null,
        ready: plot?.drawReady === 'true' ? true : plot?.drawReady === 'false' ? false : null,
        panning: typeof panel.panning === 'boolean' ? panel.panning : null,
        panEnd: stamp(plot?.panEnd), from: stamp(plot?.drawFrom), to: stamp(plot?.drawTo)});
    }
    return {status: 'available', panels, flights: detail.flights.length};
  } catch {return unavailable;}
}
