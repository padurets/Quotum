import {useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent} from 'react';
import {clock, duration, num, shortDay} from '../lib/format';
import {t} from '../i18n';
import type {Line} from '../lib/lines';

/**
 * A moment on the time axis: ahead, a known window reset or an announced extra one;
 * behind (`past`), something that happened to a source, such as an early reset.
 */
export type Marker = {key: string; at: number; label: string; color: string; strong?: boolean; past?: boolean; detail?: string};

/** The mark of a past event: a small diamond centred at (x, y). */
const diamond = (x: number, y: number, r = 4) => `M${x},${y - r}l${r},${r}l${-r},${r}l${-r},${-r}z`;

/** The spending plan of one weekly window, drawn as a faint dotted line in its colour. */
export type PlanLine = {key: string; name: string; color: string; runs: [number, number][][]};

/** Value of a piecewise-linear run at time `at`, or undefined outside it. */
function valueAt(runs: [number, number][][], at: number) {
  for (const run of runs) {
    if (at < run[0][0] || at > run.at(-1)![0]) continue;
    for (let i = 1; i < run.length; i++) {
      const [t0, v0] = run[i - 1];
      const [t1, v1] = run[i];
      if (at <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (at - t0)) / (t1 - t0);
    }
  }
  return undefined;
}


function niceTicks(from: number, to: number, count: number) {
  const span = to - from;
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(minutes => minutes * 60_000);
  const step = steps.find(candidate => span / candidate <= count) ?? steps.at(-1)!;
  const offset = new Date().getTimezoneOffset() * 60_000;
  const ticks: number[] = [];
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) ticks.push(t);
  return {ticks, daily: step >= 86_400_000};
}

function cellLabel(at: number, cellMs: number) {
  const date = shortDay(at);
  return cellMs ? `${date}, ${clock(at)}–${clock(at + cellMs)}` : `${date}, ${clock(at)}`;
}

/**
 * Remaining quota over time for every selected window. All series share one time
 * grid, so hovering anywhere snaps to a cell and reads every series for it — no
 * pixel hunting. Lines break only where a whole cell is empty.
 */
export function Chart({
  lines,
  plans = [],
  markers = [],
  from,
  now,
  to,
  cellMs,
  empty,
}: {
  lines: Line[];
  plans?: PlanLine[];
  markers?: Marker[];
  from: number;
  /** Where measurements end; everything right of it is the future. */
  now: number;
  to: number;
  cellMs: number;
  /** Said over an empty chart; none when the legend already says it. */
  empty: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  /** Start of the hovered cell. */
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.round(entries[0].contentRect.width))));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const height = width < 560 ? 220 : 300;
  const left = 40;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const span = Math.max(60_000, to - from);
  const x = (at: number) => left + ((Math.min(to, Math.max(from, at)) - from) / span) * (width - left - right);
  /** A cell is drawn at its middle (the last, partial one at "now"). */
  const bx = (cell: number) => x(Math.min(now, cell + cellMs / 2));
  const y = (value: number) => top + (1 - value / 100) * (height - top - bottom);
  const {ticks, daily} = niceTicks(from, to, width < 560 ? 4 : 7);

  const paths = useMemo(
    () =>
      lines.map(line => {
        const runs: [number, number][][] = [];
        let segment = -1;
        let previousX = -1;
        for (const [at, remaining, group] of line.points) {
          if (at + cellMs < from) continue;
          const px = bx(at);
          const py = y(remaining);
          if (group !== segment) {
            runs.push([]);
            segment = group;
          } else if (px - previousX < 0.5) continue;
          runs.at(-1)!.push([px, py]);
          previousX = px;
        }
        const fixed = (value: number) => value.toFixed(1);
        return {
          line: runs.map(run => run.map(([px, py], i) => `${i ? 'L' : 'M'}${fixed(px)},${fixed(py)}`).join('')).join(''),
          last: runs.at(-1)?.at(-1) ?? null,
        };
      }),
    [lines, from, span, width, height, cellMs],
  );

  const byBucket = useMemo(() => lines.map(line => new Map(line.points.map(([at, value]) => [at, value]))), [lines]);
  const readout =
    hover === null
      ? []
      : lines.flatMap((line, i) => {
          const value = byBucket[i].get(hover);
          return value === undefined ? [] : [{line, value}];
        });
  const markerReadout = hover === null ? [] : markers.filter(m => m.at >= hover && m.at < hover + cellMs);
  const planReadout =
    hover === null
      ? []
      : plans.flatMap(plan => {
          const value = valueAt(plan.runs, Math.min(to, hover + cellMs / 2));
          return value === undefined ? [] : [{plan, value}];
        });

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < left || px > width - right) return setHover(null);
    const at = from + ((px - left) / (width - left - right)) * span;
    setHover(Math.floor(at / cellMs) * cellMs);
  };
  // A cell ahead of now is read at its middle; the one holding now, at now.
  const hoverX = hover === null ? 0 : hover > now ? x(Math.min(to, hover + cellMs / 2)) : bx(hover);
  // The tooltip sits right of the pointer, or left of it when it would leave the chart.
  const tip = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(200);
  useLayoutEffect(() => {
    if (tip.current) setTipWidth(tip.current.offsetWidth);
  }, [hover]);
  const tipLeft = hoverX + 12 + tipWidth <= width ? hoverX + 12 : Math.max(0, hoverX - 12 - tipWidth);
  const bandWidth = Math.max(1, x(Math.min(to, (hover ?? 0) + cellMs)) - x(hover ?? 0));

  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('chart.label')}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
      >
        {to > now && (
          <g className="future">
            <rect x={x(now)} width={x(to) - x(now)} y={top} height={height - top - bottom} className="future-zone" />
            <line x1={x(now)} x2={x(now)} y1={top} y2={height - bottom} className="now-line" />
          </g>
        )}
        <line x1={left} x2={width - right} y1={y(30)} y2={y(30)} className="threshold warn" />
        <line x1={left} x2={width - right} y1={y(10)} y2={y(10)} className="threshold crit" />
        {[0, 25, 50, 75, 100].map(value => (
          <g key={value}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'axis-line' : 'grid'} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className="tick">
              {value}%
            </text>
          </g>
        ))}
        {ticks.map(tick => (
          <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
            {daily ? shortDay(tick) : clock(tick)}
          </text>
        ))}

        {plans.map(plan => (
          <path
            key={plan.key}
            className="plan-line"
            stroke={plan.color}
            d={plan.runs.map(run => run.map(([at, value], i) => `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join('')).join('')}
          />
        ))}
        {markers.map(marker => {
          if (marker.at > to) {
            // Beyond the visible future: an arrow at the right edge, with the distance.
            return marker.strong ? (
              <text key={marker.key} x={width - right} y={height - bottom - 8} textAnchor="end" className="marker-label">
                {t('chart.ahead', {label: marker.label, time: duration(marker.at - now, true)})}
              </text>
            ) : null;
          }
          const mx = x(marker.at);
          if (marker.past) {
            return (
              <g key={marker.key} className="marker is-event">
                <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.color} />
                <path d={diamond(mx, top)} fill={marker.color} />
                <title>{[`${marker.label} · ${cellLabel(marker.at, 0)}`, marker.detail].filter(Boolean).join('\n')}</title>
              </g>
            );
          }
          const nearRight = mx > width - right - 150;
          return (
            <g key={marker.key} className={`marker ${marker.strong ? 'is-strong' : ''}`}>
              <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.strong ? undefined : marker.color} />
              {marker.strong ? (
                <text x={nearRight ? mx - 6 : mx + 6} y={height - bottom - 8} textAnchor={nearRight ? 'end' : 'start'} className="marker-label">
                  {marker.label}
                </text>
              ) : (
                <circle cx={mx} cy={y(100)} r={3} fill={marker.color} />
              )}
              <title>{`${marker.label} · ${cellLabel(marker.at, 0)}`}</title>
            </g>
          );
        })}
        {lines.map((line, i) => (
          <path key={line.key} d={paths[i].line} className="series" stroke={line.color} strokeDasharray={line.dash || undefined} />
        ))}
        {hover === null &&
          lines.map((line, i) =>
            paths[i].last ? (
              <g key={`${line.key}-end`}>
                <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={7} fill={line.color} opacity={0.18} />
                <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={3} fill={line.color} />
              </g>
            ) : null,
          )}
        {hover !== null && (
          <g className="crosshair">
            <rect x={x(hover)} width={bandWidth} y={top} height={height - top - bottom} className="hover-band" />
            <line x1={hoverX} x2={hoverX} y1={top} y2={height - bottom} />
            {readout.map(row => (
              <circle key={row.line.key} cx={hoverX} cy={y(row.value)} r={4} fill={row.line.color} />
            ))}
          </g>
        )}
      </svg>

      {hover !== null && readout.length + planReadout.length + markerReadout.length > 0 && (
        <div className="tooltip" ref={tip} style={{left: tipLeft}}>
          <div className="tooltip-time">{cellLabel(hover, cellMs)}</div>
          {[...readout]
            .sort((a, b) => a.value - b.value)
            .map(row => (
              <div className="tooltip-row" key={row.line.key}>
                <svg width="14" height="4" aria-hidden="true">
                  <line x1="0" x2="14" y1="2" y2="2" stroke={row.line.color} strokeWidth="2" strokeDasharray={row.line.dash || undefined} />
                </svg>
                <strong>{num(row.value)}%</strong>
                <span>{row.line.name}</span>
              </div>
            ))}
          {markerReadout.map(marker => (
            <div className={`tooltip-row is-marker ${marker.strong ? 'is-strong' : ''}`} key={marker.key}>
              <svg width="14" height="10" aria-hidden="true">
                {marker.past ? (
                  <path d={diamond(7, 5)} fill={marker.color} />
                ) : (
                  <line x1="7" x2="7" y1="0" y2="10" stroke={marker.strong ? 'var(--accent)' : marker.color} strokeWidth="2" />
                )}
              </svg>
              <strong>{clock(marker.at)}</strong>
              <span>{marker.label}</span>
              {marker.detail && <small className="tooltip-detail">{marker.detail}</small>}
            </div>
          ))}
          {planReadout.length > 0 && <div className="tooltip-sep" />}
          {planReadout.map(row => (
            <div className="tooltip-row is-plan" key={row.plan.key}>
              <svg width="14" height="4" aria-hidden="true">
                <line x1="0" x2="14" y1="2" y2="2" stroke={row.plan.color} strokeWidth="1.5" strokeDasharray="1 3" strokeLinecap="round" />
              </svg>
              <strong>{num(row.value)}%</strong>
              <span>{row.plan.name}</span>
            </div>
          ))}
        </div>
      )}
      {!lines.length && empty && <div className="chart-empty">{empty}</div>}
    </div>
  );
}
