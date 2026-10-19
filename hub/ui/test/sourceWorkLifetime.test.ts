import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H} from './periodRuntimeFixture';
import {publishDataFilters} from '../lib/filterSelection';
import {defaultFilters} from '../../server/domain/dataFilters';
import type {SourceWorkTape} from '../../server/domain/periodCurves';

for(const kind of ['cold complete','retained complete','retained delta','bulk pattern','transferred complete'] as const)test('source preparation keeps ownership atomic after a rejected '+kind,async t=>{
  t.mock.method(Date,'now',()=>NOW);const retained=kind.startsWith('retained');publishDataFilters(retained?defaultFilters():null,retained);
  const h=await fixture(),flight={role:'visible' as const};let pinned=0;
  try{
    const prior={tape:h.period.sourceTape,cursor:h.period.sourceCursor},reply=h.fresh(),part=reply.sessions;
    if(retained)assert.ok(prior.tape,'the failure must preserve an actual admitted baseline');
    assert.equal(part?.state,'complete');if(part?.state!=='complete')throw Error('missing sessions');
    const original=part.value.refs[0];part.value.refs=Array.from({length:150},(_,i)=>({...original,ref:String(i).padStart(8,'0'),identityRef:String(i).padStart(8,'0')}));
    part.value.spans=part.value.refs.map((_,i)=>[i,H-180_000,H-120_000]);delete part.value.packed;
    const value:SourceWorkTape&{cursor:string}={version:1,from:NOW-H,cut:NOW,cursor:'recovered-source-cursor',
      patterns:kind==='bulk pattern'?[Array.from({length:20_000},(_,i)=>[i,i%2?-1:1]).flat()]:[],
      sources:Array.from({length:kind==='bulk pattern'?1:2000},(_,i)=>({id:i===0?h.source:'codex:'+i,knownFrom:NOW-H,blocks:kind==='bulk pattern'?[Math.floor((NOW-H)/H),0]:[]})),
      ...(kind==='retained delta'?{replaceFrom:NOW-120_000,replaceTo:NOW}:{})};
    const state=kind==='retained delta'?'delta' as const:'complete' as const;
    reply.sourceWork={state,basis:reply.basis,value};
    const free=kind==='retained delta'?1_400_000:800_000;pinned=h.pool.budget-h.pool.estimatedBytes-free;
    h.pool.register({get estimatedBytes(){return pinned;},evictionCandidates:()=>[]});
    const reserve=h.pool.reserve.bind(h.pool);let rejected=0,peak=0;
    t.mock.method(h.pool,'reserve',(...args:Parameters<typeof reserve>)=>{const ok=reserve(...args);if(!ok)rejected++;peak=Math.max(peak,h.pool.estimatedBytes);return ok;});
    const receive=async(incoming:typeof reply)=>{
      if(kind==='transferred complete'){
        assert.ok(h.pool.reserve(flight,JSON.stringify(incoming).length*3),'the decoded response fits before preparation');
        await h.period.receive(incoming,h.period.intent(),(bytes:number)=>h.pool.reserve(flight,bytes));h.pool.release(flight);
      }else await h.period.receive(incoming,h.period.intent());
      await flush();
    };
    await receive(reply);
    assert.equal(reply.sourceWork?.state,'error','the limited section must fail explicitly');
    assert.equal(h.period.sourceTape,prior.tape,'a rejected candidate must not outlive its released staging');
    assert.equal(h.period.sourceCursor,prior.cursor,'a failed decode cannot advance the retry cursor');
    assert.equal(h.period.sourceCurves.available,false);assert.equal(h.period.get().error,null,'selected work completes independently');
    assert.equal(rejected,1,'cleanup must release only successfully admitted bytes');assert.ok(peak<=h.pool.budget);
    pinned=0;
    const recovery=h.fresh();recovery.sourceWork={state,basis:recovery.basis,value};
    await receive(recovery);
    assert.equal(recovery.sourceWork?.state,state);assert.equal(h.period.sourceTape.sources.length,value.sources.length);
    assert.equal(h.period.sourceCurves.groups.source.size,value.sources.length);assert.equal(h.period.sourceCurves.available,true);
    assert.equal(h.period.sourceCursor,value.cursor);assert.equal(rejected,1,'recovery uses the retained baseline and available budget');
  }finally{pinned=0;h.pool.release(flight);publishDataFilters(null,false);await h.close();}
});
