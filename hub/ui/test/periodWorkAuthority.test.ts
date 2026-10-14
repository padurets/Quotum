import * as retention from '../../server/domain/periodRetention';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodTransport} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {drain} from '../lib/prepare';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {evaluatedRange,periodKey} from '../../server/domain/period';
import {cellOf} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared} from '../../server/domain/periodWork';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {hasPeriodValue,periodValueAt} from '../../server/domain/periodValues';
import {canShift,shifted} from '../../server/domain/periodShift';
import {periodOf} from '../lib/periods';
import {moneySelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {subscriptionSelection} from '../lib/subscription';
import {sameJson} from '../lib/store';
import {EMPTY_VIEW} from '../../server/domain/view';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {Events,type Frame} from '../../server/events';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {ResetFeed} from '../../server/resets';
import {HistoryTiles} from '../../server/history';
import {PeriodReader} from '../../server/periodRead';
import {expandPeriod} from '../../server/domain/periodWire';
import {workedSessions} from '../../server/domain/periodWork';
import {createStore} from '../lib/store';
import {reduce,INITIAL,type HubEvent} from '../lib/board';

import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import type {Hub} from '../../server/api';
const NOW=1_800_000_000_000,H=3_600_000,M=60_000;
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};

/** Actual producer, wire JSON boundary, page reducer, transport and bounded server reader. */
async function fixture(personal=false) {
  const store=new Store(':memory:',NOW-3*H),directory=new Directory(store.db);
  const alice=directory.createUser('a@example.com','Alice','unused',NOW-3*H),bob=directory.createUser('b@example.com','Bob','unused',NOW-3*H);
  const board=personal?directory.boards(alice.id)[0].id:directory.createBoard('Shared',alice.id,NOW-3*H).id;
  if(!personal)directory.addMember(board,bob.id,NOW-3*H);
  directory.saveView(board,{...EMPTY_VIEW,shown:[AGENTS,'quota-history'],hidden:[ACTIVITY]},alice.id,NOW-3*H);
  const source=store.source('codex','a'.repeat(24),NOW-3*H);store.hold(source,alice.id,NOW-3*H);store.hold(source,bob.id,NOW-3*H);
  if(!personal)store.share(board,source,alice.id,NOW-3*H);
  store.record(source,{observedAt:NOW-2*M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:NOW+H}]});
  const device=directory.saveDevice({userId:personal?alice.id:bob.id,machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.6.0',tokenId:null},NOW-3*H).id;
  const credit=(from=NOW-3*M,to=NOW-2*M)=>store.creditWork(device,from,to,[{source,origin:'terminal',startedAt:NOW-3*H,project:'Work project',folder:'Private folder',identity:{kind:'stable',sessionId:'work'}}]);credit();
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const events=new Events(hub,undefined,{now:()=>NOW,after:()=>()=>{}},null),tiles=new HistoryTiles(store),reader=new PeriodReader(hub,tiles,events);
  events.onHistory=(source,since,scopes,work)=>{tiles.touch(source,since,scopes);reader.touch(source,since,scopes,work);};
  events.onClientHistory=(user,since)=>{tiles.touchClient(user,since);reader.touchClient(user,since);};events.attach();
  const page=createStore(reduce,INITIAL),frames:Frame[]=[],requests:PeriodRequest[]=[],pool=new HistoryPool();
  const feed=(batch:Frame[])=>{for(const frame of batch){frames.push(frame);page.dispatch({type:'hub',event:{type:frame.type,data:JSON.parse(frame.data)} as HubEvent});}};
  const secret='fixture-session';directory.createSession(secret,alice.id,NOW-3*H,24*H);
  const opened=events.open({user:alice.id,secret,board,kind:'stream',send:feed,end:()=>{}});
  if(!opened||opened==='limit')throw new Error('stream did not open');feed(opened.frames);
  const settings={range:'1h',kind:'session',money:DEFAULT_MONEY,funds:DEFAULT_MONEY};
  const code=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  let wait:Promise<void>|null=null;
  const context={exports:{} as any,hubNow:()=>NOW,retention,historyPool:pool,clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},PeriodTransport,
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{requests.push(body);const reply=expandPeriod(JSON.parse(reader.read(board,alice.id,JSON.parse(JSON.stringify(body)))));const pending=wait;wait=null;await pending;return reply;},
    page,pan:{get:()=>null},preparations:()=>null,prepareAsync:async(_owner:object,work:Parameters<typeof drain>[0])=>drain(work),evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,
    packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,canShift,shifted,hasPeriodValue,periodValueAt,empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson,
    timeRange:()=>null,prefs:()=>settings,periodOf,cellOf,moneySelection,subscriptionSelection,PERIOD_SCOPES,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS,widgetVisible,noSessions:[],noValue:{}};
  runInNewContext(ts.transpileModule(code.slice(code.indexOf('class BoardPeriod'),code.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod();page.listen((event,state)=>period.changed(event,state));period.activate(true);await flush();
  assert.equal(period.get().error,null);assert.equal(period.get().rows.length,1);requests.length=0;frames.length=0;
  return {store,directory,board,alice,bob,source,credit,events,period,page,frames,requests,
    event:(event:HubEvent)=>page.dispatch({type:'hub',event}),
    hold:()=>{let release!:()=>void,reject!:(error:Error)=>void;wait=new Promise<void>((yes,no)=>{release=yes;reject=no;});return {release,reject};},
    remove:()=>{directory.removeMember(board,bob.id);store.unshareOrphans(board);events.flush();},
    fresh:()=>expandPeriod(JSON.parse(reader.read(board,alice.id,{version:1,selection:{mode:'live',periodMs:H},evaluatedAt:NOW,sessions:{}}))) as PeriodReply,
    close:async()=>{period.activate(false);opened.close();events.close();await new Promise(resolve=>setImmediate(resolve));store.close();assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);}};
}

for(const failed of [false,true])test(`removing a shared member retires work before its replacement ${failed?'fails':'completes'}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();try{
    const gate=h.hold();h.remove();
    assert.equal(h.period.get().rows.length,0,'the actual producer event revokes project/folder/work immediately');assert.equal(h.period.getSource(h.source).length,0);
    assert.equal(h.period.get().value,null);assert.equal(h.period.get().loading,true);
    await flush();assert.equal(h.frames[0].type,'snapshot');const news=JSON.parse(h.frames[0].data);assert.equal(news.workAuthority,h.store.workKey(h.board));assert.deepEqual(news.sessions[h.source]??[],[]);
    assert.ok(h.requests[0].sessions);assert.equal(h.requests[0].sessions!.cursor,undefined,'revoked evidence cannot become a delta base');
    assert.equal(h.requests.some(request=>request.budget||request.funds),false);
    const fresh=h.fresh();if(fresh.sessions?.state!=='complete')throw new Error('incomplete fresh baseline');assert.equal(workedSessions(fresh.sessions.value,fresh.basis.range,NOW).length,0);
    if(failed)gate.reject(new Error('unavailable'));else gate.release();await flush();
    assert.equal(h.period.get().rows.length,0);assert.equal(h.period.get().loading,false);
    assert.equal(h.period.get().error,failed?'unavailable':null);
  }finally{await h.close();}
});

test('a late work reply cannot restore a member after its work authority is revoked',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();try{
    const gate=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();assert.ok(h.requests.some(request=>request.sessions));
    h.remove();await flush();assert.equal(h.period.get().rows.length,0);gate.release();await flush();assert.equal(h.period.get().rows.length,0);
  }finally{await h.close();}
});

for(const legacy of ['scoped','unscoped','personal','shared'] as const)test(`${legacy} zero work cutoff retires the same source IDs`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture(legacy==='personal');try{
    const gate=h.hold();h.event({type:'history',data:legacy==='personal'||legacy==='shared'?{sources:[],since:NOW,workSince:0}:{sources:[h.source],since:0,...(legacy==='scoped'?{changes:[{source:h.source,scope:'quota',since:0}]}:{})}});
    assert.equal(h.period.get().rows.length,0);await flush();assert.ok(h.requests[0].sessions);assert.equal(h.requests[0].sessions!.cursor,undefined);
    gate.release();await flush();assert.equal(h.period.get().rows.length,1,'fresh evidence under the current authority can return');
  }finally{await h.close();}
});

test('budget-only and inaccessible resource cutoffs preserve visible work',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();try{
    const original=h.period.get().rows;
    for(const data of [{sources:[h.source],since:0,changes:[{source:h.source,scope:'budget' as const,since:0,workSince:0}]},{sources:['foreign'],since:0,changes:[{source:'foreign',scope:'quota' as const,since:0,workSince:0}]}]){
      h.event({type:'history',data});await flush();assert.equal(h.period.get().rows,original);
    }
    assert.equal(h.requests.some(request=>request.sessions),false);
    const gate=h.hold();h.events.history(h.source,NOW-M,['quota']);h.events.flush();await flush();assert.equal(h.period.get().rows,original);assert.equal(h.requests.some(request=>request.sessions),false);
    gate.release();await flush();h.requests.length=0;
    const work=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();assert.equal(h.period.get().rows,original,'ordinary credit keeps the authorized completed roster');
    assert.ok(h.requests[0].sessions?.cursor);assert.equal(h.requests.some(request=>request.budget||request.funds),false);work.release();await flush();
  }finally{await h.close();}
});

test('an unrelated global source holder changes no actual browser work epoch, retained rows or transport demand',async t=>{
 t.mock.method(Date,'now',()=>NOW);const h=await fixture();
 try{
  const outsider=h.directory.createUser('outside@example.test','Outside','x',NOW-M),key=h.store.workKey(h.board),rows=h.period.get().rows,requests=h.requests.length;
  h.store.hold(h.source,outsider.id,NOW);h.events.flush();await flush();assert.equal(h.store.workKey(h.board),key);assert.equal(h.period.get().rows,rows);assert.equal(h.requests.length,requests,'a nonmember holding sends no work reset or analytical HTTP');
  h.store.release(h.source,outsider.id);h.events.flush();await flush();assert.equal(h.store.workKey(h.board),key);assert.equal(h.period.get().rows,rows);assert.equal(h.requests.length,requests);
  h.store.release(h.source,h.bob.id);h.events.flush();await flush();assert.notEqual(h.store.workKey(h.board),key,'the admitted producer owner’s holding changes its funding');assert.ok(h.requests.length>requests);
 }finally{await h.close();}
});
