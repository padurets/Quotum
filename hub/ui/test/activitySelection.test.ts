import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActivitySelection,type ActivityScope} from '../lib/activitySelection';
import {HistoryPool} from '../lib/historyPool';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {periodKey} from '../../server/domain/period';
import {cellOf} from '../../server/domain/history';
import {expandPeriod} from '../../server/domain/periodWire';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import {Preparations} from '../lib/prepare';
import {ApiError} from '../lib/http';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {effectiveFilters,publishDataFilters,onDataFilters} from '../lib/filterSelection';
import {workChange} from '../lib/workChanges';
import {matchesSource} from '../../server/domain/dataFilters';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};

test('the mounted subset accepts ordinary history events carrying unchanged work authority',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),pool=new HistoryPool(),requests:PeriodRequest[]=[],cleanups:(()=>void)[]=[];
  const add=(from:number,to:number)=>{h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project:'A',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'A'}}]);h.events.flush();};
  add(NOW-20*M,NOW-10*M);
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  const context={exports:{} as any,ActivitySelection,workChange,matchesSource,timeRange:()=>({from:NOW-H,to:NOW}),historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{requests.push(body);return expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,body)));},
    useState:(init:()=>unknown)=>[init()],useRef:(current:unknown)=>({current}),useTimeRange:()=>({from:NOW-H,to:NOW}),usePref:()=> '1h',
    useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>cleanups.push(effect()),
    activityMutedKeys:()=>['"Work project"'],effectiveFilters:()=>defaultFilters(),workFilter,defaultFilters,timeRangeKey:()=> 'fixed',
    onDataFilters:()=>()=>{},UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const reader:ActivitySelection=context.exports.hook({board:h.board,activity:{barMs:M}},'project',{},1,false,true);
  try{
    await flush();assert.equal(reader.numbers(NOW)!.agentMs,10*M);assert.equal(requests.length,1);
    add(NOW-10*M,NOW-5*M);await flush();
    assert.equal(requests.length,2,'one replacement follows a real same-authority history event');
    assert.equal(reader.numbers(NOW)!.agentMs,15*M);
    h.reconnect();await flush();
    assert.equal(reader.numbers(NOW)?.agentMs,15*M,'a same-authority snapshot restores the subset without relying on a chart render');
    const nextAuthority='replacement';
    h.page.dispatch({type:'hub',event:{type:'history',data:{sources:[],since:NOW-5*M,workSince:NOW-5*M,workAuthority:nextAuthority}}});
    assert.equal(reader.numbers(NOW),null,'changed authority retires numerical evidence immediately');
  }finally{cleanups.forEach(stop=>stop());await flush();await h.close();}
});

for(const fixed of [false,true])test(`the mounted ${fixed?'fixed':'live'} subset reconciles filters without a chart render`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,initialFilters:defaultFilters()}),pool=new HistoryPool(),requests:PeriodRequest[]=[],cleanups:(()=>void)[]=[];
  h.store.creditWork(h.device,NOW-20*M,NOW-10*M,[{source:h.source,client:'codex',origin:'terminal',project:'A',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'A'}}]);h.events.flush();await flush();
  const stopPeriod=onDataFilters(()=>h.period.changed()),source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  const context={exports:{} as any,ActivitySelection,workChange,matchesSource,timeRange:()=>fixed?{from:NOW-H,to:NOW}:null,historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{requests.push(body);return expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,body)));},
    useState:(init:()=>unknown)=>[init()],useRef:(current:unknown)=>({current}),useTimeRange:()=>fixed?{from:NOW-H,to:NOW}:null,usePref:()=> '1h',
    useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>cleanups.push(effect()),
    activityMutedKeys:()=>['"Work project"'],effectiveFilters,workFilter,defaultFilters,timeRangeKey:()=> 'fixed',periodOf:()=>({ms:H}),onDataFilters,
    UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const reader:ActivitySelection=context.exports.hook({board:h.board,activity:{barMs:M}},'project',{},1,false,true);
  try{
    await flush();assert.equal(reader.numbers(NOW)?.agentMs,10*M);
    const model=reader.get().model,work=h.period.get().value,reads=requests.length;
    const money=structuredClone(effectiveFilters()!);money.funds.values=['another-source'];publishDataFilters(money);await flush();
    assert.equal(h.period.get().value,work);assert.equal(reader.get().model,model,'independent money filters preserve the complete subset');assert.equal(requests.length,reads);
    const selected=structuredClone(money);selected.projects={mode:'exclude',values:['A']};publishDataFilters(selected);
    assert.equal(reader.numbers(NOW),null,'a changed work predicate retires the old subset immediately');await flush();
    assert.equal(reader.numbers(NOW)?.agentMs,0,'the new work selection completes without rendering Activity');
  }finally{cleanups.forEach(stop=>stop());stopPeriod();publishDataFilters(null,false);await flush();await h.close();}
});

for(const days of [1,30])test(`production fixed subset ${days}d replaces dirty cells with exact totals and keeps clean cells`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,periodName:days===1?'24h':'30d'}),requests:PeriodRequest[]=[],pool=new HistoryPool();
  let gate:ReturnType<typeof deferred>|null=null,inFlight=0,peak=0,fail=false;
  const reader=new ActivitySelection({pool,now:()=>NOW,read:()=>({trace:null,ready:false,error:null}),scheduler:()=>null,
    send:async(_board,body,_signal,reserve)=>{requests.push(body);peak=Math.max(peak,++inFlight);try{if(fail){fail=false;throw Error('fixture unavailable');}const wire=h.reader.read(h.board,h.alice.id,body);assert.ok(reserve(wire.length*3));const reply=expandPeriod(JSON.parse(wire)),waiting=gate;gate=null;await waiting?.promise;return reply;}finally{inFlight--;}}
  });
  const add=(project:string,from:number,to:number,id=project)=>{h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:'',startedAt:NOW-days*24*H,identity:{kind:'stable',sessionId:id}}]);h.events.flush();};
  try{
    add('A',NOW-50*M,NOW-30*M);add('B',NOW-40*M,NOW-20*M);add('C',NOW-20*M,NOW-10*M);
    const selection={mode:'range' as const,from:NOW-days*24*H+123,to:NOW-123};
    const scope:ActivityScope={board:h.board,authority:'one',by:'project',muted:['"C"','"Work project"'],filters:workFilter(defaultFilters()),selection,rangeKey:periodKey(selection),barMs:cellOf(days*24*H)};
    reader.configure(scope);await flush();
    assert.equal(reader.get().error,null);assert.equal(requests.length,1);
    const value=reader.numbers(NOW)!;assert.deepEqual([value.agentMs,value.activeMs,value.agents],[40*M,30*M,2]);
    assert.equal(value.by.project.reduce((n,g)=>n+g.activeMs,0),40*M);
    assert.equal(requests[0].quota?.sources,'[]');assert.equal(requests[0].quota?.evidence,'skip');
    assert.deepEqual(Object.keys(requests[0]).sort(),['evaluatedAt','quota','selection','sessions','version','workFilter']);
    const tiles=(reader as unknown as {tiles:Map<number,unknown>}).tiles,first=[...tiles][0];
    add('A',NOW-12*M,NOW-7*M);reader.changed(NOW-12*M);await flush();
    assert.equal(requests.length,2);assert.equal(Number(requests[1].quota!.from),Math.floor((NOW-12*M)/cellOf(days*24*H))*cellOf(days*24*H));
    assert.deepEqual(requests[1].selection,selection,'narrow cell replacement retains the entire exact period');
    assert.equal((reader as unknown as {tiles:Map<number,unknown>}).tiles.get(first[0]),first[1],'a clean tile keeps its actual buffer');
    const fresh=reader.numbers(NOW)!;assert.deepEqual([fresh.agentMs,fresh.activeMs,fresh.agents],[45*M,35*M,2]);
    reader.changed(NOW+1);await flush();assert.equal(requests.length,2,'an event after the upper bound reads nothing');
    add('B',NOW-6*M,NOW-5*M);reader.changed(NOW-6*M);reader.changed(NOW-5*M);await flush();assert.equal(requests.length,3,'queued news coalesces');
    gate=deferred();const waiting=gate;reader.changed(NOW-10*M);await flush();assert.equal(requests.length,4);
    const retained=reader.get().model;
    add('A',NOW-4*M,NOW-3*M);reader.changed(NOW-4*M);assert.equal(reader.get().model,retained,'the last complete answer stays visible while newer work is pending');assert.equal(reader.get().loading,true);waiting.resolve();await flush();
    assert.equal(peak,1);assert.equal(requests.length,5);assert.deepEqual([reader.numbers(NOW)!.agentMs,reader.numbers(NOW)!.activeMs],[47*M,37*M]);
    fail=true;add('A',NOW-10*H,NOW-10*H+5*M,'late-A');reader.changed(NOW-10*H);await flush();assert.equal(reader.get().error,'history_failed');assert.equal(reader.numbers(NOW)?.agentMs,47*M,'a failed replacement keeps its complete evidence');
    add('A',NOW-2*M,NOW-M);reader.changed(NOW-2*M);await flush();
    assert.equal(Number(requests.at(-1)!.quota!.from),Math.floor((NOW-10*H)/cellOf(days*24*H))*cellOf(days*24*H),'a later event must also replace the earlier failed cells');
    assert.deepEqual([reader.numbers(NOW)!.agentMs,reader.numbers(NOW)!.activeMs],[53*M,43*M]);
    const repaired=reader.numbers(NOW)!;assert.deepEqual(repaired.cells.find(([at])=>at===Math.floor((NOW-10*H)/repaired.barMs)*repaired.barMs)?.slice(1),[5*M,5*M,1],'the earlier failed bar agrees with the fresh exact summary');
    reader.configure(null);await flush();assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);
  }finally{reader.reset();await flush();await h.close();}
});

test('live local projection consumes board intervals without reads and rejects obsolete generations',async()=>{
  const trace:WorkTrace=packWork({anchor:0,knownFrom:0,cut:100,refs:['A','B','C'].map((project,i)=>({ref:String(i),identityRef:i<2?'one':'two',source:null,project,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:0})),spans:[[0,0,30],[1,10,40],[2,20,60]]});
  const pool=new HistoryPool(),reader=new ActivitySelection({pool,now:()=>35,read:()=>({trace,ready:true,error:null}),scheduler:()=>null,send:async()=>{throw new Error('unexpected request');}});
  const scope:ActivityScope={board:'b',authority:'one',by:'project',muted:['"C"'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:30},rangeKey:'live',barMs:10};
  reader.configure(scope);await flush();assert.deepEqual([reader.numbers(35)!.agentMs,reader.numbers(35)!.activeMs,reader.numbers(35)!.agents],[50,30,1]);
  assert.deepEqual([reader.numbers(35,10)!.agentMs,reader.numbers(35,10)!.activeMs],[20,10]);
  reader.configure({...scope,muted:['"A"','"C"']});assert.equal(reader.numbers(35),null);await flush();assert.equal(reader.numbers(35)!.agentMs,25);
  reader.configure(scope);reader.configure(null);await flush();assert.equal(reader.numbers(35),null);assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);
});

test('a refused local preparation publishes an error and releases its reservation',async()=>{
  const trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:[],spans:[]},pool=new HistoryPool(100);
  const reader=new ActivitySelection({pool,now:()=>50,read:()=>({trace,ready:true,error:null}),scheduler:()=>null,send:async()=>{throw new Error('unexpected request');}});
  reader.configure({board:'b',authority:'one',by:'source',muted:['unknown'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:50},rangeKey:'live',barMs:10});await flush();
  assert.equal(reader.get().error,'history_limit');assert.equal(reader.numbers(50),null);assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);reader.reset();
});

test('a live work event waits for replacement board evidence and empty coverage has its own deadline',async()=>{
  let trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:[],spans:[]},ready=true;
  const pool=new HistoryPool(),reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace,ready,error:null}),scheduler:()=>null,send:async()=>{throw new Error('unexpected request');}});
  const scope:ActivityScope={board:'b',authority:'one',by:'source',muted:['unknown'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:50},rangeKey:'live',barMs:10};
  try{
    reader.configure(scope);await flush();assert.ok(reader.numbers(100)?.known);
    assert.equal(reader.changesAt(100,at=>String(!!reader.numbers(at)?.known)),150);
    const model=reader.get().model;
    reader.changed(90);await flush();assert.equal(reader.get().model,model,'retain pre-event evidence without republishing it as a ready replacement');assert.equal(reader.get().loading,true);
    trace={...trace,cut:110};reader.refresh();await flush();assert.ok(reader.numbers(100)?.known);
    assert.equal(reader.changesAt(100,at=>String(!!reader.numbers(at)?.known)),160);
    ready=false;reader.refresh();assert.ok(reader.numbers(100)?.known);assert.equal(reader.get().loading,true);
    ready=true;reader.refresh();await flush();assert.ok(reader.numbers(100)?.known,'the same trace can recover after its board dependency waits');
  }finally{reader.reset();await flush();assert.equal(pool.estimatedBytes,0);}
});

test('an oversized or invalid local predicate sends nothing and narrowing recovers',async()=>{
  const trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:[],spans:[]},pool=new HistoryPool();let requests=0;
  const reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace,ready:true,error:null}),scheduler:()=>null,send:async()=>{requests++;throw Error('unexpected request');}});
  const scope:ActivityScope={board:'b',authority:'one',by:'project',muted:Array.from({length:4000},(_,i)=>JSON.stringify(`project-${i}-${'x'.repeat(20)}`)),filters:workFilter(defaultFilters()),selection:{mode:'range',from:0,to:100},rangeKey:'fixed',barMs:10};
  reader.configure(scope);await flush();assert.equal(requests,0);assert.equal(reader.get().error,'history_limit');assert.equal(reader.numbers(100),null);assert.equal(pool.estimatedBytes,0);
  reader.configure({...scope,muted:['invalid JSON']});await flush();assert.equal(requests,0);assert.equal(reader.get().error,'history_limit');
  reader.configure({...scope,muted:['"A"'],selection:{mode:'live',periodMs:50}});await flush();assert.equal(reader.get().error,null);assert.equal(reader.numbers(100)?.agentMs,0);reader.reset();
});

test('unmount during sliced preparation releases scratch and cannot publish its retired cohort',async()=>{
  const queued:(()=>void)[]=[];let time=0;
  const scheduler=new Preparations({now:()=>++time,post:run=>queued.push(run)}),pool=new HistoryPool();
  const trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:Array.from({length:20},(_,i)=>({ref:String(i),source:null,project:'p'+i,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:0})),spans:Array.from({length:20},(_,i)=>[i,0,100])};
  const reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace,ready:true,error:null}),scheduler:()=>scheduler,send:async()=>{throw Error('unexpected request');}});
  reader.configure({board:'b',authority:'one',by:'project',muted:['"p0"'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:100},rangeKey:'live',barMs:10});await flush();
  assert.ok(queued.length);queued.shift()!();assert.ok(pool.estimatedBytes>0);assert.equal(reader.numbers(100),null);
  reader.reset();await flush();queued.splice(0).forEach(run=>run());await flush();
  assert.equal(reader.numbers(100),null);assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);assert.equal(scheduler.size,0);scheduler.dispose();
});

for(const error of [null,'history_failed'])test(`a live preparation cannot publish after board evidence becomes ${error?'failed':'pending'}`,async()=>{
  const queued:(()=>void)[]=[];let time=0,ready=true;
  const scheduler=new Preparations({now:()=>++time,post:run=>queued.push(run)}),pool=new HistoryPool();
  const trace:WorkTrace={anchor:50,knownFrom:50,cut:100,refs:Array.from({length:20},(_,i)=>({ref:String(i),source:null,project:'p'+i,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:50})),spans:Array.from({length:20},(_,i)=>[i,0,50])};
  const reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace,ready,error:ready?null:error}),scheduler:()=>scheduler,send:async()=>{throw Error('unexpected request');}});
  const drain=async()=>{for(let count=0;queued.length;count++){assert.ok(count<10000);queued.shift()!();}await flush();};
  try{
    reader.configure({board:'b',authority:'one',by:'project',muted:['"p0"'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:50},rangeKey:'live',barMs:10});await flush();
    queued.shift()!();assert.ok(scheduler.size);assert.equal(reader.numbers(100),null);
    ready=false;reader.refresh();await drain();
    assert.equal(reader.numbers(100),null,'retired C cannot become a ready local summary');assert.equal(reader.get().loading,!error);assert.equal(reader.get().error,error);
    assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
    ready=true;reader.refresh();await flush();await drain();
    assert.equal(reader.numbers(100)?.agentMs,950,'the same evidence can resume after readiness returns');
  }finally{reader.reset();await flush();scheduler.dispose();assert.equal(pool.estimatedBytes,0);}
});

test('a late forbidden reply cannot close a newer board, while current auth loss retires all local evidence',async()=>{
  const pool=new HistoryPool(),gate=deferred();let lost=0;
  const reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace:null,ready:false,error:null}),scheduler:()=>null,accessLost:()=>{lost++;},send:async()=>{await gate.promise;throw new ApiError(403,'forbidden');}});
  const scope:ActivityScope={board:'b',authority:'one',by:'project',muted:['"p0"'],filters:workFilter(defaultFilters()),selection:{mode:'range',from:0,to:100},rangeKey:'fixed',barMs:10};
  reader.configure(scope);await flush();reader.configure({...scope,authority:'two'});reader.reset();gate.resolve();await flush();assert.equal(lost,0);
  reader.configure({...scope,authority:'three'});await flush();assert.equal(lost,1);assert.equal(reader.numbers(100),null);assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);
});

for(const fixed of [false,true])for(const returnToA of [false,true])test(`queued ${fixed?'fixed':'live'} ${returnToA?'A to B to A':'A to B'} keeps the latest demand after cancellation`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true}),pool=new HistoryPool();
  const blockers=[{role:'visible'},{role:'visible'}] as const;
  for(const flight of blockers)pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});
  let requests=0;
  const reader=new ActivitySelection({pool,now:()=>NOW,read:()=>{const value=h.period.get();return {trace:value.value,ready:!value.loading&&!value.error,error:value.error};},scheduler:()=>null,
    send:async(board,body,_signal,reserve)=>{requests++;const wire=h.reader.read(board,h.alice.id,body);assert.ok(reserve(wire.length*3));return expandPeriod(JSON.parse(wire));}});
  try{
    for(const [project,from,to] of [['A',NOW-30*M,NOW-25*M],['B',NOW-20*M,NOW-10*M]] as const)h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
    h.events.flush();await flush();assert.equal(pool.activeFlights,2);
    const a:ActivityScope={board:h.board,authority:'one',by:'project',muted:['"B"','"Work project"'],filters:workFilter(defaultFilters()),selection:fixed?{mode:'range',from:NOW-H,to:NOW}:{mode:'live',periodMs:H},rangeKey:fixed?'fixed':'1h',barMs:M};
    reader.configure(a);await flush();reader.configure({...a,muted:['"A"','"Work project"']});if(returnToA)reader.configure(a);await flush();
    assert.equal(reader.numbers(NOW),null);assert.equal(requests,0);
    for(const flight of blockers)pool.release(flight);await flush();
    assert.equal(reader.numbers(NOW)?.agentMs,(returnToA?5:10)*M,'the current generation starts when a shared slot is released');
    assert.equal(requests,fixed?1:0,'retired queued generations never reach HTTP');assert.equal(pool.activeFlights,0);
  }finally{reader.reset();for(const flight of blockers)pool.release(flight);await flush();assert.equal(pool.estimatedBytes,0);await h.close();}
});

for(const fixed of [false,true])for(const kind of ['own','quota','legacy','budget','unrelated'] as const)test(`mounted ${fixed?'fixed':'live'} Activity handles ${kind} cutoffs before a replacement`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),pool=new HistoryPool(),cleanups:(()=>void)[]=[];
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  let fail=false,reads=0;
  const context={exports:{} as any,ActivitySelection,workChange,matchesSource,historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{reads++;if(fail)throw Error('unavailable');return expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,body)));},
    useState:(init:()=>unknown)=>[init()],useRef:(current:unknown)=>({current}),useTimeRange:()=>fixed?{from:NOW-H,to:NOW}:null,timeRange:()=>fixed?{from:NOW-H,to:NOW}:null,usePref:()=> '1h',
    useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>cleanups.push(effect()),activityMutedKeys:()=>['"Other"'],
    effectiveFilters:()=>defaultFilters(),workFilter,defaultFilters,timeRangeKey:()=> 'fixed',periodOf:()=>({ms:H}),onDataFilters:()=>()=>{},
    UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const reader:ActivitySelection=context.exports.hook({board:h.board,activity:{barMs:M}},'project',{},1,false,true);
  try{
    await flush();assert.equal(reader.numbers(NOW)?.agentMs,M);
    const old=reader.get().model,previousReads=reads;
    fail=true;
    const data=kind==='own'?{sources:[],since:0,workSince:0}:kind==='legacy'?{sources:[h.source],since:0}:{sources:[kind==='unrelated'?'other':h.source],since:0,changes:[{source:kind==='unrelated'?'other':h.source,scope:kind==='budget'?'budget' as const:'quota' as const,since:0}]};
    const gate=h.hold();
    h.event({type:'history',data});
    if(kind==='budget'||kind==='unrelated'){
      assert.equal(reader.get().model,old,'independent resource evidence does not retire the subset');
      await flush();assert.equal(reads,previousReads);
    }else{
      assert.equal(reader.numbers(NOW),null,'retirement is synchronous, before microtasks or HTTP');
      await flush();assert.equal(reader.numbers(NOW),null);
      if(fixed)assert.equal(reader.get().errorOwner,'subset-read');
    }
    reader.reset();gate.release();await flush();assert.equal(reader.numbers(NOW),null,'a late baseline cannot restore the retired lifetime');
  }finally{cleanups.forEach(stop=>stop());reader.reset();await flush();await h.close();}
});

test('ordinary live replacement retains one accounted complete model through pending, failure and local retry',async()=>{
  const pool=new HistoryPool();let trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:[],spans:[]},ready=true,error:string|null=null,network=0;
  const reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace,ready,error}),scheduler:()=>null,send:async()=>{network++;throw Error('unexpected');},retryWork:()=>{error=null;ready=true;trace={...trace,cut:110};}});
  const scope:ActivityScope={board:'b',authority:'same',by:'project',muted:['"other"'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:50},rangeKey:'live',barMs:10};
  try{
    reader.configure(scope);await flush();const old=reader.get().model,bytes=pool.estimatedBytes;assert.ok(old&&bytes>0);
    const publications:ReturnType<typeof reader.get>[]=[];reader.subscribe(()=>publications.push(reader.get()));
    reader.changed(90);ready=false;reader.refresh();await flush();
    assert.equal(reader.get().model,old);assert.ok(pool.estimatedBytes>=bytes,'the retained projector remains charged');
    error='history_failed';reader.refresh();assert.equal(reader.get().errorOwner,'upstream-work');assert.equal(reader.get().model,old);
    reader.retry();await flush();assert.equal(reader.get().error,null);assert.notEqual(reader.get().model,old);
    assert.ok(publications.every(state=>state.model),'no intermediate subscriber observes a missing complete model');assert.equal(network,0);
    const complete=reader.get().model;
    const reserve=pool.reserve.bind(pool);pool.reserve=()=>false;
    trace={...trace,cut:120};reader.refresh();await flush();assert.equal(reader.get().model,complete);assert.equal(reader.get().errorOwner,'local-preparation');
    pool.reserve=reserve;reader.retry();await flush();assert.equal(reader.get().error,null);assert.equal(network,0,'local preparation retry has no transport');
  }finally{reader.reset();await flush();assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);}
});

test('mounted live Activity retry repeats failed upstream work before preparing its retained subset',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true}),pool=new HistoryPool(),cleanups:(()=>void)[]=[];
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');let subsetReads=0;
  const context={exports:{} as any,ActivitySelection,workChange,matchesSource,historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,
    fetchPeriod:async()=>{subsetReads++;throw Error('live subset must reuse upstream evidence');},
    useState:(init:()=>unknown)=>[init()],useRef:(current:unknown)=>({current}),useTimeRange:()=>null,timeRange:()=>null,usePref:()=> '1h',periodOf:()=>({ms:H}),
    useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>cleanups.push(effect()),activityMutedKeys:()=>['"Other"'],
    effectiveFilters:()=>defaultFilters(),workFilter,defaultFilters,timeRangeKey:()=> 'fixed',onDataFilters:()=>()=>{},UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const reader:ActivitySelection=context.exports.hook({board:h.board,activity:{barMs:M}},'project',{},1,false,true);
  try{
    await flush();const old=reader.get().model;assert.ok(old);assert.equal(reader.numbers(NOW)?.agentMs,M);
    const gate=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();assert.equal(reader.get().model,old);assert.equal(reader.get().loading,true);
    gate.reject(Error('upstream unavailable'));await flush();assert.equal(h.period.get().error,'unavailable');assert.equal(reader.get().errorOwner,'upstream-work');assert.equal(reader.get().model,old);
    const before=h.requests.length;reader.retry();await flush();assert.equal(h.requests.length,before+1,'retry reaches the real upstream period transport');assert.equal(h.period.get().error,null);assert.equal(reader.get().error,null);assert.notEqual(reader.get().model,old);assert.equal(reader.numbers(NOW)?.agentMs,2*M);assert.equal(subsetReads,0);
    const complete=reader.get().model,reads=h.requests.length;
    h.event({type:'history',data:{sources:[h.source],since:0,workAuthority:h.page.get().board!.workAuthority,changes:[{source:h.source,scope:'budget',since:0}]}});await flush();
    assert.equal(reader.get().model,complete);assert.equal(reader.get().loading,false);assert.equal(h.requests.length,reads,'same-authority financial news never strands local work as pending');
  }finally{cleanups.forEach(stop=>stop());reader.reset();await flush();await h.close();}
});
