import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest,type Credential} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {newSecret} from '../domain/auth.js';
import {ActivityConflict,activityStateDigest,type ActivityState} from '../domain/activity.js';
import {transaction,type Touches} from '../touches.js';

const start=1_800_000_000_000;
const id=(n:number)=>n.toString(16).padStart(32,'0');
const sender={version:1,agent:'quotum/0.7.0',machine:{id:'activity-machine-0123456789',name:'laptop',os:'linux',arch:'x86_64'}};
const tracking={version:1 as const,clients:['codex'],routeDisabled:[],complete:true};
const state=(working:boolean|null=true,project='quotum'):ActivityState=>({tracking,contexts:[{contextId:id(1),clientId:'codex',sessionId:id(2),ordinal:null,
  source:null,accountBy:null,origin:'terminal',project,folder:null,startedAt:start-1000,route:null,working,lastWorkedAt:null}]});

function setup(){
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-activity-')),file=path.join(dir,'hub.sqlite');
  let store=new Store(file,start),directory=new Directory(store.db),ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const user=directory.createUser('ana@example.com','Ana','x',start),secret=newSecret('qt_m');
  directory.createToken(secret,'…',user.id,'fixture',start);
  const credential=()=>ingest.authenticate(`Bearer ${secret}`) as Credential;
  const hello=(change:Record<string,unknown>={},now=start)=>ingest.observedActivity(credential(),{...sender,op:'hello',sentAt:now,queueId:id(10),openId:id(11),
    acknowledgedThrough:0,clock:{clockEpoch:id(12),tick:0,wall:start},tracking,...change},now) as any;
  const opened=hello();
  const batch=(frames:unknown[],change:Record<string,unknown>={},now=start+600_000)=>ingest.observedActivity(credential(),{...sender,op:'batch',sentAt:now,
    queueId:opened.queueId,authorityEpoch:opened.authorityEpoch,clockAnchor:{clockEpoch:id(12),anchorTick:0,anchorAt:start},
    topologyWitnessId:opened.topologyWitness.id,checkpoint:state(),frames,...change},now) as any;
  const frame=(seq:number,from:number,to:number,current=state(),next:ActivityState|null=null)=>({seq,captureEpoch:id(13),clockEpoch:id(12),
    fromAt:start+from,toAt:start+to,fromTick:from,toTick:to,baseStateDigest:activityStateDigest(current),nextState:next,complete:true});
  return {get store(){return store;},get ingest(){return ingest;},get directory(){return directory;},user,opened,hello,batch,frame,credential,
    reopen(){store.close();store=new Store(file,start);directory=new Directory(store.db);ingest=new Ingest(store,directory,new Duty(),new Cadence());},
    close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const total=(store:Store)=>Number(store.db.prepare('SELECT COALESCE(sum(to_at-from_at),0) AS ms FROM agent_work').get()!.ms);

test('ten minutes of captured work survive delayed delivery, lost acknowledgements and both restarts exactly once',()=>{
  const s=setup();try{
    const frames=Array.from({length:40},(_,i)=>s.frame(i+1,i*15_000,(i+1)*15_000));
    assert.equal(s.batch(frames.slice(0,8)).acknowledgedThrough,8);
    s.reopen();
    assert.equal(s.hello({openId:id(14)}).floorAt,start,'restart cannot move the activation floor');
    assert.equal(s.batch(frames).acknowledgedThrough,40);
    for(let i=0;i<150;i++)assert.equal(s.batch(frames).acceptedFrames,0);
    s.reopen();s.ingest.live.sweep(start+1_000_000);
    assert.equal(total(s.store),600_000);
    assert.equal(s.store.db.prepare('SELECT accepted_seq FROM device_activity').get()!.accepted_seq,40);
  }finally{s.close();}
});

test('idle and unknown remain real gaps, and latest presence adds no speculative credit',()=>{
  const s=setup();try{
    const a=state(),idle=state(false),unknown=state(null);
    const frames=[s.frame(1,0,100_000,a,idle),s.frame(2,100_000,150_000,idle,a),s.frame(3,150_000,300_000,a,unknown),
      s.frame(4,300_000,340_000,unknown,a),s.frame(5,340_000,500_000,a)];
    s.batch(frames,{latest:{clockEpoch:id(12),tick:600_000,state:a}});
    assert.equal(total(s.store),410_000);
    s.ingest.live.sweep(start+1_000_000);
    assert.equal(total(s.store),410_000);
    assert.deepEqual(s.store.db.prepare('SELECT from_at,to_at FROM agent_work ORDER BY from_at').all().map(r=>[Number(r.from_at)-start,Number(r.to_at)-start]),[[0,100_000],[150_000,300_000],[340_000,500_000]]);
  }finally{s.close();}
});

test('sequence holes and rollback change neither committed history, memory nor its revision',()=>{
  const s=setup();try{
    assert.throws(()=>s.batch([s.frame(2,15_000,30_000)]),e=>e instanceof ActivityConflict&&e.code==='activity_sequence');
    const revision=s.store.workRevision();
    assert.throws(()=>transaction(s.store.db,()=>{s.batch([s.frame(1,0,15_000)],{latest:{clockEpoch:id(12),tick:15_000,state:state()}});throw new Error('rollback');}),/rollback/);
    assert.equal(total(s.store),0);assert.equal(s.store.workRevision(),revision);
    assert.deepEqual(s.ingest.live.devices(s.user.id,start+15_000),[]);
    assert.equal(s.store.db.prepare('SELECT accepted_seq FROM device_activity').get()!.accepted_seq,0);
    assert.equal(s.batch([s.frame(1,0,15_000)]).acknowledgedThrough,1);
  }finally{s.close();}
});

test('sticky capability suppresses malformed legacy activity before parsing and survives restart',()=>{
  const s=setup();try{
    const report={...sender,sentAt:new Date(start).toISOString(),sessions:[{provider:'malformed',working:{}}],tracking:{complete:true}};
    assert.deepEqual(s.ingest.sessions(s.credential(),report,start),{accepted:0,activitySuppressed:1,requiredActivityProtocol:1});
    s.reopen();s.ingest.sessions(s.credential(),report,start+300_000);s.ingest.live.sweep(start+900_000);
    assert.equal(total(s.store),0);
  }finally{s.close();}
});

test('skip preserves an already committed prefix and accepts the remaining suffix without inventing idle',()=>{
  const s=setup();try{
    s.batch([s.frame(1,0,15_000)]);
    s.batch([s.frame(5,60_000,75_000)],{skip:{firstSeq:1,lastSeq:4,fromAt:start,toAt:start+60_000,reason:'overflow'}});
    assert.equal(total(s.store),30_000);
    assert.equal(s.store.db.prepare('SELECT accepted_seq FROM device_activity').get()!.accepted_seq,5);
  }finally{s.close();}
});

test('hello B never remaps anchored A, and an old duplicate is safe after B or proof release',()=>{
  const s=setup();try{
    const a=s.frame(1,0,15_000);s.batch([a]);
    const fresh=s.hello({openId:id(21),knownWitnessId:s.opened.topologyWitness.id,clock:{clockEpoch:id(22),tick:0,wall:start+20_000}},start+20_000);
    assert.equal(fresh.topologyWitness.id,s.opened.topologyWitness.id);
    assert.equal(fresh.topologyWitness.issuedAt,start);
    const b={...s.frame(2,20_000,35_000),clockEpoch:id(22),captureEpoch:id(23),fromTick:0,toTick:15_000};
    s.batch([b],{clockAnchor:{clockEpoch:id(22),anchorTick:0,anchorAt:start+20_000}});
    s.batch([a],{releaseWitnesses:[s.opened.topologyWitness.id]});
    assert.equal(total(s.store),30_000);
    assert.equal(JSON.parse(String(s.store.db.prepare('SELECT clock_anchor FROM device_activity').get()!.clock_anchor)).clockEpoch,id(22));
  }finally{s.close();}
});

test('hello returns the committed prefix anchor for recovery without replacing it with its current calibration',()=>{
  const s=setup();try{
    assert.equal(s.opened.acceptedClockAnchor,null);
    s.batch([s.frame(1,0,15_000)]);
    const accepted={clockEpoch:id(12),anchorTick:0,anchorAt:start};
    const recovered=s.hello({acknowledgedThrough:1,clock:{clockEpoch:id(12),tick:40_000,wall:start+40_000}},start+40_000);
    assert.deepEqual(recovered.acceptedClockAnchor,accepted);
    const different=s.hello({clock:{clockEpoch:id(22),tick:0,wall:start+45_000}},start+45_000);
    assert.deepEqual(different.acceptedClockAnchor,accepted);
    s.reopen();
    assert.deepEqual(s.hello().acceptedClockAnchor,accepted);
    s.batch([],{skip:{firstSeq:2,lastSeq:2,fromAt:null,toAt:null,reason:'recovery'}});
    assert.equal(s.hello().acceptedClockAnchor,null,'a committed skip can clear the anchor at a nonzero cursor');
    assert.equal(total(s.store),15_000);
  }finally{s.close();}
});

test('replaced queues are fenced and a stale replace cannot discard the new writer',()=>{
  const s=setup();try{
    s.hello({latest:{clockEpoch:id(12),tick:0,state:state()}});
    assert.throws(()=>s.hello({queueId:id(30),openId:id(31)}),e=>e instanceof ActivityConflict&&e.code==='activity_binding');
    const replacement=s.hello({queueId:id(30),openId:id(31),replaceAuthorityEpoch:s.opened.authorityEpoch},start+15_000);
    assert.equal(replacement.floorAt,start+15_000);
    assert.equal(s.hello({queueId:id(30),openId:id(31),replaceAuthorityEpoch:s.opened.authorityEpoch},start+30_000).floorAt,start+15_000);
    assert.throws(()=>s.batch([s.frame(1,0,15_000)]),e=>e instanceof ActivityConflict&&e.code==='activity_stream_replaced');
    assert.throws(()=>s.hello({queueId:id(32),replaceAuthorityEpoch:s.opened.authorityEpoch}),ActivityConflict);
    assert.equal(total(s.store),0);
  }finally{s.close();}
});

test('cutover closes legacy credit once, and a stale roster sweep cannot write after the barrier',()=>{
  const s=setup();try{
    const device=s.opened.deviceId;
    s.store.db.exec('DELETE FROM device_activity_witnesses; DELETE FROM device_activity');
    s.ingest.sessions(s.credential(),{...sender,sentAt:new Date(start).toISOString(),sessions:[{provider:'codex',sessionId:id(2),origin:'terminal',startedAt:new Date(start-1000).toISOString(),working:true}]},start);
    assert.throws(()=>transaction(s.store.db,()=>{s.hello({},start+120_000);throw new Error('rollback');}),/rollback/);
    assert.equal(total(s.store),0);assert.equal(s.ingest.live.devices(s.user.id,start+120_000).length,1);
    assert.equal(s.hello({},start+120_000).floorAt,start+120_000);
    assert.equal(total(s.store),120_000);
    s.ingest.live.sweep(start+1_000_000);
    assert.equal(total(s.store),120_000);
    assert.equal(s.store.db.prepare('SELECT device_id FROM device_activity').get()!.device_id,device);
  }finally{s.close();}
});

test('bad new frames roll back a preceding good frame and immutable anchors reject remapping',()=>{
  const s=setup();try{
    const a=s.frame(1,0,15_000),b={...s.frame(2,15_000,30_000),baseStateDigest:'0'.repeat(64)};
    assert.throws(()=>s.batch([a,b]),/baseStateDigest/);assert.equal(total(s.store),0);
    assert.equal(s.store.db.prepare('SELECT accepted_seq FROM device_activity').get()!.accepted_seq,0);
    s.batch([a]);
    const remapped={...s.frame(2,15_000,30_000),fromAt:start+15_001,toAt:start+30_001};
    assert.throws(()=>s.batch([remapped],{clockAnchor:{clockEpoch:id(12),anchorTick:0,anchorAt:start+1}}),/immutable clockAnchor/);
    assert.equal(total(s.store),15_000);
  }finally{s.close();}
});

test('only captured proofs establish coverage; unchanged offline proofs survive rehello and restart',()=>{
  const s=setup();try{
    const witness=s.opened.topologyWitness;
    s.reopen();
    const repeated=s.hello({openId:id(44),knownWitnessId:witness.id},start+120_000);
    assert.deepEqual(repeated.topologyWitness,witness);assert.equal(repeated.serverTime,start+120_000);
    s.batch([s.frame(1,0,15_000)]);
    assert.deepEqual(s.store.db.prepare('SELECT from_at,to_at FROM work_coverage').all().map(r=>[Number(r.from_at)-start,Number(r.to_at)-start]),[[0,15_000]]);
    s.directory.saveDevice({userId:s.user.id,machine:{...sender.machine,id:'second-machine-0123456789'},agent:sender.agent,tokenId:null},start+20_000);
    const stale=s.batch([s.frame(2,15_000,30_000)]);
    assert.equal(stale.coverageRefreshRequired,true);assert.equal(total(s.store),30_000);
    assert.equal(s.store.db.prepare('SELECT max(to_at) AS at FROM work_coverage').get()!.at,start+15_000);
    const refreshed=s.hello({openId:id(45),knownWitnessId:witness.id},start+30_000);
    assert.notEqual(refreshed.topologyWitness.id,witness.id);
    assert.equal(refreshed.topologyWitness.issuedAt,start+30_000);
  }finally{s.close();}
});

test('witness capacity keeps positive work and late releases cannot remove replacement proofs',()=>{
  const s=setup();try{
    const proof=s.opened.topologyWitness;
    const row=s.store.db.prepare('SELECT * FROM device_activity_witnesses').get()!;
    const add=s.store.db.prepare('INSERT INTO device_activity_witnesses VALUES (?,?,?,?,?,?,?,?)');
    for(let i=1;i<256;i++)add.run(row.device_id!,row.queue_id!,row.authority_epoch!,id(1000+i),row.topology_version!,row.scope_digest!,start,id(2000+i));
    const full=s.hello({openId:id(3000)});
    assert.equal(full.topologyWitness,null);assert.equal(full.reason,'witness_capacity');
    s.batch([s.frame(1,0,15_000)],{topologyWitnessId:null,releaseWitnesses:[proof.id]});assert.equal(total(s.store),15_000);
    const fresh=s.hello({openId:id(3001)},start+15_000);
    s.batch([],{releaseWitnesses:[proof.id]});
    assert.ok(s.store.db.prepare('SELECT 1 FROM device_activity_witnesses WHERE witness_id=?').get(fresh.topologyWitness.id));
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM device_activity_witnesses').get()!.n,256);
  }finally{s.close();}
});

test('context A to B to A and parallel legacy keys retain every slice with one history notification',()=>{
  const s=setup();try{
    const current=state();
    current.contexts.push({...current.contexts[0],contextId:id(3),sessionId:null,ordinal:0,project:'legacy'});
    const other=structuredClone(current);other.contexts[0].project='other';
    let history=0;
    const nothing=()=>{};
    s.store.setObserver({touchSources:nothing,touchBoards:nothing,touchUser:nothing,touchHub:nothing,history:nothing,dropSessions:nothing,dropMember:nothing,dropBoard:nothing,
      clientHistory:()=>history++} satisfies Touches);
    s.batch([s.frame(1,0,10_000,current,other),s.frame(2,10_000,20_000,other,current),s.frame(3,20_000,30_000,current)],{checkpoint:current});
    assert.equal(total(s.store),60_000);assert.equal(history,1);assert.equal(s.store.workRevision(),1);
    s.batch([s.frame(1,0,10_000,current,other)],{checkpoint:current});assert.equal(history,1);
  }finally{s.close();}
});

test('delayed work keeps captured funding and unknown funding never falls back to the devices latest account',()=>{
  const s=setup();try{
    const a=s.store.source('codex','a'.repeat(24),start),b=s.store.source('codex','b'.repeat(24),start);
    s.store.hold(a,s.user.id,start);s.store.hold(b,s.user.id,start);
    s.store.seenDevice(s.opened.deviceId,'codex',b,start+60_000);
    const captured=state();captured.contexts[0].source={provider:'codex',account:'a'.repeat(24),accountName:null};
    const unknown=state();unknown.contexts[0].project='unknown';
    s.batch([s.frame(1,0,15_000,captured,unknown),s.frame(2,15_000,30_000,unknown)],{checkpoint:captured});
    const rows=s.store.db.prepare('SELECT s.source_id AS source,sum(w.to_at-w.from_at) AS ms FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id GROUP BY s.source_id ORDER BY s.source_id').all();
    assert.deepEqual(rows.map(r=>[r.source,Number(r.ms)]),[[null,15_000],[a,15_000]]);
    assert.equal(s.store.deviceSource(s.opened.deviceId,'codex'),b);
  }finally{s.close();}
});
