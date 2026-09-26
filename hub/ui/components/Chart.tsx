import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject} from 'react';
import {clock, day, duration, num, shortDay, stamp} from '../lib/format';
import {t} from '../i18n';
import type {Line} from '../lib/lines';
import {gapText, gapTone, readout as readCell, type PlanLine} from '../lib/readout';
import {draggedRange, type TimeRange} from '../lib/timeRange';
import {SWIPE, swiped} from '../lib/swipe';

/**
 * A moment on the time axis: ahead, a known window reset or an announced extra one;
 * behind (`past`), something that happened to a source, such as an early reset.
 */
export type Marker = {key: string; at: number; label: string; color: string; strong?: boolean; past?: boolean; detail?: string};

/** How long a finger rests on the chart before it starts a range. */
const HOLD_MS = 450;

/** The mark of a past event: a small diamond centred at (x, y). */
const diamond = (x: number, y: number, r = 4) => `M${x},${y - r}l${r},${r}l${-r},${r}l${-r},${-r}z`;

/** How wide an announcement's label is taken to be, and how near an edge a value hides under it (percent). */
const LABEL_WIDTH = 220;
const LABEL_BAND = 15;

/**
 * A label on the chart on a backing sized to its text, so no line under it gets in the way.
 * One pointing past the right edge tells its exact time under the pointer or on a tap
 * (`onTip`).
 */
function MarkerLabel({x, y, end, children, onTip}: {x: number; y: number; end: boolean; children: string; onTip?: (shown: boolean, tapped: boolean) => void}) {
  const text = useRef<SVGTextElement>(null);
  const [box, setBox] = useState<{x: number; width: number} | null>(null);
  useLayoutEffect(() => {
    const measured = text.current?.getBBox();
    if (measured) setBox({x: measured.x, width: measured.width});
  }, [x, y, end, children]);
  return (
    <g
      className={`marker-label ${onTip ? 'is-pointed' : ''}`}
      onPointerEnter={onTip && (event => event.pointerType !== 'touch' && onTip(true, false))}
      onPointerLeave={onTip && (event => event.pointerType !== 'touch' && onTip(false, false))}
      onPointerUp={onTip && (event => event.pointerType === 'touch' && onTip(true, true))}
    >
      {box && <rect x={box.x - 6} y={y - 13} width={box.width + 12} height={19} rx={5} />}
      <text ref={text} x={x} y={y} textAnchor={end ? 'end' : 'start'}>
        {children}
      </text>
    </g>
  );
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

/** How long the chart's content takes to slide in after a step through time. */
const SLIDE_MS = 220;

/**
 * How far the chart's content slides in after it steps through time, in pixels: from
 * where it was drawn to where it is now, so the eye follows which way it went. None
 * unless the period kept its length (`end` is where measurements end) and moved by a
 * tenth of it or more: a step, not a live period's clock moving on, nor another period.
 */
export function slideOf(before: {from: number; end: number}, after: {from: number; end: number; to: number}, plotWidth: number) {
  const length = after.end - after.from;
  const moved = after.from - before.from;
  if (length <= 0 || Math.abs(before.end - before.from - length) > length * 0.01 || Math.abs(moved) < length * 0.1 || Math.abs(moved) > length) return 0;
  return (moved / (after.to - after.from)) * plotWidth;
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
  onStep,
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
  /** A swipe sideways on a touchpad, or Shift with the wheel: back (-1) or forward (1) through time. */
  onStep?: (direction: -1 | 1) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  /** CSS pixels to a unit of the chart: under 1 where the chart is narrower than it is drawn (280). */
  const [scale, setScale] = useState(1);
  /** Start of the hovered cell. */
  const [hover, setHover] = useState<number | null>(null);
  /** Where a drag across the chart started and where it is now, in chart pixels. */
  const [drag, setDrag] = useState<{start: number; end: number} | null>(null);
  /** A finger held on the chart, before it starts a range. */
  const holding = useRef<{px: number; timer: ReturnType<typeof setTimeout>} | null>(null);
  useEffect(() => () => cancelHold(), []);
  /** Where the pointer last was over the chart, in chart pixels: a step reads the values under it anew. */
  const pointer = useRef<number | null>(null);

  // The wheel is heard natively, so the chart can keep a swipe from scrolling the page
  // sideways or going back in the browser. Nothing renders until the gesture steps.
  const svg = useRef<SVGSVGElement>(null);
  const swipe = useRef(SWIPE);
  const stepped = useRef(onStep);
  stepped.current = onStep;
  const dragging = useRef(false);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!stepped.current || dragging.current) return;
      const result = swiped(swipe.current, event);
      swipe.current = result.state;
      if (result.own) event.preventDefault();
      if (result.step) stepped.current(result.step);
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0].contentRect.width;
      const drawn = Math.max(280, Math.round(measured));
      setWidth(drawn);
      setScale(measured ? measured / drawn : 1);
    });
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
          // The answer on screen may be of another period while the next loads: what lies past the end is not drawn.
          if (at > now) break;
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
    [lines, from, now, span, width, height, cellMs],
  );

  const {rows, planned} = hover === null ? {rows: [], planned: false} : readCell(lines, plans, hover, cellMs, now, to);
  const markerReadout = hover === null ? [] : markers.filter(m => m.at >= hover && m.at < hover + cellMs);
  /** A marker past the right edge, its label pointed at or tapped: the tooltip tells its time instead of the cell's values. */
  const [edge, setEdge] = useState<{key: string; tapped: boolean} | null>(null);
  const edgeMarker = edge && markers.find(m => m.key === edge.key && m.at > to);
  // A label taken away under the pointer (a step to a range, which has no future) says nothing
  // of it: what it told is forgotten, so the tooltip reads the cells again.
  useEffect(() => {
    if (edge && !edgeMarker) setEdge(null);
  }, [edge, edgeMarker]);
  useEffect(() => {
    if (!edge?.tapped) return;
    const hide = () => setEdge(null);
    const timer = setTimeout(hide, 4000);
    document.addEventListener('pointerdown', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', hide);
    };
  }, [edge]);

  const toChart = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  };
  const timeAt = (px: number) => from + ((px - left) / (width - left - right)) * span;
  dragging.current = drag !== null;
  // After a step the pointer stands over another time: the tooltip reads that.
  useEffect(() => {
    const px = pointer.current;
    if (px !== null && px >= left && px <= width - right) setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cellMs]);
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
    pointer.current = px;
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
    // A label telling a time is read, not dragged from.
    if (!onSelect || event.button !== 0 || px < left || px > width - right || (event.target as Element).closest('.is-pointed')) return;
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
  // A step through time slides what the chart shows in from the side it came from. The
  // layers that move are clipped to the plot meanwhile, so nothing passes over the scale.
  const clip = useId();
  const shown = useRef<{from: number; end: number} | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = {from, end: now};
    const element = svg.current;
    if (!before || !element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dx = slideOf(before, {from, end: now, to}, width - left - right);
    if (!dx) return;
    for (const layer of element.querySelectorAll<SVGGElement>('.slides')) {
      const frame = layer.parentElement!;
      // A step taken while the last one still slides goes on from where that one is, not back.
      const moving = getComputedStyle(layer).transform;
      const start = dx + (moving === 'none' ? 0 : new DOMMatrix(moving).m41);
      layer.getAnimations().forEach(animation => animation.cancel());
      frame.setAttribute('clip-path', `url(#${CSS.escape(clip)})`);
      const animation = layer.animate([{transform: `translateX(${start}px)`}, {transform: 'none'}], {duration: SLIDE_MS, easing: 'cubic-bezier(.2, .7, .3, 1)'});
      animation.onfinish = () => frame.removeAttribute('clip-path');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, now]);

  // On a narrow chart it spans the chart's width under the plot, over what comes below, and
  // rises over the plot as far as keeps it whole in the window (a phone with many lines),
  // though never under the bars that stick at the top.
  // The page scrolling under a pointer that stays measures it again.
  const tip = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(200);
  const [lift, setLift] = useState(0);
  const lifted = useRef(0);
  const narrow = width < 560;
  useLayoutEffect(() => {
    const element = tip.current;
    if (!element) return;
    setTipWidth(element.offsetWidth);
    if (!narrow) {
      lifted.current = 0;
      return setLift(0);
    }
    const fit = () => {
      const rect = element.getBoundingClientRect();
      const [top, bottom] = [rect.top + lifted.current, rect.bottom + lifted.current];
      const bars = [...document.querySelectorAll<HTMLElement>('.topbar, .analytics-head')].filter(bar => getComputedStyle(bar).position === 'sticky');
      const cover = Math.max(0, ...bars.map(bar => bar.getBoundingClientRect().bottom));
      lifted.current = Math.max(0, Math.min(bottom - (innerHeight - 8), top - cover - 8));
      setLift(lifted.current);
    };
    fit();
    addEventListener('scroll', fit, {passive: true});
    return () => removeEventListener('scroll', fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, edge, narrow, lines.length]);
  // Beside the pointer: right of it, or left, or where there is more room when it fits
  // neither side, narrowed to that room (its names wrap) rather than over the pointer.
  const roomRight = width - hoverX - 12;
  const roomLeft = hoverX - 12;
  const onRight = tipWidth <= roomRight || (tipWidth > roomLeft && roomRight >= roomLeft);
  const tipRoom = Math.min(360, Math.max(0, onRight ? roomRight : roomLeft));
  const tipLeft = onRight ? hoverX + 12 : Math.max(0, hoverX - 12 - Math.min(tipWidth, tipRoom));
  const bandWidth = Math.max(1, x(Math.min(to, (hover ?? 0) + cellMs)) - x(hover ?? 0));

  return (
    <div className="chart" ref={box}>
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('chart.label')}
        className={onSelect ? 'is-selectable' : undefined}
        onPointerMove={move}
        onPointerLeave={() => {
          pointer.current = null;
          setHover(null);
        }}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={() => {
          cancelHold();
          setDrag(null);
        }}
        // A held finger starts a range, not the page's menu.
        onContextMenu={event => (holding.current || drag) && event.preventDefault()}
      >
        <defs>
          <clipPath id={clip}>
            <rect x={left} y={0} width={width - left - right} height={height} />
          </clipPath>
        </defs>
        <g>
          <g className="slides">
            {to > now && (
              <g className="future">
                <rect x={x(now)} width={x(to) - x(now)} y={top} height={height - top - bottom} className="future-zone" />
                <line x1={x(now)} x2={x(now)} y1={top} y2={height - bottom} className="now-line" />
              </g>
            )}
          </g>
        </g>
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
        <g>
          <g className="slides">
            {ticks.map(tick => (
              <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
                {daily ? shortDay(tick) : clock(tick)}
              </text>
            ))}
          </g>
        </g>

        <g>
          <g className="slides">
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
                  <MarkerLabel
                    key={marker.key}
                    x={lx}
                    y={labelY(lx, nearRight)}
                    end={nearRight}
                    onTip={beyond ? (shown, tapped) => setEdge(shown ? {key: marker.key, tapped} : null) : undefined}
                  >
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
          </g>
        </g>
        {drag && (
          <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />
        )}
        {hover !== null && (
          <g className="crosshair">
            <rect x={x(hover)} width={bandWidth} y={top} height={height - top - bottom} className="hover-band" />
            <line x1={hoverX} x2={hoverX} y1={top} y2={height - bottom} />
            {rows.map(row => row.value !== null && <circle key={row.line.key} cx={hoverX} cy={y(row.value)} r={4} fill={row.line.color} />)}
          </g>
        )}
      </svg>

      {edgeMarker ? (
        <Tooltip tip={tip} className="is-edge" style={{right: 0, bottom: `calc(100% - ${(labelY(width - right, true) - 18) * scale}px)`}}>
          <div className="tooltip-marker is-strong">{edgeMarker.label}</div>
          <div className="tooltip-time">{stamp(edgeMarker.at)}</div>
        </Tooltip>
      ) : (
        hover !== null &&
        !drag &&
        (rows.some(row => row.left !== null || row.plan !== null) || markerReadout.length > 0) && (
          <Tooltip tip={tip} className={narrow ? 'is-below' : ''} style={narrow ? {top: height * scale - lift} : {left: tipLeft, maxWidth: tipRoom}}>
            <div className="tooltip-time">{cellLabel(hover, cellMs)}</div>
            {rows.length > 0 && (
              <div className={`tooltip-grid ${planned ? 'is-planned' : ''}`}>
                <span />
                <span />
                <span className="tooltip-head">{t('chart.left')}</span>
                {planned && (
                  <>
                    <span className="tooltip-head">{t('chart.plan')}</span>
                    <span className="tooltip-head">{t('chart.gap')}</span>
                  </>
                )}
                {rows.map(row => (
                  <div className="tooltip-row" key={row.line.key}>
                    <svg width="14" height="4" aria-hidden="true">
                      <line x1="0" x2="14" y1="2" y2="2" stroke={row.line.color} strokeWidth="2" strokeDasharray={row.line.dash || undefined} />
                    </svg>
                    <span className="tooltip-name">{row.line.name}</span>
                    <strong>{row.left !== null && `${num(row.left)}%`}</strong>
                    {planned && (
                      <>
                        <span className="tooltip-plan">{row.plan !== null && `${num(row.plan)}%`}</span>
                        <span className={`tooltip-gap ${row.gap !== null ? gapTone(row.gap) : ''}`}>{row.gap !== null && gapText(row.gap)}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {rows.length > 0 && markerReadout.length > 0 && <div className="tooltip-sep" />}
            {markerReadout.map(marker => (
              <div className={`tooltip-mark ${marker.strong ? 'is-strong' : ''}`} key={marker.key}>
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
          </Tooltip>
        )
      )}
      {!lines.length && empty && <div className="chart-empty">{empty}</div>}
    </div>
  );
}

/** The chart's own tooltip, glass as the popovers are; it lies over the widgets below, under the sticky bars. */
function Tooltip({tip, className, style, children}: {tip: RefObject<HTMLDivElement | null>; className: string; style: CSSProperties; children: ReactNode}) {
  return (
    <div className={`tooltip glass ${className}`} ref={tip} style={style}>
      {children}
    </div>
  );
}
