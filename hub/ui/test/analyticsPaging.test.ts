import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {TABLE_PAGE_ROWS} from '../lib/table';
import {sortValue,forecastComparator,nextForecastSort,visibleForecastSort,type SortRow} from '../lib/forecastSort';
import {moneyTableValues,moneyComparator,nextMoneySort,visibleMoneySort} from '../lib/moneyTable';

for(const family of ['quota','budget'] as const)test(`${family} sorts the complete cohort before shared paging and resets pages on the header cycle`,()=>{
  let sort:any=null,page=0,reset:string|undefined,keys:string[]=[];
  const scores=Array.from({length:23},(_,i)=>(i*7)%23),column=family==='quota'?'spent':'value';
  const rows=scores.map((score,i)=>({key:String(i),name:'Row '+i,cells:{[column]:{content:String(score)}}}));
  const models:SortRow[]=scores.map((score,i)=>({line:{key:String(i),sourceId:String(i),windowId:'w',provider:'codex',kind:'weekly',label:null,minutes:10080,name:'Row '+i,color:'blue',dash:'',points:[],current:50,remainingAtStart:50,remainingAtEnd:50,consumed:score,coveredMs:3_600_000,staleAfterMs:3_600_000,work:null},measuredAt:0,ahead:null,plan:null,context:{windows:[],freeResets:0,announced:null}}));
  const entries=scores.map((score,i)=>({sourceId:String(i),meterId:'balance',kind:'balance' as const,unit:'USD',role:'total' as const,start:String(score),end:String(score),spent:null,topup:null,coveredMs:3_600_000,semantics:null,unlocated:[],topupUnlocated:[],points:[]}));
  const props={rows,models,entries,columns:[{id:column,title:'Value',width:140}],fixed:true,rangeKey:'fixed',history:{live:false,range:'fixed',since:0,to:3_600_000}};
  const node=(_type:unknown,props:unknown)=>({props});
  const context={exports:{} as Record<string,(props:unknown)=>any>,require:()=>({jsx:node,jsxs:node}),memo:(read:unknown)=>read,
    usePref:()=>sort,useLocale:()=> 'en',useRef:(current:unknown)=>({current}),useState:(read:()=>unknown)=>[read()],useMemo:(read:()=>unknown)=>read(),useCallback:(read:unknown)=>read,useLayoutEffect:()=>{},useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),
    boardPeriod:{moneyWorkAt:()=>undefined},clock:{watch:()=>({}),due:()=>{}},hubNow:()=>3_600_000,FORECAST_WIDTHS:{limit:180},sortValue,forecastComparator,nextForecastSort,visibleForecastSort,moneyTableValues,moneyComparator,nextMoneySort,visibleMoneySort,
    AnalyticsPanel:'panel',AnalyticsTable:'table',WidgetPages:'footer',TableMeasure:'measurement',TableSortMenu:'sort',t:()=> 'Value',
    setPrefs:(value:any)=>{sort=value[family==='quota'?'forecastSort':'moneySort'];},
    TableSurface:'surface',useTableWidget:(_panel:unknown,_widths:unknown,_name:unknown,all:string[],key:string)=>{
      if(reset!==key){reset=key;page=0;}keys=all;
      return {layout:'table',from:page*TABLE_PAGE_ROWS,to:(page+1)*TABLE_PAGE_ROWS,measureFrom:0,measureTo:Math.min(all.length,50)};
    },
  };
  const component=family==='quota'?'SortedForecast':'SortedMoney',file=family==='quota'?'Forecast':'MoneyAnalytics';
  const source=readFileSync(new URL(`../components/${file}.tsx`,import.meta.url),'utf8'),start=source.indexOf(`const ${component}=`);
  const end=family==='quota'?source.indexOf('/**',start):source.indexOf('const pointAt=',start);
  runInNewContext(ts.transpileModule('export '+source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{const [surface,footer,measurement]=context.exports[component](props).props.children;return [surface.props.children[1],footer,measurement];};
  let [table,footer,measurement]=render();
  assert.equal(footer.props.count,rows.length);assert.equal(measurement.props.children.props.still,true);
  assert.equal(measurement.props.children.props.sorting,table.props.sorting,'static measurement keeps the visible sortable header geometry');
  page=1;[table]=render();assert.equal(table.props.rows.length,TABLE_PAGE_ROWS);
  table.props.sorting.onSort(column);[table]=render();
  const ascending=Array.from({length:23},(_,score)=>String(scores.indexOf(score)));
  assert.equal(page,0);assert.deepEqual(Array.from(keys),ascending,'the widget receives the entire ordered cohort');
  const seen:string[]=[];
  for(page=0;page<3;page++){
    [table,footer]=render();seen.push(...table.props.rows.map((row:any)=>row.key));assert.equal(footer.props.count,23);
    for(const row of table.props.rows)assert.equal(row,rows[Number(row.key)],'sorting and pages retain the original cells');
  }
  assert.deepEqual(seen,ascending,'every row appears once across pages');
  page=1;[table]=render();table.props.sorting.onSort(column);[table]=render();
  assert.equal(page,0);assert.deepEqual(Array.from(keys),[...ascending].reverse());
  page=1;[table]=render();table.props.sorting.onSort(column);[table]=render();
  assert.equal(page,0);assert.equal(table.props.sorting.active,null,'the third header activation clears its selection');
  assert.deepEqual(Array.from(keys),family==='quota'?[...ascending].reverse():rows.map(row=>row.key));
});
