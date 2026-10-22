import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventCounts} from '../stream.js';
import {IDLE_SCRIPT_MS_PER_SECOND,idleProblems,type Idle} from '../budget.js';
import {spending,utcPeriods,type Reading} from '../../server/domain/meters.js';
import type {Card} from '../../server/projection.js';
import {safeEvidence} from '../evidence.js';

const a='own-device_1',b='own-device_2';
const send=(counts:EventCounts,type:string,data:unknown)=>counts.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
function reader(){const counts=new EventCounts();send(counts,'snapshot',{deviceContacts:{[a]:100,[b]:100}});counts.reset();return counts;}
const idle=(events:Record<string,number>):Idle=>({from:0,to:120_000,cellMs:300_000,requests:{count:0,byPath:{}},events,renders:[],mutations:[],scriptMsPerSecond:0});

test('private contacts remain fully reported while the unchanged board budget sees only board events',()=>{
  const counts=reader();for(let i=0;i<5;i++)send(counts,'ping',{});
  send(counts,'deviceContacts',{devices:[{deviceId:a,lastSeenAt:101},{deviceId:b,lastSeenAt:102}]});
  assert.deepEqual(counts.counts(),{ping:5,deviceContacts:1});
  assert.deepEqual(counts.boardCounts(),{ping:5});
  assert.deepEqual({...counts.contacts(),bytes:0},{packets:1,entries:2,bytes:0,maxEntries:2,invalid:0});
  assert.ok(counts.contacts().bytes>0);
  assert.match(idleProblems(idle(counts.counts())).join('\n'),/deviceContacts/,'the original oracle rejects an undifferentiated contact frame');
  assert.deepEqual(idleProblems(idle(counts.boardCounts())),[]);
  for(const type of ['refresh','card','history','snapshot','unknown']) {
    const changed=reader();send(changed,'ping',{});send(changed,type,{});
    assert.ok(idleProblems(idle(changed.boardCounts())).some(problem=>problem.includes(type)));
  }
  assert.ok(idleProblems({...idle(counts.boardCounts()),requests:{count:1,byPath:{'/api/devices':1}}}).length,'contact refetch remains forbidden');
  assert.ok(idleProblems({...idle(counts.boardCounts()),renders:[{region:'header',node:'div',kind:null,time:false,count:1}]}).length,'contact-driven board work remains forbidden');
  assert.ok(idleProblems({...idle(counts.boardCounts()),scriptMsPerSecond:IDLE_SCRIPT_MS_PER_SECOND+0.001}).length,'private contacts do not bypass the idle script budget');
});

test('only empty owner semantic hints qualify separately; board refreshes still fail',()=>{
  const counts=reader();send(counts,'devices',{});
  assert.deepEqual(counts.counts(),{devices:1});assert.deepEqual(counts.boardCounts(),{});
  assert.deepEqual(counts.hints(),{packets:1,bytes:2,invalid:0});
  assert.match(idleProblems(idle(counts.counts())).join('\n'),/devices/,'raw traffic still fails the original undifferentiated oracle');
  send(counts,'refresh',{id:'source',refresh:{unavailable:'no_device'}});
  assert.match(idleProblems(idle(counts.boardCounts())).join('\n'),/refresh/);
  for(const data of [null,[],[{}],true,0,'',{'deviceId':a},{devices:[]},{source:'private'},{lastSeenAt:101}]) {
    const invalid=reader();send(invalid,'devices',data);
    assert.deepEqual(invalid.hints(),{packets:0,bytes:0,invalid:1});
    assert.equal(invalid.boardCounts().devices,1);
    assert.match(idleProblems(idle(invalid.boardCounts())).join('\n'),/devices/);
  }
  const malformed=reader();malformed.push('event: devices\ndata: {\n\n');
  assert.equal(malformed.hints().invalid,1);assert.equal(malformed.boardCounts().devices,1);
  counts.reset();assert.deepEqual(counts.hints(),{packets:0,bytes:0,invalid:0});
});

test('only bounded coalesced owner contact fields qualify as metadata',()=>{
  for(const data of [null,{}, {devices:[]},{devices:[{deviceId:'foreign-id_1',lastSeenAt:101}]},
    {devices:[{deviceId:a,lastSeenAt:101},{deviceId:a,lastSeenAt:102}]},
    {devices:[{deviceId:a,lastSeenAt:101,name:'private label'}]},
    {devices:[{deviceId:a,lastSeenAt:101}],source:'hidden'},
    {devices:[{deviceId:a,lastSeenAt:-1}]},{devices:[{deviceId:a,lastSeenAt:1.5}]},
    {devices:[{deviceId:a,lastSeenAt:Number.MAX_SAFE_INTEGER+1}]},{devices:[{deviceId:a,lastSeenAt:'101'}]}]) {
    const counts=reader();send(counts,'deviceContacts',data);
    assert.equal(counts.contacts().invalid,1);assert.equal(counts.contacts().packets,0);
    assert.equal(counts.boardCounts().deviceContacts,1);
    assert.match(idleProblems(idle(counts.boardCounts())).join('\n'),/deviceContacts/);
  }
});

test('a reconnect replaces the owner baseline and does not hide snapshots or unknown metadata',()=>{
  const counts=reader();send(counts,'snapshot',{deviceContacts:{[b]:200}});
  assert.equal(counts.boardCounts().snapshot,1);
  counts.reset();send(counts,'deviceContacts',{devices:[{deviceId:a,lastSeenAt:201}]});
  assert.equal(counts.contacts().invalid,1,'a removed owner device cannot qualify');
  counts.reset();send(counts,'deviceContacts',{devices:[{deviceId:b,lastSeenAt:201}]});
  assert.equal(counts.contacts().packets,1);assert.deepEqual(counts.boardCounts(),{});
});

test('idle admits only exact UTC calendar packets and keeps all data and rendering budgets',()=>{
  for(const date of ['2026-10-17','2026-06-01','2027-01-01']) {
    const boundary=Date.parse(date+'T00:00:00Z'),from=boundary-60_000,to=boundary+60_000,at=boundary-600_000;
    const meter={id:'balance',kind:'balance' as const,unit:'USD',amount:'9007199254740993',at,staleAfterMs:21_600_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null};
    const readings:Reading[]=[{...meter,id:'usage',kind:'counter',at:at-3600_000,previousAt:null,amount:'0'},{...meter,id:'usage',kind:'counter',previousAt:at-3600_000}];
    const spans=[{from:at-3600_000,to:at,staleAfterMs:21_600_000}];
    const calendar=(now:number)=>Object.fromEntries(Object.entries(utcPeriods(now)).map(([period,start])=>[period,spending(readings,spans,start,Math.max(start,at))])) as NonNullable<Card['spending']>;
    const card:Card={id:'wallet',provider:'openrouter',plan:'',windows:[],resets:null,owners:[],successAt:at,error:null,stale:false,staleAfterMs:21_600_000,measureIntervalMs:null,meters:[meter],spending:calendar(from)};
    const next={...card,spending:calendar(boundary)};
    let now=from;
    const reader=()=>{
      const counts=new EventCounts(()=>now);
      send(counts,'snapshot',{sources:[{...card,plan:'old'}],deviceContacts:{}});
      send(counts,'card',card); // The warmup card replaces the stream's earlier snapshot.
      counts.reset({from,to});for(let i=0;i<5;i++)send(counts,'ping',{});
      return counts;
    };
    const counts=reader();now=boundary+100;send(counts,'card',next);
    assert.equal(counts.counts().card,1,'raw calendar traffic is retained');
    assert.deepEqual(counts.boardCounts(),{ping:5},'only the exact calendar delta is admitted');
    assert.deepEqual(counts.calendar().expected,[{id:'wallet'}]);assert.deepEqual(counts.calendar().received,[{id:'wallet'}]);assert.deepEqual(counts.calendar().missing,[]);
    assert.deepEqual(safeEvidence(counts.calendar()),counts.calendar(),'source receipts survive the existing artifact sanitizer');
    assert.equal(counts.calendar().packets,1);assert.ok(counts.calendar().bytes>0);
    const report={...idle(counts.boardCounts()),from,to,calendar:counts.calendar()};
    assert.deepEqual(idleProblems(report),[]);
    for(const region of ['card:wallet','analytics','header','card:other'])assert.match(idleProblems({...report,renders:[{region,node:'div',kind:null,time:false,count:1}]}).join('\n'),/rendered outside/);
    assert.match(idleProblems({...report,renders:[{region:'analytics',node:'svg',kind:'chart',time:true,count:4}]}).join('\n'),/more than 2/);
    assert.match(idleProblems({...report,scriptMsPerSecond:IDLE_SCRIPT_MS_PER_SECOND+0.001}).join('\n'),/script took/);
    assert.match(idleProblems({...report,requests:{count:1,byPath:{'/api/history':1}}}).join('\n'),/asked the hub/);
    const invalid:unknown[]=[null,[],{}, {...next,id:'foreign'}, {...next,successAt:at+1}, {...next,provider:'codex'}, {...next,owners:['other']}, {...next,keys:[]}, {...next,extra:true}, {...next,meters:[{...meter,amount:'9007199254740994'}]}, {...next,meters:[{...meter,at:at+1}]}];
    for(const change of [{from:boundary+1},{to:boundary+1},{amount:'0'},{complete:true},{knownFrom:boundary},{uncertain:true},{unlocated:[{}]},{extra:true}])invalid.push({...next,spending:{...next.spending,day:{...next.spending.day,...change}}});
    invalid.push({...next,spending:{...next.spending,week:{...next.spending.week,amount:'1'}}},{...next,spending:null},{...next,spending:{...next.spending,extra:true}});
    for(const value of invalid){const rejected=reader();send(rejected,'card',value);assert.equal(rejected.boardCounts().card,1);assert.deepEqual(rejected.calendar().received,[]);}
    const malformed=reader();malformed.push('event: card\ndata: {\n\n');assert.equal(malformed.boardCounts().card,1);
    for(const bad of [{amount:123},{amount:'01'},{complete:'bad'},{knownFrom:at+1},{uncertain:'bad'},{unlocated:[{}]},{extra:true}]){
      const baseline=new EventCounts(()=>now);send(baseline,'snapshot',{sources:[{...card,spending:{...card.spending,day:{...card.spending!.day,...bad}}}]});baseline.reset({from,to});send(baseline,'card',next);assert.equal(baseline.boardCounts().card,1,'malformed baseline grants no exception');
    }
    const duplicate=new EventCounts(()=>now);send(duplicate,'snapshot',{sources:[card,card]});duplicate.reset({from,to});send(duplicate,'card',next);assert.equal(duplicate.boardCounts().card,1,'duplicate baseline IDs grant no exception');
    for(const receiptAt of [from-1,boundary-1,to+1]){const early=reader();now=receiptAt;send(early,'card',next);assert.equal(early.boardCounts().card,1);}
    now=boundary+100;const repeated=reader();send(repeated,'card',next);send(repeated,'card',next);assert.equal(repeated.counts().card,2);assert.equal(repeated.boardCounts().card,1);
    const missing=reader();assert.match(idleProblems({...report,events:missing.boardCounts(),calendar:missing.calendar()}).join('\n'),/calendar.*wallet/);
    counts.reset();send(counts,'card',next);assert.equal(counts.boardCounts().card,1,'another phase cannot reuse the idle exception');
    const ordinary=new EventCounts(()=>now);send(ordinary,'snapshot',{sources:[card]});ordinary.reset({from:from-300_000,to:from-180_000});send(ordinary,'card',next);assert.equal(ordinary.boardCounts().card,1,'ordinary grid boundaries admit no calendar update');
  }
});
