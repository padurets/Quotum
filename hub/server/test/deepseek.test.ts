import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deepSeek,deepSeekMeasurement} from '../connectors/deepseek.js';
import type {Connector,ConnectorAnswer} from '../connectors/registry.js';
import {ConnectorStatus,ConnectorTransport} from '../connectors/transport.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Credentials} from '../secrets/credentials.js';
import {SecretKey} from '../secrets/crypto.js';
import {startSecrets} from '../secrets/start.js';
import {composeMeters} from '../domain/meterHistory.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {measurementFingerprint} from '../hubSources.js';
import {HistoryTiles} from '../history.js';

const tuple=(currency='CNY',total='110.00',granted='10.00',topup='100.00')=>({currency,total_balance:total,granted_balance:granted,topped_up_balance:topup});
const payload=(rows:unknown[]=[tuple()],available=true)=>({is_available:available,balance_infos:rows});
const key=(n:number)=>SecretKey.parse(Buffer.from(Buffer.alloc(32,n).toString('base64url')));
const inputs=(current:SecretKey,reset:null|{from:string;to:string}=null)=>({current,previous:null,reset,storageAtStart:null,wasFileAtStart:false});

test('DeepSeek allowlists exact atomic currency groups, truthful zero, empty and partial outcomes',()=>{
  const one=deepSeekMeasurement(payload(),1);
  assert.deepEqual(one.meters.map(m=>[m.id,m.amount]),[['balance:CNY','110000000'],['granted:CNY','10000000'],['topped_up:CNY','100000000']]);
  assert.equal(deepSeekMeasurement(payload([tuple('CNY','0','0','0')],false),2).balanceStatus?.isAvailable,false);
  for(const rows of [[tuple(),tuple('USD')],[tuple('USD'),tuple()]])assert.equal(deepSeekMeasurement(payload(rows),1).meters.length,6);
  const exact=deepSeekMeasurement(payload([tuple('USD','9007199254.740993','-0.1000005','1.000005e-1')]),1);
  assert.deepEqual(exact.meters.map(m=>m.amount),['9007199254740993','-100001','100001']);
  for(const bad of [110,null,'','NaN','Infinity','9223372036854.775808']) {
    assert.throws(()=>deepSeekMeasurement(payload([{...tuple(),total_balance:bad}]),1),/connector_invalid_response/);
    const partial=deepSeekMeasurement(payload([tuple(),{...tuple('USD'),granted_balance:bad}]),1);
    assert.equal(partial.meters.length,3);assert.deepEqual(partial.balanceStatus?.issues,['currency_invalid']);
  }
  const duplicate=deepSeekMeasurement(payload([tuple(),tuple(),tuple('USD')]),1);
  assert.deepEqual(duplicate.meters.map(m=>m.unit),['USD','USD','USD']);assert.deepEqual(duplicate.balanceStatus?.issues,['currency_duplicate']);
  const empty=deepSeekMeasurement(payload([],false),1);assert.equal(empty.meters.length,0);assert.deepEqual(empty.balanceStatus?.issues,['empty_balances']);
  for(const value of [null,{},payload(Array(129).fill(tuple())),{...payload(),is_available:0},payload([tuple('EUR')])])assert.throws(()=>deepSeekMeasurement(value,1));
  assert.equal(JSON.stringify(deepSeekMeasurement({...payload(),private:'SUPPLIER_CANARY'},1)).includes('SUPPLIER_CANARY'),false);
});

test('the real adapter uses only balance reads and maps safe access, funds and transport outcomes',async()=>{
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{balance:{path:'/balance'}}}),adapter=deepSeek(transport,()=>1,async()=>({date:0,at:1,usdPerEur:'1000000',cnyPerEur:'7000000'})),secret=Buffer.from('sk-'+ 'a'.repeat(32));
  try {
    transport.send=async operation=>{assert.equal(operation,'balance');return {...payload(),private:secret.toString()};};
    const found=await adapter.identify(secret);assert.equal(found.identityKind,'declared');assert.equal(found.account,null);assert.equal(found.expiresAt,null);assert.deepEqual(found.abilities,['balance']);
    assert.equal(JSON.stringify(found).includes(secret.toString()),false);
    assert.equal((await adapter.measure(secret,{account:'1'.repeat(24),expiresAt:null})).account,null,'the supplier does not fabricate an expected identity');
    for(const [status,code] of [[401,'credential_rejected'],[403,'credential_permission'],[402,'connector_balance_unavailable'],[429,'connector_status'],[500,'connector_status']] as const) {
      transport.send=async()=>{throw new ConnectorStatus(status,'2');};await assert.rejects(adapter.identify(secret),error=>error instanceof Error&&error.message===code);
    }
    for(const code of ['connector_redirect','connector_timeout','connector_cancelled','connector_response_too_large'] as const) {
      const {SecretError}=await import('../secrets/crypto.js');transport.send=async()=>{throw new SecretError(code);};await assert.rejects(adapter.measure(secret,{account:'1'.repeat(24),expiresAt:null}),error=>error instanceof Error&&error.message===code);
    }
  }finally{secret.fill(0);transport.close();}
});

function harness() {
  const store=new Store(':memory:',1),directory=new Directory(store.db),alice=directory.createUser('a@fixture.example','Alice','unused',1),bob=directory.createUser('b@fixture.example','Bob','unused',1),k=key(7);
  const report=startSecrets(store.db,inputs(k));
  let at=1,calls=0,rows:unknown[]=[tuple()],finish:((answer:ConnectorAnswer)=>void)|null=null,delay=false;
  const answer=():ConnectorAnswer=>({identityKind:'declared',account:null,abilities:['balance'],expiresAt:null,measurement:deepSeekMeasurement(payload(rows),at++)});
  const read=async()=>{calls++;if(delay)return new Promise<ConnectorAnswer>(resolve=>{finish=resolve;});return answer();};
  const connector:Connector={id:'deepseek',identityKind:'declared',secretFormat:s=>/^sk-[a-z0-9]{16,256}$/.test(s),abilities:['balance'],transport:new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),map:()=>null,identify:read,measure:read};
  const registry=new Map([['deepseek',connector]]),credentials=new Credentials(store,k,report,registry);
  const create=(owner=alice.id,name='Personal')=>credentials.create(owner,'deepseek','sk-'+ 'a'.repeat(32),{account:{kind:'new',name},allowUnknownExpiry:true});
  return {store,directory,alice,bob,k,registry,credentials,create,get calls(){return calls;},delay:()=>{delay=true;},finish:()=>{assert.ok(finish);delay=false;finish(answer());},set:(value:unknown[],time:number)=>{rows=value;at=time;},close:()=>{connector.transport.close();store.close();}};
}

test('declared identity separates owners and accounts, rotation/reconnect preserve history and consent precedes reads',async()=>{
  const h=harness();try {
    const a=await h.create(),other=await h.create(h.bob.id),work=await h.create(h.alice.id,'Work');
    assert.notEqual(a.sourceId,other.sourceId);assert.notEqual(a.sourceId,work.sourceId);assert.equal(a.expiryKind,'unknown');assert.ok(a.accountId);assert.equal(a.accountName,'Personal');
    await assert.rejects(h.create(),/declared_account_name_conflict/);
    const count=h.calls;
    await assert.rejects(h.credentials.replace(h.alice.id,a.id,'sk-'+ 'b'.repeat(32),{allowUnknownExpiry:true}),/credential_account_confirmation/);assert.equal(h.calls,count);
    await assert.rejects(h.credentials.create(h.alice.id,'deepseek','sk-'+ 'a'.repeat(32),{account:{kind:'existing',id:other.accountId!},confirmSameAccount:true,allowUnknownExpiry:true}),/declared_account_not_found/);assert.equal(h.calls,count);
    await assert.rejects(h.credentials.replace(h.alice.id,a.id,'sk-'+ 'b'.repeat(32),{confirmSameAccount:true}),/credential_expiry_confirmation/);
    assert.equal((await h.credentials.replace(h.alice.id,a.id,'sk-'+ 'b'.repeat(32),{confirmSameAccount:true,allowUnknownExpiry:true})).sourceId,a.sourceId);
    h.credentials.remove(h.alice.id,a.id);assert.equal(h.store.holds(h.alice.id,a.sourceId!),false);
    assert.equal(h.credentials.listAccounts(h.alice.id,'deepseek').accounts.find(r=>r.id===a.accountId)?.connected,false);
    const back=await h.credentials.create(h.alice.id,'deepseek','sk-'+ 'c'.repeat(32),{account:{kind:'existing',id:a.accountId!},confirmSameAccount:true,allowUnknownExpiry:true});
    assert.equal(back.sourceId,a.sourceId);assert.equal(h.store.meters.readings(a.sourceId!,'balance:CNY',0,100).length,1);
    for(const name of ['','\u0000','sk-'+ 'a'.repeat(32)])await assert.rejects(h.create(h.alice.id,name),/credential_invalid/);
  }finally{h.close();}
});

test('withdrawal invalidates pending existing creates, while explicit reconnect and additional bindings remain possible',async()=>{
  const h=harness();try {
    const first=await h.create(),options={account:{kind:'existing' as const,id:first.accountId!},confirmSameAccount:true,allowUnknownExpiry:true};
    h.delay();const pending=h.credentials.create(h.alice.id,'deepseek','sk-'+ 'b'.repeat(32),options);
    h.credentials.remove(h.alice.id,first.id);h.finish();await assert.rejects(pending,/credential_conflict/);
    assert.equal(h.credentials.list(h.alice.id).length,0);assert.equal(h.store.holds(h.alice.id,first.sourceId!),false);
    const second=await h.credentials.create(h.alice.id,'deepseek','sk-'+ 'b'.repeat(32),options);
    const third=await h.credentials.create(h.alice.id,'deepseek','sk-'+ 'c'.repeat(32),options);
    h.delay();const allowed=h.credentials.create(h.alice.id,'deepseek','sk-'+ 'd'.repeat(32),options);
    h.credentials.remove(h.alice.id,second.id);h.finish();assert.equal((await allowed).sourceId,third.sourceId);
  }finally{h.close();}
});

test('declared account creation replay compares identity rather than JSON property order',async()=>{
  const h=harness();try {
    const account=await h.create(),requestId='11111111-1111-4111-8111-111111111111',secret='sk-'+ 'b'.repeat(32);
    const options={account:{kind:'existing' as const,id:account.accountId!},confirmSameAccount:true,allowUnknownExpiry:true,requestId};
    const first=await h.credentials.create(h.alice.id,'deepseek',secret,options),calls=h.calls;
    const replay=await h.credentials.create(h.alice.id,'deepseek',secret,{...options,account:{id:account.accountId!,kind:'existing'}});
    assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);assert.equal(h.calls,calls);
    const other=await h.create(h.alice.id,'Work');
    await assert.rejects(h.credentials.create(h.alice.id,'deepseek',secret,{...options,account:{kind:'existing',id:other.accountId!}}),/credential_conflict/);
    h.credentials.remove(h.alice.id,first.id);
    await assert.rejects(h.credentials.create(h.alice.id,'deepseek',secret,{...options,account:{id:account.accountId!,kind:'existing'}}),/credential_not_found/);
  }finally{h.close();}
});

test('history clips a retained observation at retention without moving its actual heartbeat',async t=>{
  const h=harness(),M=60_000,cutoff=60_010;
  const {config}=await import('../config.js'),now=cutoff+config.retention.sampleDays*86_400_000;
  t.mock.method(Date,'now',()=>now);
  const source=h.store.source('deepseek','1'.repeat(24),1),board=h.directory.boards(h.alice.id)[0].id;
  h.store.hold(source,h.alice.id,1);h.store.record(source,deepSeekMeasurement(payload([tuple('USD')]),60_001));h.store.prune(now);
  const app=await buildApp({store:h.store,directory:h.directory,ingest:new Ingest(h.store,h.directory,new Duty(),new Cadence()),pairing:new Pairing(h.directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();h.close();});
  const token=newSecret('qt_s');h.directory.createSession(token,h.alice.id,now,60_000);
  const response=await app.inject({method:'GET',url:'/api/history?board='+board+'&cell='+M+'&from=60000&to=120000&unit=USD&meters='+encodeURIComponent(JSON.stringify([[source,'balance:USD']])),headers:{cookie:'quotum_session='+token}});
  assert.equal(response.statusCode,200);
  const history=composeMeters(response.json().chunks,M,60_000,120_000)[0];
  assert.equal(history.points[0].at,cutoff);assert.equal(history.points[0].validUntil,120_000);assert.equal(history.coveredMs,0);
  assert.equal(history.spent,null);assert.equal(history.topup,null);
  assert.deepEqual(h.store.meters.spans(source,'balance:USD',0,120_000),[{from:60_001,to:60_001,staleAfterMs:204_000}]);
});

test('empty-account KEK replacement and ABA resets reject pending creation and stale loaded keys before GET',async()=>{
  const h=harness();try {
    h.delay();const pending=h.create();const b=key(8);
    startSecrets(h.store.db,inputs(b,{from:h.k.fingerprint,to:b.fingerprint}));
    assert.equal(h.store.db.prepare("SELECT value FROM meta WHERE key='secretKeyVersion'").get()?.value,'2');
    startSecrets(h.store.db,inputs(h.k,{from:b.fingerprint,to:h.k.fingerprint}));
    h.finish();await assert.rejects(pending,/credential_conflict/);assert.equal(h.credentials.list(h.alice.id).length,0);
    startSecrets(h.store.db,inputs(b));const count=h.calls;
    await assert.rejects(h.create(),/secret_key_mismatch/);assert.equal(h.calls,count);
    const fresh=new Credentials(h.store,b,startSecrets(h.store.db,inputs(b)),h.registry);
    assert.equal((await fresh.create(h.alice.id,'deepseek','sk-'+ 'a'.repeat(32),{account:{kind:'new',name:'New'},allowUnknownExpiry:true})).expiryKind,'unknown');
  }finally{h.close();}
});

test('current epoch metadata must be a canonical safe integer before any supplier request',async()=>{
  const h=harness();try {
    for(const value of ['1e1','01','9007199254740992','0','bad']) {
      h.store.db.prepare("UPDATE meta SET value=? WHERE key='secretKeyVersion'").run(value);
      const calls=h.calls;await assert.rejects(h.create(),/secret_key_metadata_invalid/);assert.equal(h.calls,calls);
    }
  }finally{h.close();}
});

test('accepted missing and empty cut availability, same-value recovery has an actual anchor and no accounting',()=>{
  const h=harness();try {
    const source=h.store.source('deepseek','1'.repeat(24),1);
    const record=(rows:unknown[],at:number)=>h.store.record(source,deepSeekMeasurement(payload(rows),at));
    record([tuple(),tuple('USD')],1);record([tuple()],60_001);record([tuple(),tuple('USD')],120_001);
    const spans=h.store.meters.spans(source,'balance:USD',0,300_000);
    assert.deepEqual(spans.map(s=>[s.from,s.to,s.interruptedAt]),[[1,1,60_001],[120_001,120_001,undefined]]);
    assert.equal(h.store.meters.readings(source,'balance:USD',0,300_000).length,1);
    const selection={unit:'USD',ids:[[source,'balance:USD']] as [string,string][]};
    const cells=h.store.meters.cells(selection,0,240_000,60_000);
    const series=composeMeters([{from:0,meterSeries:cells}],60_000,0,240_000)[0];
    assert.equal(series.spent,null);assert.equal(series.topup,null);assert.equal(series.pointMode,'observation');
    assert.ok(series.points.some(p=>p.at===120_001&&p.validUntil===180_000));
    assert.ok(series.points.some(p=>p.at===60_000&&p.validUntil===60_001));
    record([],150_000);record([tuple('USD','105','5','100')],180_001);record([tuple('USD','130','10','120')],240_001);
    const changed=composeMeters([{from:0,meterSeries:h.store.meters.cells(selection,0,300_000,60_000)}],60_000,0,300_000)[0];
    assert.equal(changed.spent,null);assert.equal(changed.topup,null);assert.deepEqual(changed.unlocated,[]);assert.deepEqual(changed.topupUnlocated,[]);
    const before=h.store.state(source);record([],250_000);record([tuple('USD')],249_999);
    assert.equal(h.store.state(source).successAt,before.successAt);assert.equal(h.store.state(source).balanceStatus?.at,250_000);assert.equal(h.store.state(source).meters?.find(m=>m.id==='balance:USD')?.stale,true);
  }finally{h.close();}
});

test('repeated partial and empty compare retained state, and a successful empty clears errors without numerical freshness',()=>{
  const h=harness();try {
    const source=h.store.source('deepseek','1'.repeat(24),1);
    h.store.record(source,deepSeekMeasurement(payload([tuple(),tuple('USD')]),1));
    for(const rows of [[tuple()],[]]) {
      const at=rows.length?60_001:120_001,measured=deepSeekMeasurement(payload(rows),at),before=h.store.state(source);
      const candidate=measurementFingerprint(before,measured);h.store.record(source,measured);
      assert.equal(candidate,measurementFingerprint(h.store.state(source)));
      assert.equal(candidate,measurementFingerprint(h.store.state(source),deepSeekMeasurement(payload(rows),at+10)));
    }
    const before=h.store.state(source);h.store.fail(source,'connector_failed');h.store.record(source,deepSeekMeasurement(payload([]),180_001));
    assert.equal(h.store.state(source).error,null);assert.equal(h.store.state(source).successAt,before.successAt);
    assert.deepEqual(h.store.state(source).meters?.map(m=>m.at),before.meters?.map(m=>m.at));
  }finally{h.close();}
});

test('owner routes keep declared identity and expiry private, shared refresh is forbidden, and history exposes null accounting',async t=>{
  const h=harness(),now=Date.now();h.set([tuple(),tuple('USD')],now);
  const app=await buildApp({store:h.store,directory:h.directory,credentials:h.credentials,ingest:new Ingest(h.store,h.directory,new Duty(),new Cadence()),pairing:new Pairing(h.directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();h.close();});
  const cookies=new Map<string,string>();for(const user of [h.alice,h.bob]){const token=newSecret('qt_s');h.directory.createSession(token,user.id,now,60_000);cookies.set(user.id,'quotum_session='+token);}
  const call=(method:'POST'|'GET'|'DELETE',url:string,body?:object,owner=h.alice.id)=>app.inject({method,url,payload:body,headers:{cookie:cookies.get(owner),origin:'http://localhost'}});
  const input={provider:'deepseek',secret:'sk-'+ 'a'.repeat(32),account:{kind:'new',name:'PRIVATE_PERSONAL'},requestId:'44444444-4444-4444-8444-444444444444'};
  const consent=await call('POST','/api/credentials',input);assert.equal(consent.statusCode,409);assert.deepEqual(consent.json(),{error:'credential_expiry_confirmation',expiresAt:null,expiryKind:'unknown'});
  const created=await call('POST','/api/credentials',{...input,allowUnknownExpiry:true});assert.equal(created.statusCode,201);const dto=created.json();
  assert.ok(dto.accountId);assert.equal(dto.expiryKind,'unknown');
  const reads=h.calls;
  for(const requestId of [input.requestId,'55555555-5555-4555-8555-555555555555']) {
    const malformed=await call('POST','/api/credentials',{...input,requestId,account:{...input.account,id:dto.accountId},allowUnknownExpiry:true});
    assert.equal(malformed.statusCode,400);assert.equal(malformed.json().error,'credential_invalid');assert.equal(h.calls,reads);
  }
  assert.deepEqual((await call('GET','/api/source-accounts?provider=deepseek',undefined,h.bob.id)).json().accounts,[]);
  const foreign=await call('POST','/api/credentials',{...input,account:{kind:'existing',id:dto.accountId},confirmSameAccount:true,allowUnknownExpiry:true},h.bob.id);assert.equal(foreign.statusCode,404);
  assert.equal((await call('POST','/api/credentials/'+dto.id,{secret:input.secret,sourceId:dto.sourceId,confirmSameAccount:true,allowUnknownExpiry:true})).statusCode,400);
  const board=h.directory.createBoard('Shared',h.alice.id,now);h.directory.addMember(board.id,h.bob.id,now);h.store.share(board.id,dto.sourceId,h.alice.id,now);
  const own=(await call('GET','/api/boards/'+board.id+'/shares')).json();assert.equal(own.mine[0].accountLabel,'PRIVATE_PERSONAL');
  const shared=await call('GET','/api/overview?board='+board.id,undefined,h.bob.id);
  assert.equal(shared.statusCode,200);assert.equal(shared.body.includes('PRIVATE_PERSONAL'),false);assert.equal(shared.body.includes(dto.id),false);assert.equal(shared.body.includes(dto.accountId),false);assert.equal(shared.body.includes(input.secret),false);
  assert.equal(shared.json().sources.find((c:{id:string})=>c.id===dto.sourceId).spending,null);
  const memberShares=await call('GET','/api/boards/'+board.id+'/shares',undefined,h.bob.id);assert.equal(memberShares.body.includes('PRIVATE_PERSONAL'),false);
  assert.equal((await call('POST','/api/boards/'+board.id+'/sources/'+dto.sourceId+'/refresh',undefined,h.bob.id)).statusCode,403);
  const from=Math.floor(now/60_000)*60_000,to=from+60_000;
  const history=await call('GET','/api/history?board='+board.id+'&cell=60000&from='+from+'&to='+to+'&unit=CNY&meters='+encodeURIComponent(JSON.stringify([[dto.sourceId,'balance:CNY']])));
  assert.equal(history.statusCode,200);
  const series=history.json().chunks.flatMap((c:{meterSeries:unknown[]})=>c.meterSeries);assert.ok(series.length);
  for(const s of series){assert.deepEqual(s.accounting,{spending:'unavailable',topups:'unavailable'});assert.equal(s.role,'total');assert.equal(s.pointMode,'observation');assert.ok(s.cells.every((r:unknown[])=>r[2]===null&&r[3]===null));}
});

test('a warm exact tile predecessor expires at the fixed edge when the selected suffix is emptied',()=>{
  const h=harness(),M=60_000,H=3_600_000;try {
    const source=h.store.source('deepseek','1'.repeat(24),1),board=h.directory.boards(h.alice.id)[0].id;h.store.hold(source,h.alice.id,1);
    h.store.record(source,deepSeekMeasurement(payload(),H-60_000));
    const tiles=new HistoryTiles(h.store),nothing=()=>{};
    h.store.setObserver({touchSources:nothing,touchBoards:nothing,touchUser:nothing,touchHub:nothing,history:(id,since)=>tiles.touch(id,since),dropSessions:nothing,dropMember:nothing,dropBoard:nothing});
    const selection={unit:'CNY',ids:[[source,'balance:CNY']] as [string,string][]},read=(cache=tiles)=>cache.read(board,M,0,2*H,3*H,h.store.shown(board,[]),selection).map(json=>JSON.parse(json));
    const before=read();h.store.record(source,deepSeekMeasurement(payload([]),H));
    const warm=read(),cold=read(new HistoryTiles(h.store));assert.deepEqual(warm,cold);
    const previous=composeMeters(before,M,0,H)[0];assert.ok(previous.points.every(p=>p.validUntil!<=H));
    const after=composeMeters(warm,M,0,2*H)[0];assert.ok(after.points.every(p=>p.validUntil!<=H));
  }finally{h.close();}
});
