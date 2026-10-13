import {memo,useCallback,useRef,useState,type CSSProperties} from 'react';
import type {Activity,ActivityDimension,ActivityGroup} from '../lib/types';
import {activityCoverage,activityGroupName,atOnce,groupColors} from '../lib/activity';
import {ACTIVITY_COLUMNS,activityKey,effectiveActivitySort,visibleActivitySort,nextActivitySort,sortedActivity,type ActivityColumn} from '../lib/activityTable';
import {boardPeriod,usePeriodActivity,usePeriodSessions,type SessionOrder} from '../lib/period';
import {workHours,num} from '../lib/format';
import {useClock} from '../lib/clock';
import {ACTIVITY_BY,setPrefs,usePref} from '../lib/prefs';
import {ACTIVITY_TABLE,columnShown,colorOf,type Arrange} from '../lib/view';
import {useTitles} from '../lib/board';
import {timeRangeKey,useTimeRange} from '../lib/timeRange';
import {columnsOf,groupsOf,nextAgentsSort,type AgentRow,type AgentsBy,type AgentsSort} from '../lib/agents';
import {t,useLocale,type Key} from '../i18n';
import {AnalyticsTable,TableSettings,type AnalyticsColumn,type AnalyticsRow,type TimedCell} from './AnalyticsTable';
import {PeriodStatus} from './PeriodStatus';
import {AgentsDialog} from './Agents';
import {useTableWidget,WidgetPages,TableMeasure,TableSortMenu,TableGrouping,type TableSorting} from './TableWidget';

const LABELS:Record<ActivityDimension,Key>={project:'activity.byProject',device:'activity.byDevice',source:'activity.bySource'};
const COLUMNS:Record<ActivityColumn,{title:Key;hint:Key;width:number}>={
  agenthours:{title:'activity.agentHours',hint:'activity.agentHoursHint',width:120},
  active:{title:'activity.active',hint:'activity.activeHint',width:120},
  sessions:{title:'activity.agents',hint:'activity.agentsHint',width:180},
  concurrency:{title:'activityTable.concurrency',hint:'activity.atOnceHint',width:180},
};
const AGENTS_BY:Record<ActivityDimension,AgentsBy>={project:'project',device:'machine',source:'subscription'};

const metric=(summary:Activity|null,by:ActivityDimension,column:ActivityColumn,key?:string)=>{
  if(!summary?.known)return '—';
  const value=key===undefined?summary:summary.by[by].find(g=>g.key===key);
  if(!value)return '—';
  return column==='agenthours'?workHours(value.agentMs):column==='active'?workHours(value.activeMs):column==='sessions'?num(value.agents):atOnce(value.agentMs,value.activeMs);
};

function Coverage({by}:{by:ActivityDimension}){
  const now=useClock(at=>boardPeriod.activityCoverageChangesAt(at)),range=boardPeriod.activityRangeAt(now);
  const text=range?activityCoverage(boardPeriod.activitySummaryAt(by,now),range.from):null;
  return <p className="analytics-note" data-time="activity-coverage" hidden={!text}>{text}</p>;
}

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
  const visible=ACTIVITY_COLUMNS.filter(column=>columnShown(arrange.view,ACTIVITY_TABLE,column));
  const active=effectiveActivitySort(savedSort,visible);
  const chosenSort=visibleActivitySort(savedSort,visible);
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
  const [opened,setOpened]=useState<{by:ActivityDimension;key:string;title:string}|null>(null);
  const sortBy=(column:ActivityColumn|'name'|null,cycle=true)=>setPrefs({activityTableSort:nextActivitySort(chosenSort,column,cycle)});
  const columns:AnalyticsColumn<ActivityColumn>[]=visible.map(id=>({id,title:t(COLUMNS[id].title),hint:t(COLUMNS[id].hint),width:COLUMNS[id].width,align:'right'}));
  const ranked=sortedActivity(summary?.by[by]??[],{column:'agenthours',descending:true},name,locale,by);
  const colors=groupColors(ranked,by,arrange.view,id=>titles[id]?.provider??'');
  const colorOfGroup=new Map(ranked.map((g,i)=>[g.key,colors[i]]));
  const cells=(key?:string)=>Object.fromEntries(ACTIVITY_COLUMNS.map(column=>{
    const read=(now:number)=>metric(boardPeriod.activitySummaryAt(by,now,key),by,column,key);
    const cell:TimedCell={time:'activity-table',changesAt:now=>boardPeriod.activitySummaryChangesAt(by,now,read,key),at:now=>({content:read(now),title:t(COLUMNS[column].hint)})};
    return [column,cell];
  })) as Record<ActivityColumn,TimedCell>;
  const rows:AnalyticsRow<ActivityColumn>[]=groups.map(group=>({key:group.key,name:name(group),color:colorOfGroup.get(group.key),cells:cells(group.key)}));
  const totals=cells(),metrics=visible.map(id=>({id,label:t(COLUMNS[id].title),cell:totals[id]}));
  const table=useTableWidget(panel,columns.map(column=>column.width),180,rows.map(row=>row.key),JSON.stringify([by,chosenSort,selected?timeRangeKey(selected):range]));
  const sorting:TableSorting<ActivityColumn|'name'>={active:chosenSort,headers:[{id:'name',title:t(LABELS[by])},...columns],label:t('activityTable.sort'),defaultLabel:t('activityTable.defaultSort'),onSort:sortBy};
  const restore=()=>{
    const found=[...panel.current?.querySelectorAll<HTMLElement>('[data-activity-group]')??[]].find(element=>element.dataset.activityGroup===opened?.key);
    return found??panel.current?.querySelector<HTMLElement>('button')??null;
  };
  return <section ref={panel} className={`panel activity-table${period.loading?' is-loading':''}`} aria-label={t('activityTable.title')} aria-busy={period.loading}
    data-history-range={period.loading||period.error?undefined:selected&&period.basis?timeRangeKey(period.basis.range):range}>
    <div className="panel-head"><h2 className="panel-heading">{t('activityTable.title')}</h2>
      <div className="activity-table-controls">
        {table.layout==='list'&&<TableSortMenu {...sorting}/>}
        <TableSettings arrange={arrange} widget={ACTIVITY_TABLE} columns={ACTIVITY_COLUMNS.map(id=>({id,title:t(COLUMNS[id].title),width:COLUMNS[id].width}))} visible={visible}>
          <TableGrouping value={by} onChange={activityTableBy=>{setOpened(null);setPrefs({activityTableBy});}} options={ACTIVITY_BY.map(id=>[id,t(LABELS[id])])}/>
        </TableSettings>
      </div>
    </div>
    <PeriodStatus {...period}/>
    <Coverage by={by}/>
    {!summary&&period.loading&&<p className="panel-loading">{t('period.loading')}</p>}
    {summary&&<AnalyticsTable columns={columns} rows={rows.slice(table.from,table.to)} name={t(LABELS[by])} layout={table.layout} body={table.live} lead="agenthours" sorting={sorting}
      onOpen={key=>{const group=groups.find(g=>g.key===key);if(group)setOpened({by,key,title:name(group)});}}/>}
    {summary?.known&&!groups.length&&<p className="analytics-note">{t('activity.none')}</p>}
    {summary&&<WidgetPages table={table} count={rows.length} metrics={metrics}/>}
    <TableMeasure table={table} metrics={metrics}><AnalyticsTable columns={columns} rows={rows.slice(table.measureFrom,table.measureTo)} name={t(LABELS[by])} layout={table.layout} body={table.measured} lead="agenthours" still/></TableMeasure>
    {opened&&opened.by===by&&<Contributions key={`${by}:${opened.key}`} by={by} chosen={opened.key} title={opened.title} arrange={arrange} onClose={()=>setOpened(null)} restore={restore}/>}
  </section>;
});
