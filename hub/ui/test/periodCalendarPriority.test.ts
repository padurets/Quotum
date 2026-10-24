import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';

for(const mode of ['range','live'] as const)for(const pressure of ['none','alternate','only-target'] as const)test('calendar preparation respects incoming '+mode+' period recency with '+pressure+' pressure',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,heatmap:true});
  let release=()=>{};
  try{
    const first={from:NOW-H-M,to:NOW-M};
    const liveKey=h.period.cacheKey;
    h.selectRange(first);await flush();
    h.elapseTo(NOW+1000);if(mode==='range'){h.selectRange(null);await flush();}
    const repeat=mode==='range'?{from:first.from+7844,to:first.to+7844}:null;
    const selection=repeat?{mode:'range' as const,...repeat}:{mode:'live' as const,periodMs:H};
    const target=(mode==='live'?h.period.retained.get(liveKey):[...h.period.retained.values()].find((entry:any)=>entry.fits(selection))) as any;
    assert.ok(target,'the real producer must retain the incoming period before memory pressure');
    const eligible=()=>mode==='live'?target.valid(selection):target.fits(selection);
    assert.equal(eligible(),true);
    if(mode==='live')assert.equal(target.fits(selection),false,'live restoration requires its exact cache key');
    h.elapseTo(NOW+1500);
    const shownAt=NOW+1500;
    let buffer=0,armed=false,bufferDrops=0,targetDropped=false;
    const padding={get estimatedBytes(){return buffer;},evictionCandidates:()=>buffer&&pressure==='alternate'?[{bytes:buffer,shownAt,drop(){bufferDrops++;buffer=0;}}]:[]};
    h.pool.register(padding);
    const reserve=h.pool.reserve;
    const spy=t.mock.method(h.pool,'reserve',function(this:typeof h.pool,flight:Parameters<typeof reserve>[0]&{operation?:string},bytes:number){
      if(pressure!=='none'&&!armed&&flight.operation==='calendar-projection'&&bytes>1){
        const shortage=Math.min(Math.max(1,Math.floor(target.bytes/2)),Math.floor(bytes/2));
        buffer=h.pool.budget-h.pool.estimatedBytes-bytes+shortage;
        assert.ok(buffer>0);armed=true;
        assert.equal(eligible(),true);
        assert.ok([...h.period.retained.values()].includes(target));
      }
      const retained=[...h.period.retained.values()].includes(target);
      const accepted=reserve.call(this,flight,bytes);
      if(retained&&![...h.period.retained.values()].includes(target))targetDropped=true;
      if(accepted)assert.ok(h.pool.estimatedBytes<=h.pool.budget);
      return accepted;
    });
    release=()=>{spy.mock.restore();h.pool.unregister(padding);};
    h.elapseTo(NOW+2000);h.requests.length=0;
    h.selectRange(repeat);await flush();
    assert.equal(h.pool.budget,15*1024*1024);
    assert.equal(armed,pressure!=='none');
    assert.equal(targetDropped,pressure==='only-target');
    assert.equal(bufferDrops,pressure==='alternate'?1:0);
    assert.equal(h.requests.length,pressure==='only-target'?(mode==='range'?1:2):0);
    if(pressure==='only-target'){
      assert.ok(h.requests[0].sessions);assert.deepEqual(h.requests[0].values,mode==='range'?[h.source]:undefined);
      assert.equal(h.requests[0].calendar,undefined,'necessary eviction retains the normal resource fallback');
      if(mode==='live'){
        assert.ok(h.requests[0].quota);
        assert.ok(h.requests[1].funds);assert.equal(h.requests[1].sessions,undefined);
        assert.equal(h.requests[1].quota,undefined);assert.equal(h.requests[1].budget,undefined);
        assert.equal(h.requests[1].values,undefined);assert.equal(h.requests[1].calendar,undefined);
      }
    }
    assert.equal(h.period.selection.mode,mode);
    if(repeat){assert.equal(h.period.selection.from,repeat.from);assert.equal(h.period.selection.to,repeat.to);}
    else assert.equal(h.period.selection.periodMs,H);
    assert.equal(h.period.get().loading,false);assert.equal(h.period.workNeeded,false);
    assert.equal(h.period.get().rows[0].workedMs,M);
    assert.equal(h.period.calendar.get().error,null);
    assert.ok(h.period.calendar.get().value);
  }finally{release();await h.close();}
});

test('a fixed summary outside its proven shift keeps its existing recency and reads fresh evidence',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,heatmap:true});
  try{
    const first={from:NOW-H-M,to:NOW-M};
    h.selectRange(first);await flush();
    h.elapseTo(NOW+1000);h.selectRange(null);await flush();
    const target=[...h.period.retained.values()][0] as any;
    assert.ok(target);
    const outside={from:first.from-2*M,to:first.to-2*M};
    assert.equal(target.fits({mode:'range',...outside}),false);
    const previous=target.at;
    h.elapseTo(NOW+2000);h.requests.length=0;
    h.selectRange(outside);await flush();
    assert.equal(target.at,previous,'an unproven target gains no priority');
    assert.ok(h.requests.some(request=>request.sessions));
    assert.equal(h.period.workNeeded,false);
  }finally{await h.close();}
});
