import {AnalyticsPanel} from './AnalyticsPanel';
import {ReadState} from './ReadState';
import {memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode} from 'react';
import type {Activity as ActivityData, ActivityDimension, ActivityGroup} from '../lib/types';
import {clock, num, shortDay, stamp, workHours} from '../lib/format';
import {activityEmpty, activityScale, activityGroupName as groupName, atOnce, groupColors, mutedKey} from '../lib/activity';
import {ACTIVITY_BY, setMuted, setPrefs, usePref, useChartMuted, chartMuteKey, chartSeriesMuted} from '../lib/prefs';
import {setTimeRange, timeRange, timeRangeKey, useTimeRange, type TimeRange} from '../lib/timeRange';
import {cellLabel, frameChangesAt, frameOf, measuredTo, niceTicks, periodOf} from '../lib/periods';
import {ACTIVITY, cardId, isHidden, withHidden, type Arrange} from '../lib/view';
import {page, usePersonalBoard, useBoardId, useLineup, useTitles,useProjectColorPins,useProjectColorsReady} from '../lib/board';
import {useClock,hubNow} from '../lib/clock';
import {quotaHistory, useActivityHistory, useHistoryBegins, useHistoryPlot} from '../lib/history';
import {boardPeriod} from '../lib/period';
import {workChange} from '../lib/workChanges';
import type {History} from '../../server/domain/history';
import {plotBar, plotGroupsPrepared, type PlotBuffer, type PlotGroup} from '../lib/historyPlot';
import {usePrepared, usePreparationBasis} from './prepared';
import {axisNavigation, navigationAt, navigationKey, type AxisNavigation} from '../lib/axisNavigation';
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

import {ActivitySelection,type ActivitySelectionState} from '../lib/activitySelection';
import {effectiveFilters,onDataFilters} from '../lib/filterSelection';
import {defaultFilters,workFilter,matchesSource} from '../../server/domain/dataFilters';
import {fetchPeriod} from '../lib/periodTransport';
import {historyPool} from '../lib/historyPool';
import {UNAUTHORIZED} from '../lib/http';

type ActivityHistory=Pick<History,'range'|'activity'>;
type SubsetModel=ActivitySelectionState['model'];
type DetailFrame={history:ActivityHistory|null;model:SubsetModel;scoped:boolean;allOff:boolean;since:number|null;identities:GroupIdentity[]};

const MINUTE = 60_000;
const EMPTY_ACTIVITY: ActivityData = {since: 0, known: null, barMs: MINUTE, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}};

const LABELS: Record<ActivityDimension, Key> = {source: 'activity.bySource', project: 'activity.byProject', device: 'activity.byDevice'};

/** The widget's own settings, as the chart has its own: what its stacks are split by, and (for the board's owner) hiding it. */
function ActivitySettings({arrange,since}: {arrange: Arrange;since?:number|null}) {
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
      {since!=null&&<div className="popover-note">{t('activity.since',{time:stamp(since)})}</div>}
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
function useActivityNumbers(history:ActivityHistory|null,by:ActivityDimension,read:(activity:ActivityData)=>string,enabled=true,bar?:number,key?:string,retained=false) {
  const panning=usePanning();
  const at=(now:number)=>history?boardPeriod.activityAt(history,by,now,bar,key,retained||!boardPeriod.activityProjectionState(history).ready):null;
  const now=useClock(now=>history&&enabled&&!retained&&panning===null&&boardPeriod.activityProjectionState(history).ready?boardPeriod.activityChangesAt(history,by,now,time=>read(at(time)!),key):null);
  return panning===null&&enabled?at(now):bar===undefined?history?.activity??null:null;
}

function LegendAmount({history,by,groupKey,group,retained=false}:{retained?:boolean;history:ActivityHistory|null;by:ActivityDimension;groupKey:string;group:ActivityGroup|null}) {
  const text=(activity:ActivityData)=>workHours(activity.by[by].find(g=>g.key===groupKey)?.agentMs??0);
  const activity=useActivityNumbers(history,by,text,true,undefined,groupKey,retained);
  return <b data-time="activity-work">{activity?text(activity):group?workHours(group.agentMs):'—'}</b>;
}

function LegendMetrics({history,by,groupKey,group,active,retained=false}:{retained?:boolean;history:ActivityHistory|null;by:ActivityDimension;groupKey:string;group:ActivityGroup|null;active:boolean}) {
  const part=(activity:ActivityData)=>activity.by[by].find(g=>g.key===groupKey)??{agentMs:0,activeMs:0,agents:0};
  const activity=useActivityNumbers(history,by,value=>JSON.stringify(metricsText(part(value))),active,undefined,groupKey,retained);
  const value=activity?part(activity):group;
  return <span data-time="activity-metrics">{value?<Metrics agentMs={value.agentMs} activeMs={value.activeMs} agents={value.agents}/>:<span>{t('activity.pendingRange')}</span>}</span>;
}

function SelectedLegendAmount({history,subset,model,groupKey}:{history:ActivityHistory|null;subset:ActivitySelection;model:SubsetModel;groupKey:string}) {
  const {activity}=useSubsetNumbers(subset,history,true,undefined,model,groupKey);
  return <b data-time="activity-work">{activity?workHours(activity.agentMs):'—'}</b>;
}

function SelectedLegendMetrics({history,subset,model,groupKey}:{history:ActivityHistory|null;subset:ActivitySelection;model:SubsetModel;groupKey:string}) {
  const {activity}=useSubsetNumbers(subset,history,true,undefined,model,groupKey);
  return <span data-time="activity-metrics">{activity?<Metrics agentMs={activity.agentMs} activeMs={activity.activeMs} agents={activity.agents}/>:<span>{t('activity.pendingRange')}</span>}</span>;
}

/** Keyboard descriptions belong to their own entry even when the pointer wins visually. */
const LegendItem = memo(function LegendItem({history,group,groupKey,by,name,color,muted,retained=false,subset,model=null,scoped=false}:{subset:ActivitySelection;model?:SubsetModel;scoped?:boolean;retained?:boolean;history:ActivityHistory|null;group:ActivityGroup|null;groupKey:string;by:ActivityDimension;name:string;color:string;muted:boolean}) {
  useLocale();const id=useId(),[focused,setFocused]=useState(false);
  return <div className="activity-legend-item">
    <button type="button" className="legend-item" data-series-key={mutedKey(by,groupKey)} data-agent-ms={group?.agentMs} style={seriesFocusStyle(mutedKey(by,groupKey))}
      aria-describedby={id} aria-pressed={!muted} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
      onClick={()=>setMuted(chartMuteKey(ACTIVITY,by,groupKey),!muted)}>
      <i className="activity-swatch" style={{background:color}}/><span>{name}</span><>{scoped&&!muted?<SelectedLegendAmount history={history} subset={subset} model={model} groupKey={groupKey}/>:<LegendAmount retained={retained} history={history} by={by} groupKey={groupKey} group={group}/>}</>
    </button>
    <span id={id} className="sr-only">{muted?t('activity.seriesHidden'):focused?scoped?<SelectedLegendMetrics history={history} subset={subset} model={model} groupKey={groupKey}/>:<LegendMetrics retained={retained} history={history} by={by} groupKey={groupKey} group={group} active/>:null}</span>
  </div>;
});

/** Keep dormant exclusions so a newly arriving group follows the saved legend choice. */
export function activityMutedKeys(muted:Record<string,boolean>,by:ActivityDimension) {
  const keys=new Set<string>(),prefix=`activity:${by}:`;
  for(const [key,on] of Object.entries(muted))if(key.startsWith(prefix)&&on)keys.add(key.slice(prefix.length));
  for(const [key,on] of Object.entries(muted))try{const parts=JSON.parse(key);if(Array.isArray(parts)&&parts.length===3&&parts[0]===ACTIVITY&&parts[1]===by&&typeof parts[2]==='string'){if(on)keys.add(parts[2]);else keys.delete(parts[2]);}}catch{/* Legacy keys were read above. */}
  return [...keys].sort();
}

function useActivitySubset(history:History|null,by:ActivityDimension,muted:Record<string,boolean>,authority:number,allOff:boolean,scoped:boolean) {
  const [reader]=useState(()=>new ActivitySelection({pool:historyPool,now:hubNow,send:fetchPeriod,
    read:()=>{const value=boardPeriod.get();return {trace:value.value,ready:!value.loading&&!value.error&&!!value.value,error:value.error,evidence:value.evidence};},
    accessLost:()=>{page.dispatch({type:'board-close'});window.dispatchEvent(new Event(UNAUTHORIZED));},
    retryWork:()=>boardPeriod.retry(),
  }));
  const selected=useTimeRange(),range=usePref('range');
  const configure=useRef(()=>{});
  configure.current=()=>{
    const off=activityMutedKeys(muted,by),board=page.get().board;
    reader.configure(scoped&&!allOff&&off.length&&history&&board&&history.board===board.id?{board:board.id,authority:JSON.stringify([authority,board.workAuthority,page.get().hubEpoch]),workAuthority:board.workAuthority,run:page.get().hubEpoch,by,muted:off,filters:workFilter(effectiveFilters()??defaultFilters()),
      selection:selected?{mode:'range',...selected}:{mode:'live',periodMs:periodOf(range).ms},rangeKey:selected?timeRangeKey(selected):range,barMs:history.activity.barMs}:null);
  };
  useLayoutEffect(()=>configure.current());
  useEffect(()=>{
    const stops=[boardPeriod.subscribe(reader.refresh),onDataFilters(()=>configure.current()),page.listen((event,state)=>{
      if(!state.board||event.type==='board-close')reader.reset();
      else if(event.type==='hub'){
        if(event.event.type==='history'){
          const board=state.board,filters=effectiveFilters(),range=timeRange();
          const change=workChange(event.event.data,board.lineup.filter(id=>!filters||matchesSource(filters,id)),range?.to??Infinity);
          if(change.retired)reader.invalidate();
          else if(change.since!==Infinity||event.event.data.workAuthority!==undefined)reader.changed(change.since,event.event.data.workAuthority);
          configure.current();
        }else if(['hello','snapshot','mine','lineup'].includes(event.event.type)){configure.current();reader.baseline();}
      }
    })];
    return()=>{stops.forEach(stop=>stop());reader.reset();};
  },[reader]);
  return reader;
}

function useSubsetNumbers(reader:ActivitySelection,history:ActivityHistory|null,enabled:boolean,bar?:number,model?:SubsetModel,key?:string) {
  const state=useSyncExternalStore(reader.subscribe,reader.get),panning=usePanning();
  const active=model===undefined?state.model:model;
  const admitted=!!active&&reader.sameScope(active);
  const at=(now:number)=>active?.rangeKey===history?.range?reader.numbers(now,bar,active,key):null;
  const frozen=useRef<ReturnType<typeof at>>(null);
  const now=useClock(now=>enabled&&panning===null?reader.changesAt(now,at=>{const value=reader.numbers(at,bar,active,key);return JSON.stringify([value?.available,!!value?.known,...metricsText(value??EMPTY_ACTIVITY)]);},active,key):null);
  if(!enabled||!admitted)frozen.current=null;
  else if(panning===null)frozen.current=at(now);
  return {activity:enabled?(panning===null?at(now):admitted?frozen.current:null):null,state};
}

/** Only this small region hears legend preview changes. Its reserved geometry is constant. */
const Totals=memo(function Totals({history,by,subset,scoped,allOff,since,focus,model,retained=false}:{model?:SubsetModel;retained?:boolean;history:ActivityHistory|null;by:ActivityDimension;subset:ActivitySelection;scoped:boolean;allOff:boolean;since:number|null;focus:SeriesFocus}) {
  useLocale();const selected=useSyncExternalStore(focus.subscribe,focus.get);
  // The legend can retain an identity after its last work leaves this interval.
  const prefix=mutedKey(by,''),key=selected?.startsWith(prefix)?selected.slice(prefix.length):undefined,previewed=key!==undefined;
  const localPreview=scoped&&previewed&&!!model&&!model.muted.includes(key);
  const base=useActivityNumbers(history,by,value=>JSON.stringify([!!value.known,...metricsText(value)]),!scoped||previewed&&!localPreview,undefined,key,retained);
  const local=useSubsetNumbers(subset,history,scoped&&(!previewed||localPreview),undefined,model,localPreview?key:undefined);
  const context=localPreview?local.activity:base,preview=previewed?context?.by[by].find(part=>part.key===key):undefined;
  const activity=previewed&&context?{...context,agentMs:preview?.agentMs??0,activeMs:preview?.activeMs??0,agents:preview?.agents??0}:scoped?local.activity:base;
  const text=allOff?t('activity.noSeries'):activity?.available===false?t('activity.noSessions'):activity&&!activity.known?t('activity.knownFrom',{time:stamp(activity.since)}):null;
  return <div className="chart-info activity-info" data-time="activity-info" data-series-context={previewed?selected:undefined}>
    <div className="activity-totals" data-time="activity-totals" data-agent-ms={!text?activity?.agentMs:undefined}>
      {text?<span>{text}</span>:<>
        <span title={t('activity.agentHoursHint')}><span className="activity-total-name">{t('activity.agentHours')}</span><b>{activity?workHours(activity.agentMs):'—'}</b></span>
        <span title={t('activity.activeHint')}><span className="activity-total-name">{t('activity.active')}</span><b>{activity?workHours(activity.activeMs):'—'}</b></span>
        <span title={t('activity.agentsHint')}><span className="activity-total-name">{t('activity.agents')}</span><b>{activity?num(activity.agents):'—'}</b></span>
        <span title={t('activity.atOnceHint')}><span className="activity-total-name">{t('activity.atOnce')}</span><b>{activity&&activity.activeMs>0?atOnce(activity.agentMs,activity.activeMs):'—'}</b></span>
      </>}
    </div>
    {since!==null&&<span className="sr-only">{t('activity.since',{time:stamp(since)})}</span>}
    {scoped&&!previewed&&<ReadState error={local.state.error} retry={subset.retry}/>}
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
  const range=usePref('range'),horizon=usePref('horizon'),activityBy=usePref('activityBy'),muted=useChartMuted(ACTIVITY);
  const prefs=useMemo(()=>({range,horizon,activityBy,muted}),[range,horizon,activityBy,muted]);
  const groupMuted=(key:string)=>chartSeriesMuted(muted,ACTIVITY,activityBy,key,!!muted[mutedKey(activityBy,key)]);
  const by = prefs.activityBy;
  const focus=useSeriesFocus(panel,`${authority}:${drawing?.range}:${by}`);
  const locale = useLocale();
  const selected = useTimeRange();
  const board=useBoardId(),baseNavigation=axisNavigation(board,selected,prefs),navigation={...baseNavigation,context:JSON.stringify([baseNavigation.context,authority])};
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
  const currentGroups=drawnActivity?.by[by]??[];
  const allOff=currentGroups.length>0&&currentGroups.every(group=>groupMuted(group.key));
  const scoped=currentGroups.some(group=>groupMuted(group.key));
  const subset=useActivitySubset(drawing,by,muted,authority,allOff,scoped);
  const local=useSyncExternalStore(subset.subscribe,subset.get);
  const numeric=useMemo(()=>({history:drawing?{range:drawing.range,activity:drawing.activity}:null,model:local.model,scoped,allOff,since:history&&activity?.known&&activity.known.from>history.since?activity.known.from:null}),[drawing,local.model,scoped,allOff]);
  // A queued preparation owns its input even before its output can be displayed.
  useLayoutEffect(()=>subset.retain(numeric.model),[subset,numeric.model]);
  // What the groups look like changes with the answer, the board and the legend, not with time: the same objects as the clock moves the frame.
  const {groups, colors, shown} = useMemo(() => {
    const groups = drawnActivity?.by[by] ?? [];
    const colors = groupColors(groups, by, arrange.view, source => titles[source]?.provider ?? '');
    const names = groups.map(group => groupName(group, by, titles));
    const muted = groups.map(group => groupMuted(group.key));
    const shown = groups.flatMap((group, i) => (muted[i] ? [] : [{group, color: colors[i], name: names[i]}]));
    return {groups, colors, names, muted, shown};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnActivity, by, arrange.view, titles, prefs.muted, locale]);
  const prepared = usePrepared(function* () {
    const data = new Map<string, PlotGroup>();
    const found = new Map<string, Pick<PlotGroup, 'key' | 'name'>>();
    if (strip) {
      for (const group of yield* plotGroupsPrepared(strip, {k0: strip.from / strip.cell, k1: strip.to / strip.cell - 1}, by)) {data.set(group.key, group); yield;}
      for (const row of strip.activityCells.values()) for (const [key, part] of row.parts[by]) {found.set(key, {key, name: part.name}); yield;}
    }
    const seed = groups.map((group, i) => ({key: group.key, name: group.name, color: colors[i]}));
    if (!strip) return {numeric,identities: seed, shown, strip, registry: by==='project'?{authority,token:-1,range:drawing?.range,by,basis:groups,seed,groups:seed}:null};
    const previous = registry.current?.authority === authority && registry.current.token === strip.token && registry.current.by === by ? registry.current : {authority, token: strip.token,range:drawing?.range, by, seed, groups: seed};
    const identities = groupRegistry(previous.seed, previous.groups, [...found.values()], by === 'source' ? key => key==='unknown'||key==='notProvided'?'var(--other)' : colorOf(arrange.view, key, titles[key]?.provider ?? '') : undefined);
    const plotted: {group: PlotGroup; color: string; name: string}[] = [];
    for (const identity of identities) {if (!groupMuted(identity.key)) plotted.push({group: data.get(identity.key) ?? {key: identity.key, name: identity.name, cells: EMPTY_CELLS}, color: identity.color, name: groupName(identity, by, titles)}); yield;}
    return {numeric,identities, shown: plotted, strip, registry: {authority, token: strip.token,range:drawing?.range, by,basis:groups, seed: previous.seed, groups: identities}};
  }, [strip, groups, colors, shown, by, arrange.view, titles, prefs.muted, locale,numeric], `${authority}:${history?.board}:${by}:${JSON.stringify(activityMutedKeys(muted,by))}`,(by!=='project'||colorsReady)&&(panning!==null||!scoped||allOff||!loading&&!error&&!!local.model&&!local.loading&&!local.error&&subset.compatible(local.model)));
  const geometry = prepared.value;
  useLayoutEffect(()=>subset.retain(geometry?.numeric.model??null),[subset,geometry?.numeric.model]);
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
  const shownSources = lineup.filter(id => titles[id] && !isHidden(arrange.view, cardId(id)));
  // Known from later than the period the hub answered begins (not the page's frame, whose clock may be a minute behind).
  const since = history && activity?.known && activity.known.from > history.since ? activity.known.from : null;

  const said = activityEmpty(history, shownSources.length, personal);
  const empty = error || !said
    ? null
    : said.key === 'loading'
      ? null
      : said.key === 'knownFrom' || said.key === 'noneSince'
        ? t(`activity.${said.key}`, {time: stamp(said.at)})
        : t(`activity.${said.key}`);
  const answered = history?.range === (selected ? timeRangeKey(selected) : prefs.range);
  const emptyFrame = answered && panning === null && !strip ? empty : null;

  const detailFrame=useMemo(()=>geometry?{...geometry.numeric,identities:geometry.identities}:null,[geometry]);
  const renderDetails=(frame:DetailFrame|null,retained:boolean)=>({
    summary:<Totals history={frame?.history??null} model={frame?.model??null} retained={retained} by={by} subset={subset} scoped={scoped} allOff={allOff} since={frame?.since??null} focus={focus}/>,
    legend:<div className="legend">{(emptyFrame?[]:frame?.identities??[]).map(identity=><LegendItem key={identity.key} subset={subset} model={frame?.model??null} scoped={scoped} retained={retained} history={frame?.history??null} groupKey={identity.key} by={by} group={frame?.history?.activity.by[by].find(group=>group.key===identity.key)??null} name={groupName(identity,by,titles)} color={resolved.get(identity.key)?.color??identity.color} muted={!!groupMuted(identity.key)}/>)}</div>,
  });
  return (
    <AnalyticsPanel ref={panel} className="activity" title={t('activity.title')} chart history={history} loading={loading} error={error} retry={()=>{boardPeriod.retry();quotaHistory.retry();}}
      settings={<ActivitySettings arrange={arrange} since={since}/>}
    >
      <>
          <Stacks
            history={history}
            detailFrame={detailFrame}
            renderDetails={renderDetails}
            subset={subset}
            scoped={scoped}
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
            valueContext={JSON.stringify([board,activityMutedKeys(prefs.muted,by)])}
            allMuted={!emptyFrame && presentation.identities.length > 0 && presentation.shown.length === 0}
            empty={!history ? empty : emptyFrame}
          />

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
function ActivityReadout({history,by,hover,barMs,bar,parts,tipProps,subset,scoped,model,retained=false}:{model?:SubsetModel;retained?:boolean;subset:ActivitySelection;scoped:boolean;history:ActivityHistory|null;by:ActivityDimension;hover:number;barMs:number;bar:number[];parts:{key:string;name:string;color:string;ms:number}[];tipProps:Omit<ComponentProps<typeof Tooltip>,'children'>}) {
  const values=(activity:ActivityData)=>parts.map(part=>({...part,ms:activity.by[by].find(group=>group.key===part.key)?.agentMs??0})).filter(part=>part.ms>0);
  const base=useActivityNumbers(history,by,value=>JSON.stringify([...metricsText(value),...values(value).map(part=>[part.key,workHours(part.ms)])]),!scoped,hover,undefined,retained);
  const local=useSubsetNumbers(subset,history,scoped,hover,model);
  const activity=scoped?local.activity:base;
  const current=activity?values(activity):parts,agentMs=activity?.agentMs??bar[2],activeMs=activity?.activeMs??bar[1],agents=activity?.agents??bar[3];
  if(!current.length||scoped&&!activity)return null;
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

const Stacks = memo(function Stacks({
  detailFrame,
  renderDetails,
  subset,
  scoped,
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
  valueContext='',
  allMuted,
  empty,
}: {
  history?: History|null;
  detailFrame:DetailFrame|null;
  renderDetails:(frame:DetailFrame|null,retained:boolean)=>{summary:ReactNode;legend:ReactNode};
  subset:ActivitySelection;
  scoped:boolean;
  activity: ActivityData;
  /** Exact boundary bars and readout advance without rebuilding interior stacks. */
  currentActivity?: ActivityData;
  /** Where the answer begins: the bars are drawn from there, so their numbers stay small however old the hub. */
  origin: number;
  /** The groups switched on in the legend, bottom to top, each with its colour and name. */
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
  valueContext?:string;
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
  const cache = useRef({authority, paths: new StackPaths()});
  if (cache.current.authority !== authority) cache.current = {authority, paths: new StackPaths()};
  const inputs = [incomingGroups, incomingStrip, incomingActivity, incomingOrigin, incomingUnknownTo, incomingRegistry,detailFrame, by, width, height, navigationKey(navigation)];
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
    const draft=active?pan.get():null,visual=draft?axis.visualGeometry():null;
    const selected=draft&&visual?{from:visual.from,to:visual.from+draft.length}:{from,to};
    const target=incomingStrip?targetOf(selected.to-selected.from,draft?.now??to,'scale',selected):null;
    let maximum = 0;
    for (const [at,value] of heights) {
      // Only complete drawn bars set the scale. Raw strip cells may be unread,
      // or outside the selected period, and cannot supply a phantom maximum.
      if(incomingStrip?at>=selected.from&&at+barMs<=selected.to:at<selected.to&&at+barMs>selected.from)maximum=Math.max(maximum,value);
      yield;
    }
    if(incomingStrip&&target)for(const at of new Set([cellStart(selected.from,barMs),cellStart(selected.to-1,barMs)])){
      const edge=plotBar(incomingStrip,at,target,by);
      if(edge)maximum=Math.max(maximum,[...edge.groups].reduce((sum,[key,part])=>sum+(keys.has(key)?part.ms:0),0));
      yield;
    }
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
    return {basis,detailFrame, barMs, heights, maximum, vertical, perMs, pathOrigin, paths, groups: incomingGroups, strip: incomingStrip, activity: incomingActivity, originUnknownTo: incomingUnknownTo, registry:incomingRegistry};
  }, [...inputs, requested.from, requested.to, requested.end], `${authority}:${by}:${width}:${height}:${valueContext}`, incomingReady);
  const model = prepared.value;
  const coherent=incomingReady&&prepared.ready;
  useLayoutEffect(()=>subset.retain(detailFrame?.model??null),[subset,detailFrame?.model]);
  useLayoutEffect(()=>subset.retain(model?.detailFrame?.model??null),[subset,model?.detailFrame?.model]);
  const details=renderDetails(model?.detailFrame??null,!coherent);
  useLayoutEffect(()=>{onDrawing?.(model?.registry??null);},[model?.registry,onDrawing]);
  const basis = model?.basis ?? axis.basis;
  const groups = useMemo(()=>(model?.groups??[]).map(row=>({...row,color:paint.get(row.group.key)??row.color})),[model?.groups,paint]);
  const strip = model?.strip ?? null, activity = (coherent?currentActivity:undefined) ?? model?.activity ?? incomingActivity;
  const barMs = model?.barMs ?? incomingActivity.barMs;
  const vertical = model?.vertical ?? activityScale(0);
  const heights=model?.heights??new Map<number,number>();
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

  const innerClip = `${clip}-inner`;
  const bandClip = useRef<HTMLDivElement>(null);
  const mask = useRef<SVGRectElement>(null);
  const edges = useRef<SVGGElement>(null);
  const valueBand=useRef<SVGGElement>(null),valueAxis=useRef<SVGGElement>(null);
  const paintedValue=useRef('');
  const valuePin=useRef<{context:string;range:string;maximum:number}|null>(null);
  const painted = useRef('');
  // The prepared paths own their numeric basis. The native painter owns the
  // visible value projection, just as timeAxis owns their horizontal projection.
  const paintValue=(maximum:number)=>{
    const projection=activityScale(maximum),ratio=vertical.max/projection.max,baseline=height-bottom;
    const key=`${projection.max}:${vertical.max}:${height}`;
    if(paintedValue.current===key)return;
    paintedValue.current=key;
    const transform=ratio===1?'':`translate(0 ${baseline}) scale(1 ${ratio}) translate(0 ${-baseline})`;
    for(const node of [valueBand.current,edges.current])if(node){
      if(transform){if(node.getAttribute('transform')!==transform)node.setAttribute('transform',transform);}
      else if(node.hasAttribute('transform'))node.removeAttribute('transform');
    }
    [...(valueAxis.current?.children??[])].forEach((row,index)=>{
      const node=row as SVGGElement,value=projection.ticks[index],hidden=value===undefined;
      if(node.style.display!==(hidden?'none':''))node.style.display=hidden?'none':'';
      if(hidden)return;
      const at=top+(1-value/projection.max)*(height-top-bottom),line=node.querySelector('line'),label=node.querySelector('text');
      for(const name of ['y1','y2'])if(line?.getAttribute(name)!==String(at))line?.setAttribute(name,String(at));
      if(label){const text=value?workHours(value):'0';if(label.textContent!==text)label.textContent=text;if(label.getAttribute('y')!==String(at+4))label.setAttribute('y',String(at+4));}
    });
  };
  const paintEdges = (forced?:TimeRange,pin=false) => {
    if (!bandClip.current) return;
    const draft = pan.get();
    const visual = axis.visualGeometry();
    const range = forced??(draft || axis.held ? {from: visual.from, to: visual.from + (draft?.length ?? strip?.length ?? to-from)} : {from, to});
    const target = strip ? targetOf(strip.length, draft?.now ?? to, 'edge', range) : null;
    let maximum=0;
    for(const [at,value] of heights)if(strip?at>=range.from&&at+barMs<=range.to:at<range.to&&at+barMs>range.from)maximum=Math.max(maximum,value);
    if(strip&&target)for(const at of new Set([cellStart(range.from,barMs),cellStart(range.to-1,barMs)])){
      const bar=plotBar(strip,at,target,by);
      if(bar)maximum=Math.max(maximum,[...bar.groups].reduce((sum,[key,part])=>sum+(groups.some(row=>row.group.key===key)?part.ms:0),0));
    }
    if(pin||!draft&&(!axis.held||!!forced)){
      const context=`${navigation.context}:${width}:${height}:${valueContext}`,projectionKey=navigationKey(navigationAt(navigation,forced??timeRange()));
      if(pin)valuePin.current={context,range:projectionKey,maximum:activityScale(maximum).max};
      if(valuePin.current?.context!==context||valuePin.current.range!==projectionKey)valuePin.current=null;
      if(valuePin.current){valuePin.current.maximum=Math.max(activityScale(maximum).max,valuePin.current.maximum);maximum=valuePin.current.maximum;}
    }
    paintValue(maximum);
    // Until a gesture has a strip, the retained answer moves as a whole. Its
    // old accounting endpoints cannot clip the newly exposed viewport.
    if ((!strip && (!currentActivity || draft || axis.held)) || !mask.current || !edges.current) {
      clipPlot(bandClip.current, left * scale, (width - right) * scale, width * scale);
      return;
    }
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
      const local=!strip&&scoped?subset.numbers(hubNow(),at,model?.detailFrame?.model??null):null;
      let total = 0;
      const gap = perMs * barMs >= 8 ? 0.5 : 0;
      const a = x(at) + gap, b = x(at + barMs) - gap;
      groups.forEach(({group}, i) => {
        const ms = strip ? bar?.groups.get(group.key)?.ms ?? 0 : local?local.by[by].find(part=>part.key===group.key)?.agentMs??0:activity.by[by].find(g => g.key === group.key)?.cells.find(([start]) => start === at)?.[1] ?? 0;
        if (!ms) return;
        const low = total;
        total += ms;
        paths[i] += `M${a.toFixed(1)},${y(total).toFixed(1)}H${b.toFixed(1)}V${y(low).toFixed(1)}H${a.toFixed(1)}Z`;
      });
    }
    edges.current.querySelectorAll('path').forEach((path, i) => {if (path.getAttribute('d') !== paths[i]) path.setAttribute('d', paths[i]);});
  };
  // Value projection follows the committed time pose, including the final RAF.
  // Logical cancellation alone still leaves the previous native pose on screen.
  useLayoutEffect(() => {
    painted.current = '';paintedValue.current='';
    axis.commitDrawing(basis, incomingReady && prepared.ready, stop => {
      if(stop&&!stop.canceled&&stop.changed&&!stop.range)valuePin.current=null;
      paintEdges(stop?.range??undefined,!!stop&&!stop.canceled&&stop.changed&&!!stop.range);
    });
    if(!axis.held)paintEdges();
  });
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

  return (<>
    {details.summary}
    <div className="chart activity-chart" ref={box} {...handlers}>
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} style={{height: `${height * scale}px`}} preserveAspectRatio="none" role="img" aria-label={t('activity.label')} className="is-selectable">
        <desc>{t('chart.panHint')}</desc>
        <defs>
          <clipPath id={innerClip}><rect ref={mask} x={left} y={top} width={width - left - right} height={height - top - bottom} /></clipPath>
          <pattern id={`${clip}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" x2="0" y1="0" y2="6" className="activity-hatch" />
          </pattern>
        </defs>
        <g ref={valueAxis} className="activity-value-axis">{[0,1,2,3].map(index=>{const value=vertical.ticks[index]??0;return (
          <g key={index} style={index>=vertical.ticks.length?{display:'none'}:undefined}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'axis-line' : 'grid'} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className="tick">
              {value ? workHours(value) : '0'}
            </text>
          </g>
        );})}</g>
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
          <g ref={valueBand}><g transform={`translate(${(left + (pathOrigin - basis.from) * perMs).toFixed(1)} 0)`}>
            {groups.map(({group, color}, i) => (
              <path key={group.key} d={paths[i]} fill={color} className="activity-stack" style={seriesFocusStyle(mutedKey(by, group.key))}/>
            ))}
          </g></g>
        </g>
      </PlotLayer>
      {(strip || currentActivity) && (
        <PlotLayer width={width} height={height} scale={scale} left={left} right={right}>
          <g ref={edges}>{groups.map(({group, color}) => <path key={group.key} fill={color} className="activity-stack" style={seriesFocusStyle(mutedKey(by, group.key))}/>)}</g>
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
        <ActivityReadout subset={subset} scoped={scoped} model={model?.detailFrame?.model??null} retained={!coherent} history={model?.detailFrame?.history??null} by={by} hover={hover} barMs={barMs} bar={bar} parts={parts} tipProps={{tip,className:narrow?'is-below':'',style:tipStyle}}/>
      )}
    </div>
    {details.legend}
  </>);
});
