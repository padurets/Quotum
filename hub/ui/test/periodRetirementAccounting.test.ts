import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {expandPeriod} from '../../server/domain/periodWire';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {PeriodIndex} from '../../server/domain/periodIndex';
import {decodeSamples,sampleCount} from '../../server/domain/periodTape';

test('clock retirement reuses unchanged source accounting and replaces trimmed or removed work',async t=>{
  const periodMs=24*H,start=NOW-periodMs;
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({personal:true,periodName:'24h',clocked:true,creditFrom:start+2*M,creditTo:start+5*M});
  const unchanged=h.store.source('codex','b'.repeat(24),start-H),trimmed=h.store.source('codex','d'.repeat(24),start-H),removed=h.source;
  const sources=[unchanged,trimmed,removed];
  const credit=(source:string,sessionId:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source,client:'codex',origin:'terminal',startedAt:start-H,project:'Work project',folder:'Private folder',identity:{kind:'stable',sessionId}}]);
  try{
    for(const source of [unchanged,trimmed]){
      h.store.hold(source,h.alice.id,start-H);
      for(let i=0;i<12;i++)h.store.record(source,{observedAt:start+M+i*10*M,plan:'',resets:null,staleAfterMs:2*periodMs,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:10+i,remaining:90-i,resetAt:NOW+periodMs}]});
    }
    // The first context expires inside an hour whose source still has other work.
    credit(unchanged,'b'.repeat(32),start+2*M,start+5*M);
    credit(unchanged,'f'.repeat(32),start+3*M,start+50*M);
    credit(trimmed,'d'.repeat(32),start+2*M,start+5*M);
    credit(trimmed,'d'.repeat(32),start+H+10*M,start+H+30*M);
    h.events.flush();await flush();
    const before=h.period.tapes.get('quota'),work=h.period.get().value,groups=h.period.index.curves.groups.source;
    assert.equal(before.tape.quota.length,3);
    assert.equal(sampleCount(before.accounting.quota.get(unchanged+'\nw').series.samples),12);
    assert.equal(h.period.get().rows.length,4);
    const indexes=new Map(sources.map(source=>[source,before.accounting.quota.get(source+'\nw')]));
    for(const index of indexes.values())assert.ok(index);
    const requests=h.requests.length,revision=h.period.getProjectionRevision('quota');
    now=NOW+5*M;h.jump(now);await flush();
    const after=h.period.tapes.get('quota'),retained=h.period.get().value,nextGroups=h.period.index.curves.groups.source;
    assert.equal(h.period.get().error,null);
    assert.notEqual(retained,work);
    assert.equal(retained.anchor,start+5*M);
    assert.equal(retained.knownFrom,work.knownFrom,'storage retirement does not move the authority cutoff');
    assert.equal(after.tape,before.tape,'no measurement prefix needs retirement at this boundary');
    assert.equal(nextGroups.get(unchanged),groups.get(unchanged));
    assert.notEqual(nextGroups.get(trimmed),groups.get(trimmed));
    assert.ok(nextGroups.has(trimmed));
    assert.equal(nextGroups.has(removed),false);
    assert.equal(after.accounting.quota.get(unchanged+'\nw'),indexes.get(unchanged),'an unchanged source timeline must retain its quota index');
    for(const source of [trimmed,removed])assert.notEqual(after.accounting.quota.get(source+'\nw'),indexes.get(source),'trimmed and removed source timelines must replace their quota indexes');
    assert.equal(h.period.getProjectionRevision('quota'),revision,'storage retirement does not invalidate chart geometry');
    assert.equal(h.requests.length,requests,'the shared clock retires work without reading history');
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes,'retirement releases every temporary reservation');

    const range={from:now-periodMs,to:now},queries=h.period.queries(h.page.get().board,range);
    const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs},evaluatedAt:now,...queries,sessions:{}})));
    assert.ok(fresh.sessions&&fresh.sessions.state!=='error');
    assert.ok(fresh.quota?.state==='complete'&&fresh.quota.value.tape);
    const tape=fresh.quota.value.tape;
    for(const series of tape.quota)if(series.samplesEncoding==='delta'){series.samples=decodeSamples(series.samples);delete series.samplesEncoding;}
    const index=new PeriodIndex(fresh.sessions.value),expected=new PeriodAccounting(tape,fresh.sessions.value,index.curves);
    assert.equal(fresh.sessions.value.knownFrom,retained.knownFrom);
    for(const source of sources)for(const at of [range.from,range.from+1,start+10*M,start+50*M,start+H+20*M,now])for(const selected of [{from:range.from,to:at},{from:at,to:now}]){
      assert.deepEqual(after.accounting.quotaSummary(source,'w',selected),expected.quotaSummary(source,'w',selected),'retained work and quota summaries match a fresh authorized producer read');
    }
    assert.deepEqual(after.accounting.fixed(range,10*M),expected.fixed(range,10*M));
  }finally{await h.close();}
});
