// Explicit cross-language recovery check. The argument is the release observed_probe example.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {buildApp} from '../server/api.js';
import {Cadence} from '../server/cadence.js';
import {newSecret} from '../server/domain/auth.js';
import {Duty} from '../server/duty.js';
import {Ingest} from '../server/ingest.js';
import {Pairing} from '../server/pairing.js';
import {ResetFeed} from '../server/resets.js';
import {Setup} from '../server/setup.js';
import {Directory} from '../server/store/directory.js';
import {Store} from '../server/store/store.js';

const binary=path.resolve(process.argv[2]??'../agent/target/release/examples/observed_probe');
const root=mkdtempSync(path.join(tmpdir(),'quotum-observed-recovery-'));
const id=(n:number)=>n.toString(16).padStart(32,'0');
const originalNow=Date.now,start=Date.now();let now=start;
Date.now=()=>now;
const tracking={version:1,clients:['codex'],routeDisabled:[],complete:true};
const state={tracking,contexts:[{contextId:id(1),clientId:'codex',sessionId:id(2),ordinal:null,source:null,accountBy:null,
  origin:'terminal',project:'escaped "\\\n\t\u0001 🌍',folder:'研究',startedAt:start-1000,route:null,working:true,lastWorkedAt:null}]};
const sender={version:1,agent:'quotum/0.7.0',machine:{id:'activity-fixture-machine',name:'Fixture',os:'linux',arch:'x86_64'}};
const secret=newSecret('qt_m');
let store:Store,directory:Directory,app:Awaited<ReturnType<typeof buildApp>>,url:string;
async function openHub(first=false){
  store=new Store(path.join(root,'hub.sqlite'),now);directory=new Directory(store.db);
  if(first){const user=directory.createUser('fixture@example.com','Fixture','unused',now);directory.createToken(secret,'…',user.id,'fixture',now);}
  app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,''),local:null});
  url=await app.listen({host:'127.0.0.1',port:0});
}
async function call(body:object,status=200){
  const response=await fetch(url+'/v1/activity',{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({...sender,sentAt:now,...body})});
  const reply=await response.json() as any;assert.equal(response.status,status,JSON.stringify(reply));return reply;
}
function probe(){
  const child=spawn(binary,['queue',path.join(root,'queue')],{stdio:['pipe','pipe','inherit']});
  const lines=createInterface({input:child.stdout});
  const waiting:Array<{resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  lines.on('line',line=>waiting.shift()?.resolve(JSON.parse(line)));
  const exit=new Promise<void>(resolve=>child.once('exit',()=>{for(const p of waiting.splice(0))p.reject(new Error('probe exited'));resolve();}));
  return {command:(body:object)=>new Promise<any>((resolve,reject)=>{waiting.push({resolve,reject});child.stdin.write(JSON.stringify(body)+'\n');}),
    async stop(signal?:NodeJS.Signals){if(signal)child.kill(signal);else child.stdin.end();await exit;}};
}
let queue=probe();
const total=()=>Number(store.db.prepare('SELECT coalesce(sum(to_at-from_at),0) AS ms FROM agent_work').get()!.ms);
const hello=async(clock:string,tick:number,known:string|null=null,offset=0)=>{
  const status=await queue.command({op:'status'});
  return call({op:'hello',...status,sentAt:now+offset,acknowledgedThrough:status.ack,clock:{clockEpoch:clock,tick,wall:now+offset},tracking,knownWitnessId:known});
};
const install=async(clock:string,at:number,local=at)=>queue.command({op:'clock',epoch:{id:clock,boot:'fixture',zeroTick:0,zeroWall:local,lastTick:0,wallOffset:at-local,anchor:{clockEpoch:clock,anchorTick:0,anchorAt:at}}});
const append=async(clock:string,capture:string,from:number,to:number)=>queue.command({op:'append',state:{...state,contexts:state.contexts.map(c=>({...c,startedAt:c.startedAt+(clock===id(10)?120_000:0)}))},witnessId:opened.topologyWitness.id,
  raw:{seq:0,captureEpoch:capture,clockEpoch:clock,fromTick:from,toTick:to,fromWall:(clock===id(10)?start+120_000:start+600_000)+from,toWall:(clock===id(10)?start+120_000:start+600_000)+to,baseStateDigest:'',nextState:null,complete:true}});
let opened:any;
try{
  await openHub(true);opened=await hello(id(10),0,null,120_000);
  await install(id(10),start,start+120_000);
  await queue.command({op:'bind',binding:{hubId:opened.hubId,deviceId:opened.deviceId,authorityEpoch:opened.authorityEpoch,floorAt:opened.floorAt},ack:0,
    clockEpoch:id(10),anchor:{clockEpoch:id(10),anchorTick:0,anchorAt:start},witness:opened.topologyWitness});
  for(let i=0;i<40;i++)assert.equal((await append(id(10),id(11),i*15_000,(i+1)*15_000)).seq,i+1);
  const batch=await queue.command({op:'prepare'});assert.equal(batch.frames.length,40);assert.equal(batch.checkpoint.contexts[0].startedAt,start-1000);
  const envelope={op:'batch',queueId:opened.queueId,authorityEpoch:opened.authorityEpoch};
  now=start+600_000;
  await call({...envelope,...batch,frames:[batch.frames[8]]},409);
  assert.equal(total(),0);
  const credit=store!.creditWorkIntervals;
  store!.creditWorkIntervals=function(...args){credit.apply(this,args);throw new Error('injected activity rollback');};
  await call({...envelope,...batch,frames:batch.frames.slice(0,8)},500);
  assert.equal(total(),0);assert.equal(store!.db.prepare('SELECT accepted_seq FROM device_activity').get()!.accepted_seq,0);
  store!.creditWorkIntervals=credit;
  const partial=await call({...envelope,...batch,frames:batch.frames.slice(0,8)});assert.equal(partial.acknowledgedThrough,8);assert.equal(total(),120_000);
  // Neither the HTTP response nor a dead agent is an acknowledgement on disk.
  await queue.stop('SIGKILL');queue=probe();
  assert.deepEqual(await queue.command({op:'prepare'}),batch);
  await app!.close();store!.close();copyFileSync(path.join(root,'hub.sqlite'),path.join(root,'backup.sqlite'));await openHub();
  const reopened=await hello(id(20),0,opened.topologyWitness.id);
  assert.equal(reopened.floorAt,opened.floorAt);assert.equal(reopened.topologyWitness.issuedAt,opened.topologyWitness.issuedAt);
  await install(id(20),now);
  await queue.command({op:'bind',binding:{hubId:reopened.hubId,deviceId:reopened.deviceId,authorityEpoch:reopened.authorityEpoch,floorAt:reopened.floorAt},ack:8,
    clockEpoch:id(20),anchor:{clockEpoch:id(20),anchorTick:0,anchorAt:now},witness:reopened.topologyWitness});
  assert.equal((await append(id(20),id(21),0,15_000)).seq,41);
  assert.deepEqual((await queue.command({op:'prepare'})).clockAnchor,batch.clockAnchor);
  const complete=await call({...envelope,...batch});assert.equal(complete.acknowledgedThrough,40);assert.equal(total(),600_000);
  for(let i=0;i<150;i++)assert.equal((await call({...envelope,...batch})).acceptedFrames,0);
  await queue.command({op:'ack',through:40,released:[]});
  const next=await queue.command({op:'prepare'});assert.equal(next.clockAnchor.clockEpoch,id(20));assert.equal(next.frames.length,1);
  now+=15_000;await call({...envelope,...next});assert.equal(total(),615_000);
  await call({...envelope,...batch});assert.equal(total(),615_000);
  await queue.command({op:'ack',through:41,released:[]});
  assert.equal((await queue.command({op:'prepare'})).frames.length,0);
  await app!.close();store!.close();copyFileSync(path.join(root,'backup.sqlite'),path.join(root,'hub.sqlite'));await openHub();
  assert.equal(total(),120_000);
  const status=await queue.command({op:'status'});
  const conflict=await call({op:'hello',...status,acknowledgedThrough:41,clock:{clockEpoch:id(20),tick:15_000,wall:now},tracking},409);
  assert.equal(conflict.expectedSeq,9);
  const verified=await call({op:'hello',...status,acknowledgedThrough:0,clock:{clockEpoch:id(20),tick:15_000,wall:now},tracking});
  for(const key of ['hubId','deviceId','queueId','authorityEpoch'])assert.equal(verified[key],opened[key]);
  await queue.command({op:'rewind',through:verified.acknowledgedThrough});
  assert.equal((await append(id(20),id(21),15_000,30_000)).seq,42);
  const recovery=await queue.command({op:'prepare'});
  assert.deepEqual(recovery.skip,{firstSeq:9,lastSeq:41,fromAt:null,toAt:null,reason:'recovery'});
  now+=15_000;await call({...envelope,...recovery});assert.equal(total(),135_000);
  await call({...envelope,...batch});assert.equal(total(),135_000,'deleted acknowledged payload cannot resurrect after a backup');
  await queue.command({op:'ack',through:42,released:[]});
  console.log(JSON.stringify({result:'pass',firstCaptureWorkMs:600_000,secondClockWorkMs:15_000,duplicateBatches:152,agentCrash:true,hubRestart:true,rollback:true,outOfOrder:true,crossLanguageEscapes:true,backupMissingPrefix:true,calibratedContextDates:true}));
}finally{
  Date.now=originalNow;await queue.stop();await app!?.close();store!?.close();rmSync(root,{recursive:true,force:true});
}
