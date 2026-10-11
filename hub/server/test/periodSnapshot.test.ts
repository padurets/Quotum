import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {mergeWork,workedSessions,type WorkTrace} from '../domain/periodWork.js';
import {CREDIT_MS,KEEP_MS} from '../sessions.js';

const M=60_000,H=60*M,NOW=1_800_000_000_000;

test('a composite cut cannot acknowledge work credited by a later expiry sweep',async t=>{
  let clock=NOW-30*M;t.mock.method(Date,'now',()=>clock);
  const store=new Store(':memory:',NOW-3*H),directory=new Directory(store.db);
  const user=directory.createUser('snapshot@example.test','Snapshot','unused',NOW-3*H),board=directory.boards(user.id)[0].id;
  const cookie=newSecret('qt_s');directory.createSession(cookie,user.id,NOW-3*H,24*H);
  const secret=newSecret('qt_m');directory.createToken(secret,'token',user.id,'snapshot',NOW-3*H);
  const source=store.source('codex','a'.repeat(24),NOW-3*H);store.hold(source,user.id,NOW-3*H);
  const ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const app=await buildApp({store,directory,ingest,resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  const headers={origin:'http://localhost',cookie:`quotum_session=${cookie}`};
  const report=async(at:number,id:string|null)=>{
    clock=at;
    const response=await app.inject({method:'POST',url:'/v1/sessions',headers:{authorization:`Bearer ${secret}`},payload:{version:1,agent:'quotum/0.7.0',machine:{id:'machine-snapshot-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},sentAt:new Date(at).toISOString(),sessions:id?[{provider:'codex',account:'a'.repeat(24),sessionId:id.repeat(32),origin:'terminal',startedAt:new Date(at).toISOString(),working:true,project:'Project'}]:[]}});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().accepted,Number(id!==null));
  };
  const read=async(cursor?:string)=>{
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers,payload:{version:1,selection:{mode:'live',periodMs:H},evaluatedAt:clock,values:[source],sessions:cursor?{cursor}:{},quota:{cell:String(M),from:String(NOW-H),to:String(NOW),cells:'skip',evidence:'skip'}}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    if(!reply.sessions||reply.sessions.state==='error')throw new Error('incomplete work');
    assert.equal(reply.quota?.state,'complete');assert.equal(reply.values?.state,'complete');
    return {...reply,sessions:reply.sessions,work:reply.sessions.value};
  };
  const total=(work:WorkTrace)=>workedSessions(work,{from:NOW-H,to:clock},clock).reduce((n,row)=>n+row.workedMs,0);
  await report(NOW-30*M,'b');await report(NOW-29*M,null);
  await report(NOW-KEEP_MS+1,'a');
  clock=NOW-1000;const initial=await read();assert.equal(total(initial.work),M);
  const original=ingest.live.sweep.bind(ingest.live),sweeps:number[]=[];
  const sweep=t.mock.method(ingest.live,'sweep',(at:number)=>{sweeps.push(at);original(at);clock=NOW+2;});
  clock=NOW;const crossing=await read(initial.work.cursor);sweep.mock.restore();
  assert.equal(crossing.basis.evaluatedAt,NOW);assert.equal(crossing.basis.evidenceCut,NOW);
  assert.ok(sweeps.every(at=>at===NOW),'nested sections must use the captured request clock');
  assert.equal(store.agentWork(NOW-H,NOW).reduce((n,row)=>n+row.to-row.from,0),M,'the later credit belongs to a later read');
  if(crossing.sessions.state!=='delta')throw new Error('missing crossing delta');
  const merged=mergeWork(initial.work,crossing.sessions.value);
  assert.equal(total(merged),M);
  // The standalone legacy route must still expire producers using its own clock.
  const history=await app.inject({url:`/api/history?board=${board}&cell=${M}&from=${NOW-H}&to=${NOW}&scope=quota`,headers});
  assert.equal(history.statusCode,200,history.body);
  assert.equal(store.agentWork(NOW-H,NOW).reduce((n,row)=>n+row.to-row.from,0),M+CREDIT_MS);
  const correction=await read(crossing.work.cursor);
  if(correction.sessions.state!=='delta')throw new Error('missing correction delta');
  assert.equal(total(mergeWork(merged,correction.sessions.value)),M+CREDIT_MS);
  const fresh=await read();assert.equal(total(fresh.work),M+CREDIT_MS);
  const retry=await read(initial.work.cursor);if(retry.sessions.state!=='delta')throw new Error('missing retry delta');
  assert.equal(total(mergeWork(initial.work,retry.sessions.value)),M+CREDIT_MS,'older valid cursors retain late corrections');
});
