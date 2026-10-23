import test from 'node:test';
import assert from 'node:assert/strict';
import {drain} from '../domain/prepare.js';
import {PeriodCurves,type WorkTimeline} from '../domain/periodCurves.js';
import {PeriodIndex} from '../domain/periodIndex.js';
import {PeriodActivity} from '../domain/periodActivity.js';
import {retainWork} from '../domain/periodRetention.js';
import {packWork,workedSessions,WORK_BLOCK_MS as H,type WorkTrace} from '../domain/periodWork.js';
import type {History} from '../domain/history.js';

const trace=():WorkTrace=>({anchor:0,knownFrom:0,cut:6*H,
  refs:['expired','trimmed','unchanged','future'].map((ref,i)=>({ref,source:i===3?null:'s',project:i===0?'expired':i===3?null:'P',device:{id:i===3?'other':'d',name:'Device'},origin:'terminal',folder:null,startedAt:0})),
  // Encounter order differs from reference order, as after merging work deltas.
  spans:[[0,0,80],[2,H+100,2*H+50],[2,3*H,4*H+23],[1,0,H+5],[1,2*H+17,3*H+11],[3,5*H,5*H+90]],
});
const blank:History['activity']={since:0,known:{from:0,to:6*H},barMs:H,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
const timelines=(curves:PeriodCurves)=>new Set([curves.all,...curves.contexts,...Object.values(curves.groups).flatMap(groups=>[...groups.values()])]);
type Buffers={hours:Float64Array;agents:Float64Array;active:Float64Array;curves:{bytes:number}[]};
const buffers=(timeline:WorkTimeline)=>timeline as unknown as Buffers;

test('retained work curves keep exact intervals, membership and ordering after repeated prefix cuts',()=>{
  for(const packed of [false,true]){
    let work=packed?packWork(trace()):trace(),index=new PeriodIndex(work);
    for(const from of [H+6,H+101,2*H+50,3*H+12,4*H+23,5*H+90]){
      const next=drain(retainWork(work,from));index=drain(index.retain(next,()=>{}));work=next;
      const fresh=new PeriodIndex(work),activity=new PeriodActivity(work,index.curves),freshActivity=new PeriodActivity(work,fresh.curves);
      assert.equal(fresh.curves.borrowedBytes,0);
      assert.equal(index.trace,work);assert.equal(index.curves.trace,work);
      for(const dimension of ['source','project','device'] as const)assert.deepEqual([...index.curves.groups[dimension].keys()],[...fresh.curves.groups[dimension].keys()]);
      for(const start of [from,from+1,from+37,H+100,2*H+17,3*H,5*H].filter(at=>at>=from))for(const end of [start,start+1,start+101,start+H,6*H].filter(at=>at>=start)){
        const range={from:start,to:end},rows=index.advance(range,end).rows,expected=fresh.advance(range,end).rows;
        assert.deepEqual(rows,expected);
        const order=(rows:typeof expected)=>[...rows].sort((a,b)=>a.ref.localeCompare(b.ref));
        assert.deepEqual(order(rows),order(workedSessions(work,range,end)));
        activity.update(rows);freshActivity.update(expected);assert.deepEqual(activity.project(blank,range),freshActivity.project(blank,range));
        const selected=index.curves.contexts.map(curve=>[curve.working(end),curve.slope(end),curve.next(end)]);
        assert.deepEqual(selected,fresh.curves.contexts.map(curve=>[curve.working(end),curve.slope(end),curve.next(end)]));
        assert.equal(index.changesAt(end,end-start,[work.refs.map(ref=>[ref.ref])]),fresh.changesAt(end,end-start,[work.refs.map(ref=>[ref.ref])]));
      }
    }
  }
});

test('prefix retention copies only trimmed timeline buffers and counts shared curves once',()=>{
  const original=packWork(trace()),curves=new PeriodCurves(original),before=JSON.stringify(original),work=drain(retainWork(original,H+6));
  let reserved=0;const next=drain(curves.retain(work,bytes=>{assert.ok(bytes>0);reserved+=bytes;}));
  assert.notEqual(next.trace,original);assert.equal(next.trace,work);assert.equal(JSON.stringify(original),before);
  assert.deepEqual(work.refs.map(ref=>ref.ref),['unchanged','trimmed','future']);
  const unchanged=next.contexts[0],trimmed=next.contexts[1];
  assert.equal(unchanged,curves.contexts[2]);assert.equal(next.contexts[2],curves.contexts[3]);
  assert.notEqual(trimmed,curves.contexts[1]);
  for(const key of ['hours','agents','active'] as const)assert.notEqual(buffers(trimmed)[key].buffer,buffers(curves.contexts[1])[key].buffer,'retirement must release the expired backing buffers');
  for(const curve of buffers(trimmed).curves)assert.ok(buffers(curves.contexts[1]).curves.includes(curve),'surviving patterns are immutable and shared');
  const unique=timelines(next),patterns=new Set([...unique].flatMap(timeline=>buffers(timeline).curves));
  assert.equal(next.bytes,[...unique].reduce((sum,timeline)=>sum+timeline.bytes,0)+[...patterns].reduce((sum,curve)=>sum+curve.bytes,0));
  const previous=timelines(curves),allocated=[...unique].filter(timeline=>!previous.has(timeline)).reduce((sum,timeline)=>sum+timeline.bytes,0);
  const borrowed=[...unique].filter(timeline=>previous.has(timeline)).reduce((sum,timeline)=>sum+timeline.bytes,0)+[...patterns].reduce((sum,curve)=>sum+curve.bytes,0);
  assert.equal(curves.borrowedBytes,0,'a fresh build owns its full retained size');
  assert.equal(next.borrowedBytes,borrowed,'only exact old object identities are borrowed, counted once');
  assert.equal(next.bytes-next.borrowedBytes,allocated,'copied timeline buffers remain charged');
  assert.ok(reserved>=allocated,'new buffers and preparation metadata are admitted before allocation');
  const allGone=drain(retainWork(work,6*H)),empty=drain(next.retain(allGone,()=>{}));
  assert.deepEqual(empty.contexts,[]);assert.equal(buffers(empty.all).hours.length,0);assert.deepEqual(buffers(empty.all).curves,[]);
});

test('cancelling or refusing retained curve preparation leaves the authoritative index intact',()=>{
  const work=packWork(trace()),index=new PeriodIndex(work),range={from:0,to:6*H},expected=index.advance(range,6*H).rows;
  const retained=drain(retainWork(work,H+6)),before=JSON.stringify(work),owned=[...timelines(index.curves)].map(timeline=>Array.from(buffers(timeline).agents));
  for(const fail of [false,true]){
    let charges=0;const preparation=index.retain(retained,()=>{if(++charges===10&&fail)throw new Error('capacity');});
    if(fail)assert.throws(()=>drain(preparation),/capacity/);
    else {while(charges<10)assert.equal(preparation.next().done,false);preparation.return(undefined as never);}
    assert.equal(JSON.stringify(work),before);assert.deepEqual(index.advance(range,6*H).rows,expected);
    assert.deepEqual([...timelines(index.curves)].map(timeline=>Array.from(buffers(timeline).agents)),owned);
  }
  assert.deepEqual(drain(index.retain(retained,()=>{})).advance({from:H+6,to:6*H},6*H).rows,new PeriodIndex(retained).advance({from:H+6,to:6*H},6*H).rows);
});

test('borrowed curve bytes are relative to the immediate previous owner after repeated cuts',()=>{
  let work=packWork(trace()),curves=new PeriodCurves(work);
  for(const from of [H+6,2*H+50,4*H+23,6*H]){
    const before=curves,owned=timelines(before),patterns=new Set([...owned].flatMap(timeline=>buffers(timeline).curves));
    work=drain(retainWork(work,from));curves=drain(before.retain(work,()=>{}));
    const kept=timelines(curves),shared=new Set([...kept].flatMap(timeline=>buffers(timeline).curves));
    for(const curve of shared)assert.ok(patterns.has(curve),'retirement creates no replacement Curve');
    const borrowed=[...kept].filter(timeline=>owned.has(timeline)).reduce((sum,timeline)=>sum+timeline.bytes,0)+[...shared].reduce((sum,curve)=>sum+curve.bytes,0);
    assert.equal(curves.borrowedBytes,borrowed,'prior borrowed counters are not accumulated');
    assert.ok(curves.borrowedBytes>=0&&curves.borrowedBytes<=curves.bytes);
  }
});
