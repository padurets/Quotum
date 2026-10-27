import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest,type Credential} from '../ingest.js';
import {Cadence} from '../cadence.js';
import {Duty} from '../duty.js';
import {newSecret} from '../domain/auth.js';
import {parseCheckin} from '../domain/ingest.js';
const T=Date.parse('2026-10-26T12:00:00Z'),A='a'.repeat(24),B='b'.repeat(24),C='c'.repeat(24);
function fixture(t:TestContext){
  const folder=mkdtempSync(path.join(tmpdir(),'quotum-collections-')),store=new Store(path.join(folder,'db'),T);
  t.after(()=>{store.close();rmSync(folder,{recursive:true});});
  const directory=new Directory(store.db),duty=new Duty(),cadence=new Cadence(),ingest=new Ingest(store,directory,duty,cadence);
  const user=directory.createUser('fixture@example.test','Fixture','x',T),secret=newSecret('qt_m');directory.createToken(secret,'…',user.id,'test',T);
  const credential=ingest.authenticate(`Bearer ${secret}`) as Credential;
  const sender={version:1,agent:'quotum/fixture',machine:{id:'fixture-machine-01234567',name:'fixture',os:'linux',arch:'x86_64'}};
  const ask=(at:number,accounts:string[],roster?:string[])=>ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1,accountRosters:1,collectionCompletions:1},subscriptions:accounts.map(account=>({provider:'codex',account,active:false})),...(roster?{accountRosters:[{provider:'codex',accounts:roster.map(account=>({account}))}]}:{})},T+at);
  const device=()=>directory.deviceByMachine(user.id,sender.machine.id)!;
  const context=(account:string,commandId?:string)=>({version:1,authority:store.measurementPolicies.device(device().id).authority,collectorEpoch:0,target:{kind:'verified',accountKey:account},...(commandId?{commandId}:{})});
  const deliver=(at:number,account:string,commandId?:string)=>ingest.accept(credential,{...sender,sentAt:new Date(T+at).toISOString(),snapshots:[{provider:'codex',account,observedAt:new Date(T+at).toISOString(),via:'fixture',staleAfterMs:120000,windows:[{id:'session',kind:'session',usedPercent:50}],attemptContext:context(account,commandId)}]},T+at);
  const complete=(at:number,account:string,commandId?:string)=>ingest.accept(credential,{...sender,sentAt:new Date(T+at).toISOString(),completions:[{provider:'codex',outcome:'no_new_data',completedAt:new Date(T+at).toISOString(),attemptContext:context(account,commandId)}]},T+at);
  return {store,directory,duty,cadence,ingest,user,sender,ask,device,context,deliver,complete,credential};
}
test('explicit membership survives subsets, withdraws all missing accounts and rejects late association restoration',t=>{
  const f=fixture(t),answer=f.ask(0,[A,B],[A,B]);assert.deepEqual(answer.capabilities,{accountRosters:1,collectionCompletions:1});
  f.deliver(1000,A,answer.subscriptions[0].commandId);f.deliver(2000,B,answer.subscriptions[1].commandId);
  assert.equal(f.store.deviceSources(f.user.id).length,2);
  f.ask(3000,[B]);assert.equal(f.store.deviceSources(f.user.id).length,2);
  f.ask(4000,[B],[B]);assert.equal(f.store.deviceSources(f.user.id).length,1);
  f.deliver(5000,A,answer.subscriptions[0].commandId);assert.equal(f.store.deviceSources(f.user.id).length,1);assert.ok(f.store.findSource('codex',A));
  f.ask(6000,[],[]);assert.equal(f.store.deviceSources(f.user.id).length,0);
  assert.deepEqual([...f.store.accountRoster(f.device().id,'codex')!],[]);
});
test('account failures are independent and success clears only its own failure',t=>{
  const f=fixture(t);f.ask(0,[A,B],[A,B]);
  for(const [index,account] of [A,B].entries())f.ingest.accept(f.credential,{...f.sender,sentAt:new Date(T+1000+index).toISOString(),failures:[{provider:'codex',error:'timeout',observedAt:new Date(T+1000+index).toISOString(),attemptContext:f.context(account)}]},T+1000+index);
  assert.equal(f.store.deviceFailures(f.user.id).length,2);
  f.deliver(3000,A);assert.deepEqual(f.store.deviceFailures(f.user.id).map(f=>f.accountKey),[B]);
});
test('no-data completes its exact command and refresh once without changing resources or renewing duty',t=>{
  const f=fixture(t),first=f.ask(0,[A],[A]);f.deliver(1000,A,first.subscriptions[0].commandId);
  const source=f.store.findSource('codex',A)!,before=JSON.stringify(f.store.state(source));
  f.ingest.requestRefresh(source,T+61000);const next=f.ask(61000,[A]);assert.equal(next.subscriptions[0].measure,true);
  const until=f.duty.until(A),result=f.complete(62000,A,next.subscriptions[0].commandId);
  assert.equal(result.completions,1);assert.equal(f.ingest.refresh(source,T+62000).value.request?.status,'no_new_data');
  assert.equal(JSON.stringify(f.store.state(source)),before);assert.ok(f.duty.until(A)!<=until!);
  assert.equal(f.complete(63000,A,next.subscriptions[0].commandId).completions,0);
  assert.equal(f.ask(63000,[A]).subscriptions[0].measure,false);
  assert.equal(f.complete(64000,A,'00000000-0000-4000-8000-000000000000').completions,0);
});
test('rosters validate canonical identities and allow all 48 subscriptions',()=>{
  const sender={version:1,agent:'fixture',machine:{id:'test',name:'test',os:'linux',arch:'x'}};
  assert.throws(()=>parseCheckin({...sender,accountRosters:[{provider:'antigravity',accounts:[{}]}]}));
  assert.throws(()=>parseCheckin({...sender,accountRosters:[{provider:'codex'}]}));
  assert.throws(()=>parseCheckin({...sender,accountRosters:[{provider:'codex',accounts:[{account:A},{account:A}]}]}));
  assert.equal(parseCheckin({...sender,accountRosters:[{provider:'antigravity',accounts:[{accountName:null},{accountName:'default'}]}]}).accountRosters[0].accounts.length,2);
  assert.equal(parseCheckin({...sender,subscriptions:Array.from({length:48},()=>({provider:'codex',account:C}))}).subscriptions.length,48);
});

test('explicit roster deliveries never become inferred native session funding',t=>{
  const f=fixture(t),answer=f.ask(0,[A,B],[A,B]);f.deliver(1000,A,answer.subscriptions[0].commandId);f.deliver(2000,B,answer.subscriptions[1].commandId);
  f.ingest.sessions(f.credential,{...f.sender,sentAt:new Date(T+3000).toISOString(),sessions:[{provider:'codex',origin:'terminal',startedAt:new Date(T).toISOString(),working:true}]},T+3000);
  const sessions=f.ingest.live.deviceSessions(f.user.id,f.device().id,T+3000);
  assert.equal(sessions.length,1);assert.equal(sessions[0].source,null);
});

test('retained refresh completion cannot answer or move the new holder command',t=>{
  const f=fixture(t),first=f.ask(0,[A],[A]);f.deliver(1000,A,first.subscriptions[0].commandId);
  const source=f.store.findSource('codex',A)!;f.ingest.requestRefresh(source,T+61000);const original=f.ask(61000,[A]).subscriptions[0];
  f.cadence.retainDispatched(A,f.device().id);f.duty.release(A,f.device().id);f.cadence.released(A,f.device().id);
  const other={...f.sender,machine:{...f.sender.machine,id:'other-fixture-machine'}};
  const answer=f.ingest.checkin(f.credential,{...other,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account:A,active:true}]},T+62000).subscriptions[0];
  assert.equal(answer.measure,true);const second=f.directory.deviceByMachine(f.user.id,other.machine.id)!;
  const lease=f.duty.until(A);assert.ok(f.cadence.awaiting(A,second.id));
  const result=f.complete(63000,A,original.commandId);assert.equal(result.completions,1);
  assert.equal(f.ingest.refresh(source,T+63000).value.request?.status,'no_new_data');
  assert.equal(f.duty.until(A),lease);assert.ok(f.cadence.awaiting(A,second.id));
  assert.equal(f.complete(64000,A,original.commandId).completions,0);
});

test('completion retries and duplicates count one effective item',t=>{
  const f=fixture(t),answer=f.ask(0,[A],[A]);
  const item={provider:'codex',outcome:'no_new_data',completedAt:new Date(T+1000).toISOString(),attemptContext:f.context(A,answer.subscriptions[0].commandId)};
  const result=f.ingest.accept(f.credential,{...f.sender,sentAt:new Date(T+1000).toISOString(),completions:[item,item]},T+1000);
  assert.equal(result.completions,1);assert.equal(result.duplicates,1);assert.equal(f.complete(2000,A,answer.subscriptions[0].commandId).completions,0);
});

test('withdrawn verified failures cannot become unknown errors on a healthy sibling',t=>{
  const f=fixture(t),answer=f.ask(0,[A,B],[A,B]);f.deliver(1000,A,answer.subscriptions[0].commandId);f.deliver(2000,B,answer.subscriptions[1].commandId);
  const b=f.store.findSource('codex',B)!,before=JSON.stringify(f.store.state(b));f.ask(3000,[B],[B]);
  f.ingest.accept(f.credential,{...f.sender,sentAt:new Date(T+4000).toISOString(),failures:[{provider:'codex',error:'timeout',observedAt:new Date(T+4000).toISOString(),attemptContext:f.context(A,answer.subscriptions[0].commandId)}]},T+4000);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);assert.equal(JSON.stringify(f.store.state(b)),before);
});

test('a roster member keeps independent evidence when its observation arrives behind another account',t=>{
  const f=fixture(t);f.ask(0,[A,B],[A,B]);f.deliver(5000,A);f.deliver(3000,B);
  const keys=f.ingest.measurementSelection.candidateAccounts(f.device().id).map(account=>account.key);
  assert.ok(keys.includes(A));assert.ok(keys.includes(B));assert.equal(f.store.deviceSources(f.user.id).length,2);
});

test('revocation releases orphan holdings before removing every account association',t=>{
  const f=fixture(t),answer=f.ask(0,[A,B],[A,B]);f.deliver(1000,A,answer.subscriptions[0].commandId);f.deliver(2000,B,answer.subscriptions[1].commandId);
  f.directory.transaction(()=>{f.directory.revokeDevice(f.user.id,f.device().id,T+3000);f.store.releaseRevoked(f.user.id);});
  assert.equal(f.store.deviceSources(f.user.id).length,0);assert.equal(f.store.held(f.user.id).length,0);
});

test('no-data waiting never renews an expired starter and another healthy device can take duty',t=>{
  const f=fixture(t);
  const body={...f.sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account:A,active:false,minIntervalMs:600000}]};
  const first=f.ingest.checkin(f.credential,body,T).subscriptions[0];
  assert.equal(first.measure,true);assert.equal(f.duty.until(A),T+300000);
  assert.equal(f.complete(1000,A,first.commandId).completions,1);
  assert.equal(f.ingest.checkin(f.credential,body,T+301000).subscriptions[0].measure,false);
  assert.equal(f.duty.until(A),T+300000,'waiting A has no fresh starter lease');
  const other={...body,machine:{...f.sender.machine,id:'healthy-fixture-machine'}};
  const takeover=f.ingest.checkin(f.credential,other,T+302000).subscriptions[0];
  assert.equal(takeover.measure,true);
  assert.equal(f.duty.holder(A),f.directory.deviceByMachine(f.user.id,other.machine.id)!.id);
  assert.equal(f.duty.until(A),T+602000,'only an actual command protects B');
});

test('withdrawn provenance releases every orphan holding, including a first late observation',t=>{
  for(const firstLate of [false,true]){
    const f=fixture(t),answer=f.ask(0,[A,B],[A,B]);
    if(!firstLate)f.deliver(1000,A,answer.subscriptions[0].commandId);
    f.deliver(2000,B,answer.subscriptions[1].commandId);f.ask(3000,[B],[B]);
    f.ingest.accept(f.credential,{...f.sender,sentAt:new Date(T+3500).toISOString(),failures:[{provider:'codex',error:'timeout',observedAt:new Date(T+3500).toISOString(),attemptContext:f.context(B)}]},T+3500);
    const beforeB=f.store.deviceFailures(f.user.id);
    f.deliver(4000,A,answer.subscriptions[0].commandId);
    const source=f.store.findSource('codex',A)!;
    assert.ok(f.store.holds(f.user.id,source));
    assert.ok(f.store.db.prepare('SELECT 1 FROM device_sources WHERE device_id=? AND source_id=?').get(f.device().id,source));
    assert.deepEqual(f.store.deviceSources(f.user.id).map(row=>row.source),[f.store.findSource('codex',B)]);
    assert.equal(f.store.deviceSource(f.device().id,'codex'),f.store.findSource('codex',B));
    assert.ok(!f.ingest.measurementSelection.candidateAccounts(f.device().id).some(account=>account.key===A));
    assert.deepEqual(f.store.deviceFailures(f.user.id),beforeB,'late A does not clear B diagnostics');
    const history=JSON.stringify(f.store.state(source));
    f.directory.transaction(()=>{f.directory.revokeDevice(f.user.id,f.device().id,T+5000);f.store.releaseRevoked(f.user.id);});
    assert.equal(f.store.held(f.user.id).length,0);
    assert.equal(JSON.stringify(f.store.state(source)),history,'revocation preserves source evidence');
  }
});

test('persisted membership changes invalidate owner connections after restart and identical groups are no-ops',t=>{
  const f=fixture(t),answer=f.ask(0,[A,B],[A,B]);f.deliver(1000,A,answer.subscriptions[0].commandId);f.deliver(2000,B,answer.subscriptions[1].commandId);
  const filename=f.store.db.prepare('PRAGMA database_list').get()!.file as string;
  const store=new Store(filename,T+3000);t.after(()=>store.close());
  const directory=new Directory(store.db),ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const touched:string[]=[];
  store.setObserver({touchUser:user=>touched.push(user),touchSources(){},touchBoards(){},touchHub(){},history(){},dropSessions(){},dropMember(){},dropBoard(){}});
  const before=directory.connectionsRevision(f.user.id);
  const body={...f.sender,capabilities:{measurementPolicy:1,attemptContext:1,accountRosters:1},accountRosters:[{provider:'codex',accounts:[]}]};
  ingest.checkin(f.credential,body,T+3000);
  assert.equal(store.deviceSources(f.user.id).length,0);assert.ok(directory.connectionsRevision(f.user.id)>before);
  assert.ok(touched.includes(f.user.id));const revision=directory.connectionsRevision(f.user.id);touched.length=0;
  ingest.checkin(f.credential,body,T+4000);
  assert.equal(directory.connectionsRevision(f.user.id),revision);assert.deepEqual(touched,[]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM device_sources WHERE device_id=?').get(f.device().id)!.n,2,'raw provenance remains');
});

test('native current-source inference uses only its latest association while retaining older provenance',t=>{
  const f=fixture(t);f.ask(0,[A]);f.deliver(1000,A);f.ask(2000,[B]);f.deliver(3000,B);
  assert.deepEqual(f.store.deviceSources(f.user.id).map(row=>row.source),[f.store.findSource('codex',B)]);
  assert.equal(f.store.deviceSource(f.device().id,'codex'),f.store.findSource('codex',B));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM device_sources WHERE device_id=?').get(f.device().id)!.n,2);
  f.directory.transaction(()=>{f.directory.revokeDevice(f.user.id,f.device().id,T+4000);f.store.releaseRevoked(f.user.id);});
  assert.equal(f.store.held(f.user.id).length,0);
});

test('native account recency follows skew-adjusted observation time within one received batch',t=>{
  const f=fixture(t),received=T+3600000;
  const snapshots=[A,B].map((account,index)=>({provider:'codex',account,observedAt:new Date(T-100+index*50).toISOString(),via:'fixture',staleAfterMs:120000,windows:[{id:'session',kind:'session',usedPercent:5}]}));
  f.ingest.accept(f.credential,{...f.sender,sentAt:new Date(T).toISOString(),snapshots},received);
  const source=f.store.findSource('codex',B)!;
  assert.equal(f.store.deviceSource(f.device().id,'codex'),source);
  assert.deepEqual(f.store.deviceSources(f.user.id).map(row=>[row.source,row.seenAt]),[[source,received-50]]);
  assert.equal(f.directory.deviceById(f.device().id)!.lastSeenAt,received,'contact remains receipt time');
});

test('late older native login observations preserve history without replacing newer identity or clearing its failure',t=>{
  const f=fixture(t);f.ask(0,[A]);f.deliver(1000,A);f.ask(2000,[B]);f.deliver(3000,B);
  f.store.deviceFailed(f.device().id,'codex','timeout',null,T+3500);
  f.ingest.accept(f.credential,{...f.sender,sentAt:new Date(T+4000).toISOString(),snapshots:[{provider:'codex',account:A,observedAt:new Date(T+2000).toISOString(),via:'fixture',staleAfterMs:120000,windows:[{id:'session',kind:'session',usedPercent:10}]}]},T+4000);
  assert.equal(f.store.deviceSource(f.device().id,'codex'),f.store.findSource('codex',B));
  assert.equal(f.store.deviceFailures(f.user.id).length,1,'historical A cannot clear an unknown current failure');
  assert.equal(f.store.state(f.store.findSource('codex',A)!).successAt,T+2000);
});

test('equal native account observations leave current identity unknown while explicit membership stays authoritative',t=>{
  const f=fixture(t);f.ask(0,[A]);f.deliver(1000,A);f.deliver(1000,B);
  assert.equal(f.store.deviceSource(f.device().id,'codex'),null);assert.deepEqual(f.store.deviceSources(f.user.id),[]);
  f.ingest.sessions(f.credential,{...f.sender,sentAt:new Date(T+2000).toISOString(),sessions:[{provider:'codex',origin:'terminal',startedAt:new Date(T).toISOString(),working:true}]},T+2000);
  assert.equal(f.ingest.live.deviceSessions(f.user.id,f.device().id,T+2000)[0].source,null);
  f.ask(3000,[],[A,B]);
  assert.equal(f.store.deviceSources(f.user.id).length,2,'explicit membership admits both equal-time observations');
  f.ask(4000,[],[B]);
  assert.deepEqual(f.store.deviceSources(f.user.id).map(row=>row.source),[f.store.findSource('codex',B)]);
  f.deliver(5000,A);
  assert.deepEqual(f.store.deviceSources(f.user.id).map(row=>row.source),[f.store.findSource('codex',B)],'even newer withdrawn provenance cannot restore membership');
});

test('steady provenance updates use indexed reads of their device account group',t=>{
  for(const explicit of [false,true]){
    const f=fixture(t);f.ask(0,[A,B],explicit?[A,B]:undefined);f.deliver(1000,A);f.deliver(2000,B);
    for(let n=0;n<50;n++){
      const device=f.directory.saveDevice({userId:f.user.id,machine:{...f.sender.machine,id:`other-fixture-${n}`},agent:'fixture',tokenId:null},T);
      for(const account of [A,B])f.store.db.prepare('INSERT INTO device_sources VALUES (?,?,?,?)').run(device.id,'codex',f.store.findSource('codex',account),T);
    }
    const prepare=f.store.db.prepare.bind(f.store.db),plans=new Map<string,string[]>();
    f.store.db.prepare=((sql:string)=>{
      const statement=prepare(sql);
      if(/^\s*SELECT\b/i.test(sql)&&/\bFROM device_sources\b/.test(sql))for(const method of ['get','all'] as const){
        const original=statement[method].bind(statement);
        Object.defineProperty(statement,method,{value:(...args:any[])=>{
          if(!plans.has(sql))plans.set(sql,prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>String(row.detail)));
          return (original as (...args:any[])=>unknown)(...args);
        }});
      }
      return statement;
    }) as typeof f.store.db.prepare;
    f.deliver(3000,B);
    f.store.db.prepare=prepare;
    assert.ok(plans.size);
    for(const [sql,details] of plans)assert.ok(details.every(detail=>!/\bSCAN (ds|device_sources)\b/.test(detail)),JSON.stringify({sql,details}));
  }
});

function diagnosticSnapshot(f:ReturnType<typeof fixture>,account:string,at:number){
  return {provider:'codex',account,observedAt:new Date(T+at).toISOString(),via:'fixture',staleAfterMs:120000,windows:[{id:'session',kind:'session',usedPercent:50}],attemptContext:f.context(account)};
}
function diagnosticFailure(f:ReturnType<typeof fixture>,account:string|null,at:number){
  return {provider:'codex',error:'timeout',observedAt:new Date(T+at).toISOString(),attemptContext:account?f.context(account):{...f.context(A),target:{kind:'unknown'}}};
}
function diagnosticBatch(f:ReturnType<typeof fixture>,received:number,snapshots:object[]=[],failures:object[]=[],sender=f.sender,sent=received){
  return f.ingest.accept(f.credential,{...sender,sentAt:new Date(T+sent).toISOString(),snapshots,failures},T+received);
}

test('newer private failures survive delayed observations and duplicate replays until an equal or newer success',t=>{
  const f=fixture(t);f.ask(0,[A],[A]);f.deliver(1000,A);
  diagnosticBatch(f,63000,[],[diagnosticFailure(f,A,63000)]);
  diagnosticBatch(f,64000,[diagnosticSnapshot(f,A,62000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id).map(row=>[row.accountKey,row.at]),[[A,T+63000]]);
  const replay=diagnosticBatch(f,65000,[diagnosticSnapshot(f,A,1000)]);
  assert.equal(replay.accepted,0);assert.equal(replay.duplicates,1);
  assert.equal(f.store.deviceFailures(f.user.id)[0].at,T+63000,'replayed success cannot erase a later error');
  diagnosticBatch(f,66000,[diagnosticSnapshot(f,A,63000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[],'equal-time success wins');
  diagnosticBatch(f,67000,[],[diagnosticFailure(f,A,63000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[],'a replayed equal-time failure cannot return');
});

test('private failures compare to their own device and account rather than another producer success',t=>{
  const f=fixture(t);f.ask(0,[A,B],[A,B]);f.deliver(63000,A);
  diagnosticBatch(f,64000,[],[diagnosticFailure(f,A,62000),diagnosticFailure(f,B,62000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id).map(row=>row.accountKey),[B]);
  const other={...f.sender,machine:{...f.sender.machine,id:'other-diagnostic-fixture'}};
  f.ingest.checkin(f.credential,{...other,paced:true,capabilities:{measurementPolicy:1,attemptContext:1,accountRosters:1},subscriptions:[{provider:'codex',account:A,active:false}],accountRosters:[{provider:'codex',accounts:[{account:A}]}]},T+65000);
  const second=f.directory.deviceByMachine(f.user.id,other.machine.id)!;
  diagnosticBatch(f,70000,[diagnosticSnapshot(f,A,70000)],[],other);
  diagnosticBatch(f,71000,[],[diagnosticFailure(f,A,64000)]);
  assert.ok(f.store.deviceFailures(f.user.id).some(row=>row.device===f.device().id&&row.accountKey===A),'another device success is no recovery evidence');
  diagnosticBatch(f,72000,[],[diagnosticFailure(f,A,69000)],other);
  assert.ok(!f.store.deviceFailures(f.user.id).some(row=>row.device===second.id),'own newer success suppresses delayed failure');
  diagnosticBatch(f,73000,[],[diagnosticFailure(f,A,72000)],other);
  const hints:string[]=[];f.directory.setObserver({touchDevices:owner=>hints.push(owner),touchSources(){},touchBoards(){},touchUser(){},touchHub(){},history(){},dropSessions(){},dropMember(){},dropBoard(){}});
  const duplicate=diagnosticBatch(f,74000,[diagnosticSnapshot(f,A,65000)]);
  assert.deepEqual(hints,[f.user.id],'actual private recovery emits an owner hint even without a new shared observation');
  assert.equal(duplicate.accepted,0,'the shared source already has a newer observation from the other device');
  const failures=f.store.deviceFailures(f.user.id);
  assert.ok(!failures.some(row=>row.device===f.device().id&&row.accountKey===A),'own success still recovers private status even when globally duplicated');
  assert.ok(failures.some(row=>row.device===f.device().id&&row.accountKey===B));
  assert.ok(failures.some(row=>row.device===second.id&&row.accountKey===A&&row.at===T+72000));
  hints.length=0;
  diagnosticBatch(f,75000,[diagnosticSnapshot(f,A,65000)]);
  diagnosticBatch(f,76000,[diagnosticSnapshot(f,A,1000)]);
  diagnosticBatch(f,77000,[],[diagnosticFailure(f,A,64000)]);
  assert.deepEqual(hints,[],'replayed/stale outcomes without a private mutation emit no recovery hints');
});

test('one backlog batch respects event time and success wins true timestamp ties',t=>{
  const f=fixture(t);f.ask(0,[A],[A]);f.deliver(1000,A);
  const batch=diagnosticBatch(f,65000,[diagnosticSnapshot(f,A,63000),diagnosticSnapshot(f,A,1000)],[diagnosticFailure(f,A,63000),diagnosticFailure(f,A,64000),diagnosticFailure(f,A,62000)]);
  assert.equal(batch.accepted,1);assert.equal(batch.duplicates,1);
  assert.equal(f.store.deviceFailures(f.user.id)[0].at,T+64000);
  diagnosticBatch(f,66000,[diagnosticSnapshot(f,A,65000)],[diagnosticFailure(f,A,65000),diagnosticFailure(f,A,64000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
});

test('private success and failure guards compare the same skew-adjusted observation clock',t=>{
  const f=fixture(t),skew=3600000;f.ask(0,[A],[A]);f.deliver(63000,A);
  diagnosticBatch(f,64000,[],[diagnosticFailure(f,A,64000-skew)],f.sender,64000-skew);
  assert.equal(f.store.deviceFailures(f.user.id)[0].at,T+64000);
  diagnosticBatch(f,65000,[diagnosticSnapshot(f,A,63000-skew)],[],f.sender,65000-skew);
  assert.equal(f.store.deviceFailures(f.user.id)[0].at,T+64000);
  diagnosticBatch(f,66000,[diagnosticSnapshot(f,A,64000-skew)],[],f.sender,66000-skew);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  diagnosticBatch(f,67000,[],[diagnosticFailure(f,A,64000-skew)],f.sender,67000-skew);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
});

test('unknown private failures use only current eligible recovery evidence without inheriting an account',t=>{
  const f=fixture(t);f.ask(0,[A],[A]);f.deliver(10000,A);f.ask(11000,[],[B]);
  diagnosticBatch(f,12000,[],[diagnosticFailure(f,null,9000)]);
  assert.equal(f.store.deviceFailures(f.user.id).length,1,'withdrawn historical A cannot suppress an unknown failure');
  assert.equal(f.store.deviceFailures(f.user.id)[0].accountKey,undefined);
  diagnosticBatch(f,13000,[diagnosticSnapshot(f,A,13000)]);
  assert.equal(f.store.deviceFailures(f.user.id).length,1,'new withdrawn provenance is still no recovery evidence');
  diagnosticBatch(f,14000,[diagnosticSnapshot(f,B,14000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  diagnosticBatch(f,15000,[],[diagnosticFailure(f,null,13000),diagnosticFailure(f,null,14000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  diagnosticBatch(f,16000,[],[diagnosticFailure(f,null,15000)]);
  assert.equal(f.store.deviceFailures(f.user.id)[0].accountKey,undefined);
});

test('ambiguous native current identity is no recovery evidence for an unknown failure',t=>{
  const f=fixture(t);f.ask(0,[A]);f.deliver(10000,A);f.deliver(10000,B);
  diagnosticBatch(f,12000,[],[diagnosticFailure(f,null,9000)]);
  assert.equal(f.store.deviceFailures(f.user.id).length,1);
  assert.equal(f.store.deviceFailures(f.user.id)[0].accountKey,undefined);
  diagnosticBatch(f,13000,[diagnosticSnapshot(f,B,11000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  diagnosticBatch(f,14000,[],[diagnosticFailure(f,null,11000)]);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[],'equal-time current native success wins');
});

test('unknown recovery uses the final eligible group of one atomic snapshot batch',t=>{
  for(const accounts of [[A,B],[B,A]])for(const recovery of ['unique','roster']){
    const f=fixture(t);f.ask(0,[A,B]);
    diagnosticBatch(f,9000,[],[diagnosticFailure(f,null,9000)]);
    const hints:string[]=[];f.directory.setObserver({touchDevices:owner=>hints.push(owner),touchSources(){},touchBoards(){},touchUser(){},touchHub(){},history(){},dropSessions(){},dropMember(){},dropBoard(){}});
    const snapshots=accounts.map(account=>diagnosticSnapshot(f,account,10000));
    const accepted=diagnosticBatch(f,12000,snapshots);
    assert.equal(accepted.accepted,2);assert.equal(f.store.deviceSource(f.device().id,'codex'),null);
    assert.deepEqual(f.store.deviceFailures(f.user.id).map(row=>[row.accountKey,row.at]),[[undefined,T+9000]],'an intermediate unique prefix is not committed recovery evidence');
    assert.deepEqual(hints,[f.user.id,f.user.id],'new shared observations still notify their owners');hints.length=0;
    const replay=diagnosticBatch(f,13000,snapshots);
    assert.equal(replay.duplicates,2);assert.equal(f.store.deviceFailures(f.user.id).length,1);assert.deepEqual(hints,[]);
    if(recovery==='roster'){
      f.ask(14000,[],[A,B]);hints.length=0;
      const duplicate=diagnosticBatch(f,15000,snapshots);
      assert.equal(duplicate.accepted,0);assert.equal(duplicate.duplicates,2,'an actual own sample can recover even when globally duplicated');
    }else diagnosticBatch(f,15000,[diagnosticSnapshot(f,B,11000)]);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
    assert.equal(hints.length,recovery==='roster'?1:2,'private recovery notifies the owner, also when the shared observations are duplicates');
    assert.ok(hints.every(owner=>owner===f.user.id));
    hints.length=0;diagnosticBatch(f,16000,snapshots);
    assert.deepEqual(hints,[],'no-op replay emits no recovery hint');
  }
});

test('atomic unknown recovery keeps event-time guards under skew',t=>{
  for(const accounts of [[A,B],[B,A]])for(const skew of [0,3600000]){
    const f=fixture(t);f.ask(0,[A,B]);
    diagnosticBatch(f,9000,[],[diagnosticFailure(f,null,9000-skew)],f.sender,9000-skew);
    diagnosticBatch(f,12000,accounts.map(account=>diagnosticSnapshot(f,account,10000-skew)),[diagnosticFailure(f,null,9000-skew)],f.sender,12000-skew);
    assert.deepEqual(f.store.deviceFailures(f.user.id).map(row=>[row.accountKey,row.at]),[[undefined,T+9000]]);
    diagnosticBatch(f,13000,[diagnosticSnapshot(f,B,11000-skew)],[],f.sender,13000-skew);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
    diagnosticBatch(f,14000,[],[diagnosticFailure(f,null,12000-skew)],f.sender,14000-skew);
    diagnosticBatch(f,15000,[diagnosticSnapshot(f,B,11000-skew)],[],f.sender,15000-skew);
    assert.equal(f.store.deviceFailures(f.user.id)[0].at,T+12000,'a stale replay cannot borrow the retained observation timestamp');
    diagnosticBatch(f,16000,[diagnosticSnapshot(f,B,12000-skew)],[diagnosticFailure(f,null,12000-skew)],f.sender,16000-skew);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[],'equal-time current success also wins for unknown scope');
  }
});

test('a committed unique success can recover an unknown diagnostic before a later ambiguity',t=>{
  for(const accounts of [[A,B],[B,A]]){
    const f=fixture(t);f.ask(0,accounts);diagnosticBatch(f,9000,[],[diagnosticFailure(f,null,9000)]);
    diagnosticBatch(f,11000,[diagnosticSnapshot(f,accounts[0],10000)]);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[],'this committed packet has a unique eligible success');
    diagnosticBatch(f,12000,[diagnosticSnapshot(f,accounts[1],10000)]);
    assert.equal(f.store.deviceSource(f.device().id,'codex'),null);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[],'later ambiguity does not resurrect a closed diagnostic');
    f.ask(13000,[],[]);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[],'membership changes do not resurrect a closed diagnostic');
  }
});

test('atomic batches preserve event-time guarded account-scoped recovery',t=>{
  for(const accounts of [[A,B],[B,A]])for(const explicit of [false,true]){
    const f=fixture(t);f.ask(0,[A,B],explicit?[A,B]:undefined);
    diagnosticBatch(f,12000,[],[diagnosticFailure(f,A,9000),diagnosticFailure(f,B,11000)]);
    diagnosticBatch(f,13000,accounts.map(account=>diagnosticSnapshot(f,account,10000)));
    assert.deepEqual(f.store.deviceFailures(f.user.id).map(row=>[row.accountKey,row.at]),[[B,T+11000]]);
    diagnosticBatch(f,14000,[diagnosticSnapshot(f,B,11000)]);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  }
});

test('known native diagnostics follow their own account observations before, after and within a tied batch',t=>{
  for(const accounts of [[A,B],[B,A]])for(const failureAt of ['before','after','same']){
    const f=fixture(t);f.ask(0,[A,B]);
    const failure=diagnosticFailure(f,A,9000),snapshots=accounts.map(account=>diagnosticSnapshot(f,account,10000));
    if(failureAt==='before')diagnosticBatch(f,11000,[],[failure]);
    const batch=diagnosticBatch(f,12000,snapshots,failureAt==='same'?[failure]:[]);
    if(failureAt==='after')diagnosticBatch(f,13000,[],[failure]);
    assert.equal(batch.accepted,2);assert.equal(f.store.deviceSource(f.device().id,'codex'),null);
    assert.deepEqual(f.store.deviceFailures(f.user.id),[],`${failureAt}: known A recovers independently of native identity inference`);
    const replay=diagnosticBatch(f,14000,snapshots,[failure]);
    assert.equal(replay.duplicates,2);assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  }
});

test('a noncurrent native account recovers from its own duplicate sample without touching other diagnostics',t=>{
  const f=fixture(t);f.ask(0,[A,B]);f.deliver(20000,B);
  diagnosticBatch(f,22000,[],[diagnosticFailure(f,A,9000),diagnosticFailure(f,B,21000),diagnosticFailure(f,null,21000)]);
  const other={...f.sender,machine:{...f.sender.machine,id:'other-native-diagnostic-fixture'}};
  f.ingest.checkin(f.credential,{...other,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account:A,active:false}]},T+23000);
  diagnosticBatch(f,30000,[diagnosticSnapshot(f,A,30000)],[],other);
  diagnosticBatch(f,32000,[],[diagnosticFailure(f,A,31000)],other);
  const second=f.directory.deviceByMachine(f.user.id,other.machine.id)!,source=f.store.findSource('codex',A)!;
  const shared=JSON.stringify(f.store.state(source));
  const hints:string[]=[];f.directory.setObserver({touchDevices:owner=>hints.push(owner),touchSources(){},touchBoards(){},touchUser(){},touchHub(){},history(){},dropSessions(){},dropMember(){},dropBoard(){}});
  const duplicate=diagnosticBatch(f,33000,[diagnosticSnapshot(f,A,10000)]);
  assert.equal(duplicate.accepted,0);assert.equal(duplicate.duplicates,1);assert.deepEqual(hints,[f.user.id]);
  assert.equal(f.store.deviceSource(f.device().id,'codex'),f.store.findSource('codex',B),'the newer native login stays current');
  const remaining=f.store.deviceFailures(f.user.id);
  assert.equal(remaining.length,3);assert.ok(!remaining.some(row=>row.device===f.device().id&&row.accountKey===A));
  assert.ok(remaining.some(row=>row.device===f.device().id&&row.accountKey===B&&row.at===T+21000));
  assert.ok(remaining.some(row=>row.device===f.device().id&&!row.accountKey&&row.at===T+21000));
  assert.ok(remaining.some(row=>row.device===second.id&&row.accountKey===A&&row.at===T+31000));
  hints.length=0;diagnosticBatch(f,34000,[diagnosticSnapshot(f,A,10000)]);
  assert.deepEqual(hints,[],'replayed recovery is a no-op');
  diagnosticBatch(f,35000,[],[diagnosticFailure(f,A,12000)]);
  assert.deepEqual(hints,[f.user.id],'a genuinely newer own failure is still admitted');
  hints.length=0;diagnosticBatch(f,36000,[diagnosticSnapshot(f,A,11000)]);
  assert.ok(f.store.deviceFailures(f.user.id).some(row=>row.device===f.device().id&&row.accountKey===A&&row.at===T+12000));
  assert.deepEqual(hints,[],'stale own success cannot clear a newer error or emit a recovery hint');
  diagnosticBatch(f,37000,[diagnosticSnapshot(f,A,12000)]);
  assert.deepEqual(hints,[f.user.id],'equal-time own success recovers the known key');
  hints.length=0;diagnosticBatch(f,38000,[],[diagnosticFailure(f,A,12000),diagnosticFailure(f,A,11000)]);
  assert.deepEqual(hints,[]);assert.equal(f.store.deviceFailures(f.user.id).length,3);
  assert.equal(JSON.stringify(f.store.state(source)),shared,'private recovery does not replace newer shared observations');
});

test('known recovery still requires explicit membership and policy admission',t=>{
  const f=fixture(t);f.ask(0,[A,B],[A,B]);diagnosticBatch(f,9000,[],[diagnosticFailure(f,A,9000)]);
  f.ask(10000,[B],[B]);diagnosticBatch(f,12000,[diagnosticSnapshot(f,A,11000)]);
  const before=f.store.deviceFailures(f.user.id);assert.deepEqual(before.map(row=>[row.accountKey,row.at]),[[A,T+9000]]);
  const hints:string[]=[];f.directory.setObserver({touchDevices:owner=>hints.push(owner),touchSources(){},touchBoards(){},touchUser(){},touchHub(){},history(){},dropSessions(){},dropMember(){},dropBoard(){}});
  const suppressed=diagnosticBatch(f,13000,[{...diagnosticSnapshot(f,A,13000),attemptContext:{...f.context(A),collectorEpoch:1}}]);
  assert.equal(suppressed.policySuppressed,1);
  const withdrawn=diagnosticBatch(f,14000,[],[diagnosticFailure(f,A,14000)]);
  assert.equal(withdrawn.duplicates,1);assert.deepEqual(f.store.deviceFailures(f.user.id),before);assert.deepEqual(hints,[]);
  f.ask(15000,[A,B],[A,B]);assert.deepEqual(f.store.deviceFailures(f.user.id),before);
  hints.length=0;const replay=diagnosticBatch(f,16000,[diagnosticSnapshot(f,A,11000)]);
  assert.equal(replay.accepted,0);assert.equal(replay.duplicates,1);
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);assert.deepEqual(hints,[f.user.id]);
});

test('policy-suppressed snapshots neither recover unknown errors nor create an ambiguous group',t=>{
  for(const accounts of [[A,B],[B,A]]){
    const f=fixture(t);f.ask(0,[A,B]);diagnosticBatch(f,9000,[],[diagnosticFailure(f,null,9000)]);
    const hints:string[]=[];f.directory.setObserver({touchDevices:owner=>hints.push(owner),touchSources(){},touchBoards(){},touchUser(){},touchHub(){},history(){},dropSessions(){},dropMember(){},dropBoard(){}});
    const suppressed=(account:string)=>({...diagnosticSnapshot(f,account,10000),attemptContext:{...f.context(account),collectorEpoch:1}});
    const refused=diagnosticBatch(f,11000,accounts.map(suppressed));
    assert.equal(refused.policySuppressed,2);assert.equal(f.store.deviceFailures(f.user.id).length,1);assert.deepEqual(hints,[]);
    assert.deepEqual(f.store.deviceSources(f.user.id),[]);
    const mixed=diagnosticBatch(f,12000,accounts.map(account=>account===A?suppressed(account):diagnosticSnapshot(f,account,10000)));
    assert.equal(mixed.policySuppressed,1);assert.equal(mixed.accepted,1);
    assert.equal(f.store.findSource('codex',A),null,'a suppressed tie contributes no provenance');
    assert.equal(f.store.deviceSource(f.device().id,'codex'),f.store.findSource('codex',B));
    assert.deepEqual(f.store.deviceFailures(f.user.id),[]);assert.deepEqual(hints,[f.user.id,f.user.id]);
  }
});

test('private diagnostic chronology reads stay indexed within the target device and provider',t=>{
  const f=fixture(t);f.ask(0,[A,B],[A,B]);f.deliver(1000,A);f.deliver(2000,B);
  for(let n=0;n<50;n++){
    const device=f.directory.saveDevice({userId:f.user.id,machine:{...f.sender.machine,id:`other-diagnostic-${n}`},agent:'fixture',tokenId:null},T);
    for(const account of [A,B])f.store.db.prepare('INSERT INTO device_sources VALUES (?,?,?,?)').run(device.id,'codex',f.store.findSource('codex',account),T+100000);
  }
  const prepare=f.store.db.prepare.bind(f.store.db),plans=new Map<string,string[]>();
  f.store.db.prepare=((sql:string)=>{
    const statement=prepare(sql);
    if(/^\s*SELECT\b/i.test(sql)&&/\bdevice_sources\b/.test(sql))for(const method of ['get','all'] as const){
      const original=statement[method].bind(statement);
      Object.defineProperty(statement,method,{value:(...args:any[])=>{
        if(!plans.has(sql))plans.set(sql,prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>String(row.detail)));
        return (original as (...args:any[])=>unknown)(...args);
      }});
    }
    return statement;
  }) as typeof f.store.db.prepare;
  diagnosticBatch(f,3000,[],[diagnosticFailure(f,A,3000),diagnosticFailure(f,null,3000)]);
  assert.deepEqual(new Set(f.store.deviceFailures(f.user.id).map(row=>row.accountKey??'')),new Set([A,'']));
  diagnosticBatch(f,5000,[diagnosticSnapshot(f,A,4000),diagnosticSnapshot(f,B,4000)]);
  f.store.db.prepare=prepare;
  assert.deepEqual(f.store.deviceFailures(f.user.id),[]);
  assert.ok(plans.size>=2);
  for(const [sql,details] of plans)assert.ok(details.every(detail=>!/\bSCAN (ds|device_sources)\b/.test(detail)),JSON.stringify({sql,details}));
});

test('healthy batches check unknown diagnostics once per provider without reading the provenance projection',t=>{
  const f=fixture(t);f.ask(0,[A,B]);
  const accounts=Array.from({length:16},(_,n)=>n.toString(16).padStart(24,'0'));
  diagnosticBatch(f,1000,accounts.map(account=>diagnosticSnapshot(f,account,1000)));
  const prepare=f.store.db.prepare.bind(f.store.db),reads:string[]=[],plans:string[][]=[],recoveries:{changes:number|bigint;details:string[]}[]=[];
  f.store.db.prepare=((sql:string)=>{
    const statement=prepare(sql);
    if(/^\s*SELECT\b/i.test(sql))for(const method of ['get','all'] as const){
      const original=statement[method].bind(statement);
      Object.defineProperty(statement,method,{value:(...args:any[])=>{
        reads.push(sql);
        if(/FROM device_failures/.test(sql))plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>String(row.detail)));
        return (original as (...args:any[])=>unknown)(...args);
      }});
    }
    if(/^DELETE FROM device_failures/.test(sql)){
      const run=statement.run.bind(statement);
      Object.defineProperty(statement,'run',{value:(...args:any[])=>{
        const result=run(...args);
        recoveries.push({changes:result.changes,details:prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>String(row.detail))});
        return result;
      }});
    }
    return statement;
  }) as typeof f.store.db.prepare;
  diagnosticBatch(f,2000,accounts.map(account=>diagnosticSnapshot(f,account,2000)));
  f.store.db.prepare=prepare;
  assert.equal(reads.filter(sql=>/FROM device_failures.*account_key=''/.test(sql)).length,1,'one indexed absence check for the whole provider group');
  assert.ok(!reads.some(sql=>/SELECT ds.device_id,ds.provider,ds.source_id,ds.seen_at,s.account,r.accounts/.test(sql)),'a healthy group never loads the full provenance projection');
  assert.ok(plans.length);assert.ok(plans.every(details=>details.every(detail=>!/\bSCAN\b/.test(detail))),JSON.stringify(plans));
  assert.ok(recoveries.length>0&&recoveries.length<=accounts.length,'known recovery does at most one point DELETE per admitted account');
  assert.ok(recoveries.every(({changes,details})=>Number(changes)===0&&details.every(detail=>!/\bSCAN\b/.test(detail))),JSON.stringify(recoveries));
});
