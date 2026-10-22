import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {memo as reactMemo} from 'react';
import {HistoryStore} from '../lib/history';
import {Preparations} from '../lib/prepare';
import {composeMetersPrepared} from '../../server/domain/meterHistory';
import * as providers from '../../server/domain/providers';
import * as currency from '../../server/domain/currency';
import * as widgets from '../../server/domain/widgets';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as moneyView from '../lib/moneyView';
import * as money from '../lib/money';
import * as moneyTable from '../lib/moneyTable';
import {moneySelection,fundsLegacyMuted} from '../lib/moneySelection';
import {chartSeriesMuted} from '../lib/prefs';
import * as periods from '../lib/periods';
import {timeRangeKey} from '../lib/timeRange';
import {axisNavigation,navigationKey} from '../lib/axisNavigation';
import {axisPresentationFixture} from './axisPresentationFixture';
import {preparationFixture} from './preparationFixture';
import {plotPathPrepared,observationRunsPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
const root=new URL('../../',import.meta.url),M=300000,NOW=100*M,A={from:50*M,to:54*M},B={from:52*M,to:56*M};
const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
async function fixture(family:string,extreme:boolean,options:{target?:typeof B;startAtA?:boolean}={}){
  const target=options.target??B;
  const tasks:(()=>void)[]=[],reads:any[]=[];let clock=0;const scheduler=new Preparations({now:()=>clock++,post:run=>tasks.push(run)}),meter=family==='funds'?'balance:credits':'balance';
  const store=new HistoryStore({now:()=>NOW,elapsedNow:()=>0,preparations:scheduler,setTimeout:()=>null,clearTimeout:()=>{},dropTimeRange:()=>{},read:async(_board,cell,from,to)=>{
    reads.push({from,to,cell});const cells=[];for(let at=from;at<to;at+=cell){const dollars=at<52*M?(extreme?1000:10):at<54*M?10:20,row:any=[(at-from)/cell,String(dollars*1000000),at===52*M&&extreme?'990000000':'0','0',cell];if(family==='funds')row[5]={observations:[{at,value:row[1],validUntil:at+cell,semantics:null}]};cells.push(row);}
    return {run:'same-run',now:NOW,historyStart:0,known:{work:0,sources:{s:0}},chunks:[{from,to,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],meterSeries:[{source:'s',meter,kind:'balance',unit:'USD',semantics:null,...(family==='funds'?{pointMode:'observation',accounting:{spending:'unavailable',topups:'unavailable'}}:{}),cells}]}]};
  }},undefined,'budget');
  const settle=async()=>{for(let i=0;i<10000;i++){await flush();if(!tasks.length&&!scheduler.size)return;tasks.shift()?.();}throw Error('store preparation did not settle');};
  store.setMeters({unit:'USD',ids:[['s',meter]]});store.choose('1h',A);store.open('board');store.hello('same-run');store.snapshot(['s'],[]);await settle();
  store.pan({token:1,length:4*M,...(options.startAtA?A:target),direction:1});await settle();assert.ok(store.getPlot());
  return {store,meter,reads,scheduler,tasks,settle,target,async stagePan(){store.pan({token:1,length:4*M,...target,direction:1});await settle();assert.ok(store.getPlot());},async release(){store.choose('1h',target);store.endPan(true);await flush();assert.equal((store as any).interest,null);assert.equal((store as any).target().key,timeRangeKey(target));assert.ok(scheduler.size>0,'the actual exact composer is queued after release');assert.ok(store.getPlot(),'the actual postrelease pending state retains the strip');assert.equal(store.get().history?.range,timeRangeKey(A));},close(){store.close();scheduler.dispose();}};
}
function renderer(h:Awaited<ReturnType<typeof fixture>>,family:string){
  const outer=preparationFixture(),inner=preparationFixture();let selected=A,panning:number|null=1;
  const meter={id:h.meter,amount:'20000000',kind:'balance',unit:'USD',limit:null,at:NOW,stale:false,staleAfterMs:M,resetAt:null,minutes:null,scope:null,label:null};
  const sources=[{id:'s',title:'S',provider:family==='funds'?'codex':'openrouter',plan:'',successAt:NOW,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:M,measureIntervalMs:null,meters:[meter]}];
  const settings={unit:'USD',selected:{USD:[['s',h.meter]]}},prefs={range:'1h',horizon:'auto' as const,muted:{},money:settings,funds:settings},Chart=()=>null;
  const initial={...A,end:A.to},navA=axisNavigation('board',A,prefs),navB=axisNavigation('board',h.target,prefs),axisOwner=axisPresentationFixture(initial,navA,900,1,76,12);axisOwner.context.commit(initial,true);axisOwner.context.pose.current.offset=-(h.target.from-A.from)/(A.to-A.from)*812;axisOwner.active.current=1;
  const modules:any={'react/jsx-runtime':jsx,react:{memo:reactMemo,useRef:outer.useRef,useMemo:outer.useMemo},'../../server/domain/providers':providers,'../../server/domain/currency':currency,'../../server/domain/meterHistory':{composeMetersPrepared},
    '../lib/board':{useServerView:()=>undefined,useBoardId:()=> 'board',useCurrencyContext:()=>currency.defaultCurrencyContext,useNamed:()=>sources},
    '../lib/history':{useBudgetFinancialHistory:()=>({...h.store.get(),drawing:h.store.get().history}),useBudgetHistoryPlot:()=>h.store.getPlot(),useHistoryBegins:()=>0,budgetHistory:{retry(){}},fundsHistory:{retry(){}}},
    '../lib/prefs':{useChartMuted:()=>prefs.muted,chartSeriesMuted,usePref:(key:string)=>(prefs as any)[key]},'../lib/moneySelection':{moneySelection,fundsLegacyMuted},'../lib/moneyView':moneyView,'../lib/money':money,'../lib/moneyTable':moneyTable,'./seriesFocus':{useSeriesFocus:()=>{}},
    '../lib/view':{...widgets,colorOf:()=> 'blue'},'../lib/periods':periods,'../lib/timeRange':{useTimeRange:()=>selected,timeRangeKey},'../lib/clock':{useClock:()=>NOW},'../lib/pan':{usePanning:()=>panning},
    '../lib/axisNavigation':{axisNavigation},'../i18n':{t:(key:string)=>key,useLocale:()=> 'en'},'./prepared':{usePrepared:outer.usePrepared},'./sizing':{usePlot:()=>({plot:300,onBase(){}})},'./Chart':{Chart}};
  const component:any={exports:{},require:(name:string)=>modules[name]??{}};runInNewContext(compile(readFileSync(new URL('ui/components/MoneyAnalytics.tsx',root),'utf8')),component);
  const chartSource=readFileSync(new URL('ui/components/Chart.tsx',root),'utf8'),start=chartSource.indexOf('  const inputs = '),region=chartSource.slice(start,chartSource.indexOf('  const shownAxis=',start));
  const child:any={...inner,axis:{active:true,basis:initial},incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredLive:false,NO_FORECASTS:[],stepped:true,cellMs:M,width:900,height:300,left:76,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,observationRunsPrepared,navigationKey};
  runInNewContext(compile('globalThis.draw=()=>{'+region+';return prepared;};'),child);
  let lastProps:any;
  const render=()=>{outer.begin();const tree=component.exports.MoneyHistory({family,arrange:{view:EMPTY_VIEW,owner:false}}),chart=tree.props.children.find((node:any)=>node?.type===Chart);assert.ok(chart);lastProps=chart.props;outer.commit();
    Object.assign(child,{onDrawing:lastProps.onDrawing,cellMs:lastProps.cellMs,incomingLines:lastProps.lines,incomingReady:lastProps.prepared,valueAxis:lastProps.axis,modelContext:lastProps.modelContext,navigation:lastProps.navigation,incomingStrip:lastProps.strip,desiredFrom:lastProps.from,desiredTo:lastProps.to,desiredNow:lastProps.now});
    child.axis={active:panning!==null,basis:panning!==null?initial:{from:lastProps.from,to:lastProps.to,end:lastProps.now}};
    inner.begin();const result=child.draw();inner.commit();if(result.value)axisOwner.context.commit(result.value.basis,result.ready);return result;};
  const settle=()=>{for(let i=0;i<6;i++){render();outer.finish();inner.finish();}return render();};
  const snapshot=(landmarks=[52*M,54*M])=>{const result=render(),model=result.value;assert.ok(model);const axis=model.valueAxis,ys=landmarks.map(at=>{const point=model.lines[0].points.find((p:any)=>p[0]===at);return 12+(1-(point[1]-axis.min)/(axis.max-axis.min))*260;});return {model,ready:result.ready,incomingReady:lastProps.prepared,modelContext:lastProps.modelContext,navigation:lastProps.navigation,basis:model.basis,Xs:landmarks.map(axisOwner.point),Ys:ys,paths:model.paths.map((p:any)=>p.line),raw:landmarks.map(at=>[at,model.valueAxis.rawValue(model.lines[0].key,at)])};};
  return {render,finishParent:outer.finish,finishChild:inner.finish,settle,snapshot,current:()=>render().value,navigate(range:typeof A){selected=range;panning=null;axisOwner.active.current=null;axisOwner.navigate({...range,end:range.to},axisNavigation('board',range,prefs));},release(){selected=h.target;panning=null;axisOwner.active.current=null;axisOwner.navigate({...h.target,end:h.target.to},navB);},close(){outer.scheduler.dispose();inner.scheduler.dispose();}};
}
for(const family of ['budget','funds'])for(const extreme of [false,true])test(`reachable after-release ${family} ${extreme?'offscreen extreme':'ordinary control'}`,async()=>{
  const h=await fixture(family,extreme),r=renderer(h,family);try{r.settle();const active=r.snapshot();assert.equal(active.incomingReady,true);const oldModel=active.model;
    await h.release();r.release();r.settle();const pending=r.snapshot();assert.equal(pending.incomingReady,false);assert.equal(pending.model,oldModel,'actual Chart preparation retains its pan model while exact evidence waits');assert.equal(pending.ready,false);
    const reads=h.reads.length;await h.settle();r.settle();const ready=r.snapshot();assert.equal(ready.incomingReady,true);assert.equal(ready.ready,true);assert.notEqual(ready.model,pending.model);assert.equal(h.reads.length,reads,'no new measurement or HTTP supplies the replacement');
    assert.deepEqual(pending.navigation,ready.navigation);assert.equal(pending.modelContext,ready.modelContext);assert.deepEqual(pending.raw,ready.raw);pending.Xs.forEach((x:number,i:number)=>assert.ok(Math.abs(x-ready.Xs[i])<1e-8));
    assert.ok(pending.Ys.every((y:number,i:number)=>Math.abs(y-ready.Ys[i])<=1),`ready alone changes Y ${pending.Ys} → ${ready.Ys}`);
  }finally{r.close();h.close();}
});

for(const family of ['budget','funds'])test(`${family} releases the positioned value domain on another explicit range`,async()=>{
  const h=await fixture(family,true),r=renderer(h,family);
  try{
    r.settle();await h.release();r.release();r.settle();await h.settle();r.settle();
    const positioned=r.current();assert.ok(positioned);
    const next={from:54*M,to:58*M};h.store.choose('1h',next);r.navigate(next);await h.settle();r.settle();
    const model=r.current();assert.ok(model);
    const expected=money.money('20000000','USD',false,currency.defaultCurrencyContext).slice(0,-4);
    assert.equal(model.valueAxis.formatTick(0),expected,'a different range derives its own exact origin');
    assert.notEqual(model.valueAxis.formatTick(0),positioned.valueAxis.formatTick(0));
    assert.ok(model.lines[0].points.every((point:any)=>point[1]===0),'no prior offset survives the new value basis');
  }finally{r.close();h.close();}
});

for(const family of ['budget','funds'])for(const phase of ['ordinary','parent-ahead','child-committed'] as const)test(`${family} release follows its actual child drawing with ${phase} preparation`,async()=>{
  const h=await fixture(family,phase!=='ordinary',{target:{from:54*M,to:58*M},startAtA:true}),r=renderer(h,family);
  try{
    r.settle();const initial=r.snapshot([54*M,55*M]);await h.stagePan();r.render();r.finishParent();
    const waiting=r.snapshot([54*M,55*M]);assert.equal(waiting.model,initial.model);assert.equal(waiting.incomingReady,true);assert.equal(waiting.ready,false,'the new parent is ready while the actual child still draws A');
    if(phase==='child-committed'){r.finishChild();r.render();}
    const painted=r.snapshot([54*M,55*M]),reads=h.reads.length;await h.release();r.release();
    await h.settle();r.settle();const ready=r.snapshot([54*M,55*M]);
    assert.deepEqual(ready.raw,painted.raw);assert.deepEqual(ready.Xs,painted.Xs);assert.equal(h.reads.length,reads);
    painted.Ys.forEach((y:number,i:number)=>assert.ok(Math.abs(y-ready.Ys[i])<=1,'release preserves the axis of the actual committed child, independently of parent readiness'));
  }finally{r.close();h.close();}
});
