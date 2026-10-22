import {AnalyticsPanel} from './AnalyticsPanel';
import {memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps} from 'react';
import type {Activity as ActivityData, ActivityDimension, ActivityGroup} from '../lib/types';
import {clock, num, shortDay, stamp, workHours} from '../lib/format';
import {activityEmpty, activityScale, activityGroupName as groupName, atOnce, groupColors, activitySeriesKey} from '../lib/activity';
import {ACTIVITY_BY, setPrefs, usePref} from '../lib/prefs';
import {setTimeRange, timeRangeKey, useTimeRange, type TimeRange} from '../lib/timeRange';
import {cellLabel, frameChangesAt, frameOf, measuredTo, niceTicks} from '../lib/periods';
import {ACTIVITY, cardId, isHidden, withHidden, type Arrange} from '../lib/view';
import {usePersonalBoard, useBoardId, useLineup, useTitles,useProjectColorPins,useProjectColorsReady} from '../lib/board';
import {useClock} from '../lib/clock';
import {quotaHistory, useActivityHistory, useHistoryBegins, useHistoryPlot} from '../lib/history';
import {boardPeriod} from '../lib/period';
import type {ActivityFrame as History} from '../lib/period';
import {plotBar, plotGroupsPrepared, type PlotBuffer, type PlotGroup} from '../lib/historyPlot';
import {usePrepared, usePreparationBasis} from './prepared';
import {axisNavigation, navigationKey, type AxisNavigation} from '../lib/axisNavigation';
import {groupRegistry, type GroupIdentity} from '../lib/plotRegistry';
import {resolveProjectColors} from '../lib/projectColors';
import {StackPaths} from '../lib/stackPaths';
import {pan, usePanning} from '../lib/pan';
import {targetOf, cellStart} from '../../server/domain/history';
import {colorOf} from '../lib/view';
import {t, useLocale, type Key} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon} from './Popover';
import {Tooltip, useTip} from './Tooltip';
import {navigate, settingsHref} from '../lib/router';
import {useTimeAxis} from './timeAxis';
import {usePlot} from './sizing';
import {clipPlot, PlotLayer, PlotOverlay} from './PlotLayer';
import {seriesFocusStyle, useSeriesFocus, type SeriesFocus} from './seriesFocus';

const MINUTE = 60_000;
const EMPTY_ACTIVITY: ActivityData = {since: 0, known: null, barMs: MINUTE, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}};

const LABELS: Record<ActivityDimension, Key> = {source: 'activity.bySource', project: 'activity.byProject', device: 'activity.byDevice'};

/** The widget's own settings, as the chart has its own: what its stacks are split by, and (for the board's owner) hiding it. */
function ActivitySettings({arrange,since}: {arrange: Arrange;since:number|null}) {
  const activityBy=usePref('activityBy');
  const [open,setOpen]=useState(false);
  return (
    <>
    <Popover label={t('activity.settings')} icon={<SlidersIcon />} open={open} onOpenChange={setOpen}>
      <div className="popover-section">
        <div className="popover-title">{t('activity.by')}</div>
        <div className="popover-pad">
          <Segmented value={activityBy} onChange={next => setPrefs({activityBy: next})} options={ACTIVITY_BY.map(key => [key, t(LABELS[key])])} label={t('activity.by')} />
        </div>
      </div>
      <div className="popover-section"><button className="popover-row" onClick={()=>{setOpen(false);navigate(settingsHref('/settings/projects'));}}><span>{t('projects.manage')}</span></button></div>
      {since!==null&&<div className="popover-note">{t('activity.since',{time:stamp(since)})}</div>}
      {arrange.owner && <HideRow onHide={() => arrange.update(view => withHidden(view, ACTIVITY, true))}>{t('widget.hide')}</HideRow>}
    </Popover>
    </>
  );
}

/** All four quantities describe the same enabled cohort. */
function Metrics({agentMs, activeMs, agents}: {agentMs: number; activeMs: number; agents: number}) {
  const rows = [
    [t('activity.agentHours'), workHours(agentMs)],
    [t('activity.active'), workHours(activeMs)],
    [t('activity.agents'), num(agents)],
    [t('activity.atOnce'), activeMs>0?atOnce(agentMs, activeMs):'—'],
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

const metricsText = (value: {agentMs:number;activeMs:number;agents:number}) => [workHours(value.agentMs),workHours(value.activeMs),num(value.agents),atOnce(value.agentMs,value.activeMs)];

/** Small numerical consumers follow formatted changes, independently of the drawing grid. */
function useActivityNumbers(history:History|null,by:ActivityDimension,read:(activity:ActivityData)=>string,enabled=true,bar?:number,key?:string) {
  const panning=usePanning();
  const at=(now:number)=>history?boardPeriod.activityAt(history,by,now,bar,key,!boardPeriod.activityProjectionState(history).ready):null;
  const now=useClock(now=>history&&enabled&&panning===null&&boardPeriod.activityProjectionState(history).ready?boardPeriod.activityChangesAt(history,by,now,time=>read(at(time)!),key):null);
  return panning===null&&enabled?at(now):bar===undefined?history?.activity??null:null;
}

function LegendAmount({history,by,groupKey,group}:{history:History|null;by:ActivityDimension;groupKey:string;group:ActivityGroup|null}) {
  const text=(activity:ActivityData)=>workHours(activity.by[by].find(g=>g.key===groupKey)?.agentMs??0);
  const activity=useActivityNumbers(history,by,text,true,undefined,groupKey);
  return <b data-time="activity-work">{activity?text(activity):group?workHours(group.agentMs):'—'}</b>;
}

function LegendMetrics({history,by,groupKey,group,active}:{history:History|null;by:ActivityDimension;groupKey:string;group:ActivityGroup|null;active:boolean}) {
  const part=(activity:ActivityData)=>activity.by[by].find(g=>g.key===groupKey)??{agentMs:0,activeMs:0,agents:0};
  const activity=useActivityNumbers(history,by,value=>JSON.stringify(metricsText(part(value))),active,undefined,groupKey);
  const value=activity?part(activity):group;
  return <span data-time="activity-metrics">{value?<Metrics agentMs={value.agentMs} activeMs={value.activeMs} agents={value.agents}/>:<span>{t('activity.pendingRange')}</span>}</span>;
}

/** Keyboard descriptions belong to their own entry even when the pointer wins visually. */
const LegendItem = memo(function LegendItem({history,group,groupKey,by,name,color}:{history:History|null;group:ActivityGroup|null;groupKey:string;by:ActivityDimension;name:string;color:string}) {
  useLocale();const id=useId(),[focused,setFocused]=useState(false);
  return <div className="activity-legend-item" data-series-legend>
    <button type="button" className="legend-item" data-series-key={activitySeriesKey(by,groupKey)} data-agent-ms={group?.agentMs} style={seriesFocusStyle(activitySeriesKey(by,groupKey))}
      aria-describedby={id} aria-pressed={false} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}>
      <i className="activity-swatch" style={{background:color}}/><span>{name}</span><LegendAmount history={history} by={by} groupKey={groupKey} group={group}/>
    </button>
    <span id={id} className="sr-only">{focused?<LegendMetrics history={history} by={by} groupKey={groupKey} group={group} active/>:null}</span>
  </div>;
});

/** Only this small region hears legend preview changes. Its reserved geometry is constant. */
const Totals=memo(function Totals({history,by,since,focus}:{history:History|null;by:ActivityDimension;since:number|null;focus:SeriesFocus}) {
  useLocale();const selected=useSyncExternalStore(focus.subscribe,focus.get);
  // The strip can retain a legend identity after its work leaves the interval.
  const prefix=activitySeriesKey(by,''),key=selected?.startsWith(prefix)?selected.slice(prefix.length):undefined;
  const base=useActivityNumbers(history,by,value=>JSON.stringify([!!value.known,...metricsText(value)]),true,undefined,key);
  const preview=base?.by[by].find(part=>part.key===key);
  const activity=key!==undefined&&base?{...base,agentMs:preview?.agentMs??0,activeMs:preview?.activeMs??0,agents:preview?.agents??0}:base;
  const text=activity?.available===false?t('activity.noSessions'):activity&&!activity.known?t('activity.knownFrom',{time:stamp(activity.since)}):null;
  return <div className="chart-info activity-info" data-time="activity-info" data-series-context={key!==undefined?selected:undefined}>
    <div className="activity-totals" data-time="activity-totals" data-agent-ms={!text?activity?.agentMs:undefined}>
      {text?<span>{text}</span>:<>
        <span title={t('activity.agentHoursHint')}><span className="activity-total-name">{t('activity.agentHours')}</span><b>{activity?workHours(activity.agentMs):'—'}</b></span>
        <span title={t('activity.activeHint')}><span className="activity-total-name">{t('activity.active')}</span><b>{activity?workHours(activity.activeMs):'—'}</b></span>
        <span title={t('activity.agentsHint')}><span className="activity-total-name">{t('activity.agents')}</span><b>{activity?num(activity.agents):'—'}</b></span>
        <span title={t('activity.atOnceHint')}><span className="activity-total-name">{t('activity.atOnce')}</span><b>{activity&&activity.activeMs>0?atOnce(activity.agentMs,activity.activeMs):'—'}</b></span>
      </>}
    </div>
    <span className="sr-only">{since!==null?t('activity.since',{time:stamp(since)}):null}</span>
  </div>;
});

type ActivityRegistry={authority:number;token:number;range:string|undefined;by:ActivityDimension;basis:ActivityGroup[];seed:GroupIdentity[];groups:GroupIdentity[]};

/**
 * Agent-hours on the analytics' time axis, stacked by subscription, project or machine.
 * The legend adds up to the total; active time and distinct agents are told separately.
 * It follows the history's frame and reads only card titles, so measurements do not
 * render it. The unknown part of the period is hatched rather than drawn as idle.
 */
export const Activity = memo(function Activity({arrange}: {arrange: Arrange}) {
  const {history,drawing,loading,error,presentation:authority} = useActivityHistory();
  const strip = useHistoryPlot(true);
  const pins=useProjectColorPins(),colorsReady=useProjectColorsReady();
  const registry = useRef<ActivityRegistry|null>(null);
  if (registry.current?.authority !== authority) registry.current = null;
  const panel = useRef<HTMLElement>(null);
  // Made taller by its owner, the widget gives the room to the stacks, as the chart does.
  const {plot, onBase} = usePlot(panel);
  const lineup = useLineup();
  const personal = usePersonalBoard();
  const titles = useTitles(arrange.view.names);
  const range=usePref('range'),horizon=usePref('horizon'),activityBy=usePref('activityBy');
  const prefs=useMemo(()=>({range,horizon,activityBy}),[range,horizon,activityBy]);
  const by = prefs.activityBy;
  const focus=useSeriesFocus(panel,`${useBoardId()}:${by}`,{kind:by},`${authority}:${drawing?.range}`);
  const locale = useLocale();
  const selected = useTimeRange();
  const navigation = axisNavigation(useBoardId(), selected, prefs);
  const clockNow = useClock(now => frameChangesAt(selected, history?.cellMs ?? 60_000, now), [history, strip, prefs, selected, titles, arrange.view, locale]);
  const panning = usePanning();
  const captured = useRef<{authority: number; token: number; now: number} | null>(null);
  if (panning === null) captured.current = null;
  else if (captured.current?.token !== panning || captured.current.authority !== authority) captured.current = {authority, token: panning, now: Math.max(clockNow, pan.get()?.originEnd ?? clockNow)};
  const now = panning !== null ? captured.current!.now : clockNow;
  const historyStart = useHistoryBegins();
  const frame = frameOf(selected, prefs, now, historyStart);
  const from = frame.from;
  const to = measuredTo(frame, history, selected, prefs.range);
  const activity = history?.activity ?? null,drawnActivity=drawing?.activity??null;
  // What the groups look like changes with the answer and the board, not with emphasis or time: the same objects as the clock moves the frame.
  const {groups, colors, shown} = useMemo(() => {
    const groups = drawnActivity?.by[by] ?? [];
    const colors = groupColors(groups, by, arrange.view, source => titles[source]?.provider ?? '');
    const names = groups.map(group => groupName(group, by, titles));
    const shown = groups.map((group, i) => ({group, color: colors[i], name: names[i]}));
    return {groups, colors, names, shown};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnActivity, by, arrange.view, titles, locale]);
  const prepared = usePrepared(function* () {
    const data = new Map<string, PlotGroup>();
    const found = new Map<string, Pick<PlotGroup, 'key' | 'name'>>();
    if (strip) {
      for (const group of yield* plotGroupsPrepared(strip, {k0: strip.from / strip.cell, k1: strip.to / strip.cell - 1}, by)) {data.set(group.key, group); yield;}
      for (const row of strip.activityCells.values()) for (const [key, part] of row.parts[by]) {found.set(key, {key, name: part.name}); yield;}
    }
    const seed = groups.map((group, i) => ({key: group.key, name: group.name, color: colors[i]}));
    if (!strip) return {identities: seed, shown, strip, registry: by==='project'?{authority,token:-1,range:drawing?.range,by,basis:groups,seed,groups:seed}:null};
    const previous = registry.current?.authority === authority && registry.current.token === strip.token && registry.current.by === by ? registry.current : {authority, token: strip.token,range:drawing?.range, by, seed, groups: seed};
    const identities = groupRegistry(previous.seed, previous.groups, [...found.values()], by === 'source' ? key => key==='unknown'||key==='notProvided'?'var(--other)' : colorOf(arrange.view, key, titles[key]?.provider ?? '') : undefined);
    const plotted: {group: PlotGroup; color: string; name: string}[] = [];
    for (const identity of identities) {plotted.push({group: data.get(identity.key) ?? {key: identity.key, name: identity.name, cells: EMPTY_CELLS}, color: identity.color, name: groupName(identity, by, titles)}); yield;}
    return {identities, shown: plotted, strip, registry: {authority, token: strip.token,range:drawing?.range, by,basis:groups, seed: previous.seed, groups: identities}};
  }, [strip, groups, colors, shown, by, arrange.view, titles, locale], `${authority}:${history?.board}:${by}`,by!=='project'||colorsReady);
  const geometry = by==='project'&&!colorsReady?null:prepared.value;
  const [displayed,setDisplayed]=useState<ActivityRegistry|null>(null);
  const paintRegistry=useRef<ActivityRegistry|null>(null);
  const retained=displayed?.authority===authority&&displayed.by===by?displayed:null;
  const paintBasis=retained??geometry?.registry??null;
  const painted=useMemo(()=>{
    const current=geometry?.identities??[];
    if(by!=='project')return current;
    if(!paintBasis)return [];
    // The previous stacks remain visible until their numeric replacement commits.
    const keys=new Set(current.map(group=>group.key));
    const members=[...current,...(retained?.groups??[]).filter(group=>!keys.has(group.key))];
    const previous=paintRegistry.current;
    const token=paintBasis.token;
    // Ordinary answers allocate by rank again; metadata keeps the same numeric basis.
    const sameRegistry=previous?.token===token&&(token!==-1||previous.basis===paintBasis.basis);
    const enteringStrip=previous?.token===-1&&token!==-1;
    const surviving=previous?.authority===authority&&previous.by===by&&
      previous.range===paintBasis.range&&(sameRegistry||enteringStrip)?previous.groups:[];
    return resolveProjectColors(members,pins,surviving);
  },[geometry,pins,by,authority,retained,paintBasis]);
  const resolved=useMemo(()=>new Map(painted.map(identity=>[identity.key,identity])),[painted]);
  const identities=useMemo(()=>(geometry?.identities??[]).map(identity=>resolved.get(identity.key)??identity),[geometry,resolved]);
  const paint=useMemo(()=>new Map(painted.map(identity=>[identity.key,identity.color])),[painted]);
  const presentation={identities,shown:geometry?.shown??[],strip:geometry?.strip??null,registry:geometry?.registry??null,onDrawing:setDisplayed};
  useLayoutEffect(() => {
    if (geometry) registry.current = geometry.registry?{...geometry.registry,groups:identities}:null;
    paintRegistry.current=paintBasis?{...paintBasis,groups:painted}:null;
  }, [geometry,identities,paintBasis,painted]);
  // Numerical consumers keep the evidence basis and own their exact clock wakes.
  const currentGroups=drawnActivity?.by[by]??[];
  const shownSources = lineup.filter(id => titles[id] && !isHidden(arrange.view, cardId(id)));
  // Known from later than the period the hub answered begins (not the page's frame, whose clock may be a minute behind).
  const since = history && activity?.known && activity.known.from > history.since ? activity.known.from : null;

  const said = activityEmpty(history, shownSources.length, personal);
  const empty = error || !said
    ? null
    : said.key === 'loading'
      ? t('history.loading')
      : said.key === 'knownFrom' || said.key === 'noneSince'
        ? t(`activity.${said.key}`, {time: stamp(said.at)})
        : t(`activity.${said.key}`);
  const answered = history?.range === (selected ? timeRangeKey(selected) : prefs.range);
  const emptyFrame = answered && panning === null && !strip ? empty : null;

  return (
    <AnalyticsPanel ref={panel} className="activity" title={t('activity.title')} chart history={history} loading={loading} error={error} retry={()=>{boardPeriod.retry();quotaHistory.retry();}}
      settings={<ActivitySettings arrange={arrange} since={since}/>}
    >
      <Totals history={drawing} by={by} since={since} focus={focus}/>
      <>
          <Stacks
            history={history}
            activity={drawnActivity ?? EMPTY_ACTIVITY}
            currentActivity={activity ?? EMPTY_ACTIVITY}
            origin={drawing?.since ?? from}
            groups={emptyFrame ? [] : presentation.shown}
            paint={paint}
            registry={presentation.registry}
            onDrawing={presentation.onDrawing}
            from={from}
            to={to}
            unknownTo={since}
            onSelect={setTimeRange}
            plot={plot}
            onBase={onBase}
            strip={presentation.strip}
            prepared={prepared.ready && (panning !== null || answered || !!error)}
            authority={authority}
            navigation={navigation}
            by={by}
            empty={!history ? empty : emptyFrame}
          />
          <div className="legend">
            {(emptyFrame ? [] : presentation.identities).map(identity => {
              return <LegendItem key={identity.key} history={drawing} groupKey={identity.key} by={by} group={currentGroups.find(group=>group.key===identity.key)??null} name={groupName(identity, by, titles)} color={identity.color} />;
            })}
          </div>
      </>
    </AnalyticsPanel>
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

/** A stationary readout advances its clipped numbers without waking the SVG. */
function ActivityReadout({history,by,hover,barMs,bar,parts,tipProps}:{history:History|null;by:ActivityDimension;hover:number;barMs:number;bar:number[];parts:{key:string;name:string;color:string;ms:number}[];tipProps:Omit<ComponentProps<typeof Tooltip>,'children'>}) {
  const values=(activity:ActivityData)=>parts.map(part=>({...part,ms:activity.by[by].find(group=>group.key===part.key)?.agentMs??0})).filter(part=>part.ms>0);
  const base=useActivityNumbers(history,by,value=>JSON.stringify([...metricsText(value),...values(value).map(part=>[part.key,workHours(part.ms)])]),true,hover);
  const activity=base;
  const current=activity?values(activity):parts,agentMs=activity?.agentMs??bar[2],activeMs=activity?.activeMs??bar[1],agents=activity?.agents??bar[3];
  if(!current.length)return null;
  return <Tooltip {...tipProps}>
    <div className="tooltip-time">{cellLabel(hover,barMs)}</div>
    <div data-time="activity-readout"><Metrics agentMs={agentMs} activeMs={activeMs} agents={agents}/>
      <div className="tooltip-sep"/>
      <div className="tooltip-grid" style={{gridTemplateColumns:'14px minmax(0, 1fr) auto'}}>
        {current.map(part=><div className="tooltip-row" key={part.key}><i className="activity-swatch" style={{background:part.color}}/><span className="tooltip-name">{part.name}</span><strong>{workHours(part.ms)}</strong></div>)}
      </div>
    </div>
  </Tooltip>;
}

/** The prepared stack paths remain unchanged while their parent moves or clips them. */
const StackArtwork = memo(function StackArtwork({model,paint,by}: {by:ActivityDimension;paint:ReadonlyMap<string,string>;model: {
  groups: {group: PlotGroup; color: string}[];
  paths: string[];
} | null}) {
  if (!model) return null;
  return <>{model.groups.map(({group, color}, i) => (
    <path key={group.key} d={model.paths[i]} fill={paint?.get(group.key)??color} className="activity-stack" style={seriesFocusStyle(activitySeriesKey(by,group.key))} />
  ))}</>;
});

const Stacks = memo(function Stacks({
  history,
  activity: incomingActivity,
  currentActivity,
  origin: incomingOrigin,
  groups: incomingGroups,
  paint,
  registry: incomingRegistry,
  onDrawing,
  from,
  to,
  unknownTo: incomingUnknownTo,
  onSelect,
  plot,
  onBase,
  strip: incomingStrip,
  prepared: incomingReady,
  authority,
  navigation,
  by,
  empty,
}: {
  history?: History|null;
  activity: ActivityData;
  /** Exact boundary bars and readout advance without rebuilding interior stacks. */
  currentActivity?: ActivityData;
  /** Where the answer begins: the bars are drawn from there, so their numbers stay small however old the hub. */
  origin: number;
  /** The groups admitted by board filters, bottom to top, each with its colour and name. */
  groups: {group: PlotGroup; color: string; name: string}[];
  paint:ReadonlyMap<string,string>;
  registry?:ActivityRegistry|null;
  onDrawing?:(registry:ActivityRegistry|null)=>void;
  from: number;
  to: number;
  /** Where what is known of the period begins, when after its start: the part before is marked. */
  unknownTo: number | null;
  onSelect: (range: TimeRange) => void;
  plot: number | undefined;
  onBase: (height: number) => void;
  strip: PlotBuffer | null;
  prepared: boolean;
  authority: number;
  navigation: AxisNavigation;
  by: ActivityDimension;
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
  const cache = useRef({authority, maximum: 0, paths: new StackPaths()});
  if (cache.current.authority !== authority) cache.current = {authority, maximum: 0, paths: new StackPaths()};
  const inputs = [incomingGroups, incomingStrip, incomingActivity, incomingOrigin, incomingUnknownTo, incomingRegistry, by, width, height, navigationKey(navigation)];
  const requested = usePreparationBasis(axis.basis, inputs, active, incomingReady, authority);
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
    const maximum = active ? Math.max(cache.current.maximum, busiest) : busiest;
    const vertical = activityScale(maximum);
    const perMs = (width - left - right) / span;
    const pathOrigin = incomingStrip ? basis.from : incomingOrigin;
    const drawn: typeof incomingGroups = [];
    if (!incomingStrip) for (const row of incomingGroups) {
      const cells: typeof row.group.cells = [];
      for (const cell of row.group.cells) {if (cell[0] + barMs > basis.from - span / 2 && cell[0] < basis.to + span / 2) cells.push(cell); yield;}
      drawn.push({...row, group: {...row.group, cells}}); yield;
    }
    const paths = yield* cache.current.paths.drawPrepared(incomingStrip ? incomingGroups : drawn, pathOrigin, perMs, barMs, height, vertical.max);
    return {basis, barMs, heights, maximum, vertical, perMs, pathOrigin, paths, groups: incomingGroups, strip: incomingStrip, activity: incomingActivity, originUnknownTo: incomingUnknownTo, registry:incomingRegistry};
  }, [...inputs, requested.from, requested.to, requested.end], `${authority}:${by}:${width}:${height}`, incomingReady);
  const model = prepared.value;
  useLayoutEffect(()=>{onDrawing?.(model?.registry??null);},[model?.registry,onDrawing]);
  const basis = model?.basis ?? axis.basis;
  const groups = useMemo(()=>(model?.groups??[]).map(row=>({...row,color:paint.get(row.group.key)??row.color})),[model?.groups,paint]);
  const strip = model?.strip ?? null, activity = currentActivity ?? model?.activity ?? incomingActivity;
  const barMs = model?.barMs ?? incomingActivity.barMs;
  const vertical = model?.vertical ?? activityScale(0);
  const perMs = model?.perMs ?? (width - left - right) / Math.max(MINUTE, basis.to - basis.from), pathOrigin = model?.pathOrigin ?? basis.from;
  const hatchFrom = strip?.from ?? basis.from;
  const knownFrom = strip?.knownFrom ?? model?.originUnknownTo ?? incomingUnknownTo;
  const unknownTo = knownFrom !== null && knownFrom > hatchFrom ? knownFrom : null;
  const span = Math.max(MINUTE, basis.to - basis.from);
  const x = (at: number) => left + (at - basis.from) / span * (width - left - right);
  const y = (value: number) => top + (1 - value / vertical.max) * (height - top - bottom);
  const hover = incomingReady && prepared.ready ? axis.hover : null;
  const tickFrom = strip?.from ?? from, tickTo = strip?.to ?? to;
  const {ticks, daily} = niceTicks(tickFrom, tickTo, (narrow ? 4 : 7) * (tickTo - tickFrom) / span);
  useLayoutEffect(() => {if (model) cache.current.maximum = model.maximum; axis.commitDrawing(basis, incomingReady && prepared.ready);});

  const innerClip = `${clip}-inner`;
  const bandClip = useRef<HTMLDivElement>(null);
  const mask = useRef<SVGRectElement>(null);
  const edges = useRef<SVGGElement>(null);
  const edgePaint = useRef(() => {});
  const painted = useRef('');
  const paintEdges = () => {
    if (!bandClip.current) return;
    const draft = pan.get();
    // Until a gesture has a strip, the retained answer moves as a whole. Its
    // old accounting endpoints cannot clip the newly exposed viewport.
    if ((!strip && (!currentActivity || draft || axis.held)) || !mask.current || !edges.current) {
      clipPlot(bandClip.current, left * scale, (width - right) * scale, width * scale);
      return;
    }
    const visual = axis.visualGeometry();
    const range = strip && (draft || axis.held) ? {from: visual.from, to: visual.from + (draft?.length ?? strip.length)} : {from, to};
    const target = strip ? targetOf(strip.length, draft?.now ?? to, 'edge', range) : null;
    const start = strip && target ? target.k0 * strip.cell : from, end = strip && target ? (target.k1 + 1) * strip.cell : to;
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
    const key = `${start}:${end}:${strip?.version}:${vertical.max}:${height}:${perMs}:${groups.map(g => g.group.key).join(',')}`;
    if (key === painted.current) return;
    painted.current = key;
    const starts = [...new Set([cellStart(start, barMs), cellStart(end - 1, barMs)])].filter(at => at < firstFull || at >= lastFull);
    const paths = groups.map(() => '');
    for (const at of starts) {
      const bar = strip && target ? plotBar(strip, at, target, by) : null;
      if (strip && !bar) continue;
      let total = 0;
      const gap = perMs * barMs >= 8 ? 0.5 : 0;
      const a = x(at) + gap, b = x(at + barMs) - gap;
      groups.forEach(({group}, i) => {
        const ms = strip ? bar?.groups.get(group.key)?.ms ?? 0 : activity.by[by].find(g => g.key === group.key)?.cells.find(([start]) => start === at)?.[1] ?? 0;
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
    hover === null ? [] : groups.flatMap(({group, color, name}) => strip ? partialBar?.groups.has(group.key) ? [{key: group.key, color, name, ms: partialBar.groups.get(group.key)!.ms}] : [] : (currentActivity ? activity.by[by].find(g => g.key === group.key)?.cells ?? [] : group.cells).filter(([start]) => start === hover).map(([, ms]) => ({key: group.key, color, name, ms})));
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
        <g clipPath={(strip || currentActivity) && !active ? `url(#${CSS.escape(innerClip)})` : undefined}>
          <g transform={`translate(${(left + (pathOrigin - basis.from) * perMs).toFixed(1)} 0)`}>
            <StackArtwork model={model} paint={paint} by={by} />
          </g>
        </g>
      </PlotLayer>
      {(strip || currentActivity) && (
        <PlotLayer width={width} height={height} scale={scale} left={left} right={right}>
          <g ref={edges}>{groups.map(({group, color}) => <path key={group.key} fill={color} className="activity-stack" style={seriesFocusStyle(activitySeriesKey(by, group.key))}/>)}</g>
        </PlotLayer>
      )}
      <PlotOverlay width={width} height={height}>
        {drag && <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />}
        {hover !== null && bar && parts.length > 0 && (
          <rect x={axis.screenX(hover)} width={Math.max(1, axis.screenX(hover + barMs) - axis.screenX(hover))} y={top} height={height - top - bottom} className="hover-band" />
        )}
      </PlotOverlay>
      {empty && <div className="chart-empty">{empty}</div>}
      {hover !== null && bar && parts.length > 0 && !drag && (
        <ActivityReadout history={history??null} by={by} hover={hover} barMs={barMs} bar={bar} parts={parts} tipProps={{tip,className:narrow?'is-below':'',style:tipStyle}}/>
      )}
    </div>
  );
});
