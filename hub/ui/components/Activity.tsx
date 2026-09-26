import {memo, useEffect, useId, useMemo, useRef, useState, type PointerEvent} from 'react';
import {MINUTE, useNow} from '../lib/api';
import type {Activity as ActivityData, ActivityDimension, ActivityGroup, History as HistoryData, Overview} from '../lib/types';
import {clock, num, shortDay, stamp, workHours} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {activityScale, atOnce, groupColors} from '../lib/activity';
import {ACTIVITY_BY, setPrefs, usePrefs} from '../lib/prefs';
import {useTimeRange} from '../lib/timeRange';
import {cellLabel, frameOf, measuredTo, niceTicks} from '../lib/periods';
import {ACTIVITY, cardId, isHidden, withHidden, type Arrange} from '../lib/view';
import {t, useLocale, type Key} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon} from './Popover';
import {Tooltip, useTip} from './Tooltip';

const LABELS: Record<ActivityDimension, Key> = {source: 'activity.bySource', project: 'activity.byProject', device: 'activity.byDevice'};

/** A group as the legend and the tooltip name it. */
function groupName(group: ActivityGroup, by: ActivityDimension, overview: Overview | null) {
  if (group.other) return t('activity.other', {count: group.count ?? 0});
  if (by === 'source') {
    const source = overview?.sources.find(s => s.id === group.key);
    return source ? sourceLabel(source) : group.key;
  }
  return group.name ?? (by === 'project' ? t('activity.noProject') : group.key);
}

/**
 * How agents worked over the analytics' period, on its time axis: in each cell of the
 * grid, a stack of the time agents worked there, split by subscription, project or
 * machine (the reader's choice). Each moment is split among the agents working then, so a
 * stack is as tall as the cell's work; each group in the legend has how long its own
 * agents worked, which is more than its parts where others worked alongside. It follows
 * the period, a range dragged on the chart and moving through time, as the chart and the
 * table do, and shows only what the board shows. The part of the period before the hub
 * knew how agents worked is marked as such rather than drawn empty.
 */
export const Activity = memo(function Activity({
  history,
  loading,
  overview,
  arrange,
}: {
  history: HistoryData | null;
  /** Another period is loading; `history` is the previous one until it comes. */
  loading: boolean;
  overview: Overview | null;
  arrange: Arrange;
}) {
  const now = useNow(MINUTE);
  const prefs = usePrefs();
  const by = prefs.activityBy;
  useLocale();
  const selected = useTimeRange();
  const historyStart = overview?.historyStart ?? history?.historyStart ?? 0;
  const frame = frameOf(selected, prefs, now, historyStart);
  const from = frame.from;
  const to = measuredTo(frame, history, selected, prefs.range);
  const activity = history?.activity ?? null;
  const cellMs = history?.cellMs ?? MINUTE;
  const groups = activity?.by[by] ?? [];
  const colors = groupColors(groups, by, arrange.view, source => overview?.sources.find(s => s.id === source)?.provider ?? '');
  const shownSources = overview?.sources.filter(source => !isHidden(arrange.view, cardId(source.id))) ?? [];
  // Known from later than the period the hub answered begins (not the page's frame, whose clock may be a minute behind).
  const since = history && activity?.known && activity.known.from > history.since ? activity.known.from : null;

  const empty = !history
    ? t('history.loading')
    : !shownSources.length
      ? t('activity.noSources')
      : !activity?.known
        ? t('activity.knownFrom', {time: stamp(activity?.since ?? now)})
        : !activity.workMs
          ? t('activity.none')
          : null;

  return (
    <section className={`panel activity ${loading ? 'is-loading' : ''}`} aria-label={t('activity.title')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('activity.title')}</h2>
        <div className="activity-controls">
          <Segmented value={by} onChange={next => setPrefs({activityBy: next})} options={ACTIVITY_BY.map(key => [key, t(LABELS[key])])} label={t('activity.by')} />
          {arrange.owner && (
            <Popover label={t('activity.settings')} icon={<SlidersIcon />}>
              <HideRow onHide={() => arrange.update(view => withHidden(view, ACTIVITY, true))}>{t('widget.hide')}</HideRow>
            </Popover>
          )}
        </div>
      </div>
      {activity?.known && activity.workMs > 0 && (
        <div className="activity-totals">
          <span title={t('activity.workHint')}>{t('activity.work', {time: workHours(activity.workMs)})}</span>
          <span title={t('activity.agentsHint')}>{t('activity.agents', {time: workHours(activity.agentMs)})}</span>
          <span title={t('activity.atOnceHint')}>{t('activity.atOnce', {value: num(atOnce(activity.agentMs, activity.workMs), 1)})}</span>
          {since !== null && <span className="activity-since">{t('activity.since', {time: stamp(since)})}</span>}
        </div>
      )}
      {empty ? (
        <div className="chart chart-loading">{empty}</div>
      ) : (
        <>
          <Stacks activity={activity!} groups={groups} colors={colors} names={groups.map(group => groupName(group, by, overview))} from={from} to={to} cellMs={cellMs} unknownTo={since} />
          <div className="legend activity-legend">
            {groups.map((group, i) => (
              <span key={group.key} className="legend-item" title={t('activity.legendHint')}>
                <i className="activity-swatch" style={{background: colors[i]}} />
                <span>{groupName(group, by, overview)}</span>
                <b>{workHours(group.ms)}</b>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
});

/** The stacks of the period's cells, with the part before work was known marked, and a cell's tooltip. */
function Stacks({
  activity,
  groups,
  colors,
  names,
  from,
  to,
  cellMs,
  unknownTo,
}: {
  activity: ActivityData;
  groups: ActivityGroup[];
  colors: string[];
  names: string[];
  from: number;
  to: number;
  cellMs: number;
  /** Where what is known of the period begins, when after its start: the part before is marked. */
  unknownTo: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const hatch = useId();
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

  const narrow = width < 560;
  const height = narrow ? 160 : 200;
  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const span = Math.max(MINUTE, to - from);
  const x = (at: number) => left + ((Math.min(to, Math.max(from, at)) - from) / span) * (width - left - right);
  const vertical = activityScale(activity, cellMs);
  /** How tall a part is: a share of its cell, or time. */
  const size = (ms: number) => (vertical.share ? ms / cellMs : ms);
  const y = (value: number) => top + (1 - value / vertical.max) * (height - top - bottom);
  const {ticks, daily} = niceTicks(from, to, narrow ? 4 : 7);

  // One path a group, stacked in the order of the groups. Cells wide enough to read as bars
  // stand apart; narrower ones run together into a band, so a long period is not striped,
  // and only the band's edges part it from the groups above and below.
  const paths = useMemo(() => {
    const base = new Map<number, number>();
    const edge = (value: number) => value.toFixed(1);
    const apart = ((width - left - right) * cellMs) / span >= 8;
    const gap = apart ? 0.5 : 0;
    return groups.map(group => {
      const runs: {x0: number; x1: number; low: number; high: number}[][] = [];
      let previous: number | null = null;
      for (const [cell, ms] of group.cells) {
        if (cell + cellMs <= from || cell >= to) continue;
        const low = base.get(cell) ?? 0;
        const high = low + size(ms);
        base.set(cell, high);
        const bar = {x0: x(cell) + gap, x1: x(cell + cellMs) - gap, low, high};
        if (!apart && previous === cell - cellMs) runs.at(-1)!.push(bar);
        else runs.push([bar]);
        previous = cell;
      }
      return runs
        .map(run => {
          const top = run.flatMap(bar => [`${edge(bar.x0)},${edge(y(bar.high))}`, `${edge(bar.x1)},${edge(y(bar.high))}`]);
          const bottom = [...run].reverse().flatMap(bar => [`${edge(bar.x1)},${edge(y(bar.low))}`, `${edge(bar.x0)},${edge(y(bar.low))}`]);
          return `M${[...top, ...bottom].join('L')}Z`;
        })
        .join('');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, from, to, cellMs, width, height, vertical.max]);

  const cell = hover === null ? null : activity.cells.find(([start]) => start === hover);
  const parts = hover === null ? [] : groups.flatMap((group, i) => group.cells.filter(([start]) => start === hover).map(([, ms]) => ({name: names[i], color: colors[i], ms, key: group.key})));
  const hoverX = hover === null ? 0 : x(Math.max(from, Math.min(to, hover + cellMs / 2)));
  const {tip, style: tipStyle} = useTip(svg, {width, at: hoverX, narrow, rises: narrow, bottom: height * scale});

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < left || px > width - right) return setHover(null);
    const at = from + ((px - left) / (width - left - right)) * span;
    setHover(Math.floor(at / cellMs) * cellMs);
  };

  return (
    <div className="chart activity-chart" ref={box}>
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('activity.label')} onPointerMove={move} onPointerLeave={() => setHover(null)}>
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" x2="0" y1="0" y2="6" className="activity-hatch" />
          </pattern>
        </defs>
        {vertical.ticks.map(value => (
          <g key={value}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'axis-line' : 'grid'} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className="tick">
              {vertical.share ? `${num(value * 100)}%` : value ? workHours(value) : '0'}
            </text>
          </g>
        ))}
        {ticks.map(tick => (
          <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
            {daily ? shortDay(tick) : clock(tick)}
          </text>
        ))}
        {unknownTo !== null && (
          <g className="activity-unknown">
            <rect x={x(from)} width={x(unknownTo) - x(from)} y={top} height={height - top - bottom} fill={`url(#${hatch})`} />
            {x(unknownTo) - x(from) > 170 && (
              <text x={(x(from) + x(unknownTo)) / 2} y={top + (height - top - bottom) / 2} textAnchor="middle" className="activity-unknown-label">
                {t('activity.notKnown', {time: stamp(unknownTo)})}
              </text>
            )}
          </g>
        )}
        {hover !== null && cell && <rect x={x(hover)} width={Math.max(1, x(hover + cellMs) - x(hover))} y={top} height={height - top - bottom} className="hover-band" />}
        {groups.map((group, i) => (
          <path key={group.key} d={paths[i]} fill={colors[i]} className="activity-stack" />
        ))}
      </svg>
      {hover !== null && cell && (
        <Tooltip tip={tip} className={narrow ? 'is-below' : ''} style={tipStyle}>
          <div className="tooltip-time">{cellLabel(hover, cellMs)}</div>
          <div className="tooltip-grid" style={{gridTemplateColumns: '14px minmax(0, 1fr) auto'}}>
            {parts.map(part => (
              <div className="tooltip-row" key={part.key}>
                <i className="activity-swatch" style={{background: part.color}} />
                <span className="tooltip-name">{part.name}</span>
                <strong>{workHours(part.ms)}</strong>
              </div>
            ))}
          </div>
          <div className="tooltip-sep" />
          <div className="tooltip-grid" style={{gridTemplateColumns: 'minmax(0, 1fr) auto'}}>
            <div className="tooltip-row">
              <span className="tooltip-name">{t('activity.total')}</span>
              <strong>{workHours(cell[1])}</strong>
            </div>
            <div className="tooltip-row">
              <span className="tooltip-name">{t('activity.cellAtOnce')}</span>
              <strong>{num(atOnce(cell[2], cell[1]), 1)}</strong>
            </div>
          </div>
        </Tooltip>
      )}
    </div>
  );
}
