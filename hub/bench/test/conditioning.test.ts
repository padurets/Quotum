import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {SETS} from '../../demo/catalogue.js';
import {accountOf,cards,people} from '../../demo/model.js';
import {Agent,Person} from '../../demo/client.js';
import type {Stand} from '../../demo/setup.js';
import {buildApp} from '../../server/api.js';
import {Cadence} from '../../server/cadence.js';
import {Duty} from '../../server/duty.js';
import {subscriptionKey} from '../../server/domain/ingest.js';
import {Ingest} from '../../server/ingest.js';
import {Pairing} from '../../server/pairing.js';
import {ResetFeed} from '../../server/resets.js';
import {Setup} from '../../server/setup.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';
import {cellOf,cellStart} from '../../server/domain/history.js';
import {Conditioning,QUOTA_COUNT,QUOTA_EVERY,quotaProducer,ordinaryProducer,observedProducer,privateProducer} from '../conditioning.js';
import {ObservedWork} from '../observed.js';
import {stillSnapshot} from '../still.js';
import {safeEvidence} from '../evidence.js';

const DAY=86_400_000;
/** Run the exact producer bodies with a controlled test scheduler, never a benchmark clock override. */
function producers(now:()=>number,advance:(ms:number)=>void){
  const file=ts.createSourceFile('conditioning.ts',readFileSync(new URL('../conditioning.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const names=['quotaProducer','ordinaryProducer','observedProducer','privateProducer'];
  const source=file.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text??'')).map(node=>node.getText(file)).join('\n');
  const context={exports:{},QUOTA_COUNT,QUOTA_EVERY,DAY,ObservedWork,cards,people,stillSnapshot,cellOf,cellStart,Date:class extends Date{static now(){return now();}},pause:async(ms:number)=>advance(Math.max(0,ms))};
  runInNewContext(ts.transpileModule(source+'\nglobalThis.producers={quotaProducer,ordinaryProducer,observedProducer,privateProducer};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return (context as typeof context&{producers:{quotaProducer:typeof quotaProducer;ordinaryProducer:typeof ordinaryProducer;observedProducer:typeof observedProducer;privateProducer:typeof privateProducer}}).producers;
}

for(const jitter of [false,true])test(jitter?'ordinary reports retain the captured 14999/15001/15000 ms intervals across real server cuts':'shared producers retain actual protocol floors, full reports, pacing, history and cleanup; the independent oracle rejects corruption',async t=>{
  let now=Date.parse('2026-10-27T12:00:00Z');t.mock.method(Date,'now',()=>now);
  const root=mkdtempSync(path.join(tmpdir(),'quotum-conditioning-')),file=path.join(root,'hub.sqlite'),store=new Store(file,now-75*DAY),directory=new Directory(store.db);
  const ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const app=await buildApp({store,directory,ingest,pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(true,'BCDF-GHJK'),local:null});
  // Fetch terminates at the actual Fastify routes, without a listening socket or real client.
  const cleanupError=new Error('controlled observed cleanup failure');let failObservedClose=false,closeAttempts=0;
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const url=new URL(String(input));if(init?.method==='DELETE'&&url.pathname.startsWith('/api/tokens/')){closeAttempts++;if(failObservedClose)throw cleanupError;}
    const response=await app.inject({method:(init?.method??'GET') as 'GET',url:url.pathname+url.search,headers:{host:url.host,...Object.fromEntries(new Headers(init?.headers))},payload:init?.body as string|undefined});
    const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):String(value));
    return new Response(response.body,{status:response.statusCode,headers});
  });
  let ledger:Conditioning|undefined;
  try{
    const owner=await Person.signUp('http://localhost',{email:'fixture@example.com',name:'Fixture',password:'correct horse'},{setupCode:'BCDF-GHJK'});
    const card=cards(SETS[0]).find(card=>card.id==='antigravity')!,start=now-600000;
    const source=store.source('antigravity',subscriptionKey({provider:'antigravity',...accountOf(card),account:null,accountName:null},owner.id),now-75*DAY);store.hold(source,owner.id,now-75*DAY);
    const snapshot=stillSnapshot(card,start,start);await seedQuota(source,snapshot,now-75*DAY);await seedQuota(source,snapshot,start);
    const deepSources:string[]=[];
    for(let index=0;index<12;index++){
      const quota=store.source('claude','conditioning-quota-'+index,now-75*DAY);store.hold(quota,owner.id,now-75*DAY);deepSources.push(quota);
      store.record(quota,{observedAt:now-75*DAY,plan:'fixture',staleAfterMs:DAY,resets:null,windows:['session','weekly'].map(kind=>({id:kind,kind:kind as 'session',label:null,minutes:kind==='session'?300:10080,used:10,remaining:90,resetAt:null}))});
      for(const provider of ['openrouter','codex'] as const){const money=store.source(provider,'conditioning-money-'+index,now-75*DAY);store.hold(money,owner.id,now-75*DAY);
        if(provider==='codex')store.record(money,{observedAt:now-75*DAY,plan:'fixture',staleAfterMs:DAY,resets:null,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'2500'}]});
        else store.record(money,{type:'meters',observedAt:now-75*DAY,staleAfterMs:DAY,keys:[],inventoryComplete:true,inventoryError:null,meters:[{id:'credits',kind:'counter',unit:'USD',amount:'2500000000',at:now-75*DAY,staleAfterMs:DAY,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}]});
      }
    }
    const token=await owner.machineToken('Fixture'),machine={id:'conditioning-laptop',name:'Laptop',os:'linux',arch:'x86_64'},agent=new Agent(owner.base,machine,token,owner.id),peer=new Agent(owner.base,{...machine,id:'conditioning-peer',name:'Peer'},token,owner.id);
    peer.trackClients([{clientId:'opencode',sessionId:'a'.repeat(32),source:null,origin:'terminal',project:'Preserved peer',startedAt:new Date(start).toISOString(),working:false}],[]);
    let working=false,ordinal=0,lastReceipt:{at:number;ordinal:number;manual:boolean}|undefined;const reports:{at:number;working:boolean;privateCount:number}[]=[];
    const report=async(manual=false)=>{const at=now;await agent.sessions([{provider:'antigravity',...accountOf(card),sessionId:'f'.repeat(32),origin:'terminal',project:'Benchmark',startedAt:new Date(start).toISOString(),lastWorkedAt:new Date(start).toISOString(),working}],at);await peer.sessions([],at);lastReceipt={at,ordinal:++ordinal,manual};reports.push({at,working,privateCount:agent.clientSessionCount});return at;};
    let ordinaryReports=0;
    const demo={work:(value:boolean)=>{working=value;},nextReport:async()=>{now=start+(Math.floor((now-start)/15000)+1)*15000-(jitter&&ordinaryReports++===1?1:0);return report();},reportNow:async()=>report(true),reportReceipt:(_machine:string,at:number)=>{assert.equal(lastReceipt?.at,at);return {...lastReceipt!};}} as unknown as Parameters<typeof ordinaryProducer>[0];
    await agent.ingest([stillSnapshot(card,start,now)],[],now);await report();now++;
    const stand={set:SETS[0],start,people:new Map([[people(SETS[0])[0].id,owner]]),sources:new Map([['antigravity',source]]),agents:new Map([['laptop',agent],[card.machines[0],agent]])} as unknown as Stand;
    ledger=new Conditioning(file,stand);const api=producers(()=>now,ms=>{now+=ms;});
    let hookCount=0;await api.quotaProducer(stand,ledger,{before:async()=>{},after:async point=>{assert.equal(point.index,hookCount++);}});
    const beforeOrdinary=reports.length;
    await api.ordinaryProducer(demo,ledger,{before:async index=>{if(!jitter&&index===1)now+=30000;}});
    assert.equal(reports.length-beforeOrdinary,4);
    if(jitter){assert.deepEqual(ledger.ordinary.slice(1).map((row,i)=>row.reportedAt-ledger!.ordinary[i].reportedAt),[14999,15001,15000]);assert.deepEqual(ledger.receipt().ordinaryTickDeltas,[0,2,1]);}
    else assert.ok(ledger.receipt().ordinaryTickDeltas.includes(3),'a slow UI hook may miss a real tick without inventing reports');
    await api.observedProducer(stand,ledger,{ready:async actor=>{assert.equal(Number(store.db.prepare('SELECT floor_at FROM device_activity').get()!.floor_at),actor.floorAt);}});
    const beforePrivate=reports.length;await api.privateProducer(demo,stand,ledger);assert.equal(reports.length-beforePrivate,5);
    assert.deepEqual(reports.slice(beforePrivate).map(row=>row.privateCount),[1,1,1,1,0]);
    const frequency=deepSources[0];await owner.post(`/api/boards/${owner.personalBoard}/sources/${frequency}/frequency`,{intervalMs:120000});
    const result=await ledger.verify(frequency);assert.equal(result.status,'complete');assert.equal(result.quota.length,20);assert.equal(hookCount,20);
    assert.deepEqual(result.ordinaryOrdinalDeltas,[1,1,1]);
    const originalTick=ledger.ordinary[1].tick!;
    for(const tick of [undefined,{...originalTick,manual:true},{...originalTick,at:originalTick.at-1},{...originalTick,ordinal:ledger.ordinary[0].tick!.ordinal},{...originalTick,ordinal:1.5}]){
      ledger.ordinary[1].tick=tick;await assert.rejects(ledger.verify(frequency),/scheduled Demo report/);
    }
    ledger.ordinary[1].tick=originalTick;
    assert.equal(result.quota[19].pacedAt,result.quota[19].sent+3000,'the twentieth observation retains its final wait');
    assert.equal(JSON.stringify(safeEvidence(result)),JSON.stringify(result),'the actual conditioning receipt survives sanitization');
    const first=ledger.quota[0].used;ledger.quota.forEach(point=>{point.used+=1;});await assert.rejects(ledger.verify(frequency));ledger.quota.forEach(point=>{point.used-=1;});assert.ok(Math.abs(ledger.quota[0].used-first)<1e-9);
    const at=ledger.quota[0].pacedAt;ledger.quota[0].pacedAt=ledger.quota[0].sent;await assert.rejects(ledger.verify(frequency),/pacing/);ledger.quota[0].pacedAt=at;
    const binding=result.observed.binding!;const cursor=store.db.prepare('SELECT a.device_id,a.floor_at FROM device_activity a JOIN devices d ON d.id=a.device_id WHERE d.machine_id=?').get(binding.machineId)!;
    store.db.prepare('UPDATE device_activity SET floor_at=floor_at-1 WHERE device_id=?').run(String(cursor.device_id));await assert.rejects(ledger.verify(frequency));store.db.prepare('UPDATE device_activity SET floor_at=? WHERE device_id=?').run(Number(cursor.floor_at),String(cursor.device_id));
    store.db.prepare('UPDATE devices SET revoked_at=NULL WHERE id=?').run(String(cursor.device_id));await assert.rejects(ledger.verify(frequency),/cleanup/);store.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(now,String(cursor.device_id));
    const row=store.db.prepare("SELECT w.session_id,w.from_at,w.to_at FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id WHERE s.producer_id=?").get('d'.repeat(32))!;
    store.db.prepare('UPDATE agent_work SET to_at=to_at-1 WHERE session_id=? AND from_at=?').run(Number(row.session_id),Number(row.from_at));await assert.rejects(ledger.verify(frequency),/captured server cut/);store.db.prepare('UPDATE agent_work SET to_at=? WHERE session_id=? AND from_at=?').run(Number(row.to_at),Number(row.session_id),Number(row.from_at));
    const deep=deepSources[0],samples=store.db.prepare('SELECT * FROM samples WHERE source_id=?').all(deep);
    store.db.prepare('DELETE FROM samples WHERE source_id=?').run(deep);
    // Foreign deep rows must not replace an admitted series in the captured inventory.
    const foreign=store.source('claude','foreign-unheld-depth',now-75*DAY);store.record(foreign,{observedAt:now-75*DAY,plan:'fixture',staleAfterMs:DAY,resets:null,windows:[{id:'session',kind:'session',label:null,minutes:300,used:0,remaining:100,resetAt:null},{id:'weekly',kind:'weekly',label:null,minutes:10080,used:0,remaining:100,resetAt:null}]});
    assert.equal(samples.length,2);await assert.rejects(ledger.verify(frequency),/original history anchor/);
    const primary=new Error('controlled original observed checker failure'),beforeClose=closeAttempts;
    await assert.rejects(api.observedProducer(stand,undefined,{ready:async()=>{},before:async()=>{throw primary;}}),error=>error===primary);
    assert.equal(closeAttempts,beforeClose+1);assert.equal(Number(store.db.prepare("SELECT count(*) n FROM tokens WHERE name='Observed work benchmark' AND revoked_at IS NULL").get()!.n),0);
    failObservedClose=true;
    await assert.rejects(api.observedProducer(stand,undefined,{ready:async()=>{},before:async()=>{throw primary;}}),error=>error===primary);
    assert.equal(closeAttempts,beforeClose+2,'failed cleanup is attempted once and cannot replace the original checker');
    failObservedClose=false;
    const remaining=store.db.prepare("SELECT id FROM tokens WHERE name='Observed work benchmark' AND revoked_at IS NULL").all();
    for(const row of remaining)await fetch(owner.base+'/api/tokens/'+row.id,{method:'DELETE',headers:{cookie:owner.cookie,origin:owner.base}});

  }finally{ledger?.close();await app.close();store.close();rmSync(root,{recursive:true,force:true});}
  async function seedQuota(source:string,taken:ReturnType<typeof stillSnapshot>,at:number){store.record(source,{observedAt:at,plan:taken.plan??'',staleAfterMs:DAY,resets:null,windows:taken.windows.map(window=>({id:window.id,kind:window.kind,label:window.label,minutes:window.minutes,used:window.usedPercent,remaining:100-window.usedPercent,resetAt:window.resetsAt===null?null:Date.parse(window.resetsAt)}))});}
});

test('ordinary measurement hooks do not request receipt evidence without a conditioning ledger',async()=>{
  let now=100_000,reports=0;
  const demo={work(){},nextReport:async()=>{now+=15_000;reports++;return now;},reportReceipt(){throw new Error('unused ledger witness');}} as unknown as Parameters<typeof ordinaryProducer>[0];
  await producers(()=>now,ms=>{now+=ms;}).ordinaryProducer(demo);
  assert.equal(reports,4);
});


test('private producer clears its overlay and retains the original checker through a failed cleanup report',async()=>{
  for(const primaryFails of [false,true]){
    let now=Date.parse('2026-10-27T12:00:00Z'),calls=0,overlay:object[]=[];
    const api=producers(()=>now,ms=>{now+=ms;}),primary=new Error('private checker'),cleanup=new Error('private cleanup');
    const stand={agents:new Map([['laptop',{trackClients:(sessions:object[])=>{overlay=sessions;}}]])} as unknown as Stand;
    const demo={reportNow:async()=>{calls++;if(calls===(primaryFails?3:5))throw cleanup;return now;}} as unknown as Parameters<typeof privateProducer>[0];
    await assert.rejects(api.privateProducer(demo,stand,undefined,{after:async()=>{if(primaryFails)throw primary;}}),error=>error===(primaryFails?primary:cleanup));
    assert.equal(overlay.length,0);assert.equal(calls,primaryFails?3:5);
  }
});
