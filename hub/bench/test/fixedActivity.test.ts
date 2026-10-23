import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityOracle,assertActivityOverlap,assertActivityOutside,assertActivityCancellation,FIXED_ACTIVITY_BUDGET,fixedActivityScript,retainInterruptedActivity} from '../fixedActivity';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {fixture,drawings,flush,NOW} from '../../ui/test/periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../../ui/lib/filterSelection';
import {HistoryPool} from '../../ui/lib/historyPool';
import {TILE_CELLS,MAX_READ_TILES} from '../../server/domain/history';
import vm from 'node:vm';

for(const mode of ['live','disposed','save-failed','no-evidence'])test('fixed Activity interrupt snapshot: '+mode,t=>{
  const order:string[]=[],receipts:{name:string;value:unknown}[]=[];
  const started=performance.now(),state={context:'fixed-activity/30d/cancelled A to B to A',socketState:1,
    lastReply:{id:7,method:'Runtime.evaluate',at:started-1},lastEvent:null,terminal:null,failure:null,
    pending:[{id:8,method:'Runtime.evaluate',started,deadline:started+30_000}]};
  let snapshots=0;
  const cdp={snapshot:()=>{snapshots++;return structuredClone(state);}};
  const original=()=>{order.push('owner-abort');state.pending=[];};
  process.on('SIGTERM',original);t.after(()=>process.off('SIGTERM',original));
  const signals=['SIGINT','SIGTERM','SIGHUP'] as const,baseline=signals.map(signal=>process.listenerCount(signal));
  const save=(name:string,value:unknown)=>{order.push('save');if(mode==='save-failed')throw Error('stand-in write failure');receipts.push({name,value});};
  const dispose=retainInterruptedActivity(cdp,30,mode==='no-evidence'?undefined:{save});t.after(dispose);
  if(mode==='disposed')dispose();
  for(const [i,signal] of signals.entries())assert.equal(process.listenerCount(signal),baseline[i]+(mode==='disposed'||mode==='no-evidence'?0:1));
  process.emit('SIGTERM');
  assert.deepEqual(state.pending,[]);
  assert.deepEqual(order,mode==='disposed'||mode==='no-evidence'?['owner-abort']:['save','owner-abort']);
  assert.equal(snapshots,mode==='disposed'||mode==='no-evidence'?0:1);
  if(mode==='live'){
    assert.equal(receipts[0].name,'fixed-activity-command');
    const saved=receipts[0].value as ReturnType<typeof cdp.snapshot>&{days:number;capturedAtMs:number;wallAt:number};
    assert.equal(saved.days,30);assert.equal(saved.context,state.context);assert.equal(saved.pending[0].id,8);assert.equal(saved.lastReply.id,7);
    assert.equal(saved.pending[0].deadline-saved.pending[0].started,30_000);
    assert.ok(saved.capturedAtMs>=started&&saved.wallAt>0);
    process.emit('SIGTERM');assert.equal(receipts.length,1);assert.equal(snapshots,1);
  }else assert.equal(receipts.length,0);
  dispose();for(const [i,signal] of signals.entries())assert.equal(process.listenerCount(signal),baseline[i]);
});

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

test('outside fixed work refreshes the actual calendar without rereading or changing Activity',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true,fixed:true});t.after(()=>h.close());
  const rows=JSON.stringify(h.period.get().rows),cells=JSON.stringify(h.period.calendar.get().value.cells);
  h.credit(NOW,NOW+100);h.events.flush();await flush();
  assert.equal(h.requests.length,1);
  const reads=JSON.parse(JSON.stringify(h.requests)) as PeriodRequest[];
  assertActivityOutside(reads,{selection:{mode:'range',...h.selectedRange()!}});
  assert.equal(JSON.stringify(h.period.get().rows),rows);
  assert.equal(JSON.stringify(h.period.calendar.get().value.cells),cells);
  const body=reads[0],native={...body,quota:{cell:'300000',from:String(NOW-300000),to:String(NOW),sources:JSON.stringify([h.source]),evidence:'skip'}};
  assertActivityOutside([native],body);
  assertActivityOutside([{...native,quota:{...native.quota,sources:'[]'}}],body);
  for(const requests of [[body,body],[{...body,sessions:{}}],[{...native,calendar:undefined}],
    [{...body,budget:native.quota}],
    [{...body,selection:{mode:'range' as const,from:NOW-100,to:NOW}}]]){
    assert.throws(()=>assertActivityOutside(requests,body));
  }
});
