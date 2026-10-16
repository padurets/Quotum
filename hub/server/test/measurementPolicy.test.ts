import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest, type Credential} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {newSecret} from '../domain/auth.js';
import {admitMeasurement, type AttemptContext, type Participation} from '../domain/measurementPolicy.js';
import {PolicyError, RECEIPT_LIFETIME_MS} from '../store/measurementPolicies.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentVersion,compareVersions} from '../domain/versions.js';
import {buildApp} from '../api.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {Events,type Frame} from '../events.js';

const now = Date.UTC(2026,9,11), account = 'a'.repeat(24);
const desired = (enabled = true): Participation => ({enabled,collectors:{claude:true,codex:true,antigravity:true}});
function setup() {
  const store = new Store(':memory:',now), directory = new Directory(store.db), duty = new Duty(), cadence = new Cadence();
  const ingest = new Ingest(store,directory,duty,cadence);
  const user = directory.createUser('alice@example.com','Alice','x',now), secret = newSecret('qt_m');
  directory.createToken(secret,'fixture',user.id,'Fixture',now);
  const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const sender = {version:1,agent:'quotum/0.7.0',machine:{id:'measurement-machine-012345',name:'A',os:'linux',arch:'x86_64'}};
  ingest.checkin(credential,{...sender,subscriptions:[]},now);
  const device = directory.devices(user.id)[0].id;
  const batch = (at:number,extra:object = {}) => ({...sender,sentAt:new Date(at).toISOString(),failures:[],snapshots:[{provider:'codex',account,observedAt:new Date(at).toISOString(),via:'fixture',staleAfterMs:204_000,windows:[{id:'weekly',kind:'weekly',minutes:10080,usedPercent:10,resetsAt:null}],...extra}]});
  return {store,directory,duty,cadence,ingest,credential,sender,user,device,batch};
}

for(const mode of ['paced','legacy','paused'] as const) {
  test(`a ${mode} candidate retains account evidence through its instructed check-in deadline`,()=>{
    const {store,ingest,credential,sender,batch,directory,user,cadence}=setup();
    try {
      ingest.accept(credential,batch(now,{staleAfterMs:3*3_600_000}),now);
      const source=store.held(user.id)[0].id,other={...sender,machine:{...sender.machine,id:'waiting-machine-012345',name:'B'}};
      ingest.checkin(credential,{...other,subscriptions:[]},now);
      const device=directory.devices(user.id).find(device=>device.name==='B')!.id;
      if(mode==='paused')cadence.failed(account,device,'not_logged_in',now+1);
      const answer=ingest.checkin(credential,{...other,paced:mode!=='legacy',subscriptions:[{provider:'codex',account,active:false}]},now+1).subscriptions[0];
      assert.equal(answer.measure,false,mode);
      const until=Date.parse(answer.until);
      assert.ok(until>now+240_000,`${mode} exercises a wait longer than the provisional evidence`);
      store.measurementPolicies.savePreference(source,0,device);
      for(const at of [now+240_002,until-1,until]) {
        assert.equal(ingest.measurementSelection.reason(account,'codex',device,at),mode==='paused'?'paused':'eligible',`${mode} at ${at}`);
        if(mode!=='paused')assert.equal(ingest.measurementSelection.preferred(source,'codex',account,at),device,`${mode} preference survives the allowed wait`);
      }
      assert.equal(ingest.measurementSelection.reason(account,'codex',device,until+120_000),'offline',`${mode} evidence still expires`);
    }finally{store.close();}
  });
}

test('effective collector epochs survive re-enable and invalidate only the changed gate',()=>{
  const {store,device} = setup(), policies = store.measurementPolicies;
  const initial = policies.device(device);
  const off = desired(); off.collectors.claude = false;
  const saved = policies.saveDevice(device,0,off,now).policy;
  assert.equal(saved.collectors.claude.epoch,1);
  assert.equal(saved.collectors.codex.epoch,0);
  assert.equal(admitMeasurement(saved,'claude',null),'disabled');
  assert.equal(admitMeasurement(saved,'codex',null),'accepted');
  const restored = policies.saveDevice(device,1,desired(),now+1000).policy;
  assert.equal(admitMeasurement(restored,'claude',null),'epoch_required');
  assert.equal(admitMeasurement(restored,'claude',{version:1,authority:initial.authority,collectorEpoch:0,target:{kind:'unknown'}}),'epoch_mismatch');
  assert.equal(admitMeasurement(restored,'claude',{version:1,authority:restored.authority,collectorEpoch:2,target:{kind:'unknown'}}),'accepted');
  policies.saveDevice(device,2,desired(false),now+2000);
  const masked = desired(false); masked.collectors.codex = false;
  const before = policies.device(device);
  const result = policies.saveDevice(device,3,masked,now+3000);
  assert.deepEqual(result.changed,[]);
  assert.equal(result.policy.collectors.codex.epoch,before.collectors.codex.epoch);
  assert.throws(()=>policies.saveDevice(device,3,masked,now+4000),/measurement_conflict/,'stale no-op is rejected');
  store.close();
});

test('lost-reply replay returns its historical revision without undoing a later preference clear',()=>{
  const {store,user,device} = setup(), policies = store.measurementPolicies, operation = randomUUID();
  const payload = ['preference','source',0,device];
  const original = policies.mutate(user.id,operation,payload,now,()=>policies.savePreference('source',0,device));
  policies.savePreference('source',1,null);
  const replay = policies.mutate(user.id,operation,payload,now+1000,()=>{throw Error('must not apply');});
  assert.equal(replay.replayed,true); assert.deepEqual(replay.result,original.result);
  assert.deepEqual(policies.preference('source'),{revision:2,device:null});
  assert.throws(()=>policies.mutate(user.id,operation,['changed'],now+2000,()=>null),/mutation_conflict/);
  assert.throws(()=>policies.mutate(user.id,operation,payload,now+RECEIPT_LIFETIME_MS,()=>policies.savePreference('source',0,device)),/measurement_conflict/);
  assert.throws(()=>policies.mutate(user.id,randomUUID(),['rollback'],now,()=>{policies.savePreference('source',2,device);throw Error('rollback');}),/rollback/);
  assert.deepEqual(policies.preference('source'),{revision:2,device:null});
  store.close();
});

test('receipt capacity does not evict a still valid operation or apply its mutation',()=>{
  const {store,user} = setup(), policies = store.measurementPolicies;
  for (let i=0;i<1024;i++) policies.mutate(user.id,randomUUID(),[i],now,()=>i);
  let applied = false;
  assert.throws(()=>policies.mutate(user.id,randomUUID(),[],now+1000,()=>{applied=true;}),error=>error instanceof PolicyError && error.code==='mutation_capacity' && error.retryAfter===604799);
  assert.equal(applied,false);
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM measurement_mutations').get()!.n),1024);
  const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT count(*) AS n,min(created_at) AS first FROM measurement_mutations WHERE writer=? AND created_at>?').all(user.id,now-RECEIPT_LIFETIME_MS);
  assert.ok(plan.some(row=>/SEARCH measurement_mutations .*writer=\? AND created_at>\?/.test(String(row.detail))),JSON.stringify(plan));
  store.close();
});

test('a persisted receipt and authority survive restart without replaying a disabled-period policy',()=>{
  const folder=mkdtempSync(join(tmpdir(),'quotum-policy-receipt-')),file=join(folder,'db.sqlite'),operation=randomUUID();
  try {
    const first=new Store(file,now),policies=first.measurementPolicies,authority=policies.authority;
    const payload=['participation','fixture',0,desired(false)];
    const original=policies.mutate('owner',operation,payload,now,()=>({revision:policies.saveDevice('fixture',0,desired(false),now).policy.revision}));
    policies.saveDevice('fixture',1,desired(),now+1);first.close();
    const restarted=new Store(file,now+2);
    const replay=restarted.measurementPolicies.mutate('owner',operation,payload,now+2,()=>{throw Error('replayed effect');});
    assert.equal(restarted.measurementPolicies.authority,authority);
    assert.deepEqual(replay.result,original.result);assert.equal(replay.replayed,true);
    const current=restarted.measurementPolicies.device('fixture');assert.equal(current.enabled,true);assert.equal(current.revision,2);assert.equal(current.collectors.codex.epoch,2);assert.equal(admitMeasurement(current,'codex',null),'epoch_required');
    restarted.close();
  }finally{rmSync(folder,{recursive:true});}
});

test('denied and disabled-period traffic has no source effects and a mixed batch drains allowed items',()=>{
  const {store,ingest,credential,device,batch,user,duty} = setup();
  store.measurementPolicies.saveDevice(device,0,{...desired(),collectors:{claude:true,codex:false,antigravity:true}},now);
  const denied = ingest.accept(credential,batch(now+1000),now+1000);
  assert.equal(denied.policySuppressed,1);
  assert.equal(store.held(user.id).length,0); assert.equal(duty.holder(account),null);
  const mixed = batch(now+2000); mixed.snapshots.push({...mixed.snapshots[0],provider:'claude'});
  assert.equal(ingest.accept(credential,mixed,now+2000).accepted,1);
  store.measurementPolicies.saveDevice(device,1,desired(),now+3000);
  // A frozen legacy packet with corrected future sentAt still cannot prove a fresh launch.
  assert.equal(ingest.accept(credential,batch(now+4000),now+4000).policySuppressed,1);
  const policy = store.measurementPolicies.device(device);
  const context = {version:1,authority:policy.authority,collectorEpoch:policy.collectors.codex.epoch,target:{kind:'verified',accountKey:account}};
  assert.equal(ingest.accept(credential,batch(now+5000,{attemptContext:context}),now+5000).accepted,1);
  assert.equal(store.held(user.id).length,2);
  store.close();
});

test('legacy provider-only errors are private diagnostics and cannot fail the previously bound account',()=>{
  const {store,ingest,credential,device,batch} = setup();
  ingest.accept(credential,batch(now),now);
  const source = store.findSource('codex',account)!;
  const packet = batch(now+300_000); packet.snapshots=[];
  const result = ingest.accept(credential,{...packet,failures:[{provider:'codex',observedAt:new Date(now+300_000).toISOString(),error:'not_logged_in'}]},now+300_000);
  assert.equal(result.failures,0); assert.equal(store.state(source).error,null);
  assert.equal(store.db.prepare('SELECT error FROM device_failures WHERE device_id=?').get(device)!.error,'not_logged_in');
  store.close();
});

test('ordinary maintenance evicts expired account evidence without changing holdings or readings',()=>{
  const {store,ingest,user,device,credential,batch}=setup();
  ingest.accept(credential,batch(now),now);const source=store.held(user.id)[0].id;
  assert.equal(ingest.measurementSelection.prune(now+239_999),0);
  assert.equal(ingest.measurementSelection.prune(now+240_000),1);
  assert.equal(ingest.measurementSelection.prune(now+240_001),0);
  assert.equal(ingest.measurementSelection.reason(account,'codex',device,now+240_001),'account_unknown');
  assert.equal(store.holds(user.id,source),true);assert.equal(store.state(source).windows[0].used,10);store.close();
});

test('disabling measurements preserves client tracking, subscription holdings and installed observation time',()=>{
  const {store,directory,ingest,credential,sender,user,device,batch}=setup();
  ingest.accept(credential,batch(now),now);const source=store.held(user.id)[0].id;
  const report=(at:number)=>({...sender,sentAt:new Date(at).toISOString(),sessions:[{provider:'codex',account,clientId:'codex',sessionId:'c'.repeat(32),origin:'terminal',project:'Fixture',startedAt:new Date(now).toISOString(),working:true}],clients:[{clientId:'codex',version:'1.2.3',observedAt:new Date(now).toISOString()}]});
  ingest.sessions(credential,report(now),now);
  const before=ingest.live.of(source,[user.id],now)[0];
  const result=store.measurementPolicies.saveDevice(device,0,desired(false),now+1);ingest.participationChanged(device,result.changed,now+1);
  assert.equal(ingest.accept(credential,batch(now+15_000),now+15_000).policySuppressed,1);
  ingest.sessions(credential,report(now+15_000),now+15_000);
  const after=ingest.live.of(source,[user.id],now+15_000)[0];
  assert.deepEqual(after.device,before.device);assert.equal(after.startedAt,before.startedAt);assert.equal(after.project,before.project);assert.equal(after.workedMs,15_000);assert.equal(after.working,true);
  assert.equal(store.holds(user.id,source),true);assert.equal(store.state(source).windows[0].used,10);
  assert.equal(directory.deviceClients(device)[0].observedAt,now);store.close();
});

test('missing modern command ID accepts fresh data and completes refresh while leaving its issued command unanswered',()=>{
  const {store,ingest,credential,sender,device,batch,user} = setup();
  ingest.accept(credential,batch(now),now);
  const source = store.held(user.id)[0].id;
  const checkin = ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},now+120_000);
  assert.ok(checkin.subscriptions[0].commandId);
  assert.equal(ingest.requestRefresh(source,now+120_001).status,'accepted');
  const policy = store.measurementPolicies.device(device);
  const attemptContext = {version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account}};
  assert.equal(ingest.accept(credential,batch(now+120_010,{attemptContext}),now+120_010).accepted,1);
  assert.equal(ingest.refresh(source,now+120_010).value.request?.status,'updated');
  // The data refreshes the ordinary plan, but cannot silently acknowledge the modern command.
  assert.equal(ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},now+120_020).subscriptions[0].measure,false);
  store.close();
});

test('preference waits for the issued command, rejects new refreshes, then claims safely and falls back on account change',()=>{
  const h=setup(),{ingest,store,credential,sender,batch,device,duty,user}=h;
  ingest.accept(credential,batch(now),now);
  const source=store.held(user.id)[0].id;
  const other={...sender,machine:{...sender.machine,id:'measurement-machine-other-012345',name:'B'}};
  ingest.checkin(credential,{...other,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},now+1);
  const b=h.directory.devices(user.id).find(d=>d.name==='B')!.id;
  const ask=(who:typeof sender,at:number)=>ingest.checkin(credential,{...who,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},at);
  const command=ask(sender,now+120_000).subscriptions[0].commandId!;
  ask(other,now+120_001);
  store.measurementPolicies.savePreference(source,0,b);
  assert.equal(ingest.refresh(source,now+120_002).value.unavailable,'handover_pending');
  assert.deepEqual(ingest.requestRefresh(source,now+120_002),{status:'unavailable',reason:'handover_pending'});
  assert.equal(ask(other,now+120_003).subscriptions[0].onDuty,false);
  assert.equal(duty.holder(account),device);
  const policy=store.measurementPolicies.device(device);
  ingest.accept(credential,batch(now+120_004,{attemptContext:{version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account},commandId:command}}),now+120_004);
  assert.equal(ask(other,now+120_005).subscriptions[0].onDuty,true);
  assert.equal(duty.holder(account),b);
  assert.equal(ingest.measurementSources(user.id,now+120_005)[0].pending,false);
  // The current login changes. Its old historical binding cannot remain a candidate.
  ingest.checkin(credential,{...other,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account:'b'.repeat(24)}]},now+120_006);
  assert.equal(ingest.measurementSelection.reason(account,'codex',b,now+120_006),'account_unknown');
  assert.equal(ask(sender,now+120_007).subscriptions[0].onDuty,true);
  assert.equal(ingest.refresh(source,now+120_007).value.unavailable,null,'stable fallback remains refreshable');
  store.close();
});

test('a missing capability cannot downgrade an issued command and a mismatched failure cannot finish its refresh',()=>{
  const {store,ingest,credential,sender,batch,user,device}=setup();
  ingest.accept(credential,batch(now),now);const source=store.held(user.id)[0].id;
  const issued=ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},now+120_000);
  const commandId=issued.subscriptions[0].commandId!,policy=store.measurementPolicies.device(device);
  ingest.requestRefresh(source,now+120_001);
  ingest.checkin(credential,{...sender,paced:true,subscriptions:[{provider:'codex',account}]},now+120_002);
  assert.equal(ingest.measurementSelection.acknowledges(account,'codex',device,now+120_003,null,true),false);
  const attemptContext={version:1 as const,authority:policy.authority,collectorEpoch:0,target:{kind:'verified' as const,accountKey:account},commandId:randomUUID()};
  const fail=(at:number,commandId:string)=>ingest.accept(credential,{...sender,sentAt:new Date(at).toISOString(),snapshots:[],failures:[{provider:'codex',observedAt:new Date(at).toISOString(),error:'timeout',attemptContext:{...attemptContext,commandId}}]},at);
  fail(now+250_000,attemptContext.commandId);
  assert.equal(ingest.refresh(source,now+250_000).value.request?.status,'waiting');
  fail(now+250_001,commandId);
  assert.equal(ingest.refresh(source,now+250_001).value.request?.status,'failed');
  store.close();
});

test('a dispatched refresh retains A and its deadline across a safe preference handover; fresh B data completes it',()=>{
  const {store,directory,ingest,credential,sender,batch,user,device,duty}=setup();
  ingest.accept(credential,batch(now),now);const source=store.held(user.id)[0].id;
  const other={...sender,machine:{...sender.machine,id:'retained-machine-B-012345',name:'B'}};
  const ask=(machine:typeof sender,at:number)=>ingest.checkin(credential,{...machine,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},at);
  const commandId=ask(sender,now+120_000).subscriptions[0].commandId!;
  ask(other,now+370_000);const b=directory.devices(user.id).find(d=>d.name==='B')!.id;
  assert.equal(ingest.requestRefresh(source,now+370_001).status,'accepted');
  const original=ingest.refresh(source,now+370_001).value.request!;
  store.measurementPolicies.savePreference(source,0,b);
  ask(other,now+420_000);
  assert.equal(duty.holder(account),b);
  const retained=ingest.refresh(source,now+420_001).value.request!;
  assert.equal(retained.status,'waiting');assert.equal(retained.dispatchAt,original.dispatchAt);assert.equal(retained.deadline,original.deadline);
  const policy=store.measurementPolicies.device(b),attemptContext={version:1 as const,authority:policy.authority,collectorEpoch:0,target:{kind:'verified' as const,accountKey:account}};
  ingest.accept(credential,{...batch(now+420_002,{attemptContext}),machine:other.machine},now+420_002);
  assert.equal(ingest.refresh(source,now+420_002).value.request?.status,'updated');
  assert.equal(ingest.measurementSelection.acknowledges(account,'codex',b,now+420_002,{...attemptContext,commandId},true),false,'B data cannot acknowledge A');
  assert.notEqual(device,b);store.close();
});

test('accepted unavailable and equal observations keep independent producers across restart',()=>{
  const folder=mkdtempSync(join(tmpdir(),'quotum-origins-')),file=join(folder,'db.sqlite');
  const store=new Store(file,now),directory=new Directory(store.db),ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const user=directory.createUser('origins@example.com','Owner','x',now),secret=newSecret('qt_m');
  directory.createToken(secret,'fixture',user.id,'Fixture',now);
  const credential=ingest.authenticate(`Bearer ${secret}`) as Credential;
  const send=(name:string,at:number,status:'observed'|'missing')=>ingest.accept(credential,{version:1,agent:'fixture',machine:{id:`origins-machine-${name}-012345`,name,os:'linux',arch:'x'},sentAt:new Date(at).toISOString(),failures:[],snapshots:[{provider:'codex',account,observedAt:new Date(at).toISOString(),via:'fixture',client:'1.2.3',clientEvidence:'nativeHandshake',staleAfterMs:204_000,resourceStatus:{windows:status,resets:'unsupported'},windows:status==='observed'?[{id:'weekly',kind:'weekly',usedPercent:10}]:[]}]},at);
  try {
    send('A',now,'observed');const source=store.held(user.id)[0].id,a=directory.devices(user.id)[0].id;
    send('B',now+1000,'missing');const b=directory.devices(user.id).find(d=>d.name==='B')!.id;
    assert.equal(store.state(source).windows[0].used,10);
    assert.equal(store.resourceOrigins(source).find(o=>o.resource==='windows')!.valueOrigin!.device,a);
    assert.equal(store.resourceOrigins(source).find(o=>o.resource==='windows')!.observationOrigin!.device,b);
    store.close();const restarted=new Store(file,now+1001);
    assert.equal(restarted.resourceOrigins(source).find(o=>o.resource==='windows')!.valueOrigin!.device,a);
    assert.equal(restarted.resourceOrigins(source).find(o=>o.resource==='windows')!.observationOrigin!.device,b);restarted.close();
    // Reopen the same store service after proving persistence, then an equal finite sample is a new anchor.
    const final=new Store(file,now+1002),again=new Ingest(final,new Directory(final.db),new Duty(),new Cadence());
    const packet={version:1,agent:'fixture',machine:{id:'origins-machine-C-012345',name:'C',os:'linux',arch:'x'},sentAt:new Date(now+2000).toISOString(),failures:[],snapshots:[{provider:'codex',account,observedAt:new Date(now+2000).toISOString(),via:'fixture',client:'1.2.4',clientEvidence:'nativeHandshake',staleAfterMs:204_000,windows:[{id:'weekly',kind:'weekly',usedPercent:10}]}]};
    again.accept(again.authenticate(`Bearer ${secret}`) as Credential,packet,now+2000);
    const origin=final.resourceOrigins(source).find(o=>o.resource==='windows')!;assert.ok(origin.valueOrigin);assert.ok(origin.observationOrigin);assert.equal(origin.valueOrigin.device,origin.observationOrigin.device);assert.equal(origin.valueOrigin.client,'1.2.4');assert.equal(origin.valueOrigin.at,now+2000);final.close();
  }finally{rmSync(folder,{recursive:true});}
});

test('semantic versions distinguish prereleases, build metadata, and malformed reports',()=>{
  assert.equal(compareVersions('0.7.0-rc.2','0.7.0-rc.10'),-1);
  assert.equal(compareVersions('0.7.0-rc.10','0.7.0'),-1);
  assert.equal(compareVersions('0.7.0+one','0.7.0+two'),0);
  assert.equal(compareVersions('0.8.0','0.7.0'),1);
  for(const value of ['01.7.0','0.7','x0.7.0','0.7.0-01'])assert.equal(compareVersions(value,'0.7.0'),null);
  assert.equal(agentVersion('quotum/0.7.0'),'0.7.0');assert.equal(agentVersion('fixture'),null);
});

test('quota, resets and exact subscription funds retain independent value and observation producers',()=>{
  const {store,ingest,credential,sender,user,batch}=setup();
  const send=(name:string,at:number,extra:object)=>ingest.accept(credential,{...batch(at,{client:'1.2.3',clientEvidence:'nativeHandshake',...extra}),machine:{...sender.machine,id:`independent-${name}-0123456789`,name}},at);
  const balance=(status:string,amount?:string)=>[{id:'balance:credits',unit:'credits:codex',status,...(amount===undefined?{}:{amount})}];
  const a=send('A',now,{resets:{available:2},balances:balance('finite','9.2500')}).device.id;
  const b=send('B',now+1000,{windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:balance('finite','1.2300')}).device.id;
  const source=store.held(user.id)[0].id;
  let origins=store.resourceOrigins(source);
  for(const resource of ['windows','resets']) {assert.equal(origins.find(o=>o.resource===resource)!.valueOrigin!.device,a);assert.equal(origins.find(o=>o.resource===resource)!.observationOrigin!.device,b);}
  assert.equal(origins.find(o=>o.resource==='funds')!.valueOrigin!.device,b);
  const c=send('C',now+2000,{resets:{available:2},balances:balance('missing')}).device.id;
  origins=store.resourceOrigins(source);
  for(const resource of ['windows','resets'])assert.equal(origins.find(o=>o.resource===resource)!.valueOrigin!.device,c);
  assert.equal(origins.find(o=>o.resource==='funds')!.valueOrigin!.device,b);assert.equal(origins.find(o=>o.resource==='funds')!.observationOrigin!.device,c);
  assert.equal(store.state(source).meters?.[0].amount,'123');
  assert.equal(store.state(source).creditBalance?.status,'missing');store.close();
});

test('the API rechecks ownership and holding on receipts, rejects concurrent revisions, and hides foreign preferences',async t=>{
  const h=setup(),{store,directory,ingest,user,credential,batch,sender,device}=h,at=Date.now();
  t.after(()=>store.close());
  ingest.accept(credential,batch(at),at);const source=store.held(user.id)[0].id;
  ingest.checkin(credential,{...sender,paced:true,subscriptions:[{provider:'codex',account}]},at);
  const bob=directory.createUser('bob@example.com','Bob','x',at);store.hold(source,bob.id,at);
  const app=await buildApp({store,directory,ingest,resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,'unused'),local:null});t.after(()=>app.close());
  const cookies=new Map([user,bob].map(person=>{const secret=newSecret('qt_s');directory.createSession(secret,person.id,at,86_400_000);return [person.id,'quotum_session='+secret];}));
  const post=(as:string,path:string,body:object)=>app.inject({method:'POST',url:path,payload:body,headers:{cookie:cookies.get(as)!,origin:'http://localhost'}});
  const preference=`/api/sources/${source}/measurement-preference`,input={operationId:randomUUID(),expectedRevision:0,desired:device};
  const saved=await post(user.id,preference,input);assert.equal(saved.statusCode,200,saved.body);
  const projection=await app.inject({method:'GET',url:'/api/devices?measurement=1',headers:{cookie:cookies.get(bob.id)!}});
  assert.equal(projection.json().sources[0].preference.device,null);
  assert.equal(JSON.stringify(projection.json()).includes(device),false,'foreign device ID is never projected');
  const clear=await post(bob.id,preference,{operationId:randomUUID(),expectedRevision:1,desired:null});assert.equal(clear.statusCode,200,clear.body);
  const stale=await post(user.id,preference,{...input,operationId:randomUUID()});assert.equal(stale.statusCode,409);
  const replay=await post(user.id,preference,input);assert.equal(replay.statusCode,200);assert.deepEqual(replay.json(),{result:{appliedRevision:1},replayed:true});
  assert.equal(store.measurementPolicies.preference(source).device,null);
  assert.equal((await post(bob.id,`/api/devices/${device}/measurement-policy`,{operationId:randomUUID(),expectedRevision:0,desired:desired(false)})).statusCode,404);
  store.db.prepare('DELETE FROM holders WHERE user_id=? AND source_id=?').run(user.id,source);
  assert.equal((await post(user.id,preference,input)).statusCode,404,'historical receipt grants no holding');
});

test('contacts are coalesced for their owner, semantic changes stay separate, and revoked contacts disappear before flush',t=>{
  const h=setup(),{store,directory,ingest,user,credential,sender,device}=h;
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>now,after:()=>()=>{}});events.attach();
  t.after(()=>{events.close();store.close();});
  const aliceSecret=newSecret('qt_s'),bob=directory.createUser('event-bob@example.com','Bob','x',now),bobSecret=newSecret('qt_s');
  directory.createSession(aliceSecret,user.id,now,86_400_000);directory.createSession(bobSecret,bob.id,now,86_400_000);
  const received:Frame[][]=[[],[]];
  for(const [index,person,secret] of [[0,user,aliceSecret],[1,bob,bobSecret]] as const) {
    events.open({user:person.id,secret,board:directory.boards(person.id)[0].id,kind:'stream',send:frames=>received[index].push(...frames),end:()=>{}});
  }
  events.flush();for(const frames of received)frames.length=0;
  for(let i=1;i<=10;i++)ingest.checkin(credential,{...sender,subscriptions:[]},now+i);
  events.flush();
  assert.deepEqual(received[0].filter(f=>f.type==='deviceContacts').map(f=>JSON.parse(f.data)),[{devices:[{deviceId:device,lastSeenAt:now+10}]}]);
  assert.equal(received[0].some(f=>f.type==='devices'),false);
  assert.equal(received[1].some(f=>f.type==='deviceContacts'||f.type==='devices'),false);
  for(const frames of received)frames.length=0;
  directory.measurementsChanged(user.id);directory.measurementsChanged(user.id);events.flush();
  assert.equal(received[0].filter(f=>f.type==='devices').length,1);
  for(const frames of received)frames.length=0;
  ingest.sessions(credential,{...sender,agent:'quotum/0.7.1',sentAt:new Date(now+11).toISOString(),sessions:[{provider:'codex',account:null,origin:'terminal',project:'Fixture',startedAt:new Date(now).toISOString(),working:false}]},now+11);
  events.flush();
  assert.equal(received[0].filter(f=>f.type==='devices').length,1,'inventory and session changes share one owner hint');
  assert.equal(received[1].some(f=>f.type==='devices'||f.type==='deviceContacts'),false);
  for(const frames of received)frames.length=0;
  ingest.checkin(credential,{...sender,subscriptions:[]},now+20);directory.revokeDevice(user.id,device,now+21);events.flush();
  assert.equal(received[0].some(f=>f.type==='deviceContacts'),false);
});

test('delayed data from a previous login cannot restore its measurement duty',()=>{
  const {store,directory,user,duty,ingest,credential,sender,device,batch}=setup();
  ingest.accept(credential,batch(now),now);
  ingest.checkin(credential,{...sender,subscriptions:[{provider:'codex',account:'b'.repeat(24)}]},now+2000);
  assert.equal(duty.holder(account),null);
  assert.equal(ingest.accept(credential,batch(now+1000),now+3000).accepted,1,'the older numeric observation is still useful');
  assert.equal(ingest.measurementSelection.reason(account,'codex',device,now+3000),'account_unknown');
  assert.equal(duty.holder(account),null,'historical resources do not prove the current login');
  const b={...sender,machine:{...sender.machine,id:'measurement-machine-B012345'}};
  ingest.checkin(credential,{...b,paced:true,subscriptions:[{provider:'codex',account}]},now+4000);
  assert.equal(duty.holder(account),directory.devices(user.id).find(candidate=>candidate.id!==device)!.id);
  store.close();
});

test('resource diagnostics use the reported quota observation for every client provider',()=>{
  for(const provider of ['claude','codex','antigravity'] as const) {
    const {store,ingest,credential,user,batch}=setup(),input=batch(now);
    ingest.accept(credential,{...input,snapshots:input.snapshots.map(snapshot=>({...snapshot,provider}))},now);
    const origin=ingest.measurementSources(user.id,now)[0].origins.find(origin=>origin.resource==='windows')!;
    assert.equal(origin.status,'observed',provider);assert.equal(origin.stale,false,provider);assert.equal(origin.staleAt,now+204000,provider);
    assert.equal(ingest.measurementSources(user.id,now+204001)[0].origins[0].stale,true,provider);
    store.close();
  }
});

test('a long-lived retained quota does not extend expired account evidence on backlog delivery',()=>{
  const {store,ingest,duty,credential,batch}=setup();
  ingest.accept(credential,batch(now),now);
  assert.equal(ingest.accept(credential,{...batch(now+1000,{staleAfterMs:86400000}),sentAt:new Date(now+600000).toISOString()},now+600000).accepted,1);
  assert.ok((duty.until(account)??0)<=now+600000,'the resource promise is not a current-account lease');
  store.close();
});

test('a dispatched refresh retains its failure binding without acknowledging the new holder command',()=>{
  const {store,ingest,user,duty,credential,sender,device,batch}=setup();
  ingest.accept(credential,batch(now),now);
  const source=store.held(user.id)[0].id;
  const b={...sender,machine:{...sender.machine,id:'measurement-command-B012345'}};
  const ask=(machine:typeof sender,at:number)=>ingest.checkin(credential,{...machine,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},at);
  const a1=ask(sender,now+120000).subscriptions[0].commandId!;
  ask(b,now+120001);assert.equal(ingest.requestRefresh(source,now+120002).status,'accepted');
  ask(sender,now+120003);
  const target=ingest.measurementSources(user.id,now+120003)[0].candidates.find(candidate=>candidate.device!==device)!;
  store.measurementPolicies.savePreference(source,0,target.device);
  const b1=ask(b,now+120004).subscriptions[0].commandId!;assert.ok(b1);
  const policy=store.measurementPolicies.device(device),context:AttemptContext={version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account},commandId:a1};
  assert.equal(ingest.measurementSelection.acknowledges(account,'codex',device,now+120005,context,false),false);
  ingest.accept(credential,{...sender,sentAt:new Date(now+120005).toISOString(),snapshots:[],failures:[{provider:'codex',observedAt:new Date(now+120005).toISOString(),error:'timeout',attemptContext:context}]},now+120005);
  assert.equal(ingest.refresh(source,now+120005).value.request?.status,'failed');
  assert.equal(duty.holder(account),target.device,'A failure leaves B duty intact');
  const newPolicy=store.measurementPolicies.device(target.device);
  assert.equal(ingest.measurementSelection.acknowledges(account,'codex',target.device,now+120005,{version:1,authority:newPolicy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account},commandId:b1},true),true);
  store.close();
});

test('participation changes invalidate every holder private Devices view without sharing device identities',t=>{
  const {store,directory,ingest,user,device,batch,credential}=setup();ingest.accept(credential,batch(now),now);
  const source=store.held(user.id)[0].id,bob=directory.createUser('holder-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>now+1,after:()=>()=>{}});events.attach();
  t.after(()=>{events.close();store.close();});const secret=newSecret('qt_s');directory.createSession(secret,bob.id,now,86400000);const frames:Frame[]=[];
  events.open({user:bob.id,secret,board:directory.boards(bob.id)[0].id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  assert.equal(ingest.measurementSources(bob.id,now)[0].duty,'external');
  const changed=store.measurementPolicies.saveDevice(device,0,desired(false),now+1);ingest.participationChanged(device,changed.changed,now+1);events.flush();
  assert.equal(ingest.measurementSources(bob.id,now+1)[0].duty,'none');
  assert.deepEqual(frames.filter(frame=>frame.type==='devices').map(frame=>JSON.parse(frame.data)),[{}]);
  assert.equal(JSON.stringify(frames).includes(device),false,'the hint carries no foreign device ID');
});

test('a long poll rechecks a queued contact after the device is revoked',async t=>{
  const {store,directory,ingest,user,credential,sender,device}=setup();
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>now,after:()=>()=>{}});events.attach();
  t.after(()=>{events.close();store.close();});
  const secret=newSecret('qt_s');directory.createSession(secret,user.id,now,86_400_000);
  const reader={user:user.id,secret,board:directory.boards(user.id)[0].id};
  const first=await events.poll(reader,undefined);assert.ok(first && first!=='limit');
  const snapshot=JSON.parse(first.frames.find(frame=>frame.type==='snapshot')!.data);
  assert.equal(snapshot.deviceContacts[device],now);
  ingest.checkin(credential,{...sender,subscriptions:[]},now+10);events.flush();
  directory.revokeDevice(user.id,device,now+11);events.flush();
  const next=await events.poll(reader,first.lease);assert.ok(next && next!=='limit');
  assert.ok(next.frames.length>0,'revocation is delivered while its earlier contact is filtered');
  for(const frame of next.frames.filter(frame=>frame.type==='snapshot'))assert.equal(device in JSON.parse(frame.data).deviceContacts,false);
  assert.equal(next.frames.some(frame=>frame.type==='deviceContacts'),false,'revocation after enqueue prevents disclosure');
});

test('a multiplexed delivery preserves each account without reviving an obsolete login',()=>{
  const {store,ingest,user,duty,credential,device,batch,sender}=setup(),input=batch(now),other='b'.repeat(24);
  ingest.accept(credential,{...input,snapshots:[input.snapshots[0],{...input.snapshots[0],account:other,observedAt:new Date(now+1).toISOString()}]},now+1);
  for(const key of [account,other]){assert.equal(ingest.measurementSelection.reason(key,'codex',device,now+1),'eligible');assert.equal(duty.holder(key),device);}
  assert.equal(ingest.measurementSources(user.id,now+1).length,2);
  ingest.checkin(credential,{...sender,subscriptions:[{provider:'codex',account:'c'.repeat(24)}]},now+2000);
  ingest.accept(credential,{...input,sentAt:new Date(now+3000).toISOString(),snapshots:input.snapshots.concat({...input.snapshots[0],account:other,observedAt:new Date(now+1000).toISOString()})},now+3000);
  for(const key of [account,other]){assert.equal(ingest.measurementSelection.reason(key,'codex',device,now+3000),'account_unknown');assert.equal(duty.holder(key),null);}
  store.close();
});

test('inventory observation uses the report clock correction while legacy time stays unknown',()=>{
  for(const offset of [-3600000,3600000]) {
    const {store,directory,ingest,credential,sender,device}=setup();
    ingest.sessions(credential,{...sender,sentAt:new Date(now+offset).toISOString(),sessions:[],clients:[{clientId:'codex',version:'1.2.3',observedAt:new Date(now+offset-300000).toISOString()},{clientId:'claude',version:'2.0.0'}]},now);
    const clients=directory.deviceClients(device);assert.equal(clients.find(client=>client.clientId==='codex')!.observedAt,now-300000);
    assert.equal(clients.find(client=>client.clientId==='claude')!.observedAt,null);store.close();
  }
});

for(const action of ['revoke','failure'] as const)test(`${action} sends every holder the changed duty without foreign metadata`,t=>{
  const {store,directory,ingest,user,device,batch,credential,sender}=setup();ingest.accept(credential,batch(now),now);
  const at=now+120000,answer=ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},at);
  const source=store.held(user.id)[0].id,bob=directory.createUser('expiry-bob@example.com','Bob','x',at);store.hold(source,bob.id,at);
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>at+1,after:()=>()=>{}});events.attach();t.after(()=>{events.close();store.close();});
  const secret=newSecret('qt_s');directory.createSession(secret,bob.id,at,86400000);const frames:Frame[]=[];
  events.open({user:bob.id,secret,board:directory.boards(bob.id)[0].id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  assert.equal(ingest.measurementSources(bob.id,at)[0].duty,'external');
  if(action==='revoke'){directory.revokeDevice(user.id,device,at+1);store.releaseRevoked(user.id);ingest.forget([device],at+1);}
  else {const policy=store.measurementPolicies.device(device);ingest.accept(credential,{...sender,sentAt:new Date(at+1).toISOString(),snapshots:[],failures:[{provider:'codex',error:'timeout',observedAt:new Date(at+1).toISOString(),attemptContext:{version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account},commandId:answer.subscriptions[0].commandId}}]},at+1);}
  events.flush();assert.equal(ingest.measurementSources(bob.id,at+1)[0].duty,'none');
  assert.deepEqual(frames.filter(frame=>frame.type==='devices').map(frame=>JSON.parse(frame.data)),[{}]);assert.equal(JSON.stringify(frames).includes(device),false);
});

test('private measurement deadlines emit expiry without refetch hints for contact extensions',t=>{
  const {store,directory,ingest,user,batch,credential,sender}=setup();ingest.accept(credential,batch(now,{staleAfterMs:3600000}),now);
  let clock=now;const timers:{at:number;run:()=>void}[]=[];
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>clock,after:(ms,run)=>{const timer={at:clock+ms,run};timers.push(timer);return()=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);};}});events.attach();t.after(()=>{events.close();store.close();});
  const advance=(to:number)=>{for(let i=0;i<10000;i++){timers.sort((a,b)=>a.at-b.at);if(!timers.length||timers[0].at>to){clock=to;return;}const timer=timers.shift()!;clock=timer.at;timer.run();}throw Error('timer loop');};
  const secret=newSecret('qt_s');directory.createSession(secret,user.id,now,86400000);const frames:Frame[]=[];
  events.open({user:user.id,secret,board:directory.boards(user.id)[0].id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  advance(now+60000);ingest.checkin(credential,{...sender,subscriptions:[{provider:'codex',account}]},clock);events.flush();frames.length=0;
  const stable=ingest.measurementSelection.privateState(user.id,clock).value;
  advance(now+240001);events.flush();assert.deepEqual(ingest.measurementSelection.privateState(user.id,clock).value,stable);
  assert.equal(frames.filter(frame=>frame.type==='devices').length,0,'an extended heartbeat is not a semantic expiry');
  frames.length=0;advance(now+300001);events.flush();assert.equal(ingest.measurementSources(user.id,clock)[0].candidates[0].reason,'offline');
  assert.equal(frames.filter(frame=>frame.type==='devices').length,1,'actual candidate expiry reaches the open view');
});

for(const mode of ['pause','recovery'] as const)test(`preferred candidate ${mode} reaches holders watching another empty board`,t=>{
  const {store,directory,ingest,user,duty,credential,sender,device,batch}=setup();ingest.accept(credential,batch(now),now);
  const second={...sender,machine:{...sender.machine,id:'measurement-global-B012345'}};
  const ask=(machine:typeof sender,at:number)=>ingest.checkin(credential,{...machine,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},at);
  const waiting=ask(second,now+1).subscriptions[0];ask(sender,now+120000);
  const target=directory.devices(user.id).find(candidate=>candidate.id!==device)!.id,source=store.held(user.id)[0].id;
  store.measurementPolicies.savePreference(source,0,target);
  const at=mode==='pause'?now+120001:Date.parse(waiting.until)+120001,bob=directory.createUser('global-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const empty=directory.createBoard('Other board',bob.id,now),secret=newSecret('qt_s');directory.createSession(secret,bob.id,now,86400000);
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>at+1,after:()=>()=>{}});events.attach();t.after(()=>{events.close();store.close();});
  const frames:Frame[]=[];events.open({user:bob.id,secret,board:empty.id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  assert.equal(ingest.measurementSources(bob.id,at)[0].pending,mode==='pause');
  if(mode==='pause') {
    const policy=store.measurementPolicies.device(target);
    ingest.accept(credential,{...second,sentAt:new Date(at+1).toISOString(),snapshots:[],failures:[{provider:'codex',error:'timeout',observedAt:new Date(at+1).toISOString(),attemptContext:{version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account}}}]},at+1);
  }else {const answer=ask(second,at+1).subscriptions[0];assert.equal(answer.measure,false);assert.equal(answer.askInMs,15000);}
  events.flush();assert.equal(duty.holder(account),device,'the current issued measurement keeps its duty');
  assert.equal(ingest.measurementSources(bob.id,at+1)[0].pending,mode==='recovery');
  assert.deepEqual(frames.map(frame=>({type:frame.type,data:JSON.parse(frame.data)})),[{type:'devices',data:{}}]);
});

for(const paced of [false,true])test(`same-device duty recovery reaches another board with paced=${paced}`,t=>{
  const {store,directory,ingest,user,batch,credential,sender,duty,device}=setup();ingest.accept(credential,batch(now),now);
  const source=store.held(user.id)[0].id,bob=directory.createUser('duty-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const empty=directory.createBoard('Other board',bob.id,now),secret=newSecret('qt_s');directory.createSession(secret,bob.id,now,86400000);
  let clock=now+204001;
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>clock,after:()=>()=>{}});events.attach();t.after(()=>{events.close();store.close();});
  const frames:Frame[]=[];events.open({user:bob.id,secret,board:empty.id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  assert.equal(ingest.measurementSources(bob.id,clock)[0].duty,'none');assert.equal(duty.holder(account),device);
  clock=now+220000;
  assert.equal(ingest.checkin(credential,{...sender,paced,subscriptions:[{provider:'codex',account}]},clock).subscriptions[0].measure,true);
  events.flush();assert.equal(duty.holder(account),device);assert.equal(ingest.measurementSources(bob.id,clock)[0].duty,'external');
  assert.deepEqual(frames.map(frame=>({type:frame.type,data:JSON.parse(frame.data)})),[{type:'devices',data:{}}]);
});

for(const capable of [false,true])for(const empty of [false,true])test(`capability ${capable?'recovery':'loss'} reaches other holders with empty subscriptions=${empty}`,t=>{
  const {store,directory,ingest,user,batch,credential,sender,device}=setup();ingest.accept(credential,batch(now),now);
  const second={...sender,machine:{...sender.machine,id:'measurement-capability-B12345'}};
  const subscriptions=[{provider:'codex',account}];
  const ask=(modern:boolean,at:number,listed=subscriptions)=>ingest.checkin(credential,{...second,paced:true,...(modern?{capabilities:{measurementPolicy:1,attemptContext:1}}:{}),subscriptions:listed},at);
  ask(true,now+1);const target=directory.devices(user.id).find(candidate=>candidate.id!==device)!.id;
  for(const [revision,enabled] of [false,true].entries()) {
    const change=store.measurementPolicies.saveDevice(target,revision,desired(enabled),now+revision+2);
    ingest.participationChanged(target,change.changed,now+revision+2);
  }
  ask(true,now+4);
  ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions},now+120000);
  const source=store.held(user.id)[0].id;store.measurementPolicies.savePreference(source,0,target);
  if(capable)ask(false,now+120001);
  const bob=directory.createUser('capability-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const board=directory.createBoard('Other board',bob.id,now),secret=newSecret('qt_s');directory.createSession(secret,bob.id,now,86400000);
  let clock=now+120002;
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>clock,after:()=>()=>{}});events.attach();t.after(()=>{events.close();store.close();});
  const frames:Frame[]=[];events.open({user:bob.id,secret,board:board.id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  assert.equal(ingest.measurementSources(bob.id,clock)[0].pending,!capable);
  clock++;ask(capable,clock,empty?[]:subscriptions);events.flush();
  assert.equal(ingest.measurementSources(bob.id,clock)[0].pending,capable);
  assert.deepEqual(frames.map(frame=>({type:frame.type,data:JSON.parse(frame.data)})),[{type:'devices',data:{}}]);
});

test('an explicit local collector scope makes a preferred device unavailable without discarding its account',t=>{
  const {store,directory,ingest,user,batch,credential,sender,device}=setup();ingest.accept(credential,batch(now),now);
  const second={...sender,machine:{...sender.machine,id:'measurement-local-scope-B123'}};
  const ask=(at:number,extra:object={})=>ingest.checkin(credential,{...second,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[],...extra},at);
  ask(now+1,{subscriptions:[{provider:'codex',account}]});
  const target=directory.devices(user.id).find(candidate=>candidate.id!==device)!.id,source=store.held(user.id)[0].id;
  store.measurementPolicies.savePreference(source,0,target);
  const bob=directory.createUser('scope-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const board=directory.createBoard('Other board',bob.id,now),secret=newSecret('qt_s');directory.createSession(secret,bob.id,now,86400000);
  let clock=now+2;
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>clock,after:()=>()=>{}});events.attach();t.after(()=>{events.close();store.close();});
  const frames:Frame[]=[];events.open({user:bob.id,secret,board:board.id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  const seen=ingest.measurementSources(user.id,clock)[0].candidates.find(candidate=>candidate.device===target)!.seenAt;
  ask(clock,{collectors:['claude']});events.flush();
  const unavailable=ingest.measurementSources(user.id,clock)[0].candidates.find(candidate=>candidate.device===target)!;
  assert.equal(unavailable.reason,'not_configured');assert.equal(unavailable.seenAt,seen);
  assert.equal(ingest.measurementSources(bob.id,clock)[0].pending,false);
  assert.deepEqual(frames.map(frame=>({type:frame.type,data:JSON.parse(frame.data)})),[{type:'devices',data:{}}]);
  const fallback=ingest.checkin(credential,{...sender,paced:true,subscriptions:[{provider:'codex',account}]},now+120000).subscriptions[0];
  assert.equal(fallback.onDuty,true);assert.equal(ingest.refresh(source,now+120000).value.unavailable,null);
  for(const collectors of [[null],['future-collector']])ask(now+120001,{collectors});
  assert.equal(ingest.measurementSources(user.id,now+120001)[0].candidates.find(candidate=>candidate.device===target)!.reason,'not_configured','invalid or unsupported lists do not fabricate an empty scope');
  ask(now+120002,{collectors:['codex']});
  const restored=ingest.measurementSources(user.id,now+120002)[0].candidates.find(candidate=>candidate.device===target)!;
  assert.equal(restored.reason,'eligible');assert.equal(restored.seenAt,seen,'configuration alone never renews account evidence');
  assert.deepEqual(store.measurementPolicies.preference(source),{revision:1,device:target});
});

test('a locally absent collector releases idle duty and cannot receive a contradictory claim',()=>{
  const {store,ingest,user,batch,credential,sender,duty}=setup();ingest.accept(credential,batch(now),now);
  const denied=ingest.checkin(credential,{...sender,paced:true,collectors:[],subscriptions:[{provider:'codex',account}]},now+1);
  assert.equal(denied.subscriptions[0].measure,false);assert.equal(duty.holder(account),null);
  const other={...sender,machine:{...sender.machine,id:'measurement-local-fallback-12'}};
  assert.equal(ingest.checkin(credential,{...other,paced:true,subscriptions:[{provider:'codex',account}]},now+2).subscriptions[0].onDuty,true);
  assert.equal(store.state(store.held(user.id)[0].id).successAt,now);store.close();
});

test('local collector removal preserves issued work and its resource without renewing unavailable duty',()=>{
  const {store,ingest,user,batch,credential,sender,duty,device}=setup();ingest.accept(credential,batch(now),now);
  const source=store.held(user.id)[0].id;
  const answer=ingest.checkin(credential,{...sender,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]},now+120000).subscriptions[0];
  assert.equal(answer.measure,true);const until=duty.until(account);
  ingest.requestRefresh(source,now+120001);const original=ingest.refresh(source,now+120001).value.request!;
  ingest.checkin(credential,{...sender,collectors:[],capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[]},now+120002);
  assert.equal(duty.holder(account),device);assert.equal(duty.until(account),until);
  const retained=ingest.refresh(source,now+120002).value.request!;assert.equal(retained.deadline,original.deadline);assert.equal(retained.dispatchAt,original.dispatchAt);
  const policy=store.measurementPolicies.device(device),attemptContext={version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account},commandId:answer.commandId};
  assert.equal(ingest.accept(credential,batch(now+120003,{attemptContext,staleAfterMs:3*3600000}),now+120003).accepted,1);
  assert.equal(duty.holder(account),null);assert.equal(ingest.refresh(source,now+120003).value.request?.status,'updated');
  assert.equal(store.state(source).successAt,now+120003);store.close();
});

test('local scope changes reach an owner even before a device confirms any account',t=>{
  const {store,directory,ingest,user,batch,credential,sender,device}=setup();ingest.accept(credential,batch(now),now);
  const second={...sender,machine:{...sender.machine,id:'measurement-local-unknown-123'}};
  const contact={...second,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[]};ingest.checkin(credential,contact,now+1);
  const target=directory.devices(user.id).find(candidate=>candidate.id!==device)!.id;
  const board=directory.createBoard('Other board',user.id,now),secret=newSecret('qt_s');directory.createSession(secret,user.id,now,86400000);
  const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>now+2,after:()=>()=>{}});events.attach();t.after(()=>{events.close();store.close();});
  const frames:Frame[]=[];events.open({user:user.id,secret,board:board.id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();frames.length=0;
  ingest.checkin(credential,{...contact,collectors:[]},now+2);events.flush();
  assert.equal(ingest.measurementSources(user.id,now+2)[0].candidates.find(candidate=>candidate.device===target)!.reason,'not_configured');
  assert.equal(frames.filter(frame=>frame.type==='devices').length,1);
});

test('configuration expires independently of resource acceptance and current account evidence',()=>{
  const {store,ingest,user,batch,credential,sender}=setup();
  ingest.accept(credential,batch(now),now);ingest.checkin(credential,{...sender,collectors:[],subscriptions:[]},now+1);
  ingest.accept(credential,batch(now+700000),now+700000);
  assert.equal(ingest.measurementSources(user.id,now+700000)[0].candidates[0].reason,'not_configured','an in-flight resource does not overwrite a later configuration declaration');
  assert.equal(store.state(store.held(user.id)[0].id).successAt,now+700000);
  ingest.measurementSelection.prune(now+720002);
  assert.equal(ingest.measurementSources(user.id,now+720002)[0].candidates[0].reason,'eligible','expired configuration supplies no negative evidence');
  store.close();
});

for(const change of ['configuration','capability','participation','revoke','login','failure'] as const)test(`an unpreferred candidate ${change} change stays private when selection is unchanged`,t=>{
  const {store,directory,ingest,user,batch,credential,sender,device}=setup();ingest.accept(credential,batch(now),now);
  const second={...sender,machine:{...sender.machine,id:'measurement-private-B12345'}};
  const contact={...second,paced:true,collectors:['codex'],capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]};
  ingest.checkin(credential,contact,now+1);
  const target=directory.devices(user.id).find(candidate=>candidate.id!==device)!.id,source=store.held(user.id)[0].id;
  if(change==='capability')for(const [revision,enabled] of [false,true].entries()) {
    const saved=store.measurementPolicies.saveDevice(target,revision,desired(enabled),now+revision+2);
    ingest.participationChanged(target,saved.changed,now+revision+2);
  }
  if(change==='capability')ingest.checkin(credential,contact,now+4);
  const bob=directory.createUser('private-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const clock=now+10,events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>clock,after:()=>()=>{}});
  events.attach();t.after(()=>{events.close();store.close();});
  const frames=new Map<string,Frame[]>();
  for(const owner of [user,bob]) {
    const secret=newSecret('qt_s');directory.createSession(secret,owner.id,now,86400000);frames.set(owner.id,[]);
    const board=directory.createBoard('Other board',owner.id,now);
    events.open({user:owner.id,secret,board:board.id,kind:'stream',send:batch=>frames.get(owner.id)!.push(...batch),end:()=>{}});
  }
  events.flush();for(const received of frames.values())received.length=0;
  const before=ingest.measurementSources(bob.id,clock);
  if(change==='participation') {
    const next=desired();next.collectors.codex=false;
    const saved=store.measurementPolicies.saveDevice(target,0,next,clock);ingest.participationChanged(target,saved.changed,clock);
  } else if(change==='revoke') {
    directory.revokeDevice(user.id,target,clock);store.releaseRevoked(user.id);ingest.forget([target],clock);
  } else if(change==='login')ingest.checkin(credential,{...contact,subscriptions:[{provider:'codex',account:'b'.repeat(24)}]},clock);
  else if(change==='failure') {
    const policy=store.measurementPolicies.device(target);
    ingest.accept(credential,{...second,sentAt:new Date(clock).toISOString(),snapshots:[],failures:[{provider:'codex',observedAt:new Date(clock).toISOString(),error:'timeout',attemptContext:{version:1,authority:policy.authority,collectorEpoch:0,target:{kind:'verified',accountKey:account}}}]},clock);
  } else ingest.checkin(credential,{...contact,subscriptions:[],...(change==='configuration'?{collectors:[]}:{capabilities:undefined})},clock);
  events.flush();
  assert.deepEqual(ingest.measurementSources(bob.id,clock),before);
  assert.deepEqual(frames.get(bob.id),[],'foreign private availability does not invalidate an unchanged effective selection');
  assert.equal(frames.get(user.id)!.filter(frame=>frame.type===(change==='revoke'?'snapshot':'devices')).length,1,'own metadata still refreshes, including an authoritative rebaseline on revocation');
});

test('an Auto handover distinguishes own devices while foreign holders retain the same neutral selection',t=>{
  const {store,directory,ingest,user,batch,credential,sender,device}=setup();ingest.accept(credential,batch(now,{staleAfterMs:3*3600000}),now);
  const second={...sender,machine:{...sender.machine,id:'measurement-own-handover-B123'}};
  const contact={...second,paced:true,capabilities:{measurementPolicy:1,attemptContext:1},subscriptions:[{provider:'codex',account}]};
  ingest.checkin(credential,contact,now+600000);
  const target=directory.devices(user.id).find(candidate=>candidate.id!==device)!.id,source=store.held(user.id)[0].id;
  const bob=directory.createUser('handover-bob@example.com','Bob','x',now);store.hold(source,bob.id,now);
  const clock=now+600001,events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>clock,after:()=>()=>{}});
  events.attach();t.after(()=>{events.close();store.close();});
  const frames=new Map<string,Frame[]>();
  for(const owner of [user,bob]) {
    const secret=newSecret('qt_s');directory.createSession(secret,owner.id,now,86400000);frames.set(owner.id,[]);
    const board=directory.createBoard('Other board',owner.id,now);
    events.open({user:owner.id,secret,board:board.id,kind:'stream',send:batch=>frames.get(owner.id)!.push(...batch),end:()=>{}});
  }
  events.flush();for(const received of frames.values())received.length=0;
  const before=ingest.measurementSources(bob.id,clock);
  const reply=ingest.checkin(credential,{...contact,subscriptions:[{provider:'codex',account,active:true}]},clock);
  assert.equal(reply.subscriptions[0].onDuty,true);events.flush();
  assert.equal(ingest.measurementSources(user.id,clock)[0].candidates.find(candidate=>candidate.device===target)!.onDuty,true);
  assert.deepEqual(ingest.measurementSources(bob.id,clock),before);
  assert.equal(frames.get(user.id)!.filter(frame=>frame.type==='devices').length,1);
  assert.deepEqual(frames.get(bob.id),[]);
});

test('unchanged contacts reuse the private selection baseline at every held-source cohort size',()=>{
  for(const count of [1,20,200]) {
    const {store,directory,ingest,user,batch,credential,sender}=setup();ingest.accept(credential,batch(now),now);
    const request={...sender,paced:true,collectors:['codex'],subscriptions:[{provider:'codex',account}]};ingest.checkin(credential,request,now+1);
    for(let index=1;index<count;index++){const source=store.source('codex',index.toString(16).padStart(24,'0'),now);store.hold(source,user.id,now);}
    const events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>now+15000,after:()=>()=>{}});events.attach();
    try {
      const secret=newSecret('qt_s');directory.createSession(secret,user.id,now,86400000);const frames:Frame[]=[];
      const original=ingest.measurementSelection.privateState.bind(ingest.measurementSelection);let reads=0;
      ingest.measurementSelection.privateState=(...args)=>{reads++;return original(...args);};
      const accounts=ingest.measurementSelection.candidateAccounts.bind(ingest.measurementSelection);let enumerations=0;
      ingest.measurementSelection.candidateAccounts=(...args)=>{enumerations++;return accounts(...args);};
      events.open({user:user.id,secret,board:directory.boards(user.id).find(board=>board.personal)!.id,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});events.flush();reads=0;frames.length=0;
      ingest.checkin(credential,request,now+15000);events.flush();
      assert.equal(reads,0,`${count} held sources: a contact does not recalculate selection`);
      assert.equal(enumerations,0,`${count} held sources: an unchanged collector scope does not enumerate accounts`);
      assert.deepEqual(frames.map(frame=>frame.type),['deviceContacts']);
      const device=directory.devices(user.id)[0].id,change=store.measurementPolicies.saveDevice(device,0,desired(false),now+15001);
      ingest.participationChanged(device,change.changed,now+15001);events.flush();assert.equal(reads,1,'a semantic change still revalidates the baseline');
      assert.equal(frames.filter(frame=>frame.type==='devices').length,1);
    }finally{events.close();store.close();}
  }
});
