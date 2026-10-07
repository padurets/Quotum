import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {declaredPseudonym} from '../store/sourceAccounts.js';
import {newSecret,sha256} from '../domain/auth.js';
import {QUOTA_IDS,type MeterMeasurement} from '../domain/meters.js';
import {Credentials,SecretKey,startSecrets} from '../secrets/index.js';
import {ConnectorTransport,type Connector,type ConnectorIdentity} from '../connectors/index.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';

async function fixture(provider:'openrouter'|'deepseek'|'zai') {
  const store=new Store(':memory:'),directory=new Directory(store.db);
  const alice=directory.createUser('alice@fixture.example','Alice','unused',1),bob=directory.createUser('bob@fixture.example','Bob','unused',1);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url')));
  const report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const declared=provider!=='openrouter',named=provider==='deepseek',transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  const abilities=provider==='zai'?['quota' as const]:['balance' as const];
  let calls=0,account='1'.repeat(24),at=10;
  const read=async():Promise<ConnectorIdentity>=>{
    calls++;
    const measuredAt=at++,quota=provider==='zai';
    const measurement:MeterMeasurement={type:'meters',observedAt:measuredAt,staleAfterMs:204_000,inventoryComplete:true,inventoryError:null,keys:[],meters:[{id:quota?QUOTA_IDS[0]:named?'balance:USD':'balance',kind:quota?'cap':'balance',unit:quota?'credits:zai':'USD',amount:'10000000',limit:quota?'100000000':null,at:measuredAt,staleAfterMs:204_000,stale:false,resetAt:null,minutes:quota?300:null,scope:quota?'five_hour':null,label:null}]};
    const result={abilities:[...abilities],expiresAt:declared?null:Date.now()+3_600_000,measurement};
    return declared?{...result,identityOrigin:'declared',expiryKind:'unknown'}:{...result,identityOrigin:'supplier',account};
  };
  const connector:Connector={id:provider,identityOrigin:declared?'declared':'supplier',...(named?{declaredAccounts:true}:{}),abilities,secretFormat:value=>value.length>=8,transport,map:()=>null,identify:read,measure:read};
  const credentials=new Credentials(store,key,report,new Map([[provider,connector]]));
  const app=await buildApp({store,directory,credentials,ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  const tokens=new Map<string,string>();
  for(const user of [alice,bob]){const token=newSecret('qt_s');directory.createSession(token,user.id,Date.now(),60_000);tokens.set(user.id,token);}
  const call=(url:string,payload:object,owner=alice.id)=>app.inject({method:'POST',url,payload,headers:{cookie:'quotum_session='+tokens.get(owner),origin:'http://localhost'}});
  const create=(name='Personal',owner=alice.id)=>call('/api/credentials',{provider,secret:'fixture-identical-key',...(declared?{allowUnknownExpiry:true}:{}),...(named?{account:{kind:'new',name}}:{})},owner);
  return {store,directory,credentials,alice,bob,call,create,get calls(){return calls;},switchSupplier:()=>{account='2'.repeat(24);},close:async()=>{await app.close();transport.close();store.close();}};
}

for(const provider of ['deepseek','zai'] as const)test(`${provider} follows the shared declared identity and same-account contract`,async t=>{
  const h=await fixture(provider);t.after(h.close);
  const first=(await h.create()).json(),second=(await h.create('Work')).json(),foreign=(await h.create('Personal',h.bob.id)).json();
  assert.equal(first.identityOrigin,'declared');assert.equal(first.expiryKind,'unknown');
  assert.equal(new Set([first.sourceId,second.sourceId,foreign.sourceId]).size,3,'same key does not identify or merge declared accounts');
  assert.deepEqual({...h.store.db.prepare('SELECT kind,owner_id FROM source_identity WHERE source_id=?').get(first.sourceId)},{kind:'declared',owner_id:h.alice.id});
  if(provider==='deepseek') {
    const expected=sha256('quotum/declared-account/v1\n'+h.alice.id+'\n'+provider+'\n'+first.accountId).slice(0,24);
    assert.equal(h.store.account(first.sourceId),expected,'named identity uses the common declared namespace');
  }
  const url='/api/credentials/'+first.id,count=h.calls;
  for(const consent of [undefined,false]) {
    const response=await h.call(url,{secret:'fixture-rotated-key',allowUnknownExpiry:true,...(consent===undefined?{}:{sameAccount:consent})});
    assert.equal(response.statusCode,409);assert.equal(response.json().error,'credential_account_confirmation');
  }
  for(const invalid of [{sameAccount:'true'},{confirmSameAccount:true}])assert.equal((await h.call(url,{secret:'fixture-rotated-key',allowUnknownExpiry:true,...invalid})).statusCode,400);
  assert.equal((await h.call(url,{secret:'fixture-rotated-key',sameAccount:true,allowUnknownExpiry:true},h.bob.id)).statusCode,404);
  assert.equal(h.calls,count,'missing, malformed and foreign attestations stop before provider work');
  const readings=JSON.stringify(h.store.db.prepare('SELECT * FROM readings WHERE source_id=?').all(first.sourceId));
  const rotated=await h.call(url,{secret:'fixture-rotated-key',sameAccount:true,allowUnknownExpiry:true});
  assert.equal(rotated.statusCode,200);assert.equal(rotated.json().sourceId,first.sourceId);assert.equal(rotated.json().identityOrigin,'declared');
  assert.equal(JSON.stringify(h.store.db.prepare('SELECT * FROM readings WHERE source_id=?').all(first.sourceId)),readings);
  assert.equal(h.store.holds(h.alice.id,first.sourceId),true);assert.equal(h.store.holds(h.bob.id,first.sourceId),false);
});

test('supplier identity keeps account mismatch checks and rejects declared attestation',async t=>{
  const h=await fixture('openrouter');t.after(h.close);
  const first=(await h.create()).json(),foreign=(await h.create('Personal',h.bob.id)).json();
  assert.equal(first.identityOrigin,'supplier');assert.equal(first.sourceId,foreign.sourceId,'supplier evidence identifies the same account across holders');
  const url='/api/credentials/'+first.id,count=h.calls;
  assert.equal((await h.call(url,{secret:'fixture-rotated-key',sameAccount:true})).statusCode,400);assert.equal(h.calls,count);
  h.switchSupplier();const refused=await h.call(url,{secret:'fixture-rotated-key'});
  assert.equal(refused.statusCode,409);assert.equal(refused.json().error,'credential_account_mismatch');
  assert.equal(h.credentials.list(h.alice.id)[0].sourceId,first.sourceId);
  await assert.rejects(h.credentials.measure(first.sourceId),/credential_account_mismatch/);
});

test('a named account created with the earlier namespace reconnects without recomputing its source',async t=>{
  const h=await fixture('deepseek');t.after(h.close);
  const id=randomUUID(),old=sha256('quotum/account/declared/v1\ndeepseek\n'+h.alice.id+'\n'+id).slice(0,24),source=h.store.source('deepseek',old,1);
  assert.notEqual(old,declaredPseudonym(h.alice.id,'deepseek',id));
  h.store.db.prepare('INSERT INTO declared_accounts(id,user_id,provider,source_id,name,name_key,created_at) VALUES (?,?,?,?,?,?,?)').run(id,h.alice.id,'deepseek',source,'Legacy','legacy',1);
  const connected=await h.call('/api/credentials',{provider:'deepseek',secret:'fixture-legacy-key',account:{kind:'existing',id},sameAccount:true,allowUnknownExpiry:true});
  assert.equal(connected.statusCode,201);assert.equal(connected.json().sourceId,source);assert.equal(h.store.account(source),old);
  const record=connected.json();h.credentials.remove(h.alice.id,record.id);
  const reconnected=await h.call('/api/credentials',{provider:'deepseek',secret:'fixture-reconnected-key',account:{kind:'existing',id},sameAccount:true,allowUnknownExpiry:true});
  assert.equal(reconnected.statusCode,201);assert.equal(reconnected.json().sourceId,source);assert.equal(h.store.account(source),old);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM sources').get()?.n,1);
});
