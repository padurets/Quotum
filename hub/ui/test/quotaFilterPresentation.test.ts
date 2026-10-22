import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {defaultFilters} from '../../server/domain/dataFilters';
import {EMPTY_VIEW} from '../../server/domain/view';
import {onDataFilters,publishDataFilters,quotaPresentationKey} from '../lib/filterSelection';
import {subscriptionLinesOf,subscriptionLinesPrepared,subscriptionOverflow} from '../lib/subscription';
import {ofTimeRange} from '../lib/timeRange';
import {navigationKey} from '../lib/axisNavigation';
import {historyProjection} from '../lib/historyProjection';
import {chartEventsPrepared,chartResetsPrepared} from '../lib/lines';
import {chartMoments} from '../lib/readout';
import {preparationFixture} from './preparationFixture';
import type {Card,History} from '../lib/types';

const H=3_600_000;
const source={id:'codex:native',provider:'codex',title:'Native',plan:'pro',windows:[{id:'weekly',kind:'weekly',label:null,remaining:70,used:30,resetAt:null,minutes:10080}],meters:undefined,resets:null,owners:[],error:null,successAt:0,stale:false,staleAfterMs:2*H,measureIntervalMs:null} as Card;
const history={range:'24h',live:true,since:0,to:H,cellMs:60_000,historyStart:0,events:[],series:[{sourceId:source.id,windowId:'weekly',points:[[0,70,1]],consumed:2,coveredMs:H,remainingAtStart:72,remainingAtEnd:70,staleAfterMs:2*H,work:null}],meterSeries:[],activity:{since:0,known:null,barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}} as History;
const compile=(code:string,context:object)=>runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
function presentation(){
  let changed=false,value='',stop:(()=>void)|undefined;
  const context={exports:{} as {useQuotaPresentation:()=>string},onDataFilters,quotaPresentationKey,useSyncExternalStore:(subscribe:typeof onDataFilters,read:()=>string)=>{
    stop??=subscribe(()=>{const next=read();if(next!==value){value=next;changed=true;}});value=read();return value;
  }};
  const code=readFileSync(new URL('../lib/dataFilters.ts',import.meta.url),'utf8').split('\n').find(line=>line.startsWith('export const useQuotaPresentation='));assert.ok(code);compile(code,context);
  return {read:context.exports.useQuotaPresentation,consume:()=>{const result=changed;changed=false;return result;},close:()=>stop?.()};
}
const declaration=(code:string)=>{const line=code.split('\n').find(line=>line.includes('const selection=useQuotaPresentation()'));assert.ok(line);return line;};

test('the actual memoized quota table follows native window edits without replacing history or reacting to project-only edits',()=>{
  publishDataFilters(defaultFilters());const selected=presentation();
  try{
    const code=readFileSync(new URL('../components/Forecast.tsx',import.meta.url),'utf8'),start=code.indexOf('  const widget=',code.indexOf('const WindowForecast'));
    let saved:{deps:unknown[];value:unknown}|undefined,calculations=0;const sources=[source];
    const context={exports:{} as {draw:()=>unknown[]},arrange:{view:EMPTY_VIEW},kind:'weekly',useQuotaPresentation:selected.read,useHistory:()=>({history,loading:false,error:null}),useNamed:()=>sources,useLineup:()=>[],useForecastsOf:()=>[],useResetNews:()=>null,useLocale:()=> 'en',subscriptionOverflow,ofTimeRange,QUOTA_TABLE:'quota-table',QUOTA_SESSION_TABLE:'quota-session-table',
      subscriptionLinesOf:(...args:Parameters<typeof subscriptionLinesOf>)=>{calculations++;return subscriptionLinesOf(...args);},useMemo:(read:()=>unknown,deps:unknown[])=>{if(!saved||deps.some((part,i)=>!Object.is(part,saved!.deps[i])))saved={deps,value:read()};return saved.value;}};
    compile(`export function draw(){${declaration(code)}\n${code.slice(start,code.indexOf('  const modeColumns',start))}\nreturn lines;}`,context);
    assert.equal(context.exports.draw().length,1);const off=defaultFilters();off.windows={mode:'exclude',values:[[source.id,'weekly']]};publishDataFilters(off);
    assert.equal(selected.consume(),true);const hidden=context.exports.draw();assert.equal(hidden.length,0);assert.equal(calculations,2);
    publishDataFilters({...off,projects:{mode:'include',values:[]}});assert.equal(selected.consume(),false);assert.equal(context.exports.draw(),hidden);assert.equal(calculations,2);
    publishDataFilters(defaultFilters());assert.equal(selected.consume(),true);assert.equal(context.exports.draw().length,1);
  }finally{selected.close();publishDataFilters(null,false);}
});

test('the actual prepared quota chart rebuilds native presentation on a quiet board and keeps the same data objects',()=>{
  publishDataFilters(defaultFilters());const selected=presentation(),hook=preparationFixture();
  try{
    const code=readFileSync(new URL('../components/History.tsx',import.meta.url),'utf8'),start=code.indexOf('  const prepared = usePrepared('),region=code.slice(start,code.indexOf('\n  const legend = useMemo(',start));
    let calculations=0;const sources=[source],context={...hook,exports:{} as {draw:()=>{lines:unknown[]}|null},useQuotaPresentation:selected.read,now:H,measured:H,from:0,frame:{from:0,to:H,future:H,live:true},authority:0,history,drawing:history,strip:null,sources,view:EMPTY_VIEW,prefs:{kind:'weekly',showPlan:false,showForecast:false,horizon:'auto'},locale:'en',futureSources:sources,futureForecasts:[],futureLineup:[],futureNews:null,futureCodex:null,futureView:EMPTY_VIEW,navigation:{context:'b',range:'24h'},navigationKey,registry:{current:null},context:null,
      subscriptionLinesPrepared:function*(...args:Parameters<typeof subscriptionLinesPrepared>){calculations++;return yield*subscriptionLinesPrepared(...args);},planOf:()=>null,announcedOf:()=>null,started:()=>true,forecastLinePrepared:function*(){return null;},chartEventsPrepared,chartResetsPrepared,chartMoments,historyProjection,past:{},PROVIDERS:{},t:()=>'',sourceLabel:()=>''};
    compile(`export function draw(){${declaration(code)}\n${region}\nreturn model;}`,context);
    const render=()=>{hook.begin();const model=context.exports.draw();hook.commit();hook.finish();return model;};
    render();const first=render();assert.equal(first?.lines.length,1);
    const off=defaultFilters();off.windows={mode:'exclude',values:[[source.id,'weekly']]};publishDataFilters(off);assert.equal(selected.consume(),true);render();const hidden=render();assert.equal(hidden?.lines.length,0);assert.equal(calculations,2);
    assert.equal(context.drawing,history);assert.equal(context.sources,sources);
    publishDataFilters({...off,projects:{mode:'include',values:[]}});assert.equal(selected.consume(),false);assert.equal(render(),hidden);assert.equal(calculations,2);
    publishDataFilters(defaultFilters());render();assert.equal(render()?.lines.length,1);
  }finally{selected.close();publishDataFilters(null,false);}
});
