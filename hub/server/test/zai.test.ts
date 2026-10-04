import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {decodeZai, mapZai, zai} from '../connectors/zai.js';
import {ConnectorStatus, ConnectorTransport} from '../connectors/transport.js';
import {Credentials, SecretKey, startSecrets} from '../secrets/index.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {composeMeters} from '../domain/meterHistory.js';
import {publicSourceState, Projection} from '../projection.js';
import {TLS_CERT, TLS_KEY} from './fixtures/connector-tls.fixture.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';
import {newSecret} from '../domain/auth.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HistoryTiles} from '../history.js';

const time = Date.parse('2026-10-04T12:00:00Z');
const five = {type:'CREDIT_LIMIT',unit:3,number:5,usage:2000,currentValue:800,remaining:1200,percentage:40};
const week = {type:'CREDIT_LIMIT',unit:6,number:1,usage:10000,currentValue:2000,remaining:8000,percentage:20,nextResetTime:time+86400000};
const envelope = (limits:unknown[],extra:object={}) => ({code:200,success:true,data:{level:'lite',limits},...extra});
const mapped = (limits:unknown[],at=time) => mapZai(decodeZai(JSON.stringify(envelope(limits))),at);

test('personal credit tuples keep independent exact amounts, supplied resets and genuine zero',()=>{
  const result=mapped([week,five]);
  assert.deepEqual(result.measurement!.meters.map(m=>[m.id,m.unit,m.amount,m.limit,m.resetAt]),[
    ['quota:credit:5h','credits:zai','800000000','2000000000',null],
    ['quota:credit:week','credits:zai','2000000000','10000000000',time+86400000],
  ]);
  assert.equal(result.identityOrigin,'declared');assert.equal(result.expiryKind,'unknown');
  assert.equal(result.quotaObservation!.quota.complete,true);
  assert.ok(mapped([{...five,currentValue:0,remaining:2000,percentage:0},{...week,currentValue:0,remaining:10000,percentage:0}]).measurement!.meters.every(m=>m.amount==='0'));
  const precise=mapZai(decodeZai('{"code":200,"success":true,"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":9007199254.740993,"currentValue":0.1000005}]}}'),time);
  assert.equal(precise.measurement!.meters[0].limit,'9007199254740993');assert.equal(precise.measurement!.meters[0].amount,'100001');
});

test('empty, unsupported, invalid and mixed readings preserve quota truth',()=>{
  assert.equal(mapped([]).quotaObservation!.quota.issue,'empty');
  for(const raw of [{type:'TOKENS_LIMIT'},{type:'TIME_LIMIT'},{...five,unit:6,number:5}]) {
    assert.equal(mapped([raw]).measurement,undefined);assert.equal(mapped([raw]).quotaObservation!.quota.issue,'unsupported');
  }
  for(const patch of [{usage:'2000'},{usage:-1},{currentValue:null},{usage:1e30},{currentValue:'0'},{remaining:'1200'},{remaining:1300},{percentage:90}]) {
    const result=mapped([{...five,...patch},week]);
    assert.deepEqual(result.measurement!.meters.map(m=>m.id),['quota:credit:week']);assert.equal(result.quotaObservation!.quota.issue,'invalid');
  }
  assert.deepEqual(mapped([five,five,week]).measurement!.meters.map(m=>m.id),['quota:credit:week']);
  assert.equal(mapped([five,{type:'TOKENS_LIMIT'}]).quotaObservation!.quota.issue,'unsupported');
  assert.equal(mapped([five]).quotaObservation!.quota.issue,'missing');
  for(const reset of [undefined,null,'2026-10-05',1791000000,-1,1.5]) {
    const result=mapped([{...five,nextResetTime:reset},week]);
    assert.equal(result.measurement!.meters[0].resetAt,null);
    assert.equal(result.measurement!.meters.length,2);
    assert.equal(result.quotaObservation!.quota.complete,reset===undefined||reset===null);
  }
  const closed=mapped([{...five,usage:0,currentValue:0,remaining:0,percentage:0}]);
  assert.equal(closed.measurement!.meters[0].limit,'0');
  assert.equal(mapped([{...five,currentValue:2100,remaining:-100,percentage:105}]).measurement!.meters[0].amount,'2100000000');
  assert.equal(mapped([{...five,currentValue:2100,remaining:-100,percentage:100}]).measurement!.meters[0].amount,'2100000000');
});

test('authentication and malformed envelopes cannot accept plausible measurements or leak messages',async()=>{
  for(const code of [401,403])assert.throws(()=>mapZai(envelope([five,week],{code,success:false,msg:'CANARY'}),time),new RegExp(code===401?'credential_auth_rejected':'credential_permission'));
  for(const raw of [null,envelope([five],{success:false}),{code:'200',success:true,data:{limits:[]}},envelope(Array(33).fill(five)),{code:200,success:true,data:{limits:null}}])assert.throws(()=>mapZai(raw,time),/connector_invalid_response/);
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  const c=zai(transport);
  try {
    for(const status of [401,403,429,500]) {
      transport.send=async()=>{throw new ConnectorStatus(status,'17');};
      await assert.rejects(c.identify(Buffer.from('synthetic.secret')),new RegExp(status===401?'credential_auth_rejected':status===403?'credential_permission':'connector_status'));
    }
  }finally{transport.close();}
});

test('quota HTTPS uses fixed GET with raw authorization and rejects caller destinations and redirects',async t=>{
  const requests:{path:string|undefined;auth:string|undefined;method:string|undefined}[]=[];
  let redirect=false;
  const server=createServer({key:TLS_KEY,cert:TLS_CERT},(req,res)=>{
    requests.push({path:req.url,auth:req.headers.authorization,method:req.method});
    if(redirect){res.writeHead(302,{location:'https://foreign.example'});res.end();}else res.end(JSON.stringify(envelope([five,week])));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const transport=new ConnectorTransport({host:'127.0.0.1',port:(server.address() as AddressInfo).port,auth:'raw',operations:{quota:{path:'/api/monitor/usage/quota/limit'}}},{ca:TLS_CERT,decode:decodeZai});
  t.after(()=>{transport.close();server.closeAllConnections();server.close();});
  const c=zai(transport,()=>time);await c.identify(Buffer.from('fixture.secret'));
  assert.deepEqual(requests,[{path:'/api/monitor/usage/quota/limit',auth:'fixture.secret',method:'GET'}]);
  await assert.rejects(transport.send('model',Buffer.from('fixture.secret')),/destination/);
  await assert.rejects(transport.send('quota',Buffer.from('fixture.secret'),{host:'foreign'}),/destination/);
  redirect=true;await assert.rejects(c.identify(Buffer.from('fixture.secret')),/redirect/);
});

function harness() {
  let at=time,limits:unknown[]=[five,week],calls=0,fail=false;
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async()=>{calls++;if(fail)throw new ConnectorStatus(401,null);return decodeZai(JSON.stringify(envelope(limits)));};
  const store=new Store(':memory:',time),directory=new Directory(store.db);
  const alice=directory.createUser('alice@fixture.example','Alice','unused',time),bob=directory.createUser('bob@fixture.example','Bob','unused',time);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,9).toString('base64url')));
  const report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const credentials=new Credentials(store,key,report,new Map([['zai',zai(transport,()=>at)]]));
  return {store,directory,alice,bob,credentials,get calls(){return calls;},set(atNext:number,limitsNext:unknown[],failure=false){at=atNext;limits=limitsNext;fail=failure;},close(){transport.close();store.close();}};
}

test('declared connections are owner-local and idempotent; explicit rotation preserves history',async()=>{
  const h=harness();try {
    await assert.rejects(h.credentials.create(h.alice.id,'zai','fixture.secret'),/expiry_confirmation/);
    assert.equal(h.credentials.list(h.alice.id).length,0);
    const requestId='00000000-0000-4000-8000-000000000001';
    const [first,retry]=await Promise.all([h.credentials.create(h.alice.id,'zai','fixture.secret',{allowUnknownExpiry:true,requestId}),h.credentials.create(h.alice.id,'zai','fixture.secret',{allowUnknownExpiry:true,requestId})]);
    assert.equal(first.id,retry.id);assert.equal(first.sourceId,retry.sourceId);assert.equal(first.expiryKind,'unknown');assert.equal(first.identityOrigin,'declared');
    const other=await h.credentials.create(h.alice.id,'zai','fixture.secret',{allowUnknownExpiry:true});
    const bob=await h.credentials.create(h.bob.id,'zai','fixture.secret',{allowUnknownExpiry:true});
    assert.notEqual(first.sourceId,other.sourceId);assert.notEqual(first.sourceId,bob.sourceId);
    const before=h.calls;
    await assert.rejects(h.credentials.replace(h.alice.id,first.id,'fixture.rotated',{allowUnknownExpiry:true}),/account_confirmation/);assert.equal(h.calls,before);
    await assert.rejects(h.credentials.replace(h.bob.id,first.id,'fixture.rotated',{sameAccount:true,allowUnknownExpiry:true}),/not_found/);
    h.set(time+60000,[five,week]);
    const rotated=await h.credentials.replace(h.alice.id,first.id,'fixture.rotated',{sameAccount:true,allowUnknownExpiry:true});
    assert.equal(rotated.sourceId,first.sourceId);assert.equal(h.store.meters.readings(first.sourceId!,'quota:credit:5h',0,time+120000).length,1);
    const state=h.store.state(first.sourceId!);h.set(time+120000,[],true);
    await assert.rejects(h.credentials.replace(h.alice.id,first.id,'fixture.invalid',{sameAccount:true,allowUnknownExpiry:true}),/auth_rejected/);
    assert.deepEqual(h.store.state(first.sourceId!),state);
    assert.equal(JSON.stringify(publicSourceState({...state,error:'credential_auth_rejected'})).includes('auth_rejected'),false);
    h.credentials.remove(h.alice.id,first.id);assert.equal(h.store.holds(h.alice.id,first.sourceId!),false);
    await assert.rejects(h.credentials.create(h.alice.id,'zai','fixture.secret',{allowUnknownExpiry:true,requestId}),/not_found/);
  }finally{h.close();}
});

test('authenticated omission cuts history before recovery; unchanged recovery opens another span',async()=>{
  const h=harness();try {
    const c=await h.credentials.create(h.alice.id,'zai','fixture.secret',{allowUnknownExpiry:true}),source=c.sourceId!;
    const history=()=>composeMeters([{from:time,meterSeries:h.store.meters.cells({unit:'credits:zai',ids:[[source,'quota:credit:5h']]},time,time+600000,60000)}],60000,time,time+600000)[0];
    h.set(time+120000,[week]);await h.credentials.measure(source);
    assert.equal(h.store.state(source).meters![0].stale,true);
    assert.ok(history().points.every(p=>p.knownUntil!<=time+120000),'missing quota closes its old cells before recovery');
    h.set(time+180000,[five,week]);await h.credentials.measure(source);
    assert.deepEqual(history().points.slice(0,4).map(p=>p.at),[time,time+60000,time+180000,time+240000]);
    const spans=h.store.meters.spans(source,'quota:credit:5h',0,time+600000);
    assert.equal(spans.length,2);assert.equal(spans[0].holdUntil,time+120000);
    assert.equal(h.store.meters.readings(source,'quota:credit:5h',0,time+600000).length,1);
    const success=h.store.state(source).successAt;
    h.set(time+240000,[]);await h.credentials.measure(source);
    assert.equal(h.store.state(source).successAt,success);assert.equal(h.store.state(source).quota!.issue,'empty');
    assert.ok(history().points.every(p=>p.at!==time+240000));
    const old=mapped([],time+100000);assert.equal(h.store.quotaObservation(source,old.quotaObservation!),false);
    const projection=new Projection({store:h.store,ingest:{live:{of:()=>[],ofChangesAt:()=>null}}} as unknown as ConstructorParameters<typeof Projection>[0]);
    const card=projection.sourcePart({id:source,provider:'zai',account:h.store.account(source)!,holders:[h.alice.id],sharedBy:null},new Map([[h.alice.id,'Alice']]),time+240000).value.card;
    assert.equal(card.spending,undefined);assert.equal(card.keysCount,undefined);assert.equal(card.identityOrigin,'declared');
  }finally{h.close();}
});

test('HTTP consents and ownership are strict, with neutral shared failures and holder-only refresh',async()=>{
  const h=harness();
  const app=await buildApp({store:h.store,directory:h.directory,credentials:h.credentials,ingest:new Ingest(h.store,h.directory,new Duty(),new Cadence()),pairing:new Pairing(h.directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  try {
    const tokens=new Map<string,string>();
    for(const user of [h.alice,h.bob]){const token=newSecret('qt_s');h.directory.createSession(token,user.id,Date.now(),60000);tokens.set(user.id,token);}
    const call=(url:string,payload:object|undefined,owner=h.alice.id)=>app.inject({method:payload?'POST':'GET',url,payload,headers:{cookie:'quotum_session='+tokens.get(owner),origin:'http://localhost'}});
    const consent=await call('/api/credentials',{provider:'zai',secret:'fixture.secret'});
    assert.equal(consent.statusCode,409);assert.deepEqual(consent.json(),{error:'credential_expiry_confirmation',expiresAt:null,expiryKind:'unknown'});
    const connected=await call('/api/credentials',{provider:'zai',secret:'fixture.secret',allowUnknownExpiry:true}),record=connected.json();assert.equal(connected.statusCode,201);
    const calls=h.calls;
    assert.equal((await call('/api/credentials/'+record.id,{secret:'fixture.rotated',allowUnknownExpiry:true})).statusCode,409);assert.equal(h.calls,calls);
    assert.equal((await call('/api/credentials/'+record.id,{secret:'fixture.rotated',sameAccount:'true',allowUnknownExpiry:true})).statusCode,400);
    assert.equal((await call('/api/credentials/'+record.id,{secret:'fixture.rotated',sameAccount:true,allowUnknownExpiry:true,source:record.sourceId})).statusCode,400);
    assert.equal((await call('/api/credentials/'+record.id,{secret:'fixture.rotated',sameAccount:true,allowUnknownExpiry:true},h.bob.id)).statusCode,404);
    assert.equal((await call('/api/credentials/'+record.id,{secret:'fixture.rotated',sameAccount:true,allowUnknownExpiry:true})).statusCode,200);
    const board=h.directory.createBoard('Shared',h.alice.id,Date.now());h.directory.addMember(board.id,h.bob.id,Date.now());h.store.share(board.id,record.sourceId,h.alice.id,Date.now());
    h.store.fail(record.sourceId,'credential_auth_rejected');
    const shared=await call('/api/overview?board='+board.id,undefined,h.bob.id);
    assert.equal(shared.json().sources[0].error,'unmeasured');assert.deepEqual(shared.json().sourceAccess,{});
    for(const secret of ['fixture.secret',record.id,record.hint])assert.equal(shared.body.includes(secret),false);
    assert.equal((await call(`/api/boards/${board.id}/sources/${record.sourceId}/refresh`,{},h.bob.id)).statusCode,403);
    h.set(time+60000,[],true);
    const rejected=await call('/api/credentials',{provider:'zai',secret:'fixture.invalid',allowUnknownExpiry:true});assert.equal(rejected.statusCode,400);assert.deepEqual(rejected.json(),{error:'credential_auth_rejected'});
  }finally{await app.close();h.close();}
});

test('quota hard boundaries survive restart, retention and cached history invalidation',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-quota-history-')),file=path.join(dir,'db.sqlite');
  let store=new Store(file,time);
  try {
    const directory=new Directory(store.db),owner=directory.createUser('history@fixture.example','History','unused',time),board=directory.boards(owner.id).find(b=>b.personal)!;
    const source=store.source('zai','1'.repeat(24),time);store.hold(source,owner.id,time);
    const selection={unit:'credits:zai',ids:[[source,'quota:credit:5h']] as [string,string][]};
    const cache=new HistoryTiles(store),noop=()=>{};
    store.setObserver({history:(id,since)=>cache.touch(id,since),touchSources:noop,touchBoards:noop,touchUser:noop,touchHub:noop,dropSessions:noop,dropMember:noop,dropBoard:noop});
    const full=mapped([five,week],time),missing=mapped([week],time+120000);
    store.quotaObservation(source,full.quotaObservation!,full.measurement);
    const tile=time-time%3600000,to=tile+3600000;
    const read=()=>JSON.parse(cache.read(board.id,60000,tile,to,to+60000,store.shown(board.id,[]),selection)[0]);
    const before=read();store.quotaObservation(source,missing.quotaObservation!,missing.measurement);const after=read();
    assert.ok(after.meterSeries[0].cells.length<before.meterSeries[0].cells.length);
    const repeated=mapped([],time+150000);store.quotaObservation(source,repeated.quotaObservation!);
    assert.equal(store.meters.spans(source,selection.ids[0][1],0,to)[0].holdUntil,time+120000);
    store.close();store=new Store(file,time+160000);
    assert.equal(store.meters.spans(source,selection.ids[0][1],0,to)[0].holdUntil,time+120000);
    const recovered=mapped([five,week],time+180000);store.quotaObservation(source,recovered.quotaObservation!,recovered.measurement);
    store.meters.prune(time+60000);
    const cells=store.meters.cells(selection,time+60000,time+240000,60000)[0].cells;
    assert.deepEqual(cells.map(c=>c[0]),[0,2]);assert.equal(cells[0][5]!.knownUntil,time+120000);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
