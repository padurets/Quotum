import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';

for(const boundary of ['facets','value','source','work','projection'] as const)for(const replacement of ['clear','live','history'] as const)test(`fresh period ${boundary} notification can ${replacement} without reviving its captured reply`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  const wanted={from:NOW-2*H,to:NOW-H};
  let stop=()=>{},releaseFacets=()=>{};
  try{
    if(boundary==='facets'){releaseFacets=h.period.demandFacets();await flush();}
    let inside=0,reentered=0,coherent=false;
    const adopt=h.period.adoptReply;
    h.period.adoptReply=async function(...args:unknown[]){inside++;try{return await adopt.apply(this,args);}finally{inside--;}};
    const listener=()=>{
      if(!inside||reentered)return;
      if(boundary==='facets'?h.period.getFacets().loading:boundary==='value'?h.period.getValue(h.source).loading:boundary==='work'?h.period.get().loading:false)return;
      reentered++;
      const value=h.period.getValue(h.source),work=h.period.get(),tape=h.period.tapes.get('quota');
      coherent=!!work.value&&work.value===h.period.work.value&&work.basis?.range.from===wanted.from&&work.basis?.range.to===wanted.to
        &&value.basis?.range.from===wanted.from&&value.basis?.range.to===wanted.to&&!value.loading
        &&!!tape&&h.period.storage.has(tape.tape)&&h.period.storage.has(tape.accounting)&&h.period.storage.has(value.value)
        &&h.period.storage.has(h.period.activity);
      if(replacement==='clear')h.page.dispatch({type:'board-close'});
      else if(replacement==='live')h.selectRange(null);
      else {
        h.store.creditWork(h.device,NOW-90*M,NOW-89*M,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-95*M,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);
        h.events.flush();
      }
    };
    stop=boundary==='facets'?h.period.subscribeFacets(listener):boundary==='value'?h.period.subscribeValue(h.source,listener):boundary==='source'?h.period.subscribeSource(h.source,listener):boundary==='work'?h.period.subscribe(listener):h.period.subscribeProjection('quota',listener);
    h.requests.length=0;h.selectRange(wanted);await flush();
    assert.equal(reentered,1,'the actual fresh adoption must notify this consumer');
    assert.equal(coherent,true,'the first notification sees the complete numeric snapshot and its resident storage');
    if(replacement==='clear'){
      assert.equal(h.page.get().board,null);assert.equal(h.period.get().value,null);assert.equal(h.period.get().rows.length,0);
      assert.equal(h.period.values.size,0);assert.equal(h.period.tapes.size,0);assert.equal(h.period.activity,null);
      assert.equal(h.period.estimatedBytes,0);assert.equal(h.period.transport.evidence().size,0);
    }else if(replacement==='live'){
      assert.equal(h.period.selection.mode,'live');assert.equal(h.period.workSelection.mode,'live');
      assert.equal(h.period.work.basis.range.from,NOW-H);assert.equal(h.period.work.basis.range.to,NOW);
      assert.ok(h.requests.some(request=>request.selection.mode==='live'&&request.sessions),'Live must retain its new sessions demand');
      assert.equal(h.period.workNeeded,false);
    }else{
      assert.ok(h.requests.filter(request=>request.selection.mode==='range'&&request.selection.from===wanted.from&&request.sessions).length>=2,'new evidence requires another sessions read for this same target');
      assert.equal(h.period.activity.summary(wanted,'source').agentMs,M,'the actual producer contributes the disjoint new minute');
      const latest=h.fresh();
      assert.equal(h.period.work.basis.revision,latest.basis.revision);assert.equal(h.period.workProofEpoch,h.period.proofEpoch);
      assert.equal(h.period.valuesProofEpoch,h.period.proofEpoch);assert.equal(h.period.workNeeded,false);assert.equal(h.period.valuesNeeded,false);
    }
  }finally{stop();releaseFacets();drawing.close();await h.close();}
});

for(const boundary of ['facets','value'] as const)for(const replacement of ['clear','live','history'] as const)test(`failed fresh period ${boundary} notification preserves a reentrant ${replacement}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  let stop=()=>{},releaseFacets=()=>{};
  try{
    if(boundary==='facets'){releaseFacets=h.period.demandFacets();await flush();}
    let inside=0,reentered=0,coherent=false;
    const adopt=h.period.adoptReply;
    h.period.adoptReply=async function(...args:unknown[]){inside++;try{return await adopt.apply(this,args);}finally{inside--;}};
    const listener=()=>{
      if(!inside||reentered||!(boundary==='facets'?h.period.getFacets().error:h.period.getValue(h.source).error))return;
      reentered++;
      coherent=!!h.period.get().error&&!!h.period.getValue(h.source).error&&!h.period.get().loading&&!h.period.getValue(h.source).loading;
      if(replacement==='clear')h.page.dispatch({type:'board-close'});
      else if(replacement==='live')h.selectRange(null);
      else {
        h.store.creditWork(h.device,NOW-90*M,NOW-89*M,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-95*M,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);
        h.events.flush();
      }
    };
    stop=boundary==='facets'?h.period.subscribeFacets(listener):h.period.subscribeValue(h.source,listener);
    const held=h.hold();h.selectRange({from:NOW-2*H,to:NOW-H});await flush();held.reject(new Error('fixture transport failure'));await flush();
    assert.equal(reentered,1);assert.equal(coherent,true,'error sections commit together before a subscriber can replace them');
    if(replacement==='clear'){assert.equal(h.period.get().value,null);assert.equal(h.period.values.size,0);assert.equal(h.period.estimatedBytes,0);}
    else {assert.equal(h.period.get().error,null);assert.equal(h.period.workNeeded,false);assert.equal(h.period.valuesNeeded,false);assert.equal(h.period.workSelection.mode,replacement==='live'?'live':'range');}
  }finally{stop();releaseFacets();drawing.close();await h.close();}
});

test('a resource change from the first publication still notifies surviving value subscribers',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  const releaseFacets=h.period.demandFacets();await flush();
  let stopFacets=()=>{},stopValue=()=>{};
  try{
    let inside=0,reentered=0,ready=0;
    const wanted={from:NOW-2*H,to:NOW-H},adopt=h.period.adoptReply;
    h.period.adoptReply=async function(...args:unknown[]){inside++;try{return await adopt.apply(this,args);}finally{inside--;}};
    stopFacets=h.period.subscribeFacets(()=>{
      if(!inside||reentered||h.period.getFacets().loading)return;
      reentered++;
      const board=h.page.get().board!,generation=h.period.generation;
      h.event({type:'view',data:{revision:(board.viewRevision??0)+1,view:{...board.view,shown:['agents'],hidden:['activity','quota-history','quota-session-history','quota-table','quota-session-table','subscription-funds','budget-history','budget-table']}}});
      assert.ok(h.period.generation>generation,'the resource change invalidates the captured intent');
    });
    stopValue=h.period.subscribeValue(h.source,()=>{
      const reading=h.period.getValue(h.source);
      if(reading.value&&!reading.loading&&reading.basis?.range.to===wanted.to)ready++;
    });
    h.selectRange(wanted);await flush();
    assert.equal(reentered,1);assert.equal(ready,1,'a changed generation must not swallow the already committed value notification');
    assert.equal(h.period.getValue(h.source).basis.range.to,wanted.to);
  }finally{stopFacets();stopValue();releaseFacets();drawing.close();await h.close();}
});
