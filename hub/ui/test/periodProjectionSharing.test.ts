import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H} from './periodRuntimeFixture';

test('fixed chart consumers share exact accounting for the same complete evidence',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true}),d=await drawings(h);
  try {
    d.loader.choose('1h',{from:NOW-H,to:NOW});await flush();
    const history=d.loader.get().history;assert.ok(history);
    assert.equal(h.period.projectionState(history,'quota').ready,true);
    const accounting=h.period.tapes.get('quota').accounting,read=accounting.project.bind(accounting);let calls=0;
    t.mock.method(accounting,'project',(...args:Parameters<typeof read>)=>{calls++;return read(...args);});
    const first=h.period.project(history,'quota',NOW);
    assert.equal(h.period.project(history,'quota',NOW+1),first);
    assert.equal(h.period.project(history,'quota',NOW+2),first);
    assert.equal(calls,1);
    const next=h.period.project({...history},'quota',NOW);
    assert.equal(calls,2);assert.deepEqual(next,first);
  } finally {d.close();await h.close();}
});

test('shared fixed frames follow real observations and selected endpoint changes',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true}),d=await drawings(h);
  try {
    // The fixture already selected this fixed range; establish real rapid choices.
    d.loader.choose('1h',null);d.loader.choose('1h',{from:NOW-H,to:NOW});
    assert.deepEqual(d.runScheduled(),[300]);await flush();
    const initial=d.loader.get().history;assert.ok(initial);
    assert.equal(h.period.project(initial,'quota',NOW).series.find((s:any)=>s.sourceId===h.source).remainingAtEnd,83);
    h.store.record(h.source,{observedAt:NOW-60_000,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:45,remaining:55,resetAt:NOW+H}]});
    h.reader.touch(h.source,NOW-60_000,['quota']);
    h.event({type:'history',data:{sources:[h.source],since:NOW-60_000,changes:[{source:h.source,scope:'quota',since:NOW-60_000}]}});
    await flush();
    const history=d.loader.get().history;assert.ok(history);
    const updated=h.period.project(history,'quota',NOW);
    assert.equal(updated.series.find((s:any)=>s.sourceId===h.source).remainingAtEnd,55);
    assert.equal(h.period.project(history,'quota',NOW+1),updated);
    const selected={from:NOW-H-1,to:NOW-1};h.selectRange(selected);d.loader.choose('1h',selected);
    assert.equal(d.loader.get().loading,true);
    assert.deepEqual(d.runScheduled(),[300]);await flush();
    const moved=d.loader.get().history;assert.ok(moved);
    assert.equal(h.period.projectionState(moved,'quota').ready,true);
    const frame=h.period.project(moved,'quota',NOW);
    assert.equal(frame.since,selected.from);assert.equal(frame.to,selected.to);
    assert.equal(frame.series.find((s:any)=>s.sourceId===h.source).remainingAtEnd,55);
    assert.equal(h.period.project(moved,'quota',NOW+1),frame);
  } finally {d.close();await h.close();}
});

test('live chart projections keep each consumer clock endpoint',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture(),d=await drawings(h);
  try {
    const history=d.loader.get().history;assert.ok(history);
    const accounting=h.period.tapes.get('quota').accounting,read=accounting.project.bind(accounting);let calls=0;
    t.mock.method(accounting,'project',(...args:Parameters<typeof read>)=>{calls++;return read(...args);});
    const first=h.period.project(history,'quota',NOW),next=h.period.project(history,'quota',NOW+1);
    assert.equal(calls,2);assert.equal(first.to,NOW);assert.equal(next.to,NOW+1);
  } finally {d.close();await h.close();}
});
