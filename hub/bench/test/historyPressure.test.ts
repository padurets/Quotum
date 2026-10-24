import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {historyPressureScript,saveHistoryPressure} from '../historyPressure';
import {historyPageScript} from '../historyTrafficBrowser';
import {safeEvidence} from '../evidence';

test('the complete generated history bootstrap applies preferences, tags fetches and installs its pressure hook',async()=>{
  for(const pressure of [false,true])for(const period of ['24h','30d']){
    const stored=new Map<string,string>(),requests:{uri:string;headers:Headers}[]=[];
    const context:any={Map,Set,WeakMap,Headers,Request,URL,JSON,Date,performance,location:{href:'http://fixture.invalid/'},
      localStorage:{setItem:(key:string,value:string)=>stored.set(key,value),getItem:(key:string)=>stored.get(key)??null},
      fetch:async(uri:string,init:RequestInit)=>{requests.push({uri,headers:new Headers(init.headers)});return new Response('{}');}};
    context.window=context;
    runInNewContext(historyPageScript(period,pressure),context);
    assert.equal(stored.get('quotum.locale'),'en');
    assert.deepEqual(JSON.parse(stored.get('quotum.prefs')!),{range:period,horizon:'1d',filtersVisible:true});
    assert.equal(typeof context.__quotumInspectHistoryPool,pressure?'function':'undefined');
    assert.equal(typeof context.__quotumHistoryPressure,pressure?'object':'undefined');
    const response=await context.fetch('/api/boards/synthetic/period',{method:'POST',body:'{}'});
    assert.equal(await response.text(),'{}');assert.equal(requests.length,1);
    assert.match(requests[0].headers.get('x-quotum-bench-attempt')??'',/^b[0-9]+:1$/);
    assert.equal(Object.keys(context.__quotumHistoryAttempts).length,1);
  }
});

function fixture(enabled=true,order=['quota','budget','funds']){
  const pool=new HistoryPool(100);let getters=0,json=0,clocks=0,wraps=0;
  const context:any={Map,Set,WeakMap,Date:{now:()=>{clocks++;return 1000;}},performance:{now:()=>{clocks++;return 1;}},JSON:{parse:JSON.parse,stringify:(v:unknown)=>{json++;return JSON.stringify(v);}}};
  context.window=context;if(enabled)runInNewContext(historyPressureScript(),context);
  if(enabled)context.__quotumInspectHistoryPool(pool);
  const transport={queue:[] as any[],flights:new Set(),read(scope:string,query:unknown,signal:unknown){this.queue.push({scope,query,signal});return Promise.resolve('unchanged');}};
  const period={transport,retained:new Map(),valueCache:new Map(),bytes:0,get estimatedBytes(){getters++;return 0;},evictionCandidates:()=>[]};
  const charts=order.map(scope=>{
    const grids=new Map<number,Map<number,any>>();
    const member={scope:scope==='quota'?'quota':'budget',grids,flights:new Set(),responses:new Map(),reservations:new Map(),bytes:0,
      get estimatedBytes(){getters++;return [...grids.values()].reduce((sum,m)=>sum+[...m.values()].reduce((n,t)=>n+t.bytes,0),0);},
      evictionCandidates(){return [...grids.values()].flatMap(m=>[...m].map(([key,tile])=>{let drop=()=>{m.delete(key);member.nested?.();};return Object.defineProperty({bytes:tile.bytes,shownAt:0},'drop',{get:()=>drop,set:value=>{wraps++;drop=value;}}) as {bytes:number;shownAt:number;drop():void};}));},
      nested:undefined as (()=>void)|undefined,
      env:{read(_board:string,cell:number,from:number,to:number){return transport.read(scope,{cell,from,to},{});}}};
    return member;
  });
  pool.register(period);for(const chart of charts){pool.register(chart);chart.env.read('synthetic',60,0,60);}
  const seed=(chart=charts[0],key=0)=>{if(!chart.grids.has(60))chart.grids.set(60,new Map());chart.grids.get(60)!.set(key,{from:key*60,to:(key+1)*60,readFrom:key*60,readTo:(key+1)*60,nativeFrom:key*60,nativeTo:(key+1)*60,validTo:(key+1)*60,nativeValidTo:(key+1)*60-15,writeSeq:key+5,nativeSeq:key+3,bytes:80});};
  return{pool,period,charts,context,seed,read:()=>context.__quotumHistoryPressure.read(),counters:()=>({getters,json,clocks,wraps})};
}

test('ordinary reservations add no byte getter, serialization or clock reads before pressure',()=>{
  const old=fixture(false),observed=fixture();
  for(const h of [old,observed])for(let i=0;i<100;i++)assert.equal(h.pool.reserve({role:'visible'},0),true);
  assert.deepEqual(observed.counters(),old.counters());assert.equal(observed.read().rows.length,0);
});
test('actual trim records numeric removed tile identity and scopes from transport rather than ordinal',()=>{
  const h=fixture(true,['funds','quota','budget']);h.seed();
  assert.equal(h.pool.reserve({role:'visible',historyMember:h.period,operation:'calendar-projection'} as any,40),true);
  const r=h.read();assert.equal(r.status,'complete');
  const before=r.rows.find((v:any)=>v.kind==='drop-before'),after=r.rows.find((v:any)=>v.kind==='drop-after'),critical=r.rows.find((v:any)=>v.kind==='reserve-critical');
  assert.equal(before.owner.operation,'calendar-projection');assert.equal(critical.accepted,true);
  assert.equal(after.removed.length,1);assert.deepEqual(JSON.parse(JSON.stringify(after.removed[0].slice(1,4))),[60,0,60]);
  assert.deepEqual(JSON.parse(JSON.stringify(after.removed[0].slice(9))),[60,45,5,3],'resident native bytes are not necessarily valid through their stored end');
  assert.equal(r.members.find((v:any)=>v.memberId===after.memberId).boundScope,2,'first chart is funds, despite the shared budget class');
  assert.equal(after.removed[0][0],before.members.find((v:any)=>v.memberId===after.memberId).native[0][0]);
});
test('nested reservation restores the outer pressure identity and standalone trim has no invented owner',()=>{
  const h=fixture();h.seed();h.charts[0].nested=()=>{h.pool.reserve({role:'visible'},1);};
  assert.equal(h.pool.reserve({role:'visible',historyMember:h.period,operation:'restore'} as any,40),true);
  const critical=h.read().rows.find((v:any)=>v.kind==='reserve-critical');assert.equal(critical.reserveId,1);assert.equal(critical.owner.operation,'restore');
  const standalone=fixture();standalone.seed();standalone.seed(standalone.charts[1]);assert.equal(standalone.pool.trim(),true);
  assert.ok(standalone.read().rows.some((v:any)=>v.kind==='drop-before'&&v.reserveId===null&&v.owner.kind==='unknown'));
});
test('observation failure preserves actual admission and never exports exception text',()=>{
  const h=fixture();h.seed();Object.defineProperty(h.charts[0],'bytes',{get(){throw Error('private-canary');}});
  assert.equal(h.pool.reserve({role:'visible'},40),true);assert.equal(h.charts[0].grids.get(60)!.size,0);
  const r=h.read();assert.equal(r.status,'insufficient-evidence');assert.ok(r.errors>0);assert.ok(!JSON.stringify(r).includes('private-canary'));
});
test('only requests after pressure are retained, with bounded numeric resource metadata',()=>{
  const h=fixture();h.context.__quotumHistoryPressure.request('invalid','private-canary');assert.equal(h.counters().json,0);
  h.seed();h.pool.reserve({role:'visible'},40);
  h.context.__quotumHistoryPressure.request('b13:37',JSON.stringify({selection:{mode:'live',periodMs:60000},funds:{from:'0',to:'60',cell:'60',cells:'read'},values:['private-canary'],calendar:{zone:'private-canary'}}));
  const r=h.read(),row=r.rows.find((v:any)=>v.kind==='read');assert.equal(row.attemptId,'b13:37');assert.equal(row.sections[0].scope,2);assert.equal(row.values,1);assert.ok(!JSON.stringify(safeEvidence(r)).includes('private-canary'));
});
test('overflow and ambiguous scope bindings remain explicitly insufficient',()=>{
  const h=fixture(),flight={role:'visible' as const};for(let i=0;i<80;i++){h.seed(h.charts[0],i);assert.equal(h.pool.reserve(flight,40),true);}
  assert.ok(h.read().omitted>0);assert.ok(h.read().rows.length<=64);assert.ok(h.read().bytes<=65536);assert.equal(h.read().status,'insufficient-evidence');
  assert.ok(Buffer.byteLength(JSON.stringify(h.read()))<=65536);
  const wrappers=h.counters().wraps;h.seed(h.charts[0],81);assert.equal(h.pool.reserve(flight,40),true);assert.equal(h.counters().wraps,wrappers,'saturation creates no further drop wrappers');
  assert.equal(fixture(true,['quota','budget','budget']).read().status,'insufficient-evidence');
});

test('pressure collection stops its iterators instead of materializing or scanning their full tails',()=>{
  const h=fixture();h.seed();let retainedVisits=0,maxTileVisits=0;
  h.period.retained.values=function*(){for(let i=0;i<100000;i++){retainedVisits++;if(retainedVisits>33)throw Error('unbounded retained iterator');yield{bytes:1};}return undefined;};
  const map=h.charts[0].grids.get(60)!;
  Object.defineProperty(h.charts[0],'estimatedBytes',{get:()=>map.size?80:0});
  map.values=function*(){let visits=0;for(let i=0;i<100000;i++){maxTileVisits=Math.max(maxTileVisits,++visits);if(visits>129)throw Error('unbounded tile iterator');yield{from:i*60,to:(i+1)*60,bytes:1};}return undefined;};
  assert.equal(h.pool.reserve({role:'visible'},40),true);
  assert.equal(retainedVisits,33);assert.equal(maxTileVisits,129);assert.equal(h.read().errors,0);assert.ok(h.read().omitted>0);assert.equal(h.read().status,'insufficient-evidence');
});

test('unregister releases the registry owner and registering it again preserves one scope binding',()=>{
  const h=fixture();h.pool.unregister(h.charts[0]);assert.equal(h.read().members.filter((v:any)=>v.active).length,3);
  h.pool.register(h.charts[0]);h.charts[0].env.read('synthetic',60,0,60);
  assert.equal(h.read().members.length,4);assert.equal(h.read().status,'complete');
});
test('a failing original drop keeps its exception and incomplete pressure bookends',()=>{
  const h=fixture(),original=new Error('original-drop');h.seed();h.charts[0].nested=()=>{throw original;};
  assert.throws(()=>h.pool.reserve({role:'visible'},40),error=>error===original);
  const rows=h.read().rows;assert.equal(rows.find((v:any)=>v.kind==='drop-after').complete,false);
  assert.equal(rows.find((v:any)=>v.kind==='reserve-critical').complete,false);
});
test('postfailure export preserves the primary rejection through reader, writer and owner cancellation failures',async()=>{
  const primary=new Error('warm-primary');
  for(const fault of ['none','reader','writer','cancel'] as const){
    let reads=0;const saved:any[]=[];const cancel=new AbortController();if(fault==='cancel')cancel.abort();
    const cdp={evaluate:async<T>(_expression:string,signal?:AbortSignal):Promise<T>=>{reads++;signal?.throwIfAborted();if(fault==='reader')throw Error('private-canary');return{status:'complete',rows:[]} as T;}};
    const evidence={save:(name:string,value:unknown)=>{if(fault==='writer')throw Error('private-canary');saved.push({name,value});}};
    await assert.rejects(async()=>{await saveHistoryPressure(cdp,evidence,'fixture',cancel.signal);throw primary;},error=>error===primary);
    if(fault!=='writer'){assert.equal(saved[0].name,'pressure-fixture');assert.ok(!JSON.stringify(saved).includes('private-canary'));assert.equal(saved[0].value.status,fault==='none'?'complete':'insufficient-evidence');}
    assert.ok(reads<=1);
  }
});
