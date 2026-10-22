import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {idleRetentionProblems,idleRetentionScript,type IdleRetention} from '../idleRetention.js';
import {idlePhaseProblems,type IdlePhase} from '../still.js';
import {packSamples,retainSamplesPrepared,type PeriodTape} from '../../server/domain/periodTape.js';
import {retainTape} from '../../server/domain/periodRetention.js';
import {drain} from '../../server/domain/prepare.js';

const DAY=86_400_000,NOW=1_800_000_000_000,from=NOW+240000,to=NOW+360000,R=NOW+300001;
function fixture(compressed=true){
  const packed=packSamples(Array.from({length:100},(_,i)=>({at:NOW-DAY+i*300000,used:i,resetAt:NOW+DAY,staleAfterMs:DAY})));
  const tape:PeriodTape={from:NOW-DAY,cut:NOW,replaceFrom:NOW-DAY,cursor:'captured',quota:[{source:'source',window:'weekly',samples:compressed?drain(retainSamplesPrepared(packed)):packed}],money:[]};
  const entry={tape},p={active:true,retiring:false,retirementPreparing:false,workNeeded:false,dirtyScopes:new Set(),transport:{flights:new Set(),queue:[]},projectionErrors:{},
    evaluatedAt:from,identity:'board/live',generation:1,revision:2,proofEpoch:3,scopeKeys:{quota:'same'},selection:{mode:'live',periodMs:DAY},retirementAt:R,tapes:new Map([['quota',entry]]),get:()=>({loading:false,error:null}),
    refreshWorkClock:()=>{throw Error('observer must not tick');},retireExpired:()=>{throw Error('observer must not retire');}};
  let now=from;
  const read=runInNewContext('('+idleRetentionScript()+')',{Map,Date:{now:()=>now}}) as (pool:unknown)=>IdleRetention;
  const pool={members:new Set([p])};
  const before=read(pool);
  return {p,entry,tape,before,read:()=>read(pool),retire:()=>{entry.tape=drain(retainTape(tape,NOW-DAY+350000));now=NOW+350000;p.evaluatedAt=now;p.retirementAt=NOW+600001;}};
}

test('a real flat or compressed retained suffix qualifies without driving production',()=>{
  for(const compressed of [false,true]){
    const h=fixture(compressed),original=structuredClone(h.tape);
    h.retire();const after=h.read();
    assert.deepEqual(idleRetentionProblems(h.before,after,from,to,R),[]);
    assert.equal(after.quota!.rows[0].count,99);assert.equal(after.quota!.rows[0].first,h.before.quota!.rows[0].second);
    assert.deepEqual(h.tape,original,'observing and retiring preserve the earlier committed inputs');
    assert.equal(h.p.transport.flights.size,0);
  }
});

test('time and all five axes can pass while actual quota cleanup is absent',()=>{
  const phase:IdlePhase={from,to,monotonicFrom:0,monotonicTo:to-from,cellMs:300000,starts:Array(5).fill(Math.floor(from/300000)),ends:Array(5).fill(Math.floor(to/300000)),transitions:[1,1,1,1,1]};
  assert.deepEqual(idlePhaseProblems(phase,NOW+300000,R),[],'the previous coverage guard accepts this window');
  const h=fixture();
  assert.ok(idleRetentionProblems(h.before,h.read(),from,to,R).some(problem=>problem.includes('prefix did not retire')));
});

test('admitted evidence, deadline and the entire due cohort must survive the window',()=>{
  const h=fixture();h.retire();const after=h.read();
  const reject=(before:IdleRetention|null,next:IdleRetention|null)=>assert.ok(idleRetentionProblems(before,next,from,to,R).length);
  reject(null,after);reject(h.before,null);
  for(const changed of [{settled:false},{identity:'other'},{generation:2},{revision:3},{proofEpoch:4},{scopeKey:'changed'},{selection:{mode:'range'}}])reject(h.before,{...after,...changed});
  reject({...h.before,retirementAt:null},after);reject({...h.before,retirementAt:R+1},after);
  assert.deepEqual(idleRetentionProblems({...h.before,retirementAt:R-1000},after,from,to,R),[],'work or money can be due before the quota edge');
  for(const changed of [{cursor:'new'},{cut:NOW+1},{rows:[]},{rows:[...after.quota!.rows,...after.quota!.rows]}])reject(h.before,{...after,quota:{...after.quota!,...changed}});
  for(const changed of [{count:97},{first:0},{last:0},{second:NaN}])reject(h.before,{...after,quota:{...after.quota!,rows:[{...after.quota!.rows[0],...changed}]}});
  const second={...h.before.quota!.rows[0],sourceId:'second'};
  reject({...h.before,quota:{...h.before.quota!,rows:[...h.before.quota!.rows,second]}},{...after,quota:{...after.quota!,rows:[...after.quota!.rows,second]}});
  reject({...h.before,quota:{...h.before.quota!,rows:[{...h.before.quota!.rows[0],third:NOW-DAY+350000}]}},after);
  const overdue={...h.before.quota!.rows[0],sourceId:'overdue',count:101,first:NOW-DAY-300000,second:NOW-DAY,third:NOW-DAY+300000};
  reject({...h.before,quota:{...h.before.quota!,rows:[...h.before.quota!.rows,overdue]}},{...after,quota:{...after.quota!,rows:[...after.quota!.rows,overdue]}});
});
