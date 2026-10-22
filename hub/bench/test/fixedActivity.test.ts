import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {activityOracle,assertActivityOverlap,assertActivityOutside,assertActivityCancellation,assertActivityGestureRange,FIXED_ACTIVITY_BUDGET,fixedActivityScript,fixedActivityGestureScript,fixedActivityGestureReceipt,fixedActivityPointerParkScript,fixedActivityPointerPark} from '../fixedActivity';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {fixture,drawings,flush,NOW} from '../../ui/test/periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../../ui/lib/filterSelection';
import {HistoryPool} from '../../ui/lib/historyPool';
import {TILE_CELLS,MAX_READ_TILES} from '../../server/domain/history';
import {Preparations} from '../../ui/lib/prepare';
import {plotGroups} from '../../ui/lib/historyPlot';
import vm from 'node:vm';

for(const period of ['24h','30d'])test(`the complete fixed Activity script installs before the page loads: ${period}`,async()=>{
  class Storage {values=new Map<string,string>();setItem(key:string,value:string){this.values.set(key,value);}getItem(key:string){return this.values.get(key)??null;}}
  const localStorage=new Storage(),pool=new HistoryPool(),sent:Headers[]=[];
  const context=vm.createContext({Storage,localStorage,Map,Set,WeakMap,WeakRef,Headers,Request,URL,pool,
    performance:{now:()=>0},location:{href:'http://fixture.invalid/'},document:{querySelector:()=>null},
    fetch:async(_url:string,init:{headers:Headers})=>{sent.push(init.headers);return 'stand-in';}});
  vm.runInContext('window=globalThis;',context);
  vm.runInContext(fixedActivityScript(period),context);
  vm.runInContext('__quotumInspectHistoryPool(pool);',context);
  assert.equal(typeof context.__quotumInspectPreparations,'function');
  assert.equal(vm.runInContext('__quotumFixedActivity.ready()',context),false);
  assert.equal(vm.runInContext('__quotumFixedActivity.sample()',context),null);
  assert.deepEqual(JSON.parse(localStorage.getItem('quotum.prefs')!),{range:period,horizon:'1d',activityBy:'project',filtersVisible:true});
  assert.equal(localStorage.getItem('quotum.locale'),'en');
  await context.fetch('/api/boards/synthetic/period',{headers:{'content-type':'application/json'}});
  assert.match(sent[0].get('x-quotum-bench-attempt')!,/^b\d+:\d+$/);
  const receipt=vm.runInContext('__quotumHistoryPoolReceipt.read()',context);
  assert.equal(receipt.entries.find((entry:{kind:string})=>entry.kind==='http').attemptId,sent[0].get('x-quotum-bench-attempt'),'identity wraps the observer before fetch reaches it');
  context.__quotumInspectPreparations({size:3,replace:()=>{}});
  pool.register({estimatedBytes:0,evictionCandidates:()=>[]});
  const checkpoint=vm.runInContext("__quotumHistoryPoolReceipt.checkpoint('seed/settled')",context);
  assert.equal(checkpoint.members[0].pending.preparationSize,3,'the fixed Activity probe forwards the shared scheduler to the receipt observer');
});

test('native gesture range compares URL endpoints with a full historical selection',()=>{
  const selection={mode:'range' as const,from:123,to:1000};
  const params=new URL('http://fixture.invalid/?from=123&to=1000').searchParams;
  const range={from:Number(params.get('from')),to:Number(params.get('to'))};
  assertActivityGestureRange(range,selection);
  assert.throws(()=>assertActivityGestureRange({...range,from:124},selection));
  assert.throws(()=>assertActivityGestureRange({...range,to:1001},selection));
});

// Execute the shipped diagnostic script. DOM stand-ins qualify its bounds and
// rejection paths; they do not establish native input delivery or chart movement.
function gestureFixture({blocked=false,width=600,top=-40}={}){
  const listeners=new Map<string,(event:unknown)=>void>(),microtasks:(()=>void)[]=[];
  const captured=new Set<number>(),dataset:Record<string,string>={drawFrom:'100',drawTo:'200',drawReady:'true'};
  const rect=(value:number)=>({baseVal:{value}}),mask={x:rect(48),y:rect(12),width:rect(width-60),height:rect(110)};
  const chart={closest:()=>chart,hasPointerCapture:(id:number)=>captured.has(id),querySelector:()=>svg};
  const svg={closest:()=>chart,viewBox:{baseVal:{x:0,y:0,width,height:150}},dataset,classList:{contains:()=>false},getBoundingClientRect:()=>({left:20,top,width,height:150}),querySelector:()=>mask};
  const context={window:{} as {__quotumFixedActivityGesture:{finish:()=>{complete:boolean;setup:string;point:{x:number;y:number;visible:{left:number;right:number;top:number;bottom:number}};events:Record<string,unknown>[];omitted:number;before:unknown;after:unknown}}},URLSearchParams,location:{search:'?from=100&to=200&token=private-token'},queueMicrotask:(fn:()=>void)=>microtasks.push(fn),document:{
    documentElement:{clientWidth:800,clientHeight:600},querySelector:()=>chart,querySelectorAll:()=>[svg],
    elementFromPoint:()=>blocked?null:chart,
    addEventListener:(type:string,listener:(event:unknown)=>void)=>listeners.set(type,listener),
    removeEventListener:(type:string,listener:(event:unknown)=>void)=>{assert.equal(listeners.get(type),listener);listeners.delete(type);},
  }};
  return {context,listeners,captured,dataset,chart,drain:()=>{for(const task of microtasks.splice(0))task();},finish:()=>context.window.__quotumFixedActivityGesture.finish(),begin:()=>runInNewContext(fixedActivityGestureScript(),context) as {x:number;y:number}};
}

test('native gesture setup uses the visible inner plot and rejects a blocked or too small owner',()=>{
  const h=gestureFixture(),point=h.begin(),receipt=h.finish();
  assert.ok(point.x>=receipt.point.visible.left&&point.x+48<=receipt.point.visible.right);
  assert.ok(point.y>=0&&point.y<=receipt.point.visible.bottom);
  assert.equal(point.y,41,'the clipped plot, rather than its offscreen SVG centre, owns the point');
  assert.equal(h.listeners.size,0);
  for(const [options,reason] of [[{blocked:true},'blocked-plot'],[{width:90},'invisible-plot']] as const){
    const rejected=gestureFixture(options);assert.throws(()=>rejected.begin());
    assert.equal(rejected.finish().setup,reason);assert.equal(rejected.listeners.size,0);
  }
});

test('native gesture receipt preserves event trust, ownership and post-handler capture without private URL parameters',()=>{
  const h=gestureFixture(),point=h.begin();
  const event={type:'pointerdown',isTrusted:true,clientX:point.x,clientY:point.y,shiftKey:true,button:0,buttons:1,pointerId:7,pointerType:'mouse',target:h.chart,defaultPrevented:false};
  h.listeners.get('pointerdown')!(event);
  h.captured.add(7);h.dataset.panToken='3';event.defaultPrevented=true;h.drain();
  h.listeners.get('pointercancel')!({...event,type:'pointercancel',isTrusted:false});h.drain();
  const receipt=h.finish(),down=receipt.events[0];
  assert.equal(receipt.complete,true);assert.equal(down.trusted,true);assert.equal(down.target,'activity');assert.equal(down.hit,'activity');
  assert.equal(down.capturedBefore,false);assert.equal(down.capturedAfter,true);assert.equal(down.prevented,true);
  assert.equal((down.panBefore as {token:number|null}).token,null);assert.equal((down.panAfter as {token:number|null}).token,3);
  assert.equal(receipt.events[1].type,'pointercancel');assert.equal(receipt.events[1].trusted,false,'diagnostics cannot promote an untrusted event');
  assert.deepEqual(JSON.parse(JSON.stringify(receipt.before)).url,{historical:true,from:100,to:200});
  assert.ok(!JSON.stringify(receipt).includes('private-token'));
});

test('native gesture receipt fails completeness rather than silently truncating event evidence',()=>{
  const h=gestureFixture(),point=h.begin();
  for(let i=0;i<35;i++)h.listeners.get('pointermove')!({type:'pointermove',isTrusted:true,clientX:point.x+i,clientY:point.y,shiftKey:true,button:-1,buttons:1,pointerId:7,pointerType:'mouse',target:h.chart,defaultPrevented:false});
  h.drain();const receipt=h.finish();
  assert.equal(receipt.events.length,32);assert.equal(receipt.omitted,3);assert.equal(receipt.complete,false);
});

// Execute the actual setup and receipt. Stand-in events test rejection and cleanup;
// trusted native delivery is qualified separately by the browser benchmark.
function pointerParkFixture({blocked=false,sticky=true}={}){
  const origin={x:50,y:150},listeners=new Map<string,(event:unknown)=>void>();
  const child={},chart={contains:(node:unknown)=>node===chart||node===child};
  const blank={closest:()=>null},control={closest:()=>control};let hit:unknown=blocked?control:blank;
  const heading={contains:(node:unknown)=>node===blank||node===control,getBoundingClientRect:()=>({left:0,top:0,width:200,height:60})};
  const plots=Array.from({length:5},()=>({dataset:{drawFrom:'100',drawTo:'200',drawReady:'true'},classList:{contains:()=>false}}));
  const context={window:{} as {__quotumFixedActivityPointerPark?:{finish:()=>{complete:boolean;trustedExit:boolean;finalOutside:boolean;before:unknown;after:unknown}}},URLSearchParams,location:{search:'?from=100&to=200&token=private-token'},innerWidth:200,innerHeight:300,getComputedStyle:()=>({position:sticky?'sticky':'static'}),document:{
    querySelector:()=>chart,querySelectorAll:(selector:string)=>selector.includes('chart>svg')?plots:[heading],
    elementFromPoint:(x:number,y:number)=>x===origin.x&&y===origin.y?chart:hit,
    addEventListener:(type:string,listener:(event:unknown)=>void)=>listeners.set(type,listener),
    removeEventListener:(type:string,listener:(event:unknown)=>void)=>{assert.equal(listeners.get(type),listener);listeners.delete(type);},
  }};
  const vmContext=vm.createContext(context);
  return {origin,listeners,plots,context,chart,child,blank,control,setHit:(value:unknown)=>{hit=value;},
    evaluate:<T>(source:string)=>vm.runInContext(source,vmContext) as T,
    begin:()=>vm.runInContext(fixedActivityPointerParkScript(origin),vmContext) as {x:number;y:number},
    emit:(change:Record<string,unknown>={})=>listeners.get('pointerout')?.({isTrusted:true,pointerType:'mouse',buttons:0,target:chart,relatedTarget:blank,...change}),
    finish:()=>context.window.__quotumFixedActivityPointerPark!.finish(),
  };
}

test('pointer setup requires a blank sticky heading and an actual trusted mouse exit from Activity',()=>{
  for(const options of [{blocked:true},{sticky:false}]){
    const h=pointerParkFixture(options);assert.throws(()=>h.begin(),/blank existing sticky heading/);assert.equal(h.listeners.size,0);
  }
  for(const change of [{isTrusted:false},{pointerType:'touch'},{buttons:1},{target:{}},{relatedTarget:'inside'}]){
    const h=pointerParkFixture();h.begin();h.emit(change.relatedTarget==='inside'?{relatedTarget:h.child}:change);
    assert.equal(h.finish().complete,false);assert.equal(h.listeners.size,0);assert.equal(h.context.window.__quotumFixedActivityPointerPark,undefined);
  }
  const h=pointerParkFixture(),point=h.begin();h.emit();const receipt=h.finish();
  assert.deepEqual(JSON.parse(JSON.stringify(point)),{x:190,y:30});
  assert.equal(receipt.complete,true);assert.equal(receipt.trustedExit,true);assert.equal(receipt.finalOutside,true);
  assert.deepEqual(receipt.after,receipt.before);assert.equal(h.listeners.size,0);
  assert.ok(!JSON.stringify(receipt).includes('private-token'));
});

test('pointer receipt rejects a blocked final hit or a changed historical projection',()=>{
  const blocked=pointerParkFixture();blocked.begin();blocked.emit();blocked.setHit(blocked.control);
  assert.equal(blocked.finish().complete,false);
  for(const field of ['drawFrom','drawTo','drawReady'] as const){
    const h=pointerParkFixture();h.begin();h.emit();h.plots[4].dataset[field]=field==='drawReady'?'false':'201';
    assert.equal(h.finish().complete,false,'every one of the five projections remains part of the receipt');assert.equal(h.listeners.size,0);
  }
  const changed=pointerParkFixture();changed.begin();changed.emit();changed.context.location.search='?from=101&to=200';
  assert.equal(changed.finish().complete,false);
});

test('pointer setup sends native released mouse input and waits for cleanup before reading its receipt',async()=>{
  const h=pointerParkFixture(),commands:{method:string;params:object}[]=[],finished:string[]=[];
  let entered!:()=>void,resume!:()=>void;
  const waiting=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>resume=resolve);
  type ParkCdp=Parameters<typeof fixedActivityPointerPark>[0];
  const cdp:ParkCdp={snapshot:()=>{throw Error('successful setup needs no recovery probe');},
    evaluate:async<T>(source:string)=>{if(source.includes('PointerPark.finish()'))finished.push('receipt');return h.evaluate<T>(source);},
    send:async<T>(method:string,params:object={})=>{commands.push({method,params});h.emit();return undefined as T;},
  };
  const work=fixedActivityPointerPark(cdp,h.origin,async()=>{entered();await gate;});
  await waiting;assert.equal(finished.length,0,'the receipt cannot precede completion of the ready/RAF settlement');assert.equal(h.listeners.size,1);
  resume();const receipt=await work;
  assert.equal(receipt.complete,true);assert.equal(finished.length,1);assert.equal(h.listeners.size,0);
  assert.deepEqual(commands,[{method:'Input.dispatchMouseEvent',params:{type:'mouseMoved',x:190,y:30,modifiers:0,button:'none',buttons:0}}]);
});

test('pointer setup preserves the native failure and avoids probing a failed or pending renderer',async()=>{
  type ParkCdp=Parameters<typeof fixedActivityPointerPark>[0];type Command=ReturnType<ParkCdp['snapshot']>;
  const clean:Command={context:'fixed-activity/pointer-setup',socketState:1,lastAck:null,lastEvent:null,terminal:null,failure:null,pending:[]};
  const failed={id:1,method:'Input.dispatchMouseEvent',context:clean.context,started:10,deadline:30010,elapsedMs:30000};
  for(const command of [clean,{...clean,failure:failed},{...clean,pending:[failed]},{...clean,socketState:3},{...clean,terminal:{method:'Inspector.targetCrashed' as const,at:10}}]){
    const h=pointerParkFixture(),error=Error('original native failure');let evaluations=0,settlements=0;
    const cdp:ParkCdp={snapshot:()=>command,evaluate:async<T>(source:string)=>{evaluations++;return h.evaluate<T>(source);},send:async()=>{throw error;}};
    await assert.rejects(fixedActivityPointerPark(cdp,h.origin,async()=>{settlements++;}),actual=>actual===error);
    assert.equal(settlements,0);assert.equal(evaluations,command===clean?2:1);
    assert.equal(h.listeners.size,command===clean?0:1,'a healthy renderer releases its own listener; failed renderers receive no further commands');
  }
  const h=pointerParkFixture(),error=Error('settlement failed');let evaluations=0;
  const cdp:ParkCdp={snapshot:()=>clean,evaluate:async<T>(source:string)=>{if(++evaluations>1)throw Error('cleanup also failed');return h.evaluate<T>(source);},send:async<T>()=>undefined as T};
  await assert.rejects(fixedActivityPointerPark(cdp,h.origin,async()=>{throw error;}),actual=>actual===error);
});

test('the shared-filter benchmark oracle clips intervals, unions overlap and deduplicates identities',()=>{
  const trace:WorkTrace={anchor:100,knownFrom:100,cut:200,refs:[0,1,2].map(i=>({ref:String(i),identityRef:i<2?'shared':'other',source:null,project:null,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:100})),spans:[[0,0,30],[1,10,40],[2,50,60]]};
  for(const value of [trace,packWork(trace)]){
    assert.deepEqual(activityOracle(value,115,135),{agentMs:35,activeMs:20,agents:1});
    assert.deepEqual(activityOracle(value,125,155),{agentMs:25,activeMs:20,agents:2});
    assert.deepEqual(activityOracle(value,170,180),{agentMs:0,activeMs:0,agents:0});
  }
  assert.equal(FIXED_ACTIVITY_BUDGET.request,76*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.pool,15*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.body,7*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.combined24h,1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.combined30d,4*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.advancesPerUpdate,1_000_000);
});

test('overlapping work counts its recorded native follow-up without allowing another selected-work reader',()=>{
  const base:PeriodRequest={version:1,selection:{mode:'range',from:123,to:1000},evaluatedAt:2000};
  const work:PeriodRequest={...base,sessions:{}},native:PeriodRequest={...base,quota:{cell:'300000',from:'0',to:'300000',sources:'["source"]',evidence:'skip'}};
  assertActivityOverlap([work],1);
  assertActivityOverlap([work,native],1);
  assert.throws(()=>assertActivityOverlap([work,work],1));
  assertActivityOverlap([work,work],2);
  assertActivityOverlap([work,work,native],2);
  assert.throws(()=>assertActivityOverlap([work,work,work],2),'a cancelled third work attempt still counts');
  assert.throws(()=>assertActivityOverlap([work,work,native,native],2));
  assert.throws(()=>assertActivityOverlap([work,work,{...native,quota:{...native.quota!,evidence:'another-ledger'}}],2));
  assert.throws(()=>assertActivityOverlap([work,work,{...native,facets:true}],2));
  assert.throws(()=>assertActivityOverlap([work,work,{...native,selection:{mode:'range',from:123,to:2000}}],2));
});

for(const period of ['24h','30d'] as const)test(`the shared ${period} reader rebuilds native and Activity tiles without creating a legend reader`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const filters=defaultFilters(),h=await fixture({periodName:period,fixed:true,initialFilters:filters});let d:Awaited<ReturnType<typeof drawings>>|undefined;
  t.after(async()=>{try{d?.close();await h.close();}finally{publishDataFilters(null,false);}});
  const selection={mode:'range' as const,from:NOW-(period==='24h'?1:30)*86400000,to:NOW};
  h.selectRange(selection);await flush();
  const work=JSON.parse(JSON.stringify(h.requests.find(body=>body.sessions))) as PeriodRequest;
  assert.ok(work);h.requests.length=0;
  d=await drawings(h,true);await flush();
  const native=JSON.parse(JSON.stringify(h.requests)) as PeriodRequest[];
  if(period==='30d')assert.ok(native.length>3&&native.length<=8,'a real monthly strip needs several one-tile reads');
  else assert.ok(native.some(body=>{const query=body.quota!,span=Number(query.cell)*TILE_CELLS;return Math.floor(Number(query.from)/span)!==Math.floor((Number(query.to)-1)/span);}), 'the actual fine-grid fixed reader batches several tiles');
  assertActivityCancellation([work,work,...native],selection);
  assertActivityCancellation([work,work,work,...native],selection);
  assert.throws(()=>assertActivityCancellation([work,work,work,work,...native],selection),'retired work still counts');
  assert.throws(()=>assertActivityCancellation([work,work,...Array.from({length:9},()=>native[0])],selection));
  const first=native[0],query=first.quota!;
  const span=Number(query.cell)*TILE_CELLS;
  for(const extra of [{...first,facets:true as const},{...first,quota:{...query,evidence:'another-ledger'}},
    {...first,quota:{...query,to:String(Number(query.from)+(period==='30d'?2:MAX_READ_TILES+1)*span)}},
    {...first,quota:{...query,from:String(Number(query.from)+1)}},
    {...first,quota:{...query,to:String(Number(query.to)-1)}},
    {...first,selection:{...selection,to:selection.to+1}}]){
    assert.throws(()=>assertActivityCancellation([work,work,extra],selection));
  }
  const members=(h.pool as unknown as {members:Set<unknown>}).members;
  assert.equal(members.size,2);h.requests.length=0;
  const held=h.hold();
  try{
    h.credit(NOW-60000,NOW);h.events.flush();await flush();
    const changed={...filters,clients:{mode:'exclude' as const,values:['codex']}};
    for(const next of [changed,filters]){
      publishDataFilters(next);h.period.changed();d.loader.setWorkFilter(JSON.stringify(workFilter(next)),next);
    }
  }finally{held.release();}
  await flush();
  const replacement=JSON.parse(JSON.stringify(h.requests)) as PeriodRequest[];
  if(period==='30d')assert.ok(replacement.some(body=>!body.sessions&&body.quota?.sources==='[]'),'the existing reader fetches Activity cells without native source data');
  else assert.ok(replacement.some(body=>!body.sessions&&body.quota),'the existing fine-grid reader refills its drawing cells');
  assertActivityCancellation(replacement,selection);
  assert.equal(members.size,2,'shared-filter replacement creates no legend-specific reader');
});

for(const periodName of ['24h','30d'])for(const offset of [0,1,30_124])test(`${periodName}: outside work preserves a nonaligned fixed drawing at +${offset}ms`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-(periodName==='24h'?24:30*24)*3_600_000+123;
  const h=await fixture({personal:true,fixed:true,periodName,creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();
  const d=await drawings(h,true),queue:(()=>void)[]=[];
  const scheduler=new Preparations({now:()=>performance.now(),post:run=>queue.push(run)},1);
  const replace=t.mock.method(scheduler,'replace');
  h.prepareWith(scheduler);(d.loader as any).env.preparations=scheduler;
  const settle=async()=>{
    for(let n=0;n<5000;n++){
      await flush();const run=queue.shift();if(run)run();
      else if(!scheduler.size&&!h.pool.activeFlights){await flush();if(!queue.length&&!scheduler.size&&!h.pool.activeFlights)return;}
    }
    assert.fail('bounded outside-work preparation did not settle');
  };
  try{
    const shown=d.loader.get(),financial=d.loader.getFinancial(),work=h.period.get();
    assert.ok(shown.history);assert.equal(shown.history.range,`${from}-${to}`);
    const total=()=>h.period.get().rows.reduce((sum:number,row:any)=>sum+row.workedMs,0);
    assert.equal(total(),299_900);h.requests.length=0;h.frames.length=0;
    h.credit(to+offset,to+offset+100);h.events.flush();await settle();
    assert.ok(h.frames.some(frame=>frame.type==='history'&&JSON.parse(frame.data).workSince===to+offset),'the actual outside producer event reached follow');
    assertActivityOutside(h.requests,{selection:{mode:'range',from,to}});
    assert.equal(h.requests.length,0,'outside work cannot reread the partial last drawing cell');
    assert.equal(replace.mock.callCount(),0,'outside work cannot prepare another drawing');
    assert.equal(d.loader.get(),shown);assert.equal(d.loader.getFinancial(),financial);assert.equal(h.period.get(),work);
    if(offset===0){
      h.selectRange({from,to:to+100});d.loader.choose(periodName,h.selectedRange());d.runScheduled();await settle();
      assert.ok(h.requests.some(body=>body.quota),'expanding the target must reread the dirty suffix');
      assert.equal(total(),300_000,'navigation receives the newly credited outside work');
    }
  }finally{d.close();scheduler.dispose();h.prepareWith(null);await h.close();}
});

for(const outside of [false,true])test(`outside work cannot dirty the initial fixed drawing reply: ${outside}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-24*3_600_000+123;
  const h=await fixture({personal:true,fixed:true,periodName:'24h',creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();h.requests.length=0;
  const held=h.hold(),d=await drawings(h,true);
  try{
    assert.ok(held.reply);assert.equal(d.loader.get().history,null);
    if(outside){h.credit(to,to+100);h.events.flush();await flush();}
    held.release();await flush();
    assert.equal(h.requests.length,1,'outside work cannot invalidate an initial reply for this exact range');
    assert.equal(d.loader.get().loading,false);assert.ok(d.loader.get().history);
  }finally{held.release();d.close();await h.close();}
});

for(const outside of [false,true])test(`outside work cannot dirty a held fixed-range reply: ${outside}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-24*3_600_000+123;
  const h=await fixture({personal:true,fixed:true,periodName:'24h',creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();const d=await drawings(h,true),held=h.hold();
  try{
    h.requests.length=0;
    h.credit(to-1,to);h.events.flush();await flush();
    assert.equal(h.requests.length,1);assert.ok(held.reply,'the actual replacement response is held');
    if(outside){h.credit(to,to+100);h.events.flush();await flush();}
    held.release();await flush();
    assert.equal(h.requests.length,1,'outside news must not turn an otherwise valid held reply into a second read');
    assert.equal(h.period.get().rows.reduce((sum:number,row:any)=>sum+row.workedMs,0),299_901);
    assert.equal(d.loader.get().loading,false);
  }finally{held.release();d.close();await h.close();}
});

for(const periodName of ['24h','30d'])for(const change of ['inside work','native measurement','outside work with native measurement'] as const)test(`${periodName}: fixed drawing producer control preserves ${change}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-(periodName==='24h'?24:30*24)*3_600_000+123;
  const h=await fixture({personal:true,fixed:true,periodName,creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();const d=await drawings(h,true);
  try{
    const total=()=>h.period.get().rows.reduce((sum:number,row:any)=>sum+row.workedMs,0);
    const native=()=>d.loader.getFinancial().history!.series.find(row=>row.sourceId===h.source&&row.windowId==='w')!;
    assert.equal(total(),299_900);assert.equal(native().remainingAtEnd,83);
    h.requests.length=0;h.frames.length=0;
    if(change==='inside work')h.credit(to-1,to+100);
    if(change==='outside work with native measurement')h.credit(to,to+100);
    if(change!=='inside work')h.store.record(h.source,{observedAt:to-1,plan:'',resets:null,staleAfterMs:3_600_000,
      windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:18,remaining:82,resetAt:NOW+3_600_000}]});
    h.events.flush();await flush();
    const notices=h.frames.filter(frame=>frame.type==='history').map(frame=>JSON.parse(frame.data));
    assert.ok(notices.some(data=>data.changes?.some((row:any)=>row.source===h.source&&row.scope==='quota'&&row.since===to-1)), 'the real producer changed evidence inside the fixed interval');
    if(change==='inside work')assert.ok(notices.some(data=>data.workSince===to-1));
    else if(change==='native measurement')assert.ok(notices.every(data=>data.workSince===undefined),'the native control adds no credited work');
    else assert.ok(notices.some(data=>data.workSince===to&&data.changes.some((row:any)=>row.since<row.workSince)), 'combined news preserves the earlier native measurement');
    assert.ok(h.requests.some(body=>body.quota),'an inside update must still reach the existing drawing reader');
    assert.equal(total(),change==='inside work'?299_901:299_900,'only the one millisecond before the exclusive endpoint changes selected work');
    assert.equal(native().remainingAtEnd,change==='inside work'?83:82,'the native change must reach the published quota history');
    assert.ok(d.loader.get().history);assert.equal(d.loader.get().loading,false);
  }finally{d.close();await h.close();}
});

for(const periodName of ['24h','30d'])for(const navigation of ['fixed','live','pan'] as const)test(`${periodName}: deferred outside work reenters through ${navigation}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-(periodName==='24h'?24:30*24)*3_600_000+123;
  const h=await fixture({personal:true,fixed:true,periodName,creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();const d=await drawings(h,true);
  try{
    const total=()=>h.period.get().rows.reduce((sum:number,row:any)=>sum+row.workedMs,0);
    h.requests.length=0;h.frames.length=0;h.credit(to,to+100);h.events.flush();await flush();
    assert.ok(h.frames.some(frame=>frame.type==='history'&&JSON.parse(frame.data).workSince===to),'the actual outside credit reached the reader');
    assert.equal(h.requests.length,0,'the original fixed drawing remains untouched');assert.equal(total(),299_900);
    if(navigation==='pan'){
      d.loader.pan({token:1,length:to-from,from:from+100,to:to+100,direction:0});await flush();
      const plot=d.loader.getActivityPlot();assert.ok(plot);
      const groups=plotGroups(plot,{k0:Math.floor((from+100)/plot.cell),k1:Math.ceil((to+100)/plot.cell)-1},'project');
      assert.equal(groups.reduce((sum,group)=>sum+group.cells.reduce((n,[,ms])=>n+ms,0),0),300_000,'the actual pan strip includes the previously outside credit');
      assert.equal(total(),299_900,'panning does not change the committed fixed work selection');
    }else{
      h.selectRange(navigation==='live'?null:{from,to:to+100});
      d.loader.choose(periodName,h.selectedRange());d.runScheduled();await flush();
      assert.equal(total(),300_000,'the new committed target includes the outside credit');
      assert.equal(d.renderActivity().history!.activity.agentMs,300_000,'the published Activity projection includes the same work');
    }
    assert.ok(h.requests.some(body=>body.quota&&body.quota.cells!=='skip'),'navigation must refill the previously dirty drawing cells');
  }finally{d.close();await h.close();}
});

test('deferred outside work yields to a zero-cutoff producer rebaseline',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-24*3_600_000+123;
  const h=await fixture({personal:true,fixed:true,periodName:'24h',creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();const d=await drawings(h,true);
  try{
    h.credit(to,to+100);h.events.flush();await flush();h.requests.length=0;h.frames.length=0;
    const invalidation=t.mock.method(h.events,'clientHistory'),authority=h.page.get().board!.workAuthority;
    h.store.observeWork(h.device,[{accountBy:'login',source:h.source,origin:'terminal',startedAt:h.period.get().rows[0].startedAt,project:'Work project',folder:'Private folder',client:'codex',
      identity:{kind:'stable',sessionId:'c'.repeat(32)},route:{class:'api',by:'session',host:'api.example',provider:'openai'}}]);
    h.events.flush();await flush();
    assert.ok(invalidation.mock.calls.some(call=>call.arguments[0]===h.owner&&call.arguments[1]===0),'the actual producer enrichment retires previous evidence at cutoff zero');
    assert.notEqual(h.page.get().board!.workAuthority,authority);
    assert.ok(h.frames.some(frame=>frame.type==='snapshot'),'the changed work authority delivers a fresh baseline');
    assert.ok(h.requests.some(body=>body.sessions),'the new baseline refreshes selected work evidence');
    assert.equal(h.period.get().rows.length,1);assert.equal(h.period.get().rows[0].source,null,'the API-route evidence retires the previous subscription funding');
    assert.equal(d.renderActivity().history!.activity.agentMs,299_900,'evidence enrichment preserves the exact selected interval');
  }finally{d.close();await h.close();}
});

test('deferred outside work yields to actual shared-board authority revocation',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const to=NOW-30_123,from=to-24*3_600_000+123;
  const h=await fixture({fixed:true,periodName:'24h',creditFrom:to-300_000,creditTo:to-100});
  h.selectRange({from,to});await flush();const d=await drawings(h,true);
  try{
    const authority=h.page.get().board!.workAuthority;assert.equal(h.period.get().rows.length,1);
    h.credit(to,to+100);h.events.flush();await flush();h.frames.length=0;
    h.remove();await flush();
    assert.notEqual(h.page.get().board!.workAuthority,authority,'removing the actual supplying member changes admitted work');
    assert.equal(h.period.get().rows.length,0,'revoked work cannot survive the deferred outside update');
    const activity=d.renderActivity().history!.activity;
    assert.equal(activity.agentMs,0);assert.equal(activity.by.project.length,0);
    assert.equal(d.loader.getFinancial().history!.series.find(row=>row.sourceId===h.source&&row.windowId==='w')!.remainingAtEnd,83,'the still-provided native quota remains available');
  }finally{d.close();await h.close();}
});

test('work at the fixed exclusive endpoint leaves calendar and Activity evidence without another read',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true,fixed:true});t.after(()=>h.close());
  const rows=JSON.stringify(h.period.get().rows),cells=JSON.stringify(h.period.calendar.get().value.cells);
  h.credit(NOW,NOW+100);h.events.flush();await flush();
  assert.ok(h.frames.some(frame=>frame.type==='history'&&JSON.parse(frame.data).workSince===NOW),'the actual outside-work event reached the board');
  assert.equal(h.requests.length,0,'work starting at the exclusive endpoint cannot dirty this historical calendar');
  const reads=JSON.parse(JSON.stringify(h.requests)) as PeriodRequest[];
  assertActivityOutside(reads,{selection:{mode:'range',...h.selectedRange()!}});
  assert.equal(JSON.stringify(h.period.get().rows),rows);
  assert.equal(JSON.stringify(h.period.calendar.get().value.cells),cells);
  const body:PeriodRequest={version:1,selection:{mode:'range',from:NOW-3600000,to:NOW},evaluatedAt:NOW,calendar:{zone:'UTC'}};
  assertActivityOutside([body],body);
  const native={...body,quota:{cell:'300000',from:String(NOW-300000),to:String(NOW),sources:JSON.stringify([h.source]),evidence:'skip' as const}};
  assertActivityOutside([native],body);
  assertActivityOutside([{...native,quota:{...native.quota,sources:'[]'}}],body);
  for(const requests of [[body,body],[{...body,sessions:{}}],[{...native,calendar:undefined}],
    [{...body,budget:native.quota}],
    [{...body,selection:{mode:'range' as const,from:NOW-100,to:NOW}}]]){
    assert.throws(()=>assertActivityOutside(requests,body));
  }
});


test('native Activity failure cleanup never probes a failed or pending renderer',async()=>{
  type GestureCdp=Parameters<typeof fixedActivityGestureReceipt>[0];
  type Command=ReturnType<GestureCdp['snapshot']>;
  const clean:Command={context:'fixed-activity/gesture',socketState:1,lastAck:null,lastEvent:null,terminal:null,failure:null,pending:[]};
  const unavailable:Command[]=[
    {...clean,failure:{id:1,method:'Input.dispatchMouseEvent',context:clean.context,started:10,deadline:30010,elapsedMs:30000}},
    {...clean,pending:[{id:1,method:'Input.dispatchMouseEvent',started:10,deadline:30010}]},
    {...clean,socketState:3},
    {...clean,terminal:{method:'Inspector.targetCrashed',at:10}},
  ];
  for(const state of unavailable){
    let evaluations=0;
    const cdp:GestureCdp={snapshot:()=>state,evaluate:<T>()=>{evaluations++;return new Promise<T>(()=>{});}};
    const receipt=await fixedActivityGestureReceipt(cdp);
    assert.equal(receipt,null);assert.equal(evaluations,0);
  }
  let evaluations=0;const expected={complete:true,events:[]};
  const cdp:GestureCdp={snapshot:()=>clean,evaluate:async<T>()=>{evaluations++;return expected as T;}};
  const receipt=await fixedActivityGestureReceipt(cdp);
  assert.equal(receipt,expected);assert.equal(evaluations,1);
});
