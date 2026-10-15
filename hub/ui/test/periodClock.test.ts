import {test} from 'node:test';
import assert from 'node:assert/strict';
import {periodTextChangesAt} from '../lib/periodClock.js';
import {PeriodIndex} from '../lib/periodIndex.js';
import {workHours} from '../lib/format.js';

test('period labels skip unchanged boundaries and wake at the first rounded change',()=>{
  const edges=[20,40,80],next=(at:number)=>edges.find(edge=>edge>at)??null;
  const read=(at:number)=>at<40?'same':at<80?String(Math.round((80-at)/10)):'done';
  assert.equal(periodTextChangesAt(0,next,read),40);
  assert.equal(periodTextChangesAt(40,next,read),46);
  assert.equal(periodTextChangesAt(76,next,read),80);
  assert.equal(periodTextChangesAt(80,next,read),null);
});

test('rolling worked labels retain every credited millisecond without waking their roster',()=>{
  const index=new PeriodIndex({anchor:0,knownFrom:0,refs:[{ref:'a',source:'s',device:{id:'d',name:'D'},origin:'terminal',project:null,folder:null,startedAt:0}],spans:[[0,0,180_000],[0,240_000,360_000]]});
  const period=600_000,curve=index.curves.contexts[0];
  const read=(now:number)=>workHours(curve.read({from:now-period,to:now}));
  const next=(now:number)=>{const at=curve.next(now-period)+period;return Number.isFinite(at)?at:null;};
  let now=period,changes=0;
  while(now<period+360_000){
    const due=periodTextChangesAt(now,next,read);assert.ok(due!==null&&due>now);
    for(let at=now;at<due;at++)assert.equal(read(at),read(now));
    assert.notEqual(read(due),read(now));now=due;changes++;
  }
  assert.ok(changes>3);assert.equal(read(now),workHours(0));
  assert.equal(periodTextChangesAt(now,next,read),null);
});

test('a long linear piece schedules its later formatting boundary without polling each minute',()=>{
  const read=(at:number)=>String(Math.floor(at/7_200_000));
  assert.equal(periodTextChangesAt(0,()=>10_000_000,read),3_600_000);
  assert.equal(periodTextChangesAt(3_600_000,()=>10_000_000,read),7_200_000);
});
