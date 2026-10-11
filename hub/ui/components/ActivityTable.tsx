import {memo,useCallback,useLayoutEffect,useRef,useState,type CSSProperties,type RefObject} from 'react';
import type {Activity,ActivityDimension,ActivityGroup} from '../lib/types';
import {activityGroupName,atOnce,groupColors} from '../lib/activity';
import {ACTIVITY_COLUMNS,activityKey,effectiveActivitySort,nextActivitySort,sortedActivity,type ActivityColumn} from '../lib/activityTable';
import {boardPeriod,usePeriodActivity,usePeriodSessions,type SessionOrder} from '../lib/period';
import {workHours,num,stamp} from '../lib/format';
import {ACTIVITY_BY,setPrefs,usePref} from '../lib/prefs';
import {ACTIVITY_TABLE,columnShown,colorOf,type Arrange} from '../lib/view';
import {useTitles} from '../lib/board';
import {timeRangeKey,useTimeRange} from '../lib/timeRange';
import {columnsOf,groupsOf,nextAgentsSort,type AgentRow,type AgentsBy,type AgentsSort} from '../lib/agents';
import {t,useLocale,type Key} from '../i18n';
import {Segmented} from './Kit';
import {Popover} from './Popover';
import {AnalyticsTable,TableSettings,type AnalyticsColumn,type AnalyticsRow,type TimedCell} from './AnalyticsTable';
import {PeriodStatus} from './PeriodStatus';
import {AgentPages,AgentsDialog,SortIcon} from './Agents';
import {fillOf,pixels,useSizing} from './sizing';

const LABELS:Record<ActivityDimension,Key>={project:'activity.byProject',device:'activity.byDevice',source:'activity.bySource'};
const COLUMNS:Record<ActivityColumn,{title:Key;hint:Key;width:number}>={
  agenthours:{title:'activity.agentHours',hint:'activity.agentHoursHint',width:120},
  active:{title:'activity.active',hint:'activity.activeHint',width:120},
  sessions:{title:'activity.agents',hint:'activity.agentsHint',width:180},
  concurrency:{title:'activityTable.concurrency',hint:'activity.atOnceHint',width:180},
};
const AGENTS_BY:Record<ActivityDimension,AgentsBy>={project:'project',device:'machine',source:'subscription'};

/** Measure only the current page; a chosen height scrolls those rows inside the widget. */
function useTableSize(panel:RefObject<HTMLElement|null>){
  const sizing=useSizing(),measure=useRef(()=>{});
  measure.current=()=>{
    const root=panel.current,body=root?.querySelector<HTMLElement>('.table-wrap,.analytics-compact');
    if(!sizing||!root||!body)return;
    const shown=root.getBoundingClientRect().height-fillOf(root),chrome=shown-body.getBoundingClientRect().height;
    const natural=chrome+body.scrollHeight;
    const first=body.querySelector('tbody > tr, :scope > li'),heading=body.querySelector('thead');
    const minimum=chrome+(first?.getBoundingClientRect().height??0)+(heading?.getBoundingClientRect().height??0);
    sizing.report({min:pixels(minimum),natural:pixels(natural),shown:pixels(shown)});
    body.style.maxHeight=sizing.manual?`${pixels(Math.max(minimum-chrome,sizing.allocated-chrome))}px`:'';
    body.style.overflowY=sizing.manual?'auto':'';
  };
  useLayoutEffect(()=>measure.current());
  useLayoutEffect(()=>{
    if(!sizing||!panel.current)return;
    const observer=new ResizeObserver(()=>measure.current());observer.observe(panel.current);
    return ()=>observer.disconnect();
  },[panel,sizing?.report]);
  const report=sizing?.report;useLayoutEffect(()=>()=>report?.(null),[report]);
}
const metric=(summary:Activity|null,by:ActivityDimension,column:ActivityColumn,key?:string)=>{
  if(!summary?.known)return '—';
  const value=key===undefined?summary:summary.by[by].find(g=>g.key===key);
  if(!value)return '—';
  return column==='agenthours'?workHours(value.agentMs):column==='active'?workHours(value.activeMs):column==='sessions'?num(value.agents):atOnce(value.agentMs,value.activeMs);
};

/** Presence and disclosure sorting wake only the open session list. */
function Contributions({by,chosen,title,arrange,onClose,restore}:{by:ActivityDimension;chosen:string;title:string;arrange:Arrange;onClose:()=>void;restore:()=>HTMLElement|null}){
  const titles=useTitles(arrange.view.names),[sort,setSort]=useState<AgentsSort>(null);
  const period=usePeriodSessions(rows=>{
    const selected=rows.filter(row=>activityKey(row,by)===chosen);
    return sort?.column==='worked'?{key:selected.slice().sort((a,b)=>(sort.descending?b.workedMs-a.workedMs:a.workedMs-b.workedMs)||a.ref.localeCompare(b.ref)).map(row=>row.ref),worked:[selected.map(row=>[row.ref])]}:null;
  });
  const entries:AgentRow[]=period.rows.map(session=>({session,source:session.source===null?null:{id:session.source,...titles[session.source],sessions:[]}}));
  const groups=groupsOf(entries,AGENTS_BY[by]);
  const current=groups.find(g=>g.key===chosen);
  const color=useCallback((source:AgentRow['source'])=>({'--card-color':source?colorOf(arrange.view,source.id,source.provider):'var(--other)'}) as CSSProperties,[arrange.view]);
  return <AgentsDialog groups={groups} by={AGENTS_BY[by]} arrangement={()=>{const {name,rest}=columnsOf(AGENTS_BY[by],true);return {name,columns:rest.filter(column=>column!=='running')};}}
    agentsSort={sort} sortBy={(active,column,cycle)=>setSort(nextAgentsSort(active,column,cycle))} color={color} empty={null} period={period}
    initial={chosen} keepChosen chosenTitle={current?(by==='project'?current.name??t('activity.noProject'):current.name??title):title} onClose={onClose} restore={restore}/>;
}

export const ActivityTable=memo(function ActivityTable({arrange}:{arrange:Arrange}){
  const locale=useLocale(),by=usePref('activityTableBy'),savedSort=usePref('activityTableSort'),range=usePref('range'),selected=useTimeRange();
  const titles=useTitles(arrange.view.names),panel=useRef<HTMLElement>(null);
  useTableSize(panel);
  const visible=ACTIVITY_COLUMNS.filter(column=>columnShown(arrange.view,ACTIVITY_TABLE,column));
  const active=effectiveActivitySort(savedSort,visible);
  const name=(group:ActivityGroup)=>activityGroupName(group,by,titles);
  const ordered=(summary:Activity|null)=>sortedActivity(summary?.by[by]??[],active,name,locale,by);
  const period=usePeriodActivity(by,rows=>{
    const groups=ordered(boardPeriod.activitySummaryAt(by));
    const demand:SessionOrder={key:groups.map(g=>g.key)};
    if(active.column==='agenthours'){
      const refs=new Map<string,string[]>();for(const row of rows){const key=activityKey(row,by);let entries=refs.get(key);if(!entries)refs.set(key,entries=[]);entries.push(row.ref);}
      demand.worked=[groups.map(g=>refs.get(g.key)??[])];
    }
    if(active.column==='active'||active.column==='concurrency')demand.activity={by,column:active.column,keys:groups.map(g=>g.key)};
    return demand;
  });
  const {summary}=period,groups=ordered(summary);
  const paginationKey=JSON.stringify([by,active,selected?timeRangeKey(selected):range]);
  const [pagination,setPagination]=useState({key:paginationKey,page:0});
  const currentPage=Math.min(pagination.key===paginationKey?pagination.page:0,Math.max(0,Math.ceil(groups.length/50)-1));
  const [opened,setOpened]=useState<{by:ActivityDimension;key:string;title:string}|null>(null);
  const sortBy=(column:ActivityColumn|'name')=>setPrefs({activityTableSort:nextActivitySort(savedSort,column)});
  const columns:AnalyticsColumn<ActivityColumn>[]=visible.map(id=>({id,title:t(COLUMNS[id].title),hint:t(COLUMNS[id].hint),width:COLUMNS[id].width,align:'right'}));
  const ranked=sortedActivity(summary?.by[by]??[],{column:'agenthours',descending:true},name,locale,by);
  const colors=groupColors(ranked,by,arrange.view,id=>titles[id]?.provider??'');
  const colorOfGroup=new Map(ranked.map((g,i)=>[g.key,colors[i]]));
  const cells=(key?:string)=>Object.fromEntries(ACTIVITY_COLUMNS.map(column=>{
    const read=(now:number)=>metric(boardPeriod.activitySummaryAt(by,now,key),by,column,key);
    const cell:TimedCell={time:'activity-table',changesAt:now=>boardPeriod.activitySummaryChangesAt(by,now,read,key),at:now=>({content:read(now),title:t(COLUMNS[column].hint)})};
    return [column,cell];
  })) as Record<ActivityColumn,TimedCell>;
  const rows:AnalyticsRow<ActivityColumn>[]=groups.slice(currentPage*50,currentPage*50+50).map(group=>({key:group.key,name:name(group),color:colorOfGroup.get(group.key),cells:cells(group.key)}));
  const total:AnalyticsRow<ActivityColumn>={key:'total',name:t('activityTable.total'),cells:cells()};
  const restore=()=>{
    const found=[...panel.current?.querySelectorAll<HTMLElement>('[data-activity-group]')??[]].find(element=>element.dataset.activityGroup===opened?.key);
    return found??panel.current?.querySelector<HTMLElement>('button')??null;
  };
  const knownFrom=summary?.known?.from;
  return <section ref={panel} className={`panel activity-table${period.loading?' is-loading':''}`} aria-label={t('activityTable.title')} aria-busy={period.loading}
    data-history-range={period.loading||period.error?undefined:selected&&period.basis?timeRangeKey(period.basis.range):range}>
    <div className="panel-head"><h2 className="panel-heading">{t('activityTable.title')}</h2>
      <div className="activity-table-controls">
        <Popover label={t('activityTable.sort')} icon={<SortIcon/>}><button type="button" className="popover-row" onClick={()=>setPrefs({activityTableSort:null})}><span>{t('activityTable.defaultSort')}</span>{!savedSort&&<b>✓</b>}</button>
          {(['name',...visible] as const).map(column=><button type="button" className="popover-row" key={column} aria-pressed={active.column===column} onClick={()=>sortBy(column)}><span>{column==='name'?t(LABELS[by]):t(COLUMNS[column].title)}</span>{active.column===column&&<b aria-label={t(active.descending?'agents.descending':'agents.ascending')}>{active.descending?'↓':'↑'}</b>}</button>)}
        </Popover>
        <TableSettings arrange={arrange} widget={ACTIVITY_TABLE} columns={ACTIVITY_COLUMNS.map(id=>({id,title:t(COLUMNS[id].title),width:COLUMNS[id].width}))} visible={visible}>
          <div className="popover-section"><div className="popover-title">{t('activity.by')}</div><div className="popover-pad"><Segmented value={by} onChange={activityTableBy=>{setOpened(null);setPrefs({activityTableBy});}} options={ACTIVITY_BY.map(id=>[id,t(LABELS[id])])} label={t('activity.by')}/></div></div>
        </TableSettings>
      </div>
    </div>
    <PeriodStatus {...period}/>
    {summary&&!summary.known&&<p className="analytics-note">{t('activity.knownFrom',{time:stamp(summary.since)})}</p>}
    {summary?.known&&knownFrom!==undefined&&period.basis&&knownFrom>period.basis.range.from&&<p className="analytics-note">{t('activity.notKnown',{time:stamp(knownFrom)})}</p>}
    {!summary&&period.loading&&<p className="panel-loading">{t('period.loading')}</p>}
    {summary&&<AnalyticsTable columns={columns} rows={rows} name={t(LABELS[by])} nameWidth={180} lead="agenthours" total={total} sorting={{...active,onSort:sortBy}}
      onOpen={key=>{const group=groups.find(g=>g.key===key);if(group)setOpened({by,key,title:name(group)});}}/>}
    {summary?.known&&!groups.length&&<p className="analytics-note">{t('activity.none')}</p>}
    <AgentPages page={currentPage} count={groups.length} onPage={page=>setPagination({key:paginationKey,page})}/>
    {opened&&opened.by===by&&<Contributions key={`${by}:${opened.key}`} by={by} chosen={opened.key} title={opened.title} arrange={arrange} onClose={()=>setOpened(null)} restore={restore}/>}
  </section>;
});
