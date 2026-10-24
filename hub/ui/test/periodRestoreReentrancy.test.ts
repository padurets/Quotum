import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';

for(const replacement of ['live','clear'] as const)test(`a value listener ${replacement==='live'?'choosing live':'closing the board'} interrupts the actual retained period restore`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  let stop=()=>{};
  try{
    const first={...h.selectedRange()!},original=h.period.get().value;
    assert.ok(h.period.transport.evidence().size>0,'the complete target must own real transport evidence');
    h.selectRange({from:NOW-2*H,to:NOW-H});await flush();
    assert.ok(h.period.retained.size>0,'the first fixed target must have an actual complete cache entry');
    // Observe the production restore boundary without reproducing its algorithm.
    // The same wrapper works before and after the ownership implementation changes.
    let restored=false,reentered=0;
    for(const entry of h.period.retained.values()){
      const restore=entry.restore;
      entry.restore=function(...args:unknown[]){const result=restore.apply(this,args);restored=true;return result;};
    }
    stop=h.period.subscribeValue(h.source,()=>{
      if(!restored||reentered)return;
      assert.equal(h.period.get().value,original,'the publication must come from the actual restored numerical root');
      reentered++;
      if(replacement==='live')h.selectRange(null);
      else h.page.dispatch({type:'board-close'});
    });
    h.requests.length=0;
    h.selectRange(first);await flush();
    assert.equal(reentered,1,'the completed restore publication must permit synchronous replacement');
    if(replacement==='live'){
      assert.equal(h.period.selection.mode,'live');
      assert.equal(h.period.workSelection.mode,'live','the old fixed work selection must not be revived');
      assert.equal(h.period.workRangeKey,'1h');
      assert.equal(h.period.work.basis.range.from,NOW-H);
      assert.equal(h.period.work.basis.range.to,NOW);
      assert.equal(h.period.workNeeded,false,'the latest live sessions reply must complete');
      assert.ok(h.requests.some(request=>request.selection.mode==='live'&&request.sessions),'the latest target still needs its own session evidence');
    }else{
      assert.equal(h.page.get().board,null);
      assert.equal(h.period.get().value,null,'an interrupted restore cannot republish work after access closes');
      assert.equal(h.period.get().rows.length,0);
      assert.equal(h.period.values.size,0);
      assert.equal(h.period.tapes.size,0);
      assert.equal(h.period.activity,null);
      assert.equal(h.period.transport.evidence().size,0,'the old restore cannot reinstate cursors after access closes');
      assert.equal(h.period.estimatedBytes,0,'the stale restore releases its captured storage after clear');
      assert.equal(h.requests.length,0,'cleared access cannot start another period read');
    }
  }finally{stop();drawing.close();await h.close();}
});

test('relevant same-context history inside a value listener keeps the restored target pending until fresh work and values arrive',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);let stop=()=>{};
  try{
    const first={...h.selectedRange()!},original=h.period.get().value,before=h.period.activity.summary(first,'source').agentMs;
    assert.equal(before,M);
    h.selectRange({from:NOW-2*H,to:NOW-H});await flush();
    assert.ok(h.period.retained.size>0);
    let restored=false,reentered=0,observed:Record<string,number|boolean>|null=null;
    for(const entry of h.period.retained.values()){
      const restore=entry.restore;
      entry.restore=function(...args:unknown[]){const result=restore.apply(this,args);restored=true;return result;};
    }
    stop=h.period.subscribeValue(h.source,()=>{
      if(!restored||reentered)return;reentered++;
      assert.equal(h.period.get().value,original,'new evidence arrives after the real cache root is restored');
      const generation=h.period.generation,key=h.period.cacheKey,revision=h.period.revision,proof=h.period.proofEpoch;
      // Actual work and a measurement change inside A without changing its
      // date, source selection or authority. Both independent proofs become old.
      h.store.creditWork(h.device,NOW-20*M,NOW-19*M,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-25*M,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);
      h.store.record(h.source,{observedAt:NOW-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:30,remaining:70,resetAt:NOW+H}]});h.events.flush();
      observed={sameGeneration:h.period.generation===generation,sameKey:h.period.cacheKey===key,revisionAdvanced:h.period.revision>revision,proofAdvanced:h.period.proofEpoch>proof,workNeeded:h.period.workNeeded,valuesNeeded:h.period.valuesNeeded};
    });
    h.requests.length=0;h.selectRange(first);await flush();
    assert.equal(reentered,1);assert.deepEqual(observed,{sameGeneration:true,sameKey:true,revisionAdvanced:true,proofAdvanced:true,workNeeded:true,valuesNeeded:true});
    const target=h.requests.filter(request=>request.selection.mode==='range'&&request.selection.from===first.from&&request.selection.to===first.to);
    assert.ok(target.some(request=>request.sessions),'the changed current target still needs a new sessions read after the captured old A was restored');
    assert.ok(target.some(request=>request.values?.includes(h.source)),'the history event must not lose its new values demand');
    assert.equal(h.period.getValue(h.source).value.windows[0].remaining,70,'the measurement replacement reaches the restored card');
    assert.equal(h.period.activity.summary(first,'source').agentMs,before+M,'the recovered target includes the exact disjoint minute from the producer');
    const latest=JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'range',...first},evaluatedAt:NOW,sessions:{},values:[h.source]}));
    assert.equal(h.period.work.basis.revision,latest.basis.revision,'a current proof epoch cannot certify the captured old basis');
    assert.equal(h.period.workProofEpoch,h.period.proofEpoch);assert.equal(h.period.valuesProofEpoch,h.period.proofEpoch);
    assert.equal(h.period.workNeeded,false);assert.equal(h.period.valuesNeeded,false);
  }finally{stop();drawing.close();await h.close();}
});
