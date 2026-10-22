import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import type {History} from '../../server/domain/history';
import {Preparations} from '../lib/prepare';

for(const values of ['complete','error'] as const)test(`future fixed summaries with ${values} card values stay expired while past endpoints remain historical`,async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true,personal:true});t.after(()=>h.close());
  h.store.record(h.source,{observedAt:NOW-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:NOW+H}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'123',hasCredits:true}]});
  const view=h.directory.view(h.board);h.directory.saveView(h.board,{...view,shown:[...view.shown,'subscription-funds']},h.alice.id,NOW);h.events.flush();await flush();
  if(values==='error'){
    const send=h.period.transport.send.bind(h.period.transport);
    h.period.transport.send=async(...args:any[])=>{const reply=await send(...args);if(args[1].values)reply.values={state:'error',error:'history_limit'};return reply;};
  }
  h.selectRange({from:NOW-H,to:NOW+2*H});await flush();h.requests.length=0;
  const history=(scope:'quota'|'funds'):History=>{
    const entry=h.period.tapes.get(scope);assert.ok(entry.tape.fixed);
    const {from,to}=entry.tape.fixed.range;
    return {range:entry.rangeKey,live:false,since:from,to,cellMs:entry.tape.fixed.cell,historyStart:0,series:[],meterSeries:[],events:[],activity:{since:from,known:null,barMs:M,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
  };
  const quota=history('quota'),funds=history('funds');
  assert.deepEqual(h.period.project(quota,'quota',now).series.map((s:any)=>s.remainingAtEnd),[83]);
  assert.deepEqual(h.period.project(funds,'funds',now).meterSeries.map((s:any)=>s.end),['4920000']);
  for(const at of [NOW+H+1,NOW+2*H,NOW+3*H]){
    now=at;h.jump(now);await flush();
    assert.deepEqual(h.period.project(quota,'quota',now).series.map((s:any)=>s.remainingAtEnd),[null],`quota at ${at}`);
    assert.deepEqual(h.period.project(funds,'funds',now).meterSeries.map((s:any)=>s.end),[null],`funds at ${at}`);
  }
  assert.equal(h.requests.length,0,'expiry consumes accepted evidence without polling');
  h.selectRange({from:NOW-H,to:NOW});await flush();
  assert.deepEqual(h.period.project(history('quota'),'quota',now).series.map((s:any)=>s.remainingAtEnd),[83]);
  assert.deepEqual(h.period.project(history('funds'),'funds',now).meterSeries.map((s:any)=>s.end),['4920000']);
});

test('a sessions-only preparation crossing a card deadline publishes the expired value before its subscribers',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({clocked:true,personal:true});let stop=()=>{};
  const tasks:(()=>void)[]=[];let cpu=0;
  const scheduler=new Preparations({now:()=>cpu++,post:run=>tasks.push(run)},1);
  try{
    h.selectRange({from:NOW-H,to:NOW+2*H});await flush();
    const deadline=h.period.nativeDue;
    assert.ok(deadline>NOW&&deadline<NOW+H);assert.equal(h.period.getValue(h.source).value.windows[0].stale,false);
    h.prepareWith(scheduler);h.requests.length=0;
    let seen:boolean|undefined;
    stop=h.period.subscribe(()=>{if(!h.period.get().loading)seen=h.period.getValue(h.source).value.windows[0].stale;});
    h.store.creditWork(h.device,NOW-M,NOW,[{source:null,accountBy:null,client:'codex',origin:'terminal',startedAt:NOW-5*M,project:'Other project',folder:'Other folder',identity:{kind:'stable',sessionId:'f'.repeat(32)}}]);
    h.events.flush();await flush();
    assert.ok(h.requests.some(request=>request.sessions&&!request.values),'unfunded work needs sessions without another card-values response');
    assert.ok(scheduler.size>0,'the actual reply must be in cooperative preparation');
    // Time passes while preparation owns the event loop, before a clock task runs.
    now=deadline+1;h.elapseTo(now);
    while(tasks.length){tasks.shift()!();await flush();}
    await flush();
    assert.equal(h.period.getValue(h.source).value.windows[0].stale,true);
    assert.equal(seen,true,'the work subscriber must never see the newly expired card as fresh');
  }finally{stop();scheduler.dispose();h.prepareWith(null);await h.close();}
});
