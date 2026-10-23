import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H} from './periodRuntimeFixture';

type Runtime=Awaited<ReturnType<typeof fixture>>;
type Boundary='calendar'|'facets'|'value'|'source'|'work'|'projection';
function subscribe(h:Runtime,boundary:Boundary,listener:()=>void){
  return boundary==='calendar'?h.period.calendar.subscribe(listener)
    :boundary==='facets'?h.period.subscribeFacets(listener)
    :boundary==='value'?h.period.subscribeValue(h.source,listener)
    :boundary==='source'?h.period.subscribeSource(h.source,listener)
    :boundary==='work'?h.period.subscribe(listener)
    :h.period.subscribeProjection('quota',listener);
}

for(const boundary of ['calendar','facets','value','work','projection'] as const)
for(const replacement of ['newer','inactive','close'] as const)
test(`a fixed target's ${boundary} publication preserves a synchronous ${replacement} replacement`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true,heatmap:true}),drawing=await drawings(h);
  const a={from:NOW-2*H,to:NOW-H},b={from:NOW-3*H,to:NOW-2*H};
  let armed=true,entered=0;
  const seen:{from:number|undefined;to:number|undefined}[]=[];
  const stop=subscribe(h,boundary,()=>{
    if(!armed)return;armed=false;entered++;
    seen.push({from:h.period.selection.from,to:h.period.selection.to});
    if(replacement==='newer')h.selectRange(b);
    else if(replacement==='inactive')h.period.activate(false);
    else h.page.dispatch({type:'board-close'});
  });
  try{
    h.requests.length=0;h.selectRange(a);
    // The history listener reads the latest shared range after the period listener.
    if(replacement==='newer')drawing.loader.choose(h.settings.range,h.selectedRange());
    await flush();assert.equal(entered,1,'the actual producer must cross this publication');
    assert.deepEqual(seen,[a],'the first notification sees the completed target mutation');
    if(replacement==='newer'){
      assert.deepEqual(h.selectedRange(),b);assert.equal(h.period.selection.from,b.from);assert.equal(h.period.selection.to,b.to);
      assert.deepEqual(h.period.get().basis?.range,b,'the producer answers the last shared target');
      assert.deepEqual(h.period.calendar.get().basis?.range,b);assert.equal(h.period.calendar.demand(),undefined);
      assert.ok(h.requests.length>0);assert.ok(h.requests.every(request=>request.selection.mode==='range'&&request.selection.from===b.from&&request.selection.to===b.to),'no old target reaches HTTP after its synchronous replacement');
      const activity=drawing.renderActivity();assert.ok(activity.history);assert.equal(activity.loading,false);
      assert.equal(activity.history.since,b.from);assert.equal(activity.history.to,b.to);
    }else{
      assert.equal(h.period.get().value,null);assert.equal(h.period.get().rows.length,0);
      assert.equal(h.period.values.size,0);assert.equal(h.period.tapes.size,0);assert.equal(h.period.activity,null);
      assert.equal(h.period.calendar.get().value,null);assert.equal(h.period.calendar.demand(),undefined);
      assert.equal(h.period.estimatedBytes,0,'the abandoned mutation cannot recreate resident metadata after clear');
      assert.equal(h.requests.length,0,'closed or inactive periods cannot start another read');
      if(replacement==='inactive')assert.equal(h.period.active,false);else assert.equal(h.page.get().board,null);
    }
    assert.equal(h.pool.activeFlights,0);
  }finally{stop();drawing.close();h.page.dispatch({type:'board-close'});await h.close();}
});

for(const boundary of ['calendar','facets','source','work','projection'] as const)
test(`hard work retirement at ${boundary} cannot resume after a subscriber deactivates the period`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true,heatmap:true});let armed=true,entered=0;
  const stop=subscribe(h,boundary,()=>{if(armed){armed=false;entered++;h.period.activate(false);}});
  try{
    h.requests.length=0;h.event({type:'history',data:{sources:[],since:0,workSince:0}});await flush();
    assert.equal(entered,1);assert.equal(h.period.active,false);assert.equal(h.period.get().value,null);
    assert.equal(h.period.get().rows.length,0);assert.equal(h.period.values.size,0);assert.equal(h.period.tapes.size,0);
    assert.equal(h.period.calendar.demand(),undefined);assert.equal(h.period.estimatedBytes,0);
    assert.equal(h.requests.length,0);assert.equal(h.pool.activeFlights,0);
  }finally{stop();h.page.dispatch({type:'board-close'});await h.close();}
});

for(const replacement of ['inactive','close'] as const)test(`a later calendar wake cannot recreate ${replacement} live demand`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,heatmap:true});
  try{
    if(replacement==='inactive')h.period.activate(false);else h.page.dispatch({type:'board-close'});
    h.requests.length=0;h.elapseTo(NOW+2*24*H);h.period.wakeCalendar();h.period.refreshWorkClock();await flush();
    assert.equal(h.period.calendar.demand(),undefined);assert.equal(h.period.calendar.get().value,null);
    assert.equal(h.period.estimatedBytes,0);assert.equal(h.period.nativeDue,Infinity);
    assert.equal(h.requests.length,0);assert.equal(h.pool.activeFlights,0);
  }finally{h.page.dispatch({type:'board-close'});await h.close();}
});

for(const replacement of ['newer','inactive','close'] as const)test(`financial value retirement preserves a subscriber's ${replacement} replacement`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true,heatmap:true});
  h.store.record(h.source,{observedAt:NOW-60_000,plan:'pro',resets:null,staleAfterMs:H,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'123',hasCredits:true}]});h.events.flush();await flush();
  const target={from:NOW-2*H,to:NOW-H},currency=h.store.currencies.create(h.alice.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',NOW);
  let armed=true,entered=0;
  const stop=h.period.subscribeValue(h.source,()=>{
    if(!armed)return;armed=false;entered++;
    assert.equal(h.period.getValue(h.source).value?.meters.length,0,'the old financial amount is retired before publication');
    if(replacement==='newer')h.selectRange(target);
    else if(replacement==='inactive')h.period.activate(false);
    else h.page.dispatch({type:'board-close'});
  });
  try{
    h.requests.length=0;h.store.currencies.select(h.alice.id,currency.id);h.event({type:'currencies',data:h.store.currencies.context(h.alice.id)});await flush();
    assert.equal(entered,1);
    if(replacement==='newer'){
      assert.equal(h.period.selection.from,target.from);assert.equal(h.period.selection.to,target.to);
      assert.deepEqual(h.period.get().basis?.range,target);assert.deepEqual(h.period.calendar.get().basis?.range,target);
      assert.ok(h.requests.length>0);assert.ok(h.requests.every(request=>request.selection.mode==='range'&&request.selection.from===target.from&&request.selection.to===target.to));
    }else{
      assert.equal(h.period.get().value,null);assert.equal(h.period.values.size,0);assert.equal(h.period.tapes.size,0);
      assert.equal(h.period.calendar.demand(),undefined);assert.equal(h.period.estimatedBytes,0);assert.equal(h.requests.length,0);
    }
    assert.equal(h.pool.activeFlights,0);
  }finally{stop();h.page.dispatch({type:'board-close'});await h.close();}
});
