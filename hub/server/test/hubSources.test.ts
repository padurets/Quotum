import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {HubSources} from '../hubSources.js';
import {Credentials} from '../secrets/credentials.js';
import {SecretError,SecretKey} from '../secrets/crypto.js';
import {startSecrets} from '../secrets/start.js';
import {ConnectorTransport} from '../connectors/transport.js';
import type {Connector,ConnectorIdentity} from '../connectors/registry.js';
import type {Clock} from '../events.js';
import type {Meter} from '../domain/meters.js';

class TestClock implements Clock {
  time=Date.now();tasks=new Map<number,{at:number;run:()=>void}>();id=0;
  now=()=>this.time;
  after=(ms:number,run:()=>void)=>{const id=++this.id;this.tasks.set(id,{at:this.time+ms,run});return()=>{this.tasks.delete(id);};};
  tick(ms=0){this.time+=ms;for(let count=0;count<100;count++){const due=[...this.tasks].find(([,t])=>t.at<=this.time);if(!due)return;this.tasks.delete(due[0]);due[1].run();}throw new Error('timer_loop');}
}
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function harness() {
  const clock=new TestClock(),store=new Store(':memory:',clock.now()),directory=new Directory(store.db);
  const alice=directory.createUser('alice@fixture.example','Alice','unused',clock.now()),bob=directory.createUser('bob@fixture.example','Bob','unused',clock.now());
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url'))),report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  let account='1'.repeat(24),expiry:number|null=clock.now()+86_400_000,usage='1000000',calls=0,late:((value:ConnectorIdentity)=>void)|null=null;
  let delayed=false,revoked=false,retryAfterMs:number|undefined;
  const identity=():ConnectorIdentity=>{
    const at=clock.now()+1;
    const meter=(id:string,amount:string):Meter=>({id,amount,at,kind:'counter',unit:'USD',staleAfterMs:204_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});
    return {account,abilities:['balance','usage'],expiresAt:expiry,retryAfterMs,measurement:{type:'meters',observedAt:at,staleAfterMs:204_000,meters:[meter('credits','50000000'),meter('usage',usage)],keys:[],inventoryComplete:retryAfterMs===undefined,inventoryError:retryAfterMs===undefined?null:'connector_status'}};
  };
  const connector:Connector={id:'openrouter',secretFormat:s=>s.length>=16,abilities:['balance','usage'],transport:new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),map:()=>null,
    identify:async()=>identity(),measure:async()=>{calls++;if(revoked)throw new SecretError('credential_revoked');if(delayed)return new Promise(resolve=>{late=resolve;});return identity();}};
  const credentials=new Credentials(store,key,report,new Map([['openrouter',connector]])),sources=new HubSources(store,credentials,clock);
  const connect=(owner=alice.id,requestId?:string)=>credentials.create(owner,'openrouter','fixture-secret-key',{requestId,allowNoExpiry:true});
  return {clock,store,directory,alice,bob,credentials,sources,connect,identity,get calls(){return calls;},delay:()=>{delayed=true;},finish:()=>{assert.ok(late);late(identity());delayed=false;},revoke:()=>{revoked=true;},setAccount:(id:string)=>{account=id;},setExpiry:(value:number|null)=>{expiry=value;},setUsage:(value:string)=>{usage=value;},rateLimit:(ms:number)=>{retryAfterMs=ms;}};
}

test('a partial inventory retry delay survives a fixed cadence, manual refresh and frequency changes',async()=>{
  const h=harness();try {
    const source=(await h.connect()).sourceId!;
    h.store.setMeasureInterval(source,60_000);h.setUsage('9000000');h.rateLimit(3_600_000);
    h.clock.tick(1);h.sources.start();h.clock.tick();await settle();
    const retryAt=h.clock.now()+3_600_000;
    assert.equal(h.store.state(source).meters?.find(m=>m.id==='usage')?.amount,'9000000');
    assert.equal(h.sources.cadence(source).value?.next,retryAt);
    assert.deepEqual(h.sources.requestRefresh(source,h.clock.now()),{status:'too_soon',retryAt});
    h.sources.frequencyChanged(source,h.clock.now());
    assert.equal(h.sources.cadence(source).value?.next,retryAt);
    h.clock.tick(60_000);await settle();assert.equal(h.calls,1);
    h.clock.tick(3_540_000);await settle();assert.equal(h.calls,2);
  }finally{h.sources.stop();h.store.close();}
});

test('a connector-completed partial round is committed without a competing poll timeout',async(t)=>{
  const deadline=new AbortController();t.mock.method(AbortSignal,'timeout',()=>deadline.signal);
  const h=harness();try {
    const source=(await h.connect()).sourceId!;h.delay();h.clock.tick(1);h.sources.start();h.clock.tick();await settle();
    deadline.abort();h.setUsage('9000000');h.rateLimit(120000);h.finish();await settle();
    assert.equal(h.store.state(source).meters?.find(m=>m.id==='usage')?.amount,'9000000');
    assert.equal(h.store.state(source).error,null);
    assert.equal(h.store.state(source).inventory?.complete,false);
  }finally{h.sources.stop();h.store.close();}
});

test('frequency saves publish immediately during a poll, including a return to the previous value',async()=>{
  const h=harness();try {
    const source=(await h.connect()).sourceId!;h.store.setMeasureInterval(source,900000);
    h.delay();h.clock.tick(1);h.sources.start();h.clock.tick();await settle();
    const intervals:(number|null)[]=[];
    const noop=()=>{};
    h.sources.setObserver({touchSources:()=>{intervals.push(h.store.measureInterval(source));},touchBoards:noop,touchUser:noop,touchHub:noop,history:noop,dropSessions:noop,dropMember:noop,dropBoard:noop});
    for(const interval of [60000,900000] as const){h.store.setMeasureInterval(source,interval);h.sources.frequencyChanged(source,h.clock.now());}
    assert.deepEqual(intervals,[60000,900000]);
    assert.equal(h.calls,1,'saving does not start a second poll');
    h.finish();await settle();assert.equal(h.sources.cadence(source).value?.next,h.clock.now()+900000);
  }finally{h.sources.stop();h.store.close();}
});

test('verified connections deduplicate an account, preserve holds until the last own key and keep replay tombstones',async()=>{
  const h=harness();try {
    const requestId='11111111-1111-4111-8111-111111111111';
    const a=await h.connect(h.alice.id,requestId),again=await h.connect(h.alice.id,requestId),second=await h.connect(),b=await h.connect(h.bob.id);
    assert.equal(a.id,again.id);assert.equal(again.replayed,true);assert.equal(a.sourceId,b.sourceId);
    assert.equal(h.store.held(h.alice.id).length,1);
    h.credentials.remove(h.alice.id,a.id);assert.equal(h.store.holds(h.alice.id,a.sourceId!),true);
    await assert.rejects(h.connect(h.alice.id,requestId),/credential_not_found/);
    h.credentials.remove(h.alice.id,second.id);assert.equal(h.store.holds(h.alice.id,a.sourceId!),false);assert.equal(h.store.holds(h.bob.id,a.sourceId!),true);
    assert.equal(h.credentials.access(h.alice.id,a.sourceId!),null);
  }finally{h.sources.stop();h.store.close();}
});

test('replacement consent and identity checks preserve ciphertext, and a delayed poll cannot restore a removed access',async()=>{
  const h=harness();try {
    const a=await h.connect(),source=a.sourceId!;
    const before=h.store.db.prepare('SELECT cipher,nonce FROM credentials WHERE id=?').get(a.id);
    h.setExpiry(null);await assert.rejects(h.credentials.replace(h.alice.id,a.id,'fixture-next-secret'),/credential_expiry_confirmation/);
    assert.deepEqual(h.store.db.prepare('SELECT cipher,nonce FROM credentials WHERE id=?').get(a.id),before);
    await h.credentials.replace(h.alice.id,a.id,'fixture-next-secret',{allowNoExpiry:true});
    h.setAccount('2'.repeat(24));await assert.rejects(h.credentials.replace(h.alice.id,a.id,'fixture-next-secret',{allowNoExpiry:true}),/credential_account_mismatch/);h.setAccount('1'.repeat(24));
    h.delay();h.sources.start();h.clock.tick();await settle();h.setUsage('9000000');h.credentials.remove(h.alice.id,a.id);h.finish();await settle();
    assert.equal(h.store.holds(h.alice.id,source),false);assert.equal(h.store.state(source).meters?.find(m=>m.id==='usage')?.amount,'1000000');
  }finally{h.sources.stop();h.store.close();}
});

test('refresh joins a running job, shares a source cooldown, and fixed plans set freshness before commit',async()=>{
  const h=harness();try {
    const a=await h.connect(),source=a.sourceId!;h.store.setMeasureInterval(source,900_000);
    h.delay();h.sources.start();h.clock.tick();await settle();
    assert.equal(h.calls,1);assert.equal(h.sources.requestRefresh(source,h.clock.now()).status,'accepted');assert.equal(h.sources.requestRefresh(source,h.clock.now()).status,'accepted');
    h.clock.tick(1);h.finish();await settle();
    assert.equal(h.sources.refresh(source,h.clock.now()).value.request?.status,'updated');
    assert.equal(h.sources.requestRefresh(source,h.clock.now()).status,'too_soon');
    assert.equal(h.store.state(source).staleAfterMs,1_140_000);
    assert.equal(h.sources.cadence(source).value?.why,'fixed');
    assert.equal(h.sources.cadence(source).value?.next,h.clock.now()+900_000);
  }finally{h.sources.stop();h.store.close();}
});

test('permanent access failure preserves numbers and turns automatic retry off',async()=>{
  const h=harness();try {
    const a=await h.connect(),source=a.sourceId!;h.revoke();h.sources.start();h.clock.tick();await settle();
    assert.equal(h.store.state(source).error,'credential_revoked');assert.equal(h.store.state(source).meters?.find(m=>m.id==='usage')?.amount,'1000000');
    assert.equal(h.sources.cadence(source).value,null);h.clock.tick(3_600_000);await settle();assert.equal(h.calls,1);
    assert.equal(h.credentials.access(h.alice.id,source)?.error,'credential_revoked');
  }finally{h.sources.stop();h.store.close();}
});

test('polling updates known expiry metadata without confusing it with unknown expiry',async()=>{
  const h=harness();try {
    h.setExpiry(null);const record=await h.connect(),source=record.sourceId!;assert.equal(record.expiryKind,'none');
    h.setExpiry(h.clock.now()+90_000);h.clock.tick(1);await h.credentials.measure(source);
    assert.equal(h.credentials.list(h.alice.id)[0].expiryKind,'at');assert.equal(h.credentials.access(h.alice.id,source)?.expiryKind,'at');
    h.setExpiry(null);h.clock.tick(1);await h.credentials.measure(source);
    assert.equal(h.credentials.list(h.alice.id)[0].expiryKind,'none');assert.equal(h.credentials.access(h.alice.id,source)?.expiryKind,'none');
  }finally{h.sources.stop();h.store.close();}
});
