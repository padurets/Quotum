import {useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent} from 'react';
import {clock, day, duration, num, shortDay, stamp} from '../lib/format';
import {t} from '../i18n';
import {valueIn, type Line} from '../lib/lines';
import {draggedRange, type TimeRange} from '../lib/timeRange';

/**
 * A moment on the time axis: ahead, a known window reset or an announced extra one;
 * behind (`past`), something that happened to a source, such as an early reset.
 */
export type Marker = {key: string; at: number; label: string; color: string; strong?: boolean; past?: boolean; detail?: string};

/** How long a finger rests on the chart before it starts a range. */
const HOLD_MS = 450;

/** The mark of a past event: a small diamond centred at (x, y). */
const diamond = (x: number, y: number, r = 4) => `M${x},${y - r}l${r},${r}l${-r},${r}l${-r},${-r}z`;

/** The spending plan of one weekly window, drawn as a faint dotted line in its colour; `lines` are the keys of the lines it plans. */
export type PlanLine = {key: string; lines: string[]; name: string; color: string; runs: [number, number][][]};

/** How wide an announcement's label is taken to be, and how near an edge a value hides under it (percent). */
const LABEL_WIDTH = 220;
const LABEL_BAND = 15;

/** A label on the chart on a backing sized to its text, so no line under it gets in the way. */
function MarkerLabel({x, y, end, children}: {x: number; y: number; end: boolean; children: string}) {
  const text = useRef<SVGTextElement>(null);
  const [box, setBox] = useState<{x: number; width: number} | null>(null);
  useLayoutEffect(() => {
    const measured = text.current?.getBBox();
    if (measured) setBox({x: measured.x, width: measured.width});
  }, [x, y, end, children]);
  return (
    <g className="marker-label">
      {box && <rect x={box.x - 6} y={y - 13} width={box.width + 12} height={19} rx={5} />}
      <text ref={text} x={x} y={y} textAnchor={end ? 'end' : 'start'}>
        {children}
      </text>
    </g>
  );
}

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

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * A cell's times under its day. Cells are laid on UTC, so one may cross midnight here, and
 * then each end names its day; a time within a cell, shorter than a day, then reads as one
 * moment, save for the hour the clocks go back.
 */
export function cellLabel(at: number, cellMs: number) {
  if (!cellMs) return stamp(at);
  const end = at + cellMs;
  return sameDay(at, end - 1) ? `${day(at)} ${clock(at)}–${clock(end)}` : `${stamp(at)} – ${stamp(end)}`;
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
  onSelect,
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
  /** A time range dragged across the chart, as in Grafana. */
  onSelect?: (range: TimeRange) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  /** Start of the hovered cell. */
  const [hover, setHover] = useState<number | null>(null);
  /** Where a drag across the chart started and where it is now, in chart pixels. */
  const [drag, setDrag] = useState<{start: number; end: number} | null>(null);
  /** A finger held on the chart, before it starts a range. */
  const holding = useRef<{px: number; timer: ReturnType<typeof setTimeout>} | null>(null);
  useEffect(() => () => cancelHold(), []);

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

  const readout =
    hover === null
      ? []
      : lines.flatMap(line => {
          const value = valueIn(line.points, hover, now, Math.max(cellMs, line.staleAfterMs));
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
  // A plan is read beside what its source has left; one with nothing read there stands on its own.
  const planOf = (line: string) => planReadout.find(row => row.plan.lines.includes(line));
  const lonePlans = planReadout.filter(row => !readout.some(r => row.plan.lines.includes(r.line.key)));

  const toChart = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  };
  const timeAt = (px: number) => from + ((px - left) / (width - left - right)) * span;
  // A label hides what runs under it: it stands at the bottom of the plot, or at the top
  // when more of the lines run near the bottom there (a limit about to run out).
  const labelY = (anchor: number, end: boolean) => {
    const [a, b] = (end ? [anchor - LABEL_WIDTH, anchor] : [anchor, anchor + LABEL_WIDTH]).map(timeAt);
    let low = 0;
    let high = 0;
    for (const line of lines) {
      for (const [at, value] of line.points) {
        if (at < a || at > b) continue;
        if (value < LABEL_BAND) low++;
        else if (value > 100 - LABEL_BAND) high++;
      }
    }
    return low > high ? top + 18 : height - bottom - 8;
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const px = toChart(event);
    const held = holding.current;
    // A finger that moves before the hold is up reads values instead.
    if (held && Math.abs(px - held.px) > 8) cancelHold();
    if (drag) setDrag({...drag, end: Math.min(width - right, Math.max(left, px))});
    if (px < left || px > width - right) return setHover(null);
    setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
  };
  const cancelHold = () => {
    if (holding.current) clearTimeout(holding.current.timer);
    holding.current = null;
  };
  // A mouse or a pen drags a range at once. A finger sliding along the chart reads its
  // values, as it always did; holding it still for a moment starts a range instead.
  const press = (event: PointerEvent<SVGSVGElement>) => {
    const px = toChart(event);
    if (!onSelect || event.button !== 0 || px < left || px > width - right) return;
    const svg = event.currentTarget;
    const {pointerId} = event;
    const start = () => {
      holding.current = null;
      svg.setPointerCapture(pointerId);
      setDrag({start: px, end: px});
    };
    if (event.pointerType !== 'touch') return start();
    cancelHold();
    holding.current = {px, timer: setTimeout(start, HOLD_MS)};
  };
  // A drag of a few pixels is a click.
  const release = () => {
    cancelHold();
    if (!drag || !onSelect) return;
    setDrag(null);
    const range = Math.abs(drag.end - drag.start) >= 6 ? draggedRange(timeAt(drag.start), timeAt(drag.end), now) : null;
    if (range) onSelect(range);
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
        className={onSelect ? 'is-selectable' : undefined}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={() => {
          cancelHold();
          setDrag(null);
        }}
        // A held finger starts a range, not the page's menu.
        onContextMenu={event => (holding.current || drag) && event.preventDefault()}
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
          if (marker.at > to) return null;
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
          return (
            <g key={marker.key} className={`marker ${marker.strong ? 'is-strong' : ''}`}>
              <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.strong ? undefined : marker.color} />
              {!marker.strong && <circle cx={mx} cy={y(100)} r={3} fill={marker.color} />}
              <title>{`${marker.label} · ${cellLabel(marker.at, 0)}`}</title>
            </g>
          );
        })}
        {lines.map((line, i) => (
          <path key={line.key} d={paths[i].line} className="series" stroke={line.color} strokeDasharray={line.dash || undefined} />
        ))}
        {/* Announcements are read over the lines, each on its own backing. */}
        {markers
          .filter(marker => marker.strong && !marker.past)
          .map(marker => {
            const beyond = marker.at > to;
            const mx = beyond ? width - right : x(marker.at);
            // Beyond the visible future: at the right edge, with the distance.
            const nearRight = beyond || mx > width - right - 150;
            const lx = beyond ? mx : nearRight ? mx - 6 : mx + 6;
            return (
              <MarkerLabel key={marker.key} x={lx} y={labelY(lx, nearRight)} end={nearRight}>
                {beyond ? t('chart.ahead', {label: marker.label, time: duration(marker.at - now, true)}) : marker.label}
              </MarkerLabel>
            );
          })}
        {hover === null &&
          lines.map((line, i) =>
            paths[i].last ? (
              <g key={`${line.key}-end`}>
                <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={7} fill={line.color} opacity={0.18} />
                <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={3} fill={line.color} />
              </g>
            ) : null,
          )}
        {drag && (
          <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />
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

      {hover !== null && !drag && readout.length + lonePlans.length + markerReadout.length > 0 && (
        <div className="tooltip glass" ref={tip} style={{left: tipLeft}}>
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
                {planOf(row.line.key) && <em className="tooltip-plan">{t('chart.planValue', {value: num(planOf(row.line.key)!.value)})}</em>}
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
          {lonePlans.length > 0 && <div className="tooltip-sep" />}
          {lonePlans.map(row => (
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
