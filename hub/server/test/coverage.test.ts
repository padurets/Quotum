import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type WorkKey} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {parseSessions,type Tracking} from '../domain/ingest.js';
import {resolveLink,safeRoute} from '../domain/links.js';
import {capSteps} from '../domain/usageWork.js';
import {quotaSteps} from '../domain/usageWork.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import type {Meter} from '../domain/meters.js';

const start=1_800_000_000_000,minute=60_000,day=86_400_000;
const scope=(complete=true):Tracking=>({version:1,clients:['opencode'],routeDisabled:[],complete});
function fixture(file=':memory:') {
  const store=new Store(file,start),directory=new Directory(store.db),owner=directory.createUser('fixture@example.com','Owner','fixture',start);
  const device=directory.saveDevice({userId:owner.id,machine:{id:'fixture',name:'Laptop',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},start).id;
  const source=store.source('codex','fixture',start);store.hold(source,owner.id,start);
  const witness=(at:number,complete=true,epoch='runtime')=>store.coverage.record(device,owner.id,scope(complete),at,epoch);
  const sample=(at:number,used:number,resetAt=start+day)=>store.record(source,{observedAt:at,plan:'',windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt}],staleAfterMs:30*minute,resets:null});
  const mark=(at=start+4*minute)=>store.usageWork.of(source,store.state(source),at).value;
  const key:WorkKey={client:'opencode',source:null,origin:'terminal',startedAt:start,project:'Project',folder:'',identity:{kind:'stable',sessionId:'a'.repeat(32)}};
  return {store,directory,owner,device,source,witness,sample,mark,key};
}

test('tracking is additive, lenient, bounded and cannot certify dropped client sessions',()=>{
  const input={version:1,agent:'fixture',machine:{id:'0123456789abcdef',name:'Laptop',os:'linux',arch:'x86_64'},sentAt:new Date(start).toISOString(),sessions:[],tracking:scope()};
  assert.equal(parseSessions(input).tracking?.complete,true);
  assert.equal(parseSessions({...input,tracking:{...scope(),version:2}}).tracking,null);
  assert.equal(parseSessions({...input,tracking:{...scope(),clients:['opencode','opencode']}}).tracking,null);
  assert.equal(parseSessions({...input,tracking:{...scope(),clients:Array.from({length:70},(_,i)=>'client'+i)}}).tracking,null);
  assert.equal(parseSessions({...input,clientSessions:[{clientId:'opencode'}]}).tracking?.complete,false);
  assert.equal(parseSessions({...input,tracking:null}).tracking,null);
});

test('malformed tracking cannot withdraw route opt-out or reinterpret saved attribution',()=>{
  for(const patch of [{routeDisabled:['INVALID ID']},{clients:['INVALID ID'],routeDisabled:[]},{clients:['codex','codex'],routeDisabled:[]},{clients:Array.from({length:65},(_,i)=>'client'+i),routeDisabled:[]},{routeDisabled:['custom-client']},{version:2,routeDisabled:[]}]){
    const f=fixture();try{
      const tracking={version:1 as const,clients:['codex'],routeDisabled:['codex'],complete:true};
      const context=()=>f.store.links.batch([f.owner.id])(f.owner.id,f.device,'codex');
      const input={clientId:'codex',deviceId:f.device,source:f.source,route:{class:'api' as const,by:'session' as const,host:'openrouter.ai',provider:'openrouter'}};
      f.store.coverage.record(f.device,f.owner.id,tracking,start);
      const parsed=parseSessions({version:1,agent:'fixture',machine:{id:'0123456789abcdef',name:'Laptop',os:'linux',arch:'x86_64'},sentAt:new Date(start+1000).toISOString(),sessions:[],tracking:{...tracking,...patch}});
      assert.equal(parsed.tracking,null);f.store.coverage.record(f.device,f.owner.id,parsed.tracking,start+1000);
      assert.equal(context().routeEnabled,false);assert.equal(safeRoute(input.route,context().routeEnabled).route,null);
      assert.equal(resolveLink(input,context(),start).source,f.source);
      f.store.coverage.record(f.device,f.owner.id,{...tracking,routeDisabled:[],complete:false},start+2000);
      assert.equal(context().routeEnabled,true,'a valid incomplete snapshot can explicitly change the policy');
    }finally{f.store.close();}
  }
});

test('coverage needs two complete endpoints, preserves unknown gaps and never extrapolates',()=>{
  const f=fixture();try {
    f.witness(start,false);f.witness(start+2*minute);assert.equal(f.store.coverage.full(f.source,start,start+2*minute),false);
    f.witness(start+4*minute);assert.equal(f.store.coverage.full(f.source,start+2*minute,start+4*minute),true);
    assert.equal(f.store.coverage.full(f.source,start+2*minute,start+4*minute+1),false);
    f.witness(start+6*minute,false);f.witness(start+8*minute);f.witness(start+10*minute);
    assert.equal(f.store.coverage.full(f.source,start+2*minute,start+10*minute),false);
    assert.equal(f.store.coverage.full(f.source,start+8*minute,start+10*minute),true);
    f.witness(start+9*minute);f.witness(start+12*minute);assert.equal(f.store.coverage.full(f.source,start+10*minute,start+12*minute),false);
    f.witness(start+14*minute);assert.equal(f.store.coverage.full(f.source,start+12*minute,start+14*minute),true);
    f.store.coverage.record(f.device,f.owner.id,{...scope(),clients:[]},start+16*minute,'runtime');
    assert.equal(f.store.coverage.full(f.source,start+12*minute,start+14*minute),false);
  }finally{f.store.close();}
});

test('finished coverage survives reopen while another runtime cannot bridge the restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'quotum-coverage-')),file=join(dir,'hub.sqlite'),f=fixture(file);
  f.witness(start);f.witness(start+2*minute);f.store.close();
  const store=new Store(file,start+minute);try{
    assert.equal(store.coverage.full(f.source,start,start+2*minute),true);
    store.coverage.record(f.device,f.owner.id,scope(),start+4*minute,'restarted');
    assert.equal(store.coverage.full(f.source,start+2*minute,start+4*minute),false);
    store.coverage.record(f.device,f.owner.id,scope(),start+6*minute,'restarted');
    assert.equal(store.coverage.full(f.source,start+4*minute,start+6*minute),true);
    store.coverage.prune(start+minute);assert.equal(store.coverage.full(f.source,start+minute,start+2*minute),true);
  }finally{store.close();rmSync(dir,{recursive:true});}
});

test('quota growth distinguishes partial from confirmed; new topology cannot repair the past',()=>{
  const f=fixture();try{
    f.sample(start,10);f.sample(start+4*minute,12);assert.equal(f.mark()[0].quality,'partial');
    f.witness(start);f.witness(start+2*minute);f.witness(start+4*minute);assert.equal(f.mark()[0].quality,'confirmed');
    const device=f.directory.saveDevice({userId:f.owner.id,machine:{id:'second',name:'Second',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},start+5*minute).id;
    assert.equal(f.mark(start+5*minute)[0].quality,'partial');
    f.store.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(start+6*minute,device);
    assert.equal(f.mark(start+6*minute)[0].quality,'partial');
    f.sample(start+7*minute,0,start+2*day);assert.deepEqual(f.mark(start+7*minute),[],'reset retires the previous finding');
  }finally{f.store.close();}
});

test('a one-millisecond resolved work overlap vetoes the finding and correction leaves the raw ledger intact',()=>{
  const f=fixture();try {
    f.sample(start,10);f.sample(start+4*minute,11);f.store.creditWork(f.device,start+minute,start+minute+1,[f.key]);
    assert.equal(f.mark().length,1,'unknown work is not guessed onto an account');
    const raw=f.store.db.prepare('SELECT * FROM agent_work').all();
    f.store.links.mutate(f.owner.id,'create',null,{clientId:'opencode',deviceId:null,route:null,sourceId:f.source,from:start,to:null,expectedRevision:f.store.links.revision(f.owner.id),requestId:randomUUID()},start+4*minute);
    assert.deepEqual(f.mark(),[]);assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_work').all(),raw);
    assert.deepEqual(f.mark(start+day+4*minute),[]);
  }finally{f.store.close();}
});

test('cap comparison uses native allowance, generation and exclusive observation bounds',()=>{
  const meter=(at:number,amount:string):Meter&{generation:string|null}=>({id:'quota:credit:5h',kind:'cap',unit:'credits:zai',amount,limit:'100000000',resetAt:start+day,minutes:300,scope:null,label:null,at,staleAfterMs:30*minute,stale:false,generation:'credit'});
  const a=meter(start,'0'),b=meter(start+4*minute,'1000000'),spans=[{from:start,to:b.at,staleAfterMs:30*minute}];
  assert.equal(capSteps(a.id,[a,b],spans)[0].growth,1);
  assert.deepEqual(capSteps(a.id,[a,{...b,limit:'200000000'}],spans),[]);
  assert.deepEqual(capSteps(a.id,[a,{...b,generation:null}],spans),[]);
  assert.deepEqual(capSteps(a.id,[a,b],[{...spans[0],holdUntil:b.at}]),[]);
});

test('native quota thresholds use original samples and exact time boundaries',()=>{
  const a={at:start,used:10,resetAt:start+day,staleAfterMs:30*minute},b={...a,at:start+30*minute,used:11};
  assert.equal(quotaSteps('weekly',[a,b]).length,1);
  assert.deepEqual(quotaSteps('weekly',[a,{...b,used:10.99}]),[]);
  assert.equal(quotaSteps('weekly',[{...a,used:0.15},{...b,used:1.15}]).length,1,'decimal endpoints do not lose the threshold through subtraction');
  assert.deepEqual(quotaSteps('weekly',[a,{...b,used:10.99996}]),[],'display rounding cannot promote a smaller native change');
  assert.deepEqual(quotaSteps('weekly',[{...a,staleAfterMs:day},{...b,at:b.at+1}]),[]);
  assert.deepEqual(quotaSteps('weekly',[{...a,validUntil:b.at},b]),[]);
  assert.deepEqual(quotaSteps('weekly',[{...a,resetAt:b.at},{...b,resetAt:b.at+day}]),[]);
  assert.deepEqual(quotaSteps('weekly',[{...a,resetAt:null},{...b,resetAt:null}]),[]);
});

test('every hundredth retains an exact one-point native quota threshold',()=>{
  const decimal=(value:number)=>Number(`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`);
  const a={at:start,used:0,resetAt:start+day,staleAfterMs:30*minute};
  for(let value=0;value<=9900;value++){
    assert.equal(quotaSteps('weekly',[{...a,used:decimal(value)},{...a,at:start+minute,used:decimal(value+100)}]).length,1,`${decimal(value)} → ${decimal(value+100)}`);
  }
});

test('persisted quota growth compares decimal and exponent endpoints without rounding',()=>{
  for(const [before,after,expected] of [[0.14,1.14,1],[0.15,1.15,1],[98.99,99.99,1],[0,1,1],[0.14,1.1399999999,0],[0,1-Number.EPSILON,0],[1e-30,1,0],[Number.MIN_VALUE,1,0],[1e-30,1.0000000000000002,1],[0.9999999999999999,2,1]]){
    const f=fixture();try{
      f.sample(start,before);f.sample(start+4*minute,after);
      assert.equal(f.mark().length,expected,`${before} → ${after}`);
    }finally{f.store.close();}
  }
});

test('empty ingest heartbeats close coverage without changing raw work or connection revisions; legacy reports break it',()=>{
  const f=fixture();try{
    const ingest=new Ingest(f.store,f.directory,new Duty(),new Cadence()),credential={kind:'device' as const,device:f.directory.deviceById(f.device)!};
    const input=(at:number,tracking:Tracking|null=scope())=>({version:1,agent:'fixture',machine:{id:'fixture',name:'Laptop',os:'linux',arch:'x86_64'},sentAt:new Date(at).toISOString(),sessions:[],clients:[],tracking});
    const revision=f.directory.connectionsRevision(f.owner.id);
    for(let n=0;n<=2;n++)ingest.sessions(credential,input(start+n*2*minute),start+n*2*minute);
    assert.equal(f.store.coverage.full(f.source,start,start+4*minute),true);
    assert.equal(f.directory.connectionsRevision(f.owner.id),revision);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_work').all(),[]);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_sessions').all(),[]);
    ingest.sessions(credential,input(start+6*minute,null),start+6*minute);
    ingest.sessions(credential,input(start+8*minute),start+8*minute);
    assert.equal(f.store.coverage.full(f.source,start+4*minute,start+8*minute),false);
    ingest.sessions(credential,input(start+10*minute,{...scope(),routeDisabled:['opencode']}),start+10*minute);
    assert.equal(f.store.links.batch([f.owner.id])(f.owner.id,f.device,'opencode').routeEnabled,false);
  }finally{f.store.close();}
});
