import {memo, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {MINUTE, useNow} from '../lib/api';
import type {Activity as ActivityData, ActivityDimension, ActivityGroup, History as HistoryData, Overview} from '../lib/types';
import {clock, num, shortDay, stamp, workHours} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {activityEmpty, activityScale, groupColors, mutedKey} from '../lib/activity';
import {ACTIVITY_BY, setMuted, setPrefs, usePrefs} from '../lib/prefs';
import {goTo, setTimeRange, useTimeRange, type TimeRange} from '../lib/timeRange';
import {cellLabel, frameOf, measuredTo, niceTicks, step} from '../lib/periods';
import {ACTIVITY, cardId, isHidden, withHidden, type Arrange} from '../lib/view';
import {t, useLocale, type Key} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon} from './Popover';
import {Tooltip, useTip} from './Tooltip';
import {useTimeAxis} from './timeAxis';

const LABELS: Record<ActivityDimension, Key> = {source: 'activity.bySource', project: 'activity.byProject', device: 'activity.byDevice'};

/** A group as the legend and the tooltip name it. */
function groupName(group: ActivityGroup, by: ActivityDimension, overview: Overview | null) {
  if (by === 'source') {
    const source = overview?.sources.find(s => s.id === group.key);
    return source ? sourceLabel(source) : group.key;
  }
  return group.name ?? (by === 'project' ? t('activity.noProject') : group.key);
}

/** The widget's own settings, as the chart has its own: what its stacks are split by, and (for the board's owner) hiding it. */
function ActivitySettings({arrange}: {arrange: Arrange}) {
  const {activityBy} = usePrefs();
  return (
    <Popover label={t('activity.settings')} icon={<SlidersIcon />}>
      <div className="popover-section">
        <div className="popover-title">{t('activity.by')}</div>
        <div className="popover-pad">
          <Segmented value={activityBy} onChange={next => setPrefs({activityBy: next})} options={ACTIVITY_BY.map(key => [key, t(LABELS[key])])} label={t('activity.by')} />
        </div>
      </div>
      {arrange.owner && <HideRow onHide={() => arrange.update(view => withHidden(view, ACTIVITY, true))}>{t('widget.hide')}</HideRow>}
    </Popover>
  );
}

/**
 * How agents worked over the analytics' period, on its time axis: in each bar (an hour,
 * or the period's cell where that is longer), a stack of the time agents worked there,
 * split by subscription, project or machine (the reader's choice, in its settings). Each
 * moment is split among the agents working then, so a stack is as tall as the bar's work;
 * each group in the legend has how long its own agents worked, which is more than its
 * parts where others worked alongside, and is switched off and on there as a line of the
 * chart is. Over it, the period's work time, how many different agents worked and their
 * time together. It follows the period, a range dragged on it or on the chart and moving
 * through time, as the chart and the table do, and shows only what the board shows. The
 * part of the period before the hub knew how agents worked is marked as such rather than
 * drawn empty.
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
  const groups = activity?.by[by] ?? [];
  const colors = groupColors(groups, by, arrange.view, source => overview?.sources.find(s => s.id === source)?.provider ?? '');
  const names = groups.map(group => groupName(group, by, overview));
  const muted = groups.map(group => !!prefs.muted[mutedKey(by, group.key)]);
  const shownSources = overview?.sources.filter(source => !isHidden(arrange.view, cardId(source.id))) ?? [];
  // Known from later than the period the hub answered begins (not the page's frame, whose clock may be a minute behind).
  const since = history && activity?.known && activity.known.from > history.since ? activity.known.from : null;

  const said = activityEmpty(history, shownSources.length);
  const empty = !said
    ? null
    : said.key === 'loading'
      ? t('history.loading')
      : said.key === 'knownFrom' || said.key === 'noneSince'
        ? t(`activity.${said.key}`, {time: stamp(said.at)})
        : t(`activity.${said.key}`);

  return (
    <section className={`panel activity ${loading ? 'is-loading' : ''}`} aria-label={t('activity.title')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('activity.title')}</h2>
        <ActivitySettings arrange={arrange} />
      </div>
      {activity?.known && activity.workMs > 0 && (
        <div className="activity-totals">
          <span title={t('activity.workHint')}>
            {t('activity.work')} <b>{workHours(activity.workMs)}</b>
          </span>
          <span title={t('activity.agentsHint')}>
            {t('activity.agents')} <b>{num(activity.agents)}</b>
          </span>
          <span title={t('activity.agentTimeHint')}>
            {t('activity.agentTime')} <b>{workHours(activity.agentMs)}</b>
          </span>
          {since !== null && <span className="activity-since">{t('activity.since', {time: stamp(since)})}</span>}
        </div>
      )}
      {empty ? (
        <div className="chart chart-loading">{empty}</div>
      ) : (
        <>
          <Stacks
            activity={activity!}
            groups={groups.flatMap((group, i) => (muted[i] ? [] : [{group, color: colors[i], name: names[i]}]))}
            from={from}
            to={to}
            unknownTo={since}
            onSelect={setTimeRange}
            onStep={direction => goTo(step(selected, prefs.range, direction, now, historyStart))}
          />
          <div className="legend">
            {groups.map((group, i) => (
              <button key={group.key} type="button" className="legend-item" title={t('activity.legendHint')} aria-pressed={!muted[i]} onClick={() => setMuted(mutedKey(by, group.key), !muted[i])}>
                <i className="activity-swatch" style={{background: colors[i]}} />
                <span>{names[i]}</span>
                <b>{workHours(group.ms)}</b>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
});

/**
 * The stacks of the period's bars, of the groups shown, with the part before work was known
 * marked, and a bar's tooltip: its groups' parts, its work time and how many agents worked
 * in it. It reads, and moves through time, as the chart does (`useTimeAxis`).
 */
function Stacks({
  activity,
  groups,
  from,
  to,
  unknownTo,
  onSelect,
  onStep,
}: {
  activity: ActivityData;
  /** The groups switched on in the legend, bottom to top, each with its colour and name. */
  groups: {group: ActivityGroup; color: string; name: string}[];
  from: number;
  to: number;
  /** Where what is known of the period begins, when after its start: the part before is marked. */
  unknownTo: number | null;
  onSelect: (range: TimeRange) => void;
  onStep: (direction: -1 | 1) => void;
}) {
  const barMs = activity.barMs;
  const left = 44;
  const right = 12;
  const {box, svg, width, scale, hover, drag, x, clip, handlers} = useTimeAxis({from, to, end: to, cellMs: barMs, left, right, onSelect, onStep});
  const narrow = width < 560;
  const height = narrow ? 160 : 200;
  const top = 12;
  const bottom = 28;
  const span = Math.max(MINUTE, to - from);
  const {ticks, daily} = niceTicks(from, to, narrow ? 4 : 7);

  // How tall each bar's stack is, of the groups shown: the scale reaches the tallest.
  const heights = useMemo(() => {
    const sums = new Map<number, number>();
    for (const {group} of groups) for (const [start, ms] of group.cells) sums.set(start, (sums.get(start) ?? 0) + ms);
    return sums;
  }, [groups]);
  const vertical = activityScale(Math.max(0, ...heights.values()), barMs);
  const y = (value: number) => top + (1 - value / vertical.max) * (height - top - bottom);

  // One path a group, stacked in the order of the groups. Bars wide enough to read as such
  // stand apart; narrower ones run together into a band, so a long period is not striped,
  // and only the band's edges part it from the groups above and below.
  const paths = useMemo(() => {
    const base = new Map<number, number>();
    const edge = (value: number) => value.toFixed(1);
    const apart = ((width - left - right) * barMs) / span >= 8;
    const gap = apart ? 0.5 : 0;
    return groups.map(({group}) => {
      const runs: {x0: number; x1: number; low: number; high: number}[][] = [];
      let previous: number | null = null;
      for (const [start, ms] of group.cells) {
        if (start + barMs <= from || start >= to) continue;
        const low = base.get(start) ?? 0;
        const high = low + ms;
        base.set(start, high);
        const bar = {x0: x(start) + gap, x1: x(start + barMs) - gap, low, high};
        if (!apart && previous === start - barMs) runs.at(-1)!.push(bar);
        else runs.push([bar]);
        previous = start;
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
  }, [groups, from, to, barMs, width, height, vertical.max]);

  const bar = hover === null ? null : activity.cells.find(([start]) => start === hover);
  // What the hovered bar draws: over one whose groups are all switched off, nothing tells of it, as over an empty one.
  const parts = hover === null ? [] : groups.flatMap(({group, color, name}) => group.cells.filter(([start]) => start === hover).map(([, ms]) => ({key: group.key, color, name, ms})));
  // The bar's totals are of all its work, which its parts add up to: while some of it is in a
  // group switched off, which cannot be taken out of them (agents worked across groups), they are not told.
  const whole = !!bar && Math.abs(parts.reduce((sum, part) => sum + part.ms, 0) - bar[1]) < 1000;
  const hoverX = hover === null ? 0 : x(Math.max(from, Math.min(to, hover + barMs / 2)));
  const {tip, style: tipStyle} = useTip(svg, {width, at: hoverX, narrow, rises: true, bottom: height * scale});
  // The label of the part not known shows only where it fits within its hatching, measured
  // as drawn (its length depends on the language and the font), never over the scale.
  const unknownLabel = useRef<SVGTextElement>(null);
  const [labelFits, setLabelFits] = useState(false);
  const hatched = unknownTo === null ? 0 : x(unknownTo) - x(from);
  useLayoutEffect(() => {
    const label = unknownLabel.current;
    setLabelFits(!!label && label.getComputedTextLength() + 24 <= hatched);
  });

  return (
    <div className="chart activity-chart" ref={box}>
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('activity.label')} className="is-selectable" {...handlers}>
        <defs>
          <clipPath id={clip}>
            <rect x={left} y={0} width={width - left - right} height={height} />
          </clipPath>
          <pattern id={`${clip}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" x2="0" y1="0" y2="6" className="activity-hatch" />
          </pattern>
        </defs>
        {vertical.ticks.map(value => (
          <g key={value}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'axis-line' : 'grid'} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className="tick">
              {value ? workHours(value) : '0'}
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
            {unknownTo !== null && (
              <g className="activity-unknown">
                <rect x={x(from)} width={x(unknownTo) - x(from)} y={top} height={height - top - bottom} fill={`url(#${CSS.escape(clip)}-hatch)`} />
                <text
                  ref={unknownLabel}
                  x={(x(from) + x(unknownTo)) / 2}
                  y={top + (height - top - bottom) / 2}
                  textAnchor="middle"
                  className="activity-unknown-label"
                  visibility={labelFits ? undefined : 'hidden'}
                >
                  {t('activity.notKnown', {time: stamp(unknownTo)})}
                </text>
              </g>
            )}
            {groups.map(({group, color}, i) => (
              <path key={group.key} d={paths[i]} fill={color} className="activity-stack" />
            ))}
          </g>
        </g>
        {drag && <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />}
        {hover !== null && bar && parts.length > 0 && <rect x={x(hover)} width={Math.max(1, x(hover + barMs) - x(hover))} y={top} height={height - top - bottom} className="hover-band" />}
      </svg>
      {!groups.length && <div className="chart-empty">{t('activity.allOff')}</div>}
      {hover !== null && bar && parts.length > 0 && !drag && (
        <Tooltip tip={tip} className={narrow ? 'is-below' : ''} style={tipStyle}>
          <div className="tooltip-time">{cellLabel(hover, barMs)}</div>
          {/* The totals come first: a tooltip cut to the window loses the last of its parts, not them. */}
          {whole && (
            <>
              <div className="tooltip-grid" style={{gridTemplateColumns: 'minmax(0, 1fr) auto'}}>
                <div className="tooltip-row">
                  <span className="tooltip-name">{t('activity.work')}</span>
                  <strong>{workHours(bar[1])}</strong>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-name">{t('activity.agents')}</span>
                  <strong>{num(bar[3])}</strong>
                </div>
              </div>
              <div className="tooltip-sep" />
            </>
          )}
          <div className="tooltip-grid" style={{gridTemplateColumns: '14px minmax(0, 1fr) auto'}}>
            {parts.map(part => (
              <div className="tooltip-row" key={part.key}>
                <i className="activity-swatch" style={{background: part.color}} />
                <span className="tooltip-name">{part.name}</span>
                <strong>{workHours(part.ms)}</strong>
              </div>
            ))}
          </div>
        </Tooltip>
      )}
    </div>
  );
}
