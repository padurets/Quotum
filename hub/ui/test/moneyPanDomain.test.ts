import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {memo as reactMemo} from 'react';
import {HistoryStore,followPan} from '../lib/history';
import {Preparations} from '../lib/prepare';
import {composeMetersPrepared} from '../../server/domain/meterHistory';
import * as providers from '../../server/domain/providers';
import * as currency from '../../server/domain/currency';
import * as widgets from '../../server/domain/widgets';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as moneyView from '../lib/moneyView';
import * as money from '../lib/money';
import * as moneyTable from '../lib/moneyTable';
import {moneySelection} from '../lib/moneySelection';
import * as periods from '../lib/periods';
import {Pan} from '../lib/pan';
import {timeRangeKey,type TimeRange} from '../lib/timeRange';
import {planEventsAt,planEventsDeadline} from '../../server/domain/history';
import {shallowEqual} from '../lib/store';
import {axisNavigation,navigationKey,navigationAt} from '../lib/axisNavigation';
import {axisPresentationFixture} from './axisPresentationFixture';
import {preparationFixture} from './preparationFixture';
import {plotPathPrepared,observationRunsPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
const root=new URL('../../',import.meta.url),M=300000,NOW=100*M,A={from:50*M,to:54*M},B={from:52*M,to:56*M};
const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
async function fixture(family:string,extreme:boolean,options:{target?:TimeRange;initial?:TimeRange;now?:number;period?:string;financialHook?:boolean;cap?:boolean;startAtA?:boolean}={}){
  const initial=options.initial??A,now=options.now??NOW,period=options.period??'1h',target=options.target??B,length=initial.to-initial.from;
  const tasks:(()=>void)[]=[],reads:any[]=[];let clock=0;const scheduler=new Preparations({now:()=>clock++,post:run=>tasks.push(run)}),meter=options.cap?'cap':family==='funds'?'balance:credits':'balance',semantics=options.cap?{limit:'40000000',resetAt:null,minutes:null,scope:null,label:'Cap'}:null;
  const store=new HistoryStore({now:()=>now,elapsedNow:()=>0,preparations:scheduler,setTimeout:()=>null,clearTimeout:()=>{},dropTimeRange:()=>{},read:async(_board,cell,from,to)=>{
    reads.push({from,to,cell});const cells=[];for(let at=from;at<to;at+=cell){const dollars=at<52*M?(extreme?1000:10):at<54*M?10:20,row:any=[(at-from)/cell,String(dollars*1000000),at===52*M&&extreme?'990000000':'0','0',cell];if(options.cap)row[5]={knownFrom:at,knownUntil:at+cell};else if(family==='funds')row[5]={observations:[{at,value:row[1],validUntil:at+cell,semantics:options.financialHook?{limit:null,resetAt:null,minutes:null,scope:null,label:null,conversion:{original:{meterId:meter,amount:row[1],unit:'USD',at},rate:{id:'rate',source:'manual',base:'USD',date:0,fetchedAt:now,from:'USD',to:'USD'}}}:null}]};cells.push(row);}
    return {run:'same-run',now:now,historyStart:0,known:{work:0,sources:{s:0}},chunks:[{from,to,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],meterSeries:[{source:'s',meter,kind:options.cap?'cap':'balance',unit:'USD',semantics,...(family==='funds'?{pointMode:'observation',accounting:{spending:'unavailable',topups:'unavailable'}}:{}),cells}]}]};
  }},undefined,'budget');
  const settle=async()=>{for(let i=0;i<10000;i++){await flush();if(!tasks.length&&!scheduler.size)return;tasks.shift()?.();}throw Error('store preparation did not settle');};
  store.setMeters({unit:'USD',ids:[['s',meter]]});store.choose(period,initial);store.open('board');store.hello('same-run');store.snapshot(['s'],[]);await settle();
  let selected:typeof initial|null=initial,serial=0;
  const nativeFrames=new Map<number,()=>void>(),listeners=new Set<(range:typeof initial|null)=>void>();
  const nativeRequest=(run:()=>void)=>{nativeFrames.set(++serial,run);return serial;};
  const runFrames=()=>{const callbacks=[...nativeFrames.values()];nativeFrames.clear();callbacks.forEach(run=>run());};
  const choose=(range:typeof initial|null)=>{selected=range;store.choose(period,range);for(const listener of listeners)listener(range);};
  const gesture=new Pan({now:()=>now,commit:choose,requestFrame:nativeRequest,cancelFrame:id=>nativeFrames.delete(id as number),setTimeout:()=>null,clearTimeout:()=>{}});
  const stop=followPan(store,gesture,()=>selected);
  const token=gesture.begin({source:Symbol('money chart'),input:'pointer',selected:initial,length:length,now:now,historyStart:0,span:length,width:812})!;
  if(!options.startAtA){gesture.move(token,(target.from-initial.from)/(length)*812);runFrames();}
  await settle();assert.ok(store.getPlot());
  return {initial,now,period,cap:options.cap??false,financialHook:options.financialHook??false,store,meter,reads,scheduler,tasks,settle,target,gesture,nativeFrames,nativeRequest,runFrames,choose,onSelection:(listener:(range:typeof initial|null)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    async stagePan(){gesture.move(token,(target.from-initial.from)/(length)*812);runFrames();await settle();assert.ok(store.getPlot());},
    async release(){gesture.finish(token);await flush();assert.equal((store as any).interest,null);assert.equal((store as any).target().key,timeRangeKey(target));assert.ok(scheduler.size>0,'the actual exact composer is queued after release');assert.ok(store.getPlot(),'pending exact composition retains its strip');assert.equal(store.get().history?.range,timeRangeKey(initial));},
    close(){stop();listeners.clear();store.close();scheduler.dispose();}};
}
function renderer(h:Awaited<ReturnType<typeof fixture>>,family:string){
  const {initial:opening,now,period}=h,liveLength=periods.periodOf(period).ms;
  const outer=preparationFixture(),inner=preparationFixture();let selected:TimeRange|null=opening,panning:number|null=1,externalGesture:any=null,board='board';
  const meter={id:h.meter,amount:'20000000',kind:h.cap?'cap':'balance',unit:'USD',limit:h.cap?'40000000':null,at:now,stale:false,staleAfterMs:M,resetAt:null,minutes:null,scope:null,label:null};
  const sources=[{id:'s',title:'S',provider:family==='funds'?'codex':'openrouter',plan:'',successAt:now,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:M,measureIntervalMs:null,meters:[meter]}];
  const settings={unit:'USD',selected:{USD:[['s',h.meter]]}},prefs={range:period,horizon:'auto' as const,money:settings,funds:settings},Chart=()=>null;
  const initial={...opening,end:opening.to},navA=axisNavigation(board,opening,prefs),navB=axisNavigation(board,h.target,prefs),axisOwner=axisPresentationFixture(initial,navA,900,1,76,12);axisOwner.context.commit(initial,true);axisOwner.context.pose.current.offset=-(h.target.from-opening.from)/(opening.to-opening.from)*812;axisOwner.active.current=1;
  // Exact reader frames are already composed; this seam only authorizes their
  // financial projection while the actual hook owns phase and retention.
  const projection={ready:true,authority:{}};
  const financial:any={...outer,useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),pan:h.gesture,hubNow:()=>now,planEventsAt,planEventsDeadline,shallowEqual,timeRangeKey,useClock:()=>now,fundsHistory:family==='funds'?h.store:{},page:{get:()=>({board:{id:board}})},timeRange:()=>selected,prefs:()=>prefs,boardPeriod:{subscribeProjection:()=>()=>{},getFinancialProjectionSnapshot:()=>projection,projectionChangesAt:()=>null,projectionState:(history:any)=>({ready:history.board===board}),project:(history:unknown)=>history}};
  if(h.financialHook){
    const code=readFileSync(new URL('ui/lib/history.ts',root),'utf8'),from=code.indexOf('function usePeriodHistory('),to=code.indexOf('export function useHistory(',from);assert.ok(from>=0&&to>from);
    runInNewContext(compile(code.slice(from,to)+'\nglobalThis.read=usePeriodHistory;'),financial);
  }
  const modules:any={'react/jsx-runtime':jsx,react:{memo:reactMemo,useRef:outer.useRef,useMemo:outer.useMemo,useLayoutEffect:outer.useLayoutEffect},'../../server/domain/providers':providers,'../../server/domain/currency':currency,'../../server/domain/meterHistory':{composeMetersPrepared},
    '../lib/board':{useServerView:()=>undefined,useBoardId:()=>board,useCurrencyContext:()=>currency.defaultCurrencyContext,useNamed:()=>sources},
    '../lib/history':{useBudgetFinancialHistory:()=>h.financialHook?financial.read(h.store,true,true):({...h.store.get(),drawing:h.store.get().history}),useBudgetHistoryPlot:()=>h.financialHook?h.store.getDrawingPlot():h.store.getPlot(),useHistoryBegins:()=>0,budgetHistory:{retry(){}},fundsHistory:{retry(){}}},
    '../lib/prefs':{usePref:(key:string)=>(prefs as any)[key]},'../lib/moneySelection':{moneySelection},'../lib/moneyView':moneyView,'../lib/money':money,'../lib/moneyTable':moneyTable,'./seriesFocus':{useSeriesFocus:()=>{}},
    '../lib/view':{...widgets,colorOf:()=> 'blue'},'../lib/periods':periods,'../lib/timeRange':{useTimeRange:()=>selected,timeRangeKey},'../lib/clock':{useClock:()=>now},'../lib/pan':{pan:h.gesture,usePanning:h.gesture.active},
    '../lib/axisNavigation':{axisNavigation},'../i18n':{t:(key:string)=>key,useLocale:()=> 'en'},'./prepared':{usePrepared:outer.usePrepared},'./sizing':{usePlot:()=>({plot:300,onBase(){}})},'./Chart':{Chart}};
  const component:any={exports:{},require:(name:string)=>modules[name]??{}};runInNewContext(compile(readFileSync(new URL('ui/components/MoneyAnalytics.tsx',root),'utf8')),component);
  const chartSource=readFileSync(new URL('ui/components/Chart.tsx',root),'utf8'),start=chartSource.indexOf('  const inputs = '),region=chartSource.slice(start,chartSource.indexOf('  const shownAxis=',start));
  const child:any={...inner,axis:{active:true,basis:initial},incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredLive:false,NO_FORECASTS:[],stepped:true,cellMs:M,incomingCellMs:M,width:900,height:300,left:76,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,observationRunsPrepared,navigationKey};
  runInNewContext(compile('globalThis.draw=()=>{'+region+';return prepared;};'),child);
  let lastProps:any,lastResult:any,parentRenders=0;
  const render=()=>{parentRenders++;outer.begin();const tree=component.exports.MoneyHistory({family,arrange:{view:EMPTY_VIEW,owner:false}}),chart=tree.props.children.find((node:any)=>node?.type===Chart);assert.ok(chart);lastProps=chart.props;outer.commit();
    Object.assign(child,{onDrawing:lastProps.onDrawing,cellMs:lastProps.cellMs,incomingCellMs:lastProps.cellMs,incomingLines:lastProps.lines,incomingReady:lastProps.prepared,valueAxis:lastProps.axis,modelContext:lastProps.modelContext,navigation:lastProps.navigation,incomingStrip:lastProps.strip,desiredFrom:lastProps.from,desiredTo:lastProps.to,desiredNow:lastProps.now});
    const activeToken=h.gesture.active();child.axis={active:activeToken!==null,basis:activeToken!==null?(externalGesture?(axisOwner.context.captured.current??axisOwner.context.drawing.current):initial):{from:lastProps.from,to:lastProps.to,end:lastProps.now}};
    inner.begin();const result=child.draw();inner.commit();if(result.value)axisOwner.context.commit(result.value.basis,result.ready);lastResult=result;return result;};
  const settle=()=>{for(let i=0;i<6;i++){render();outer.finish();inner.finish();}return render();};
  const modelSnapshot=(result:any,landmarks=[52*M,54*M])=>{const model=result.value;assert.ok(model);const axis=model.valueAxis,ys=landmarks.map(at=>{const point=model.lines[0].points.find((p:any)=>p[0]===at);return 12+(1-(point[1]-axis.min)/(axis.max-axis.min))*260;});return {model,ready:result.ready,incomingReady:lastProps.prepared,modelContext:lastProps.modelContext,navigation:lastProps.navigation,basis:model.basis,Xs:landmarks.map(axisOwner.point),Ys:ys,paths:model.paths.map((p:any)=>p.line),raw:landmarks.map(at=>[at,model.valueAxis.rawValue(model.lines[0].key,at)])};};
  const snapshot=(landmarks=[52*M,54*M])=>modelSnapshot(render(),landmarks);
  const nativeSnapshot=(landmarks=[52*M,54*M])=>modelSnapshot(lastResult,landmarks);
  const {nativeFrames,nativeRequest,runFrames}=h,nativeStops:(()=>void)[]=[];
  nativeStops.push(h.onSelection(range=>{selected=range;panning=h.gesture.active();axisOwner.active.current=panning;const wanted=range??{from:now-liveLength,to:now};axisOwner.navigate({...wanted,end:wanted.to},axisNavigation(board,range,prefs));}));
  const bindPan=()=>{
    externalGesture=h.gesture;
    const c:any=axisOwner.context,classes=axisOwner.classes;
    Object.assign(c,{navigationAt,pan:externalGesture,source:{current:Symbol('money native chart')},paintTicks:{current:()=>{}},paintDrawing:{current:undefined},folding:false,present:()=>{},freezeSlides:()=>c.cancelSlides(),panPointer:{current:null},wheelBounds:{current:null},requestAnimationFrame:nativeRequest,cancelAnimationFrame:(id:number)=>nativeFrames.delete(id),useLayoutEffect:(effect:()=>any)=>{const stop=effect();if(typeof stop==='function')nativeStops.push(stop);}});
    c.svg.current.classList={contains:(name:string)=>classes.has(name),add:(name:string)=>classes.add(name),remove:(name:string)=>classes.delete(name),toggle:(name:string,on:boolean)=>on?classes.add(name):classes.delete(name)};
    c.box.current={querySelectorAll:(selector:string)=>selector==='.plot-move'?axisOwner.layers:axisOwner.slides,hasPointerCapture:()=>false,releasePointerCapture:()=>{}};
    const source=readFileSync(new URL('ui/components/timeAxis.ts',root),'utf8'),start=source.indexOf('  const paint = () => {');
    runInNewContext(compile(source.slice(start,source.indexOf('  useEffect(() => () => {',start))),c);
    return externalGesture;
  };
  return {props:()=>lastProps,peek:()=>lastResult,visual:()=>axisOwner.context.visualGeometry(),resize:(width:number,height:number)=>{child.width=width;child.height=height;},setBoard:(value:string)=>{board=value;},setUnit:(value:string)=>{settings.unit=value;},revokeSelection:()=>{settings.selected.USD=[];h.store.setMeters({unit:'USD',ids:[]});},nativeSnapshot,parentRenders:()=>parentRenders,bindPan,runFrames,nativeRequest,getSelected:()=>selected,beginNative(){assert.ok(externalGesture);const c:any=axisOwner.context,visual=c.visualGeometry();return externalGesture.begin({source:c.source.current,input:'pointer',selected,length:selected?selected.to-selected.from:liveLength,now:now,historyStart:0,span:visual.to-visual.from,width:812});},setRange(range:typeof opening){h.choose(range);axisOwner.navigate({...range,end:range.to},axisNavigation(board,range,prefs));},changeContext(){(prefs as any).horizon='1d';const wanted=selected??{from:now-liveLength,to:now};axisOwner.navigate({...wanted,end:wanted.to},axisNavigation(board,selected,prefs));},render,finishParent:outer.finish,finishChild:inner.finish,settle,snapshot,current:()=>render().value,navigate(range:typeof opening){h.choose(range);panning=null;axisOwner.active.current=null;axisOwner.navigate({...range,end:range.to},axisNavigation(board,range,prefs));},release(){selected=h.target;panning=null;axisOwner.active.current=null;axisOwner.navigate({...h.target,end:h.target.to},navB);},close(){nativeStops.forEach(stop=>stop());outer.dispose();inner.dispose();}};
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

for(const family of ['budget','funds'])for(const mode of ['no-op','no-op-parent-ahead','cancel','moved-cancel','moved-cancel-parent-ahead','second-pan','explicit-range','context-change'] as const)test(`${family} actual native ${mode} after committed extreme domain`,async()=>{
 const h=await fixture(family,true),r=renderer(h,family);
 const snap=()=>{const value=r.snapshot([54*M,55*M]);return {...value,model:undefined,paths:undefined};};
 try{
  r.settle();await h.release();r.release();r.settle();await h.settle();r.settle();
  const before=snap(),reads=h.reads.length;assert.equal(before.ready,true);assert.ok(before.Ys[0]>200);
  let during:any=null,finalNative:any=null,stop:any=null;
  if(mode==='explicit-range'){r.setRange({from:54*M,to:58*M});await h.settle();r.settle();}
  else if(mode==='context-change'){r.changeContext();r.settle();}
  else{
   const pan=r.bindPan();pan.onStop((value:any)=>{stop=value;});const token=r.beginNative();assert.ok(token);await h.settle();
   if(mode.includes('moved')||mode==='second-pan'){pan.move(token,406);r.runFrames();await h.settle();}
   if(mode.includes('parent-ahead')){r.render();r.finishParent();r.render();assert.equal(r.snapshot([54*M,55*M]).ready,false,'the parent is prepared while the actual child still awaits its replacement');}
   else r.settle();
   during=snap();if(mode==='no-op'||mode==='cancel')assert.deepEqual(during.Ys,before.Ys,'begin alone preserves the committed monetary scale');
   if(mode.includes('cancel'))pan.cancel(token);else pan.finish(token);
   r.runFrames();finalNative=snap();assert.deepEqual(finalNative.raw,before.raw);await h.settle();r.settle();
   assert.equal(stop.canceled,mode.includes('cancel'));
   assert.equal(stop.changed,mode==='second-pan');
  }
  const after=snap(),sameRaw=JSON.stringify(before.raw)===JSON.stringify(after.raw),sameX=before.Xs.every((x:number,i:number)=>Math.abs(x-after.Xs[i])<1e-8),sameY=before.Ys.every((y:number,i:number)=>Math.abs(y-after.Ys[i])<=1);
  assert.equal(after.ready,true);assert.equal(after.incomingReady,true);assert.equal(sameRaw,true);assert.equal(h.reads.length,reads);
  if(mode==='explicit-range'||mode==='context-change'){assert.equal(sameY,false,'explicit navigation/context releases the monetary domain');assert.notDeepEqual(before.navigation,after.navigation);}
  else if(mode==='second-pan'){assert.notDeepEqual(before.navigation,after.navigation);assert.equal(sameX,false);}
  else{assert.deepEqual(before.navigation,after.navigation);assert.equal(sameX,true);assert.ok(sameY,'no committed navigation must restore the original monetary projection');}
 }finally{r.close();h.close();}
});
for(const family of ['budget','funds'])for(const stopMode of ['finish','cancel'] as const)for(const phaseRender of [false,true])test(`${family} rapid ${stopMode}, active parent phase ${phaseRender?'observed':'coalesced'}`,async()=>{
 const h=await fixture(family,true),r=renderer(h,family);
 try{
  r.settle();await h.release();r.release();r.settle();await h.settle();r.settle();
  const reads=h.reads.length,pan=r.bindPan();let stop:any=null;pan.onStop((value:any)=>{stop=value;});
  const renderCount=r.parentRenders(),token=r.beginNative();assert.ok(token);
  if(phaseRender)r.render();
  pan.move(token,203); // The accepted last delta has not reached its input RAF.
  if(stopMode==='finish')pan.finish(token);else pan.cancel(token);
  r.runFrames();
  assert.equal(r.parentRenders(),renderCount+(phaseRender?1:0),'there was no parent render between the accepted input and stop/final native paint');
  const nativeFinal=r.nativeSnapshot([54*M,55*M]);
  assert.equal(stop.changed,stopMode==='finish');assert.equal(stop.canceled,stopMode==='cancel');
  await h.settle();r.settle();const ready=r.snapshot([54*M,55*M]);
  const sameX=nativeFinal.Xs.every((x:number,i:number)=>Math.abs(x-ready.Xs[i])<1e-8),sameY=nativeFinal.Ys.every((y:number,i:number)=>Math.abs(y-ready.Ys[i])<=1),sameRaw=JSON.stringify(nativeFinal.raw)===JSON.stringify(ready.raw);
  assert.equal(sameX,true);assert.equal(sameRaw,true);assert.equal(h.reads.length,reads);assert.equal(ready.ready,true);assert.ok(sameY,'ready replacement keeps the monetary value domain shown by the final native frame even when React coalesces the active phase');
 }finally{r.close();h.close();}
});


for(const [family,cap] of [['budget',false],['funds',false],['budget',true]] as const)test(`${family}${cap?' cap':''} cross-period publication retains the curve through both preparation owners`,async()=>{
  const H=3_600_000,day=24*H,now=200*H+23_017,initial={from:now-74*H,to:now-2*H};
  const h=await fixture(family,true,{initial,target:{from:now-26*H,to:now-2*H},now,period:'24h',financialHook:true,cap,startAtA:true}),r=renderer(h,family);
  try{
    const positive=(value:any)=>!!value&&value.paths.some((path:any)=>path.line||path.parts?.some((part:any)=>part.line));
    r.settle();assert.ok(r.peek().ready&&positive(r.peek().value));assert.equal(r.peek().value.cellMs??r.props().cellMs,900_000);
    h.gesture.cancel(h.gesture.active()!);r.runFrames();await h.settle();r.settle();
    const pan=r.bindPan(),first=r.beginNative();assert.ok(first);pan.move(first,100);r.runFrames();assert.equal(pan.finish(first),'live');r.runFrames();r.render();assert.equal(r.getSelected(),null);
    const old=r.peek().value,oldAxis=r.props().axis,key=old.lines[0].key;
    const interval=cap?old.lines[0].capCells.find((cell:any)=>cell.to-cell.from===900_000&&cell.from>=old.basis.from&&cell.to<=old.basis.to):null,at=cap?interval.from+600_001:old.lines[0].points.filter((point:any)=>point[0]<=old.basis.end).at(-1)[0];
    const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
    const amount=oldAxis.rawValue(key,at),observation=oldAxis.observation(key,at),formatted=oldAxis.formatValue(key,0,at),detail=text(oldAxis.detail(key,at));
    if(family==='funds'){assert.equal(observation?.at,at);assert.equal(observation?.value,amount);}
    if(cap){const series=h.store.getFinancial().history!.meterSeries!.find(series=>series.meterId===h.meter)!;assert.equal(moneyView.meterPointIn(series,at,900_000)?.value,'20000000');assert.equal(moneyView.meterPointIn(series,at,300_000),undefined,'this old-cell timestamp detects a raw new-grid lookup');assert.ok(detail.includes('money.limitTotal'));}
    assert.ok(positive(old));assert.equal(amount,'20000000');assert.equal(r.visual().to-r.visual().from,72*H);
    const second=r.beginNative();assert.ok(second&&second!==first);assert.equal(pan.get()!.length,day);pan.move(second,-30);r.runFrames();r.render();assert.equal(r.peek().value,old,'before incoming strips, the old curve remains');
    await h.settle();const incoming=h.store.getDrawingPlot();assert.equal(incoming?.cell,300_000);assert.equal(incoming?.length,day);assert.ok(incoming?.meterChunks?.length);
    r.render();assert.ok(r.peek().value===old&&positive(r.peek().value),'pending raw cells must retain the actual positive curve');assert.equal(r.props().prepared,false);assert.equal(r.props().cellMs,900_000);assert.equal(r.props().axis,oldAxis,'pending raw cells do not rebuild callbacks over old entries');assert.equal(r.props().axis.rawValue(key,at),amount);assert.equal(r.props().axis.formatValue(key,0,at),formatted);assert.deepEqual(r.props().axis.observation(key,at),observation);assert.equal(text(r.props().axis.detail(key,at)),detail);
    r.finishParent();r.render();assert.equal(r.props().prepared,true);assert.equal(r.props().cellMs,300_000);assert.equal(r.peek().ready,false);assert.ok(r.peek().value===old&&positive(r.peek().value),'the outer replacement cannot clear the still-pending inner curve');assert.equal(r.peek().value.cellMs,900_000);assert.equal(r.peek().value.valueAxis,oldAxis);assert.equal(r.peek().value.valueAxis.rawValue(key,at),amount);assert.deepEqual(r.peek().value.valueAxis.observation(key,at),observation);assert.equal(r.peek().value.valueAxis.formatValue(key,0,at),formatted);assert.equal(text(r.peek().value.valueAxis.detail(key,at)),detail);
    r.settle();assert.ok(r.peek().ready&&positive(r.peek().value));assert.equal(r.peek().value.cellMs,300_000);
    const committed=pan.finish(second);assert.ok(committed&&committed!=='live');r.runFrames();await h.settle();r.settle();assert.ok(r.peek().ready&&positive(r.peek().value));assert.equal(r.peek().value.cellMs,300_000);assert.equal(r.peek().value.basis.to-r.peek().value.basis.from,day);assert.equal(r.getSelected()!.to-r.getSelected()!.from,day);
  }finally{r.close();h.close();}
});

for(const family of ['budget','funds'])for(const change of ['selection','unit','board','width','height'] as const)test(`${family} ${change} change retires a monetary prepared frame`,async()=>{
  const h=await fixture(family,true,{financialHook:true,startAtA:true}),r=renderer(h,family);
  try{
    r.settle();assert.ok(r.peek().value&&r.peek().ready);const prior=r.peek().value,authority=h.store.getFinancial().presentation;
    if(change==='selection'){r.revokeSelection();assert.notEqual(h.store.getFinancial().presentation,authority,'the actual reader retires its financial authority');}
    else if(change==='unit')r.setUnit('EUR');
    else if(change==='board')r.setBoard('other-board');
    else if(change==='width')r.resize(901,300);
    else r.resize(900,301);
    r.render();assert.notEqual(r.peek().value,prior);assert.equal(r.peek().value,null,'incompatible authority or dimensions cannot keep an old numeric frame');assert.equal(r.peek().ready,false);
  }finally{r.close();h.close();}
});
