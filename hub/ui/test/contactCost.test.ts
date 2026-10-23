import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {namedCardsOf,reduce,type PageState} from '../lib/board';

test('private device contacts do not reconfigure analytical readers while real work and clock changes still arrive',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,heatmap:true,clocked:true}),period=h.period;
  const original=period.queries;let queries=0,configurations=0;
  period.queries=(...args:unknown[])=>{queries++;return original.apply(period,args);};
  const calendar=period.calendar,configure=calendar.configure;
  calendar.configure=(...args:unknown[])=>{configurations++;return configure.apply(calendar,args);};
  try{
    const board=h.page.get().board,work=period.get(),requests=h.requests.length;
    for(let i=0;i<20;i++)h.event({type:'deviceContacts',data:{devices:[{deviceId:h.device,lastSeenAt:NOW+i}]}});
    await flush();assert.equal(h.page.get().board,board);assert.equal(period.get(),work);assert.equal(h.requests.length,requests);
    const contactQueries=queries,contactConfigurations=configurations;
    h.store.creditWork(h.device,NOW-M,NOW,[{source:h.source,client:'codex',origin:'terminal',project:'B',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'B'}}]);h.events.flush();await flush();
    assert.ok(queries>contactQueries);assert.ok(configurations>contactConfigurations);
    assert.ok(period.get().rows.some((row:{project:string;workedMs:number})=>row.project==='B'&&row.workedMs===M),'real work still updates the period');
    h.advance(NOW+H+1);await flush();assert.equal(period.get().rows.length,0,'the shared clock still ages work out');
    assert.equal(contactQueries,0);assert.equal(contactConfigurations,0);
  }finally{await h.close();}
});

test('named-card readers reuse each immutable board projection on private contacts and accept changed measurements',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true});
  try{
    let reads=0;
    const board={...h.page.get().board!,cards:new Proxy(h.page.get().board!.cards,{get(target,key,receiver){if(key===h.source)reads++;return Reflect.get(target,key,receiver);}})};
    let state:PageState={...h.page.get(),board};
    const first=namedCardsOf(state,'quota');
    for(let i=0;i<20;i++){
      state=reduce(state,{type:'hub',event:{type:'deviceContacts',data:{devices:[{deviceId:h.device,lastSeenAt:NOW+i}]}}});
      for(let reader=0;reader<8;reader++)assert.deepEqual(namedCardsOf(state,'quota'),first);
    }
    assert.equal(reads,1,'private contact traffic and reader count must not multiply the source scan');
    const all=namedCardsOf(state),funds=namedCardsOf(state,'funds'),budget=namedCardsOf(state,'budget');
    assert.equal(all[0],state.board!.cards[h.source]);assert.equal(funds[0],all[0]);assert.equal(budget.length,0);
    assert.equal(namedCardsOf(state),all);assert.equal(namedCardsOf(state,'funds'),funds);assert.equal(namedCardsOf(state,'budget'),budget);
    const card=state.board!.cards[h.source],changed={...card,windows:card.windows.map(window=>({...window,remaining:42,used:58}))};
    state=reduce(state,{type:'hub',event:{type:'card',data:changed}});
    assert.equal(namedCardsOf(state,'quota')[0].windows[0].remaining,42);
    assert.equal(first[0].windows[0].remaining,83,'a new report does not mutate a retained projection');
  }finally{await h.close();}
});
