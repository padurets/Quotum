import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryStore} from '../lib/history';
import {HistoryPool} from '../lib/historyPool';
import {abortable} from './periodRuntimeFixture';
import {PeriodTransport,type HistoryReadOwner,type PeriodIntent} from '../lib/periodTransport';
import {Preparations} from '../lib/prepare';
import {expandHistory,tileEnd,tileOf,type Chunk,type HistoryAnswer} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type PeriodReply,type PeriodRequest} from '../../server/domain/periodRead';

const H=3_600_000,NOW=4*H+12_345;
const SOURCES=Array.from({length:12},(_,i)=>`s${i}`);
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
type Attempt={body:PeriodRequest;signal:AbortSignal;answer(patch?:Partial<PeriodReply>):Promise<void>};
type ReaderState={flights:Set<{role:'visible'|'ahead';startedAt:number}>;responses:Map<object,unknown>;metaAt:number|null};
const state=(reader:HistoryStore)=>reader as unknown as ReaderState;

/** The HTTP boundary is a stand-in; the readers, tiles and yielding preparation are real. */
function fixture(extras:Partial<PeriodRequest>={}) {
  const pool=new HistoryPool(),jobs:(()=>void)[]=[],attempts:Attempt[]=[],timers:number[]=[];
  let clock=0,elapsed=0,generation=1,now=NOW;
  const scheduled=new Map<object,{at:number;run():void}>();
  const preparer=new Preparations({now:()=>clock++,post:run=>jobs.push(run)},-1);
  const intent=():PeriodIntent=>({board:'b',generation,revision:generation,request:{version:1,selection:{mode:'range',from:NOW-H,to:NOW},evaluatedAt:NOW,...extras}});
  const transport=new PeriodTransport(pool,intent,()=>{},(_board,body,signal,reserve)=>new Promise((resolve,reject)=>{
    const basis={run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range:{from:NOW-H,to:NOW}};
    const reply:PeriodReply={basis};
    for(const scope of PERIOD_SCOPES){
      const query=body[scope];if(!query)continue;
      const cell=Number(query.cell),chunks:Chunk[]=[];
      for(let from=Number(query.from);from<Number(query.to);){
        const to=Math.min(Number(query.to),tileEnd(tileOf(from,cell),cell)),count=(to-from)/cell;
        chunks.push({from,to,series:scope==='quota'?SOURCES.flatMap(source=>['w0','w1'].map(window=>({source,window,hold:2*cell,open:80,
          cells:Array.from({length:count},(_,i):[number,number,number,number]=>[i,80-i,0,cell]),}))):[],
          ...(scope==='quota'?{}:{meterSeries:SOURCES.map(source=>({source,meter:'balance',kind:'balance' as const,unit:'USD',semantics:null,
            cells:Array.from({length:count},(_,i):[number,string,string,string,number]=>[i,'10000000','0','0',cell]),}))}),
          activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[]});
        from=to;
      }
      const value:HistoryAnswer={run:'run',now:NOW,historyStart:0,known:{work:0,sources:Object.fromEntries(SOURCES.map(id=>[id,0]))},meta:`metadata-${scope}`,chunks};
      reply[scope]={state:'complete',basis,value};
    }
    assert.ok(reserve(JSON.stringify(reply).length*3));
    attempts.push({body,signal,async answer(patch={}){resolve({...reply,...patch});await flush();}});
    signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  }));
  const readers=new Map<PeriodScope,HistoryStore>();
  for(const scope of PERIOD_SCOPES){
    const reader=new HistoryStore({sharedTransport:true,now:()=>now,elapsedNow:()=>elapsed,preparations:preparer,
      read:(_board,cell,from,to,signal,meters,meta,owner)=>transport.read(scope,{cell:String(cell),from:String(from),to:String(to),meta:meta?.meta??'',
        ...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{})}:{}),},signal,owner).then(reply=>expandHistory(reply,meta)),
      setTimeout:(run,ms)=>{timers.push(ms);const token={};scheduled.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{scheduled.delete(token as object);},dropTimeRange:()=>{throw Error('unexpected range loss');},
    },pool.budget,scope==='quota'?'quota':'budget',pool);
    readers.set(scope,reader);
  }
  transport.metadataToken=(board,scope)=>readers.get(scope)?.metadataToken(board);
  const start=(scope:PeriodScope)=>{
    const reader=readers.get(scope)!;
    reader.choose('1h',null);
    if(scope!=='quota')reader.setMeters({unit:'USD',displayCurrency:'EUR',ids:SOURCES.map(id=>[id,'balance'])});
    reader.open('b');reader.hello('run');reader.snapshot(SOURCES,SOURCES.flatMap(id=>['w0','w1'].map(w=>`${id} ${w}`)));
  };
  const tick=async()=>{jobs.shift()?.();await flush();assert.ok(pool.estimatedBytes<=pool.budget);};
  const finish=async()=>{for(let i=0;i<10_000;i++){await tick();if(!jobs.length&&!pool.activeFlights)return;}throw Error('preparation did not settle');};
  const advance=async(ms:number)=>{
    const end=now+ms;
    for(;;){const next=[...scheduled].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      elapsed+=next[1].at-now;now=next[1].at;scheduled.delete(next[0]);next[1].run();await flush();}
    elapsed+=end-now;now=end;
  };
  const close=async()=>{for(const reader of readers.values())reader.close();transport.reset();await flush();preparer.dispose();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);};
  return {pool,transport,readers,attempts,jobs,preparer,timers,start,tick,finish,advance,close,elapsed:(value:number)=>{elapsed=value;},change:()=>{generation++;transport.change();}};
}
function owner(initial:'visible'|'ahead'='visible') {
  let role:'visible'|'ahead'|null=initial,settle!:()=>void,cancelled=0;
  const value:HistoryReadOwner={finished:new Promise<void>(resolve=>{settle=resolve;}),role:()=>role,cancel:()=>{role=null;cancelled++;settle();}};
  return {value,role:(next:typeof role)=>{role=next;},settle:()=>{role=null;settle();},cancelled:()=>cancelled};
}
const query={cell:'60000',from:'10800000',to:'14400000'};
const scopes=(body:PeriodRequest)=>PERIOD_SCOPES.filter(scope=>body[scope]);

test('the first standalone baseline reuses metadata committed by its actual drawing reader',async()=>{
  const h=fixture({quota:{...query,cells:'skip'}});try{
    h.start('quota');await flush();assert.equal(h.attempts.length,1);
    assert.equal(h.attempts[0].body.quota!.meta,'');
    await h.attempts[0].answer();
    for(let i=0;i<1000&&h.attempts.length<2;i++)await h.tick();
    assert.equal(h.attempts.length,2);
    assert.equal(h.readers.get('quota')!.metadataToken('b'),'metadata-quota');
    assert.equal(h.attempts[1].body.quota!.cells,'skip');
    assert.equal(h.attempts[1].body.quota!.meta,'metadata-quota');
    await h.attempts[1].answer();await h.finish();
  }finally{await h.close();}
});

test('a standalone baseline captures its metadata token before waiting for pool admission',async()=>{
  const pool=new HistoryPool(),blockers=[{role:'visible' as const},{role:'visible' as const}],sent:PeriodRequest[]=[];
  let token='captured';
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'range',from:NOW-H,to:NOW},evaluatedAt:NOW,quota:{...query,cells:'skip'}}};
  const transport=new PeriodTransport(pool,()=>intent,()=>{},(_board,body,signal)=>new Promise((_resolve,reject)=>{sent.push(body);signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}));
  transport.metadataToken=()=>token;
  try{
    for(const flight of blockers)pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});
    transport.change();await flush();assert.equal(sent.length,0);
    token='later';pool.release(blockers[0]);await flush();
    assert.equal(sent.length,1);assert.equal(sent[0].quota!.meta,'captured');
  }finally{transport.reset();for(const flight of blockers)pool.release(flight);await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}
});

test('three families share one HTTP slot and retain decoded input through actual COW commit or cancellation',async()=>{
  const h=fixture();try{
    for(const scope of PERIOD_SCOPES)h.start(scope);await flush();
    assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),PERIOD_SCOPES);assert.equal(h.pool.activeFlights,1);
    for(const scope of ['budget','funds'] as const){assert.equal(h.attempts[0].body[scope]!.unit,'USD');assert.equal(h.attempts[0].body[scope]!.currency,'EUR');}
    const input=h.pool.estimatedBytes;await h.attempts[0].answer();assert.equal(h.pool.activeFlights,1);
    assert.ok([...h.readers.values()].every(reader=>state(reader).responses.size===1));
    let growth=false;
    for(let i=0;i<50&&h.jobs.length;i++){await h.tick();if(h.pool.estimatedBytes>input+[...h.readers.values()].reduce((n,reader)=>n+reader.estimatedBytes,0)){growth=true;break;}}
    assert.ok(growth,'a yielded private tile has its own reservation beside the decoded input');
    h.readers.get('quota')!.close();await flush();assert.equal(h.pool.activeFlights,1,'surviving readers retain the shared input');
    await h.finish();assert.equal(h.pool.activeFlights,0);
    for(const scope of ['budget','funds'] as const){assert.equal(h.readers.get(scope)!.get().error,undefined);assert.ok(h.readers.get(scope)!.get().history);}
    assert.equal(h.pool.estimatedBytes,[...h.readers.values()].reduce((n,reader)=>n+reader.estimatedBytes,0),'commit releases transport and private growth reservations');
  }finally{await h.close();}
});

test('foreground batching precedes queued speculation and admits only one purely speculative family',async()=>{
  const h=fixture(),q=owner('ahead'),b=owner(),f=owner();try{
    const pending=[h.transport.read('quota',query,undefined,q.value),h.transport.read('budget',query,undefined,b.value),h.transport.read('funds',query,undefined,f.value)].map(p=>p.catch(error=>error));
    await flush();assert.equal(h.attempts.length,2);assert.deepEqual(scopes(h.attempts[0].body),['budget','funds']);assert.deepEqual(scopes(h.attempts[1].body),['quota']);assert.equal(h.pool.activeFlights,2);
    q.value.cancel();b.value.cancel();f.value.cancel();h.transport.reset();await Promise.all(pending);await flush();assert.equal(h.pool.activeFlights,0);
    const speculative=PERIOD_SCOPES.map(()=>owner('ahead'));
    const next=PERIOD_SCOPES.map((scope,i)=>h.transport.read(scope,query,undefined,speculative[i].value).catch(error=>error));
    await flush();assert.equal(h.attempts.length,3,'the other ahead families wait for the single speculative slot');assert.deepEqual(scopes(h.attempts[2].body),['quota']);assert.equal(h.pool.activeFlights,1);
    for(const item of speculative)item.value.cancel();h.transport.reset();await Promise.all(next);
  }finally{await h.close();}
});

test('an incoming visible read preempts a flight after live visible and ahead priority changes',async()=>{
  const h=fixture(),q=owner(),b=owner(),blocker={role:'visible' as const};try{
    const first=h.transport.read('quota',query,undefined,q.value).catch(error=>error);await flush();
    q.role('ahead');q.role('visible');q.role('ahead');
    h.pool.request({estimatedBytes:0,evictionCandidates:()=>[]},blocker,()=>{},()=>{});await flush();assert.equal(h.pool.activeFlights,2);
    const second=h.transport.read('budget',query,undefined,b.value).catch(error=>error);await flush();
    assert.equal(h.attempts[0].signal.aborted,true);assert.equal(q.cancelled(),1);assert.equal((await first).name,'AbortError');
    assert.equal(h.attempts.length,2,'preemption does not wait for the abandoned HTTP delivery');assert.deepEqual(scopes(h.attempts[1].body),['budget']);assert.equal(h.pool.activeFlights,2);
    b.value.cancel();h.transport.reset();await second;
  }finally{h.pool.release(blocker);await h.close();}
});

test('shared readers anchor metadata at actual HTTP start after waiting for capacity',async()=>{
  const h=fixture(),blockers=[{role:'visible' as const},{role:'visible' as const}];try{
    for(const flight of blockers)h.pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});await flush();
    h.start('quota');await flush();assert.equal(h.attempts.length,0);
    h.elapsed(400);h.pool.release(blockers[0]);await flush();assert.equal(h.attempts.length,1);
    const reader=h.readers.get('quota')!;assert.equal([...state(reader).flights][0].startedAt,400);
    h.elapsed(700);await h.attempts[0].answer();h.pool.release(blockers[1]);await h.finish();assert.equal(state(reader).metaAt,400,'COW time and slot wait do not advance the captured hub clock');
    reader.news(NOW-60_000);await flush();assert.equal(h.attempts.length,2);assert.equal(h.attempts[1].body.quota!.meta,'metadata-quota');assert.equal(h.attempts[1].body.quota!.evidence,'skip');
  }finally{for(const flight of blockers)h.pool.release(flight);await h.close();}
});

test('retired queued owners settle without an empty POST or a microtask retry loop',async()=>{
  const h=fixture(),q=owner();let calls=0;try{
    const value={...q.value,role:()=>{assert.ok(++calls<50,'retired demand must leave the queue');return q.value.role();}};
    const pending=h.transport.read('quota',query,undefined,value).catch(error=>error);q.role(null);await flush();assert.equal((await pending).name,'AbortError');assert.equal(h.attempts.length,0);
    const before=calls;for(let i=0;i<3;i++){h.transport.change();await flush();}assert.equal(calls,before);assert.equal(h.pool.activeFlights,0);
  }finally{q.settle();await h.close();}
});

test('physical admission omits retired readers while preserving a queued surviving family',async()=>{
  const h=fixture(),q=owner(),next=owner(),b=owner(),blockers=[{role:'visible' as const},{role:'visible' as const}];try{
    for(const flight of blockers)h.pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});await flush();
    const pending=h.transport.read('quota',query,undefined,q.value).catch(error=>error);await flush();q.role(null);
    h.pool.release(blockers[0]);await flush();assert.equal((await pending).name,'AbortError');assert.equal(h.attempts.length,0);assert.equal(h.pool.activeFlights,1);
    h.pool.request({estimatedBytes:0,evictionCandidates:()=>[]},blockers[0],()=>{},()=>{});await flush();
    const retired=h.transport.read('quota',query,undefined,next.value).catch(error=>error);
    const survivor=h.transport.read('budget',query,undefined,b.value);await flush();next.role(null);
    h.pool.release(blockers[0]);await flush();assert.equal((await retired).name,'AbortError');assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),['budget']);
    await h.attempts[0].answer();await survivor;b.settle();await flush();assert.equal(h.pool.activeFlights,1);
  }finally{q.settle();next.settle();b.settle();for(const flight of blockers)h.pool.release(flight);await h.close();}
});

test('retiring a drawing restores its independently wanted exact query and captured evidence',async()=>{
  for(const explicit of [true,false]){
    const pool=new HistoryPool(),q=owner(),blockers=[{role:'visible' as const},{role:'visible' as const}],sent:PeriodRequest[]=[];
    const exact={cell:'60000',from:'10800000',to:'14400000',meta:'exact-metadata',cells:'skip',...(explicit?{evidence:'explicit-exact'}:{})};
    const captured={...exact,evidence:explicit?'explicit-exact':'captured-cursor'},cursorKey=JSON.stringify(['b','quota',undefined,undefined,undefined,undefined]);
    const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'range',from:NOW-H,to:NOW},evaluatedAt:NOW,quota:exact}};
    const transport=new PeriodTransport(pool,()=>intent,()=>{},(_board,body,signal)=>new Promise((_resolve,reject)=>{sent.push(body);signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}));
    try{
      transport.restoreEvidence(new Map([[cursorKey,'captured-cursor']]));
      for(const flight of blockers)pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});await flush();
      const pending=transport.read('quota',{cell:'300000',from:'9000000',to:'15000000',meta:'drawing-metadata',evidence:'skip'},undefined,q.value).catch(error=>error);
      await flush();q.role(null);transport.restoreEvidence(new Map([[cursorKey,'later-cursor']]));
      exact.meta='changed-metadata';pool.release(blockers[0]);await flush();assert.equal((await pending).name,'AbortError');
      assert.equal(sent.length,1);assert.deepEqual(sent[0].quota,captured,'a retired drawing cannot replace the captured exact request or borrow newer cursor evidence');
    }finally{q.settle();transport.reset();for(const flight of blockers)pool.release(flight);await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}
  }
});


test('ordinary navigation replaces a submitted target before physical HTTP admission',async()=>{
  const h=fixture(),blockers=[{role:'visible' as const},{role:'visible' as const}];try{
    h.start('quota');await flush();await h.attempts[0].answer();await h.finish();await h.advance(300);
    for(const flight of blockers)h.pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});await flush();
    const reader=h.readers.get('quota')!,first={from:NOW-2*H,to:NOW-H},selected={from:NOW-4*H,to:NOW-3*H};
    reader.choose('1h',first);await flush();assert.equal(h.attempts.length,1);
    reader.choose('1h',selected);await flush();assert.deepEqual(h.timers,[300],'rapid navigation uses the production settle delay');
    await h.advance(300);assert.equal(state(reader).flights.size,1,'only the latest submitted family target remains');
    h.elapsed(700);h.pool.release(blockers[0]);await flush();assert.equal(h.attempts.length,2);
    const sent=h.attempts[1].body.quota!,cell=Number(sent.cell);
    assert.equal(Number(sent.from),Math.floor(selected.from/cell)*cell);assert.equal(Number(sent.to),tileEnd(tileOf(Math.ceil(selected.to/cell)*cell-cell,cell),cell));
    await h.attempts[1].answer();h.pool.release(blockers[1]);await h.finish();assert.equal(h.attempts.length,2,'the displaced target must never start or create a duplicate demand');
    assert.equal(reader.get().history?.range,`${selected.from}-${selected.to}`);assert.equal(state(reader).metaAt,700);
  }finally{for(const flight of blockers)h.pool.release(flight);await h.close();}
});


test('an aborted HTTP attempt owns its slot and decoded reservation until its boundary settles',async()=>{
  const pool=new HistoryPool();let complete!:()=>void,signal!:AbortSignal;
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'range',from:NOW-H,to:NOW},evaluatedAt:NOW,sessions:{}}};
  const transport=new PeriodTransport(pool,()=>intent,()=>{},(_board,_body,requestSignal,reserve)=>new Promise(resolve=>{
    signal=requestSignal;assert.equal(reserve(1024),true);
    complete=()=>resolve({basis:{run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range:{from:NOW-H,to:NOW}}});
  }));
  try{
    transport.change();await flush();assert.equal(pool.activeFlights,1);assert.equal(pool.estimatedBytes,1024);
    transport.reset();await flush();assert.equal(signal.aborted,true);
    assert.equal(pool.activeFlights,1,'aborting a signal is not completion of the HTTP boundary');
    assert.equal(pool.estimatedBytes,1024,'the cancelled decoder still owns its reservation');
    complete();await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
  }finally{complete?.();transport.reset();await flush();}
});

/** Keep adoption and the drawing's finished promise independently owned across reset. */
async function resetLifecycle(holdNext=false,blockSecondSlot=false) {
  const pool=new HistoryPool(),sends:{generation:number;signal:AbortSignal}[]=[];
  const blocker={role:'visible' as const};
  let generation=1,active=true,adoptions=0,pins=0,role:'visible'|null='visible',finish!:()=>void,adopt!:()=>void,deliver!:()=>void;
  const finished=new Promise<void>(resolve=>{finish=resolve;}),adopting=new Promise<void>(resolve=>{adopt=resolve;}),delivery=new Promise<void>(resolve=>{deliver=resolve;});
  const basis={run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range:{from:NOW-H,to:NOW}};
  const intent=():PeriodIntent|null=>active?{board:'b',generation,revision:generation,resourceGeneration:1,request:{version:1,selection:{mode:'range',...basis.range},evaluatedAt:NOW,quota:{...query}}}:null;
  const transport=new PeriodTransport(pool,intent,async(_reply,_intent,reserve)=>{
    pins++;reserve!.retain!(()=>{pins--;});if(++adoptions===1)await adopting;
  },async(_board,body,signal,reserve)=>{
    sends.push({generation,signal});assert.equal(reserve(2048),true);
    if(holdNext&&sends.length>1)await abortable(delivery,signal);
    const reply:PeriodReply={basis};
    for(const scope of PERIOD_SCOPES)if(body[scope])reply[scope]={state:'complete',basis,value:{run:'run',now:NOW,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:{cursor:'cursor-'+sends.length,from:NOW-H,cut:NOW,replaceFrom:NOW-H,quota:[],money:[]}}};
    return reply;
  });
  const first=transport.read('quota',query,undefined,{finished,role:()=>role,cancel:()=>{role=null;}}).catch(error=>error);
  await flush();assert.equal(sends.length,1);assert.equal(adoptions,1);assert.equal(pins,1);assert.equal(pool.activeFlights,1);assert.equal(pool.estimatedBytes,2048);
  if(blockSecondSlot){pool.request({estimatedBytes:0,evictionCandidates:()=>[]},blocker,()=>{},()=>{});await flush();assert.equal(pool.activeFlights,2);}
  const finishAdoption=async()=>{adopt();await flush();assert.equal(pool.activeFlights,blockSecondSlot?2:1,'the original drawing still owns the shared slot');assert.equal(pool.estimatedBytes,2048);assert.equal(pins,1);};
  const finishReader=async()=>{finish();await flush();if(blockSecondSlot){pool.release(blocker);await flush();}};
  const close=async()=>{active=false;transport.reset();adopt();finish();deliver();pool.release(blocker);await first;await flush();assert.equal(pins,0);assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);};
  return {pool,transport,sends,first,finishAdoption,finishReader,pins:()=>pins,next:()=>{generation++;},close};
}

test('a newer intent before reset cannot authorize an unrequested post-reset baseline',async()=>{
  const h=await resetLifecycle();try{
    h.next();h.transport.change();await flush();assert.equal(h.sends.length,1);
    h.transport.reset();assert.equal((await h.first).name,'AbortError');
    await h.finishAdoption();await h.finishReader();
    assert.equal(h.sends.length,1,'an intent that already existed at reset supplies no new demand');
    assert.equal(h.pins(),0);assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }finally{await h.close();}
});

for(const action of ['change','read'] as const)for(const target of ['same','new'] as const)test(`a post-reset ${action} for the ${target} intent waits for the actual old owner and resumes`,async()=>{
  const h=await resetLifecycle(false,action==='read');let read:Promise<unknown>|undefined;try{
    h.transport.reset();if(target==='new')h.next();
    if(action==='change')h.transport.change();else read=h.transport.read('quota',query);
    await flush();assert.equal(h.sends.length,1,'the new request cannot borrow the old visible slot');
    await h.finishAdoption();assert.equal(h.sends.length,1);
    await h.finishReader();await read;
    assert.ok(h.sends.length>1,'demand after reset must wake even when the intent text is unchanged');
    assert.equal(h.sends[1].generation,target==='same'?1:2);
    assert.equal(h.pins(),0);assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }finally{await h.close();}
});

for(const cancellation of ['latest reset','queued read'] as const)test(`the latest reset retires earlier demand after ${cancellation}`,async()=>{
  const h=await resetLifecycle(false,cancellation==='queued read');try{
    h.next();h.transport.change();h.transport.reset();h.transport.change();h.transport.reset();
    if(cancellation==='queued read'){
      const signal=new AbortController(),read=h.transport.read('quota',query,signal.signal).catch(error=>error);
      await flush();assert.equal(h.sends.length,1);signal.abort();assert.equal((await read).name,'AbortError');
    }
    await h.finishAdoption();await h.finishReader();
    assert.equal(h.sends.length,1,'neither an earlier change nor a canceled reader survives the latest reset');
    assert.equal(h.pins(),0);assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }finally{await h.close();}
});

test('canceling a started post-reset reader does not make its implicit demand sticky',async()=>{
  const h=await resetLifecycle(true);try{
    h.transport.reset();await h.finishAdoption();await h.finishReader();assert.equal(h.pool.activeFlights,0);
    const signal=new AbortController(),read=h.transport.read('quota',query,signal.signal).catch(error=>error);
    await flush();assert.equal(h.sends.length,2);assert.equal(h.pool.activeFlights,1);assert.equal(h.pool.estimatedBytes,2048);
    signal.abort();assert.equal((await read).name,'AbortError');await flush();
    assert.equal(h.sends.length,2,'cancellation before delivery cannot request an exact baseline');
    assert.equal(h.pins(),0);assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }finally{await h.close();}
});

test('a canceled queued reader leaves no implicit baseline in its scheduled flush',async()=>{
  const pool=new HistoryPool();let sent=0;
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'range',from:NOW-H,to:NOW},evaluatedAt:NOW,quota:{...query}}};
  const transport=new PeriodTransport(pool,()=>intent,()=>{},async()=>{sent++;throw new Error('unexpected baseline');});
  const signal=new AbortController(),read=transport.read('quota',query,signal.signal).catch(error=>error);
  try{
    signal.abort();assert.equal((await read).name,'AbortError');await flush();
    assert.equal(sent,0);assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
  }finally{transport.reset();await flush();}
});

test('canceling the last delivered reader before baseline admission revokes only its implicit demand',async()=>{
  const pool=new HistoryPool();let sent=0;
  const basis={run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range:{from:NOW-H,to:NOW}};
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'range',...basis.range},evaluatedAt:NOW,quota:{...query}}};
  const transport=new PeriodTransport(pool,()=>intent,()=>{},async()=>{sent++;return {basis,quota:{state:'complete',basis,value:{run:'run',now:NOW,historyStart:0,known:{work:0,sources:{}},chunks:[]}}};});
  const signal=new AbortController();try{
    await transport.read('quota',query,signal.signal);signal.abort();await flush();
    assert.equal(sent,1,'a completed drawing that is then canceled cannot leave a later exact baseline');
    assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
  }finally{transport.reset();await flush();}
});

test('canceling a queued post-reset reader preserves an independent coordinator change',async()=>{
  const h=await resetLifecycle(false,true);try{
    h.transport.reset();h.transport.change();
    const signal=new AbortController(),read=h.transport.read('quota',query,signal.signal).catch(error=>error);
    await flush();assert.equal(h.sends.length,1);signal.abort();assert.equal((await read).name,'AbortError');
    await h.finishAdoption();await h.finishReader();
    assert.ok(h.sends.length>1,'canceling the reader does not cancel the independently requested baseline');
    assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);assert.equal(h.pins(),0);
  }finally{await h.close();}
});

for(const cancellation of ['one of two readers','an older reset epoch'] as const)test(`canceling ${cancellation} preserves another delivered reader's demand`,async()=>{
  const pool=new HistoryPool(),signals=[new AbortController(),new AbortController()];let sent=0;
  const basis={run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range:{from:NOW-H,to:NOW}};
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'range',...basis.range},evaluatedAt:NOW,quota:{...query},budget:{...query}}};
  const transport=new PeriodTransport(pool,()=>intent,()=>{},async(_board,body)=>{
    sent++;const reply:PeriodReply={basis};for(const scope of PERIOD_SCOPES)if(body[scope])reply[scope]={state:'complete',basis,value:{run:'run',now:NOW,historyStart:0,known:{work:0,sources:{}},chunks:[]}};return reply;
  });
  try{
    if(cancellation==='one of two readers')await Promise.all([transport.read('quota',query,signals[0].signal),transport.read('budget',query,signals[1].signal)]);
    else {await transport.read('quota',query,signals[0].signal);transport.reset();await transport.read('quota',query,signals[1].signal);}
    const before=sent;signals[0].abort();await flush();
    assert.equal(sent,before+1,'the other reader still requests one exact combined baseline');
    assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
  }finally{for(const signal of signals)signal.abort();transport.reset();await flush();}
});
