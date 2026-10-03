import {memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {Activity as ActivityData, ActivityDimension, ActivityGroup} from '../lib/types';
import {clock, num, shortDay, stamp, workHours} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {activityEmpty, activityScale, atOnce, groupColors, mutedKey} from '../lib/activity';
import {ACTIVITY_BY, setMuted, setPrefs, usePrefs} from '../lib/prefs';
import {answeredRangeLabel, setTimeRange, timeRangeKey, useTimeRange, type TimeRange} from '../lib/timeRange';
import {cellLabel, frameChangesAt, frameOf, measuredTo, niceTicks} from '../lib/periods';
import {ACTIVITY, cardId, isHidden, withHidden, type Arrange} from '../lib/view';
import {useBoardId, useLineup, useTitles, type Title} from '../lib/board';
import {useClock} from '../lib/clock';
import {useHistory, useHistoryBegins, useHistoryPlot} from '../lib/history';
import {plotBar, plotGroupsPrepared, type PlotBuffer, type PlotGroup} from '../lib/historyPlot';
import {usePrepared, usePreparationBasis} from './prepared';
import {axisNavigation, navigationKey, type AxisNavigation} from '../lib/axisNavigation';
import {groupRegistry, type GroupIdentity} from '../lib/plotRegistry';
import {StackPaths} from '../lib/stackPaths';
import {pan, usePanning, useShifting} from '../lib/pan';
import {targetOf, cellStart} from '../../server/domain/history';
import {colorOf} from '../lib/view';
import {t, useLocale, type Key} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon} from './Popover';
import {Tooltip, useBubble, useTip} from './Tooltip';
import {useTimeAxis} from './timeAxis';
import {usePlot} from './sizing';
import {clipPlot, PlotLayer, PlotOverlay} from './PlotLayer';

const MINUTE = 60_000;
const EMPTY_ACTIVITY: ActivityData = {since: 0, known: null, barMs: MINUTE, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}};

const LABELS: Record<ActivityDimension, Key> = {source: 'activity.bySource', project: 'activity.byProject', device: 'activity.byDevice'};

/** A group as the legend and the tooltip name it. */
function groupName(group: Pick<ActivityGroup, 'key' | 'name'>, by: ActivityDimension, titles: Record<string, Title>) {
  if (by === 'source') return titles[group.key] ? sourceLabel(titles[group.key]) : group.key;
  return group.name ?? (by === 'project' ? t('activity.noProject') : group.key);
}

/** The widget's own settings, as the chart has its own: what its stacks are split by, and (for the board's owner) hiding it. */
function ActivitySettings({arrange}: {arrange: Arrange}) {
  const {activityBy} = usePrefs();
  return (
    <Popover label={t('activity.settings')} icon={<SlidersIcon />}>
      <div className="popover-note">{t('chart.panHint')}</div>
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
const LegendItem = memo(function LegendItem({group, groupKey, by, name, color, muted}: {group: ActivityGroup | null; groupKey: string; by: ActivityDimension; name: string; color: string; muted: boolean}) {
  useLocale();
  const shifting = useShifting();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const active = !shifting && !dismissed && (hovered || focused || pinned > 0);
  const container = button.current?.closest<HTMLElement>('.activity');
  const tip = useBubble(active, button, container);
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
  const bubble = (
    <span
      ref={tip}
      id={id}
      role="tooltip"
      className={`activity-legend-tip glass ${active ? 'is-open' : ''}`}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      <span className="tooltip-time">{name}</span>
      {group ? <Metrics agentMs={group.agentMs} activeMs={group.activeMs} agents={group.agents} /> : <span>{t('activity.pendingRange')}</span>}
    </span>
  );
  return (
    <div
      ref={wrap}
      className={`activity-legend-item ${active ? 'is-open' : ''}`}
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
        onClick={() => setMuted(mutedKey(by, groupKey), !muted)}
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
        <b>{group ? workHours(group.agentMs) : '—'}</b>
      </button>
      {container ? createPortal(bubble, container) : bubble}
    </div>
  );
});

/** Complete quantities do not render for partial plot arrivals. */
const Totals = memo(function Totals({activity, shownMs, since}: {activity: ActivityData | null; shownMs: number; since: number | null}) {
  useLocale();
  if (!activity?.known || activity.activeMs <= 0) return null;
  return (
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
  );
});

/**
 * Agent-hours on the analytics' time axis, stacked by subscription, project or machine.
 * The legend adds up to the total; active time and distinct agents are told separately.
 * It follows the history's frame and reads only card titles, so measurements do not
 * render it. The unknown part of the period is hatched rather than drawn as idle.
 */
export const Activity = memo(function Activity({arrange}: {arrange: Arrange}) {
  const {history, loading} = useHistory();
  const strip = useHistoryPlot();
  const registry = useRef<{token: number; by: ActivityDimension; seed: GroupIdentity[]; groups: GroupIdentity[]} | null>(null);
  const panel = useRef<HTMLElement>(null);
  // Made taller by its owner, the widget gives the room to the stacks, as the chart does.
  const {plot, onBase} = usePlot(panel);
  const lineup = useLineup();
  const titles = useTitles(arrange.view.names);
  const prefs = usePrefs();
  const by = prefs.activityBy;
  const locale = useLocale();
  const selected = useTimeRange();
  const navigation = axisNavigation(useBoardId(), selected, prefs);
  const clockNow = useClock(now => frameChangesAt(selected, history?.cellMs ?? 60_000, now), [history, strip, prefs, selected, titles, arrange.view, locale]);
  const panning = usePanning();
  const captured = useRef<{token: number; now: number} | null>(null);
  if (panning === null) captured.current = null;
  else if (captured.current?.token !== panning) captured.current = {token: panning, now: Math.max(clockNow, pan.get()?.originEnd ?? clockNow)};
  const now = panning !== null ? captured.current!.now : clockNow;
  const historyStart = useHistoryBegins();
  const frame = frameOf(selected, prefs, now, historyStart);
  const from = frame.from;
  const to = measuredTo(frame, history, selected, prefs.range);
  const activity = history?.activity ?? null;
  // What the groups look like changes with the answer, the board and the legend, not with time: the same objects as the clock moves the frame.
  const {groups, colors, shown} = useMemo(() => {
    const groups = activity?.by[by] ?? [];
    const colors = groupColors(groups, by, arrange.view, source => titles[source]?.provider ?? '');
    const names = groups.map(group => groupName(group, by, titles));
    const muted = groups.map(group => !!prefs.muted[mutedKey(by, group.key)]);
    const shown = groups.flatMap((group, i) => (muted[i] ? [] : [{group, color: colors[i], name: names[i]}]));
    return {groups, colors, names, muted, shown};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, by, arrange.view, titles, prefs.muted, locale]);
  const prepared = usePrepared(function* () {
    const data = new Map<string, PlotGroup>();
    const found = new Map<string, Pick<PlotGroup, 'key' | 'name'>>();
    if (strip) {
      for (const group of yield* plotGroupsPrepared(strip, {k0: strip.from / strip.cell, k1: strip.to / strip.cell - 1}, by)) {data.set(group.key, group); yield;}
      for (const row of strip.activityCells.values()) for (const [key, part] of row.parts[by]) {found.set(key, {key, name: part.name}); yield;}
    }
    const seed = groups.map((group, i) => ({key: group.key, name: group.name, color: colors[i]}));
    if (!strip) return {identities: seed, shown, strip, registry: null};
    const previous = registry.current?.token === strip.token && registry.current.by === by ? registry.current : {token: strip.token, by, seed, groups: seed};
    const identities = groupRegistry(previous.seed, previous.groups, [...found.values()], by === 'source' ? key => colorOf(arrange.view, key, titles[key]?.provider ?? '') : undefined);
    const plotted: {group: PlotGroup; color: string; name: string}[] = [];
    for (const identity of identities) {if (!prefs.muted[mutedKey(by, identity.key)]) plotted.push({group: data.get(identity.key) ?? {key: identity.key, name: identity.name, cells: EMPTY_CELLS}, color: identity.color, name: groupName(identity, by, titles)}); yield;}
    return {identities, shown: plotted, strip, registry: {token: strip.token, by, seed: previous.seed, groups: identities}};
  }, [strip, groups, colors, shown, by, arrange.view, titles, prefs.muted, locale], `${history?.board}:${by}`);
  const presentation = prepared.value ?? {identities: [], shown: [], strip: null};
  useLayoutEffect(() => {if (prepared.value) registry.current = prepared.value.registry;}, [prepared.value]);
  const shownMs = useMemo(() => shown.reduce((sum, {group}) => sum + group.agentMs, 0), [shown]);
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
  const answered = history?.range === (selected ? timeRangeKey(selected) : prefs.range);
  const emptyFrame = answered && panning === null && !strip ? empty : null;

  return (
    <section ref={panel} className={`panel activity ${loading ? 'is-loading' : ''}`} data-time="chart" aria-label={t('activity.title')} aria-busy={loading} data-history-range={history?.range}>
      <div className="panel-head">
        <div><h2>{t('activity.title')}</h2>{history && <span className="answered-range">{t('history.answeredRange', {range: answeredRangeLabel(history)})}</span>}</div>
        <ActivitySettings arrange={arrange} />
      </div>
      <Totals activity={activity} shownMs={shownMs} since={since} />
      <>
          <Stacks
            activity={activity ?? EMPTY_ACTIVITY}
            origin={history?.since ?? from}
            groups={emptyFrame ? [] : presentation.shown}
            from={from}
            to={to}
            unknownTo={since}
            onSelect={setTimeRange}
            plot={plot}
            onBase={onBase}
            strip={presentation.strip}
            prepared={prepared.ready}
            navigation={navigation}
            by={by}
            allMuted={!emptyFrame && presentation.identities.length > 0 && presentation.shown.length === 0}
            empty={!history ? empty : emptyFrame}
          />
          <div className="legend">
            {(emptyFrame ? [] : presentation.identities).map(identity => (
              <LegendItem key={identity.key} groupKey={identity.key} by={by} group={groups.find(group => group.key === identity.key) ?? null} name={groupName(identity, by, titles)} color={identity.color} muted={!!prefs.muted[mutedKey(by, identity.key)]} />
            ))}
          </div>
      </>
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
const EMPTY_CELLS: PlotGroup['cells'] = [];

const Stacks = memo(function Stacks({
  activity: incomingActivity,
  origin: incomingOrigin,
  groups: incomingGroups,
  from,
  to,
  unknownTo: incomingUnknownTo,
  onSelect,
  plot,
  onBase,
  strip: incomingStrip,
  prepared: incomingReady,
  navigation,
  by,
  allMuted,
  empty,
}: {
  activity: ActivityData;
  /** Where the answer begins: the bars are drawn from there, so their numbers stay small however old the hub. */
  origin: number;
  /** The groups switched on in the legend, bottom to top, each with its colour and name. */
  groups: {group: PlotGroup; color: string; name: string}[];
  from: number;
  to: number;
  /** Where what is known of the period begins, when after its start: the part before is marked. */
  unknownTo: number | null;
  onSelect: (range: TimeRange) => void;
  plot: number | undefined;
  onBase: (height: number) => void;
  strip: PlotBuffer | null;
  prepared: boolean;
  navigation: AxisNavigation;
  by: ActivityDimension;
  allMuted: boolean;
  empty: string | null;
}) {
  const locale = useLocale();
  const left = 48, right = 12;
  const axis = useTimeAxis({from, to, end: to, cellMs: incomingStrip?.barMs ?? incomingActivity.barMs, left, right, onSelect, ready: incomingReady, navigation});
  const {box, svg, width, scale, drag, clip, handlers, active} = axis;
  const narrow = width < 560;
  const base = stacksHeight(width);
  const height = plot === undefined ? base : Math.max(base, plot / scale);
  useLayoutEffect(() => onBase(base * scale), [base, scale, onBase]);
  const top = 12, bottom = 28;
  const maxSeen = useRef(0);
  const stackPaths = useRef(new StackPaths());
  const inputs = [incomingGroups, incomingStrip, incomingActivity, incomingOrigin, incomingUnknownTo, by, width, height, navigationKey(navigation)];
  const requested = usePreparationBasis(axis.basis, inputs, active, incomingReady);
  const prepared = usePrepared(function* () {
    const basis = {from: requested.from, to: requested.to, end: requested.end};
    const span = Math.max(MINUTE, basis.to - basis.from);
    const barMs = incomingStrip?.barMs ?? incomingActivity.barMs;
    const heights = new Map<number, number>(), keys = new Set<string>();
    for (const {group} of incomingGroups) {
      keys.add(group.key);
      for (const [at, ms] of group.cells) {heights.set(at, (heights.get(at) ?? 0) + ms); yield;}
    }
    const bars = new Map<number, number>();
    if (incomingStrip) for (const [at, row] of incomingStrip.activityCells) {
      const bar = cellStart(at, barMs);
      let ms = 0;
      for (const [key, part] of row.parts[by]) {if (keys.has(key)) ms += part.ms; yield;}
      bars.set(bar, (bars.get(bar) ?? 0) + ms);
    }
    let busiest = 0;
    for (const value of heights.values()) {busiest = Math.max(busiest, value); yield;}
    for (const value of bars.values()) {busiest = Math.max(busiest, value); yield;}
    const maximum = active ? Math.max(maxSeen.current, busiest) : busiest;
    const vertical = activityScale(maximum);
    const perMs = (width - left - right) / span;
    const pathOrigin = incomingStrip ? basis.from : incomingOrigin;
    const paths = yield* stackPaths.current.drawPrepared(incomingGroups, pathOrigin, perMs, barMs, height, vertical.max);
    return {basis, barMs, heights, maximum, vertical, perMs, pathOrigin, paths, groups: incomingGroups, strip: incomingStrip, activity: incomingActivity, originUnknownTo: incomingUnknownTo};
  }, [...inputs, requested.from, requested.to, requested.end], `${by}:${width}:${height}`, incomingReady);
  const model = prepared.value;
  const basis = model?.basis ?? axis.basis;
  const groups = model?.groups ?? [], strip = model?.strip ?? null, activity = model?.activity ?? incomingActivity;
  const barMs = model?.barMs ?? incomingActivity.barMs;
  const vertical = model?.vertical ?? activityScale(0);
  const paths = model?.paths ?? [], perMs = model?.perMs ?? (width - left - right) / Math.max(MINUTE, basis.to - basis.from), pathOrigin = model?.pathOrigin ?? basis.from;
  const hatchFrom = strip?.from ?? basis.from;
  const knownFrom = strip?.knownFrom ?? model?.originUnknownTo ?? incomingUnknownTo;
  const unknownTo = knownFrom !== null && knownFrom > hatchFrom ? knownFrom : null;
  const span = Math.max(MINUTE, basis.to - basis.from);
  const x = (at: number) => left + (at - basis.from) / span * (width - left - right);
  const y = (value: number) => top + (1 - value / vertical.max) * (height - top - bottom);
  const hover = incomingReady && prepared.ready ? axis.hover : null;
  const tickFrom = strip?.from ?? from, tickTo = strip?.to ?? to;
  const {ticks, daily} = niceTicks(tickFrom, tickTo, (narrow ? 4 : 7) * (tickTo - tickFrom) / span);
  useLayoutEffect(() => {if (model) maxSeen.current = model.maximum; axis.commitDrawing(basis, incomingReady && prepared.ready);});

  const innerClip = `${clip}-inner`;
  const bandClip = useRef<HTMLDivElement>(null);
  const mask = useRef<SVGRectElement>(null);
  const edges = useRef<SVGGElement>(null);
  const edgePaint = useRef(() => {});
  const painted = useRef('');
  const paintEdges = () => {
    if (!bandClip.current) return;
    if (!strip || !mask.current || !edges.current) {
      clipPlot(bandClip.current, left * scale, (width - right) * scale, width * scale);
      return;
    }
    const draft = pan.get();
    const visual = axis.visualGeometry();
    const range = draft || axis.held ? {from: visual.from, to: visual.from + (draft?.length ?? strip.length)} : {from, to};
    const target = targetOf(strip.length, draft?.now ?? to, 'edge', range);
    const start = target.k0 * strip.cell, end = (target.k1 + 1) * strip.cell;
    const firstFull = Math.ceil(start / barMs) * barMs, lastFull = Math.floor(end / barMs) * barMs;
    if (draft || axis.held) {
      const a = Math.max(left, Math.min(width - right, axis.screenX(firstFull)));
      const b = Math.max(a, Math.min(width - right, axis.screenX(lastFull)));
      clipPlot(bandClip.current, a * scale, b * scale, width * scale);
    } else {
      // The short final SVG fold transforms its mask with the artwork, preserving
      // non-scaling strokes. Continuous input only changes the HTML band clip.
      clipPlot(bandClip.current, left * scale, (width - right) * scale, width * scale);
      const maskX = String(x(firstFull)), maskWidth = String(Math.max(0, x(lastFull) - x(firstFull)));
      if (mask.current.getAttribute('x') !== maskX) mask.current.setAttribute('x', maskX);
      if (mask.current.getAttribute('width') !== maskWidth) mask.current.setAttribute('width', maskWidth);
    }
    const key = `${target.k0}:${target.k1}:${strip.version}:${vertical.max}:${height}:${perMs}:${groups.map(g => g.group.key).join(',')}`;
    if (key === painted.current) return;
    painted.current = key;
    const starts = [...new Set([cellStart(start, barMs), cellStart(end - 1, barMs)])].filter(at => at < firstFull || at >= lastFull);
    const paths = groups.map(() => '');
    for (const at of starts) {
      const bar = plotBar(strip, at, target, by);
      if (!bar) continue;
      let total = 0;
      const gap = perMs * barMs >= 8 ? 0.5 : 0;
      const a = x(at) + gap, b = x(at + barMs) - gap;
      groups.forEach(({group}, i) => {
        const ms = bar.groups.get(group.key)?.ms ?? 0;
        if (!ms) return;
        const low = total;
        total += ms;
        paths[i] += `M${a.toFixed(1)},${y(total).toFixed(1)}H${b.toFixed(1)}V${y(low).toFixed(1)}H${a.toFixed(1)}Z`;
      });
    }
    edges.current.querySelectorAll('path').forEach((path, i) => {if (path.getAttribute('d') !== paths[i]) path.setAttribute('d', paths[i]);});
  };
  // Input uses the committed groups while React prepares their replacement.
  useLayoutEffect(() => {edgePaint.current = paintEdges; painted.current = ''; paintEdges();});
  useLayoutEffect(() => pan.subscribe(() => edgePaint.current()), []);
  useEffect(() => {if (!strip) painted.current = '';}, [strip]);

  const partialBar = strip && hover !== null ? plotBar(strip, hover, targetOf(strip.length, to, 'hover', {from, to}), by) : null;
  const bar = hover === null ? null : strip ? partialBar ? [hover, partialBar.activeMs, partialBar.agentMs, partialBar.agents] : null : activity.cells.find(([start]) => start === hover);
  // What the hovered bar draws: over one whose groups are all switched off, nothing tells of it, as over an empty one.
  const parts =
    hover === null ? [] : groups.flatMap(({group, color, name}) => strip ? partialBar?.groups.has(group.key) ? [{key: group.key, color, name, ms: partialBar.groups.get(group.key)!.ms}] : [] : group.cells.filter(([start]) => start === hover).map(([, ms]) => ({key: group.key, color, name, ms})));
  const shownMs = parts.reduce((sum, part) => sum + part.ms, 0);
  const hoverX = hover === null ? 0 : axis.screenX(Math.max(from, Math.min(to, hover + barMs / 2)));
  const {tip, style: tipStyle} = useTip(svg, {width, at: hoverX, narrow, rises: true, bottom: height * scale});
  // The label of the part not known shows only where it fits within its hatching, measured
  // as drawn (its length depends on the language and the font), never over the scale.
  const unknownLabel = useRef<SVGTextElement>(null);
  const [labelWidth, setLabelWidth] = useState<number | null>(null);
  const hatched = unknownTo === null ? 0 : Math.max(0, x(unknownTo) - x(hatchFrom));
  const labelFits = labelWidth !== null && labelWidth + 24 <= hatched;
  useLayoutEffect(() => {
    const label = unknownLabel.current;
    setLabelWidth(label?.getComputedTextLength() ?? null);
  }, [unknownTo, locale]);

  return (
    <div className="chart activity-chart" ref={box} {...handlers}>
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} style={{height: `${height * scale}px`}} preserveAspectRatio="none" role="img" aria-label={t('activity.label')} className="is-selectable">
        <desc>{t('chart.panHint')}</desc>
        <defs>
          <clipPath id={innerClip}><rect ref={mask} x={left} y={top} width={width - left - right} height={height - top - bottom} /></clipPath>
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
      </svg>
      <PlotLayer width={width} height={height} scale={scale} left={left} right={right} main>
        {ticks.map(tick => (
          <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
            {daily ? shortDay(tick) : clock(tick)}
          </text>
        ))}

        {unknownTo !== null && (
          <g className="activity-unknown">
            <rect x={x(hatchFrom)} width={hatched} y={top} height={height - top - bottom} fill={`url(#${CSS.escape(clip)}-hatch)`} />
            <text
              ref={unknownLabel}
              x={(x(hatchFrom) + x(unknownTo)) / 2}
              y={top + (height - top - bottom) / 2}
              textAnchor="middle"
              className="activity-unknown-label"
              visibility={labelFits ? undefined : 'hidden'}
            >
              {t('activity.notKnown', {time: stamp(unknownTo)})}
            </text>
          </g>
        )}
      </PlotLayer>
      <PlotLayer width={width} height={height} scale={scale} left={left} right={right} clipRef={bandClip} top={top} bottom={bottom}>
        <g clipPath={strip && !active ? `url(#${CSS.escape(innerClip)})` : undefined}>
          <g transform={`translate(${(left + (pathOrigin - basis.from) * perMs).toFixed(1)} 0)`}>
            {groups.map(({group, color}, i) => (
              <path key={group.key} d={paths[i]} fill={color} className="activity-stack" />
            ))}
          </g>
        </g>
      </PlotLayer>
      {strip && (
        <PlotLayer width={width} height={height} scale={scale} left={left} right={right}>
          <g ref={edges}>{groups.map(({group, color}) => <path key={group.key} fill={color} className="activity-stack" />)}</g>
        </PlotLayer>
      )}
      <PlotOverlay width={width} height={height}>
        {drag && <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />}
        {hover !== null && bar && parts.length > 0 && (
          <rect x={axis.screenX(hover)} width={Math.max(1, axis.screenX(hover + barMs) - axis.screenX(hover))} y={top} height={height - top - bottom} className="hover-band" />
        )}
      </PlotOverlay>
      {empty && <div className="chart-empty">{empty}</div>}
      {allMuted && <div className="chart-empty">{t('activity.allOff')}</div>}
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
});
