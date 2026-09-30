import {memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {Activity as ActivityData, ActivityDimension, ActivityGroup} from '../lib/types';
import {clock, num, shortDay, stamp, workHours} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {activityEmpty, activityScale, atOnce, groupColors, mutedKey, shownActivity} from '../lib/activity';
import {ACTIVITY_BY, setMuted, setPrefs, usePrefs} from '../lib/prefs';
import {goTo, setTimeRange, useTimeRange, type TimeRange} from '../lib/timeRange';
import {cellLabel, frameChangesAt, frameOf, measuredTo, niceTicks, step} from '../lib/periods';
import {ACTIVITY, cardId, isHidden, withHidden, type Arrange} from '../lib/view';
import {useLineup, useTitles, type Title} from '../lib/board';
import {hubNow, useClock} from '../lib/clock';
import {useHistory, useHistoryBegins} from '../lib/history';
import {t, useLocale, type Key} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon} from './Popover';
import {Tooltip, useBubble, useTip} from './Tooltip';
import {useTimeAxis} from './timeAxis';
import {usePlot} from './sizing';

const MINUTE = 60_000;

const LABELS: Record<ActivityDimension, Key> = {source: 'activity.bySource', project: 'activity.byProject', device: 'activity.byDevice'};

/** A group as the legend and the tooltip name it. */
function groupName(group: ActivityGroup, by: ActivityDimension, titles: Record<string, Title>) {
  if (by === 'source') return titles[group.key] ? sourceLabel(titles[group.key]) : group.key;
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

/** The same quantities for a bar and a legend group; totals always cover every agent. */
function Metrics({agentMs, activeMs, agents, shownMs}: {agentMs: number; activeMs: number; agents: number; shownMs?: number}) {
  const rows = [
    [t('activity.agentHours'), workHours(agentMs)],
    ...(shownMs !== undefined && shownMs < agentMs ? [[t('activity.shownRow'), workHours(shownMs)]] : []),
    [t('activity.active'), workHours(activeMs)],
    [t('activity.agents'), num(agents)],
    [t('activity.atOnce'), atOnce(agentMs, activeMs)],
  ];
  return (
    <span className="tooltip-grid" style={{gridTemplateColumns: 'minmax(0, 1fr) auto'}}>
      {rows.map(([name, value]) => (
        <span className="tooltip-row" key={name}>
          <span className="tooltip-name">{name}</span>
          <strong>{value}</strong>
        </span>
      ))}
    </span>
  );
}

/** Hover and touch state belong to one legend entry, leaving the stacks untouched. */
function LegendItem({group, name, color, muted, onToggle}: {group: ActivityGroup; name: string; color: string; muted: boolean; onToggle: () => void}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const active = !dismissed && (hovered || focused || pinned > 0);
  const tip = useBubble(active, button);
  useEffect(() => {
    if (!active) return;
    // A bubble opened by the pointer must dismiss even while another control has focus.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDismissed(true);
        setPinned(0);
      }
    };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [active]);
  useEffect(() => {
    if (!pinned) return;
    const timer = setTimeout(() => setPinned(0), 4000);
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setPinned(0);
    };
    addEventListener('pointerdown', outside);
    return () => {
      clearTimeout(timer);
      removeEventListener('pointerdown', outside);
    };
  }, [pinned]);
  return (
    <div
      ref={wrap}
      className="activity-legend-item"
      onPointerEnter={event => {
        if (event.pointerType !== 'touch') {
          setHovered(true);
          setDismissed(false);
        }
      }}
      onPointerLeave={event => {
        if (event.pointerType !== 'touch') setHovered(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="legend-item"
        aria-describedby={id}
        aria-pressed={!muted}
        onClick={onToggle}
        onFocus={event => {
          setFocused(event.currentTarget.matches(':focus-visible'));
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onPointerUp={event => {
          if (event.pointerType === 'touch') {
            setPinned(value => value + 1);
            setDismissed(false);
          }
        }}
      >
        <i className="activity-swatch" style={{background: color}} />
        <span>{name}</span>
        <b>{workHours(group.agentMs)}</b>
      </button>
      <span
        ref={tip}
        id={id}
        role="tooltip"
        className={`activity-legend-tip glass ${active ? 'is-open' : ''}`}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
      >
        <span className="tooltip-time">{name}</span>
        <Metrics agentMs={group.agentMs} activeMs={group.activeMs} agents={group.agents} />
      </span>
    </div>
  );
}

/**
 * Agent-hours on the analytics' time axis, stacked by subscription, project or machine.
 * The legend adds up to the total; active time and distinct agents are told separately.
 * It follows the history's frame and reads only card titles, so measurements do not
 * render it. The unknown part of the period is hatched rather than drawn as idle.
 */
export const Activity = memo(function Activity({arrange}: {arrange: Arrange}) {
  const {history, loading} = useHistory();
  const panel = useRef<HTMLElement>(null);
  // Made taller by its owner, the widget gives the room to the stacks, as the chart does.
  const {plot, onBase} = usePlot(panel);
  const lineup = useLineup();
  const titles = useTitles(arrange.view.names);
  const prefs = usePrefs();
  const by = prefs.activityBy;
  const locale = useLocale();
  const selected = useTimeRange();
  const now = useClock(now => frameChangesAt(selected, history?.cellMs ?? 60_000, now));
  const historyStart = useHistoryBegins();
  const frame = frameOf(selected, prefs, now, historyStart);
  const from = frame.from;
  const to = measuredTo(frame, history, selected, prefs.range);
  const activity = history?.activity ?? null;
  // What the groups look like changes with the answer, the board and the legend, not with time: the same objects as the clock moves the frame.
  const {groups, colors, names, muted, shown} = useMemo(() => {
    const groups = activity?.by[by] ?? [];
    const colors = groupColors(groups, by, arrange.view, source => titles[source]?.provider ?? '');
    const names = groups.map(group => groupName(group, by, titles));
    const muted = groups.map(group => !!prefs.muted[mutedKey(by, group.key)]);
    const shown = groups.flatMap((group, i) => (muted[i] ? [] : [{group, color: colors[i], name: names[i]}]));
    return {groups, colors, names, muted, shown};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, by, arrange.view, titles, prefs.muted, locale]);
  const shownMs = shownActivity(shown.map(({group}) => group)).agentMs;
  const shownSources = lineup.filter(id => titles[id] && !isHidden(arrange.view, cardId(id)));
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
    <section ref={panel} className={`panel activity ${loading ? 'is-loading' : ''}`} data-time="chart" aria-label={t('activity.title')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('activity.title')}</h2>
        <ActivitySettings arrange={arrange} />
      </div>
      {activity?.known && activity.activeMs > 0 && (
        <div className="activity-totals">
          <span title={t('activity.agentHoursHint')}>
            {t('activity.agentHours')} <b>{workHours(activity.agentMs)}</b>
            {shownMs < activity.agentMs && <span className="activity-since activity-shown">{t('activity.shown', {time: workHours(shownMs)})}</span>}
          </span>
          <span title={t('activity.activeHint')}>
            {t('activity.active')} <b>{workHours(activity.activeMs)}</b>
          </span>
          <span title={t('activity.agentsHint')}>
            {t('activity.agents')} <b>{num(activity.agents)}</b>
          </span>
          <span title={t('activity.atOnceHint')}>
            {t('activity.atOnce')} <b>{atOnce(activity.agentMs, activity.activeMs)}</b>
          </span>
          {since !== null && <span className="activity-since">{t('activity.since', {time: stamp(since)})}</span>}
        </div>
      )}
      {empty ? (
        <div className="chart chart-loading" style={plot === undefined ? undefined : {height: plot}}>
          {empty}
        </div>
      ) : (
        <>
          <Stacks
            activity={activity!}
            origin={history!.since}
            groups={shown}
            from={from}
            to={to}
            unknownTo={since}
            onSelect={setTimeRange}
            onStep={direction => goTo(step(selected, prefs.range, direction, hubNow(), historyStart))}
            plot={plot}
            onBase={onBase}
          />
          <div className="legend">
            {groups.map((group, i) => (
              <LegendItem key={group.key} group={group} name={names[i]} color={colors[i]} muted={muted[i]} onToggle={() => setMuted(mutedKey(by, group.key), !muted[i])} />
            ))}
          </div>
        </>
      )}
    </section>
  );
});

/** How tall the stacks are drawn by themselves, in their units: lower on a narrow widget. */
export const stacksHeight = (width: number) => (width < 560 ? 160 : 200);

/**
 * The stacks of the period's bars, of the groups shown, with the part before work was known
 * marked, and a bar's tooltip: its groups' parts, its work time and how many agents worked
 * in it. It reads, and moves through time, as the chart does (`useTimeAxis`), and is made
 * taller as the chart is (`plot`, `onBase`).
 */
function Stacks({
  activity,
  origin,
  groups,
  from,
  to,
  unknownTo,
  onSelect,
  onStep,
  plot,
  onBase,
}: {
  activity: ActivityData;
  /** Where the answer begins: the bars are drawn from there, so their numbers stay small however old the hub. */
  origin: number;
  /** The groups switched on in the legend, bottom to top, each with its colour and name. */
  groups: {group: ActivityGroup; color: string; name: string}[];
  from: number;
  to: number;
  /** Where what is known of the period begins, when after its start: the part before is marked. */
  unknownTo: number | null;
  onSelect: (range: TimeRange) => void;
  onStep: (direction: -1 | 1) => void;
  plot: number | undefined;
  onBase: (height: number) => void;
}) {
  const barMs = activity.barMs;
  // Room for the scale's longest label ("480h" or "30 мин") within the widget.
  const left = 48;
  const right = 12;
  const {box, svg, width, scale, hover, drag, x, clip, handlers} = useTimeAxis({from, to, end: to, cellMs: barMs, left, right, onSelect, onStep});
  const narrow = width < 560;
  const base = stacksHeight(width);
  const height = plot === undefined ? base : Math.max(base, plot / scale);
  useLayoutEffect(() => onBase(base * scale), [base, scale, onBase]);
  const top = 12;
  const bottom = 28;
  const span = Math.max(MINUTE, to - from);
  const {ticks, daily} = niceTicks(from, to, narrow ? 4 : 7);

  // How tall each bar's stack is, of the groups shown: the scale reaches the tallest.
  const heights = useMemo(() => shownActivity(groups.map(({group}) => group)).cells, [groups]);
  const vertical = activityScale(Math.max(0, ...heights.values()));
  const y = (value: number) => top + (1 - value / vertical.max) * (height - top - bottom);

  // One path a group, stacked in the order of the groups. Bars wide enough to read as such
  // stand apart; narrower ones run together into a band, so a long period is not striped,
  // and only the band's edges part it from the groups above and below. They are drawn from
  // the start of the answer (`origin`) and moved into place whole, clipped to the plot: as
  // the clock moves the frame on by a cell, only where they stand changes.
  const perMs = (width - left - right) / span;
  const paths = useMemo(() => {
    const base = new Map<number, number>();
    const edge = (value: number) => value.toFixed(1);
    const at = (time: number) => (time - origin) * perMs;
    const apart = perMs * barMs >= 8;
    const gap = apart ? 0.5 : 0;
    return groups.map(({group}) => {
      const runs: {x0: number; x1: number; low: number; high: number}[][] = [];
      let previous: number | null = null;
      for (const [start, ms] of group.cells) {
        const low = base.get(start) ?? 0;
        const high = low + ms;
        base.set(start, high);
        const bar = {x0: at(start) + gap, x1: at(start + barMs) - gap, low, high};
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
  }, [groups, origin, perMs, barMs, height, vertical.max]);

  const bar = hover === null ? null : activity.cells.find(([start]) => start === hover);
  // What the hovered bar draws: over one whose groups are all switched off, nothing tells of it, as over an empty one.
  const parts =
    hover === null ? [] : groups.flatMap(({group, color, name}) => group.cells.filter(([start]) => start === hover).map(([, ms]) => ({key: group.key, color, name, ms})));
  const shownMs = parts.reduce((sum, part) => sum + part.ms, 0);
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
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} style={{height: `${height * scale}px`}} preserveAspectRatio="none" role="img" aria-label={t('activity.label')} className="is-selectable" {...handlers}>
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
            <g clipPath={`url(#${CSS.escape(clip)})`}>
              <g transform={`translate(${(left + (origin - from) * perMs).toFixed(1)} 0)`}>
                {groups.map(({group, color}, i) => (
                  <path key={group.key} d={paths[i]} fill={color} className="activity-stack" />
                ))}
              </g>
            </g>
          </g>
        </g>
        {drag && <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />}
        {hover !== null && bar && parts.length > 0 && (
          <rect x={x(hover)} width={Math.max(1, x(hover + barMs) - x(hover))} y={top} height={height - top - bottom} className="hover-band" />
        )}
      </svg>
      {!groups.length && <div className="chart-empty">{t('activity.allOff')}</div>}
      {hover !== null && bar && parts.length > 0 && !drag && (
        <Tooltip tip={tip} className={narrow ? 'is-below' : ''} style={tipStyle}>
          <div className="tooltip-time">{cellLabel(hover, barMs)}</div>
          {/* The totals come first: a tooltip cut to the window loses the last of its parts, not them. */}
          <Metrics agentMs={bar[2]} activeMs={bar[1]} agents={bar[3]} shownMs={shownMs} />
          <div className="tooltip-sep" />
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
