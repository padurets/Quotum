import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SETS} from '../../demo/catalogue.js';
import {cards, DAY, MIN, historyTimes} from '../../demo/model.js';
import {STILL_FOR} from '../../demo/setup.js';
import {panningSet} from '../fixture.js';
import {DOT_STILL_AFTER,fixtureTiming,idleWindow,SETTLE_MS,stillProblems,stillSnapshot,warmUntil} from '../still.js';
import {drain} from '../../server/domain/prepare.js';
import {packSamples,sampleAt,sampleCount,type PeriodTape} from '../../server/domain/periodTape.js';
import {retainTape,retirementEdge} from '../../server/domain/periodRetention.js';
import {PageClock} from '../../ui/lib/clock.js';

test('the aged fixture keeps its grid anchor and waits for actual freshness and page settle',()=>{
  const crossing=Date.parse('2026-10-15T10:34:10Z');
  const before=fixtureTiming(crossing-1),after=fixtureTiming(crossing);
  assert.equal(before.start,crossing-15*MIN);
  assert.equal(after.start,crossing-10*MIN);
  assert.equal(before.warmAt,before.start+DOT_STILL_AFTER);
  assert.equal(after.warmAt,after.start+DOT_STILL_AFTER);
  const card=cards(panningSet(SETS[0])).find(card=>card.id==='antigravity')!;
  const observation=(at:number)=>{const wire=stillSnapshot(card,after.start,at);return{id:card.id,successAt:Date.parse(wire.observedAt),staleAfterMs:wire.staleAfterMs,windows:wire.windows.map(window=>({resetAt:window.resetsAt===null?null:Date.parse(window.resetsAt)})),forecast:undefined};};
  const seeded=observation(after.start);
  assert.equal(Math.max(after.warmAt,warmUntil([seeded],crossing)),crossing+SETTLE_MS);
  assert.deepEqual(stillProblems([seeded],crossing,crossing+20*MIN),[]);
  const freshAt=crossing+MIN,fresh=observation(freshAt);
  assert.equal(fresh.successAt!+fresh.staleAfterMs,after.start+STILL_FOR,'a later sample keeps the original absolute deadline');
  assert.equal(warmUntil([fresh],crossing),freshAt+DOT_STILL_AFTER,'a new observation cannot borrow the aged seed deadline');
  assert.ok(stillProblems([fresh],freshAt,freshAt+2*MIN).includes(card.id+"'s dot still fades"));
});

test('each launch-minute phase includes regular quota retirement in the measured chart transition',()=>{
  const set=panningSet(SETS[0]),dense=cards(set).find(card=>card.id==='claude-max')!;
  const relative=historyTimes(set,dense);
  const seed=Date.parse('2026-10-15T10:30:00Z');
  for(let phase=0;phase<5;phase++)for(const offset of [0,9999,10000,59999]){
    const now=seed+phase*MIN+offset,timing=fixtureTiming(now);
    assert.equal(timing.warmAt,timing.start+DOT_STILL_AFTER,'warmth follows the actual seed rather than the launch minute');
    assert.ok(timing.start<=now-10*MIN);
    assert.equal((timing.start+50_000)%(5*MIN),0,'aging preserves the quota/grid phase');
    for(let cell=0;cell<3;cell++){
      const boundary=Date.parse('2026-10-15T13:00:00Z')+cell*5*MIN;
      const planned=idleWindow(boundary-115000,120,5*MIN);
      assert.equal(planned.boundary,boundary);
      const samples=packSamples(relative.map(({t})=>({at:timing.start+t,used:0,resetAt:null,staleAfterMs:STILL_FOR})));
      const tape:PeriodTape={from:timing.start+relative[0].t,cut:timing.start,replaceFrom:timing.start,cursor:'',quota:[{source:dense.id,window:'cadence',samples}],money:[]};
      const from=planned.from-DAY,to=planned.to-DAY,before=drain(retainTape(tape,from));
      const edge=drain(retirementEdge(null,[before],from));
      assert.equal(edge+DAY,boundary-50_000+1,`seed phase ${phase} must retire quota before the measured cell`);
      const after=drain(retainTape(before,to));
      assert.equal(sampleCount(after.quota[0].samples),sampleCount(before.quota[0].samples)-1);
      assert.notEqual(after,before);
      assert.equal(sampleAt(after.quota[0].samples,0)!.at,boundary-50_000-DAY,'the real boundary predecessor remains');
      assert.equal(sampleCount(tape.quota[0].samples),relative.length,'no seeded observation was removed');
    }
  }
});

test('quota retirement and the axis keep separate wakes instead of coalescing at the cell edge',()=>{
  const boundary=Date.parse('2026-10-15T13:00:00Z'),planned=idleWindow(boundary-115000,120,5*MIN);
  const timing=fixtureTiming(Date.parse('2026-10-15T10:32:12Z')),set=panningSet(SETS[0]);
  const card=cards(set).find(card=>card.id==='claude-max')!,relative=historyTimes(set,card);
  const samples=packSamples(relative.map(({t})=>({at:timing.start+t,used:0,resetAt:null,staleAfterMs:STILL_FOR})));
  const tape:PeriodTape={from:timing.start+relative[0].t,cut:timing.start,replaceFrom:timing.start,cursor:'',quota:[{source:card.id,window:'cadence',samples}],money:[]};
  const from=planned.from-DAY,retained=drain(retainTape(tape,from)),quotaAt=drain(retirementEdge(null,[retained],from))+DAY;
  function wakes(quotaAt:number){
    let now=planned.from,next:{at:number;run:()=>void}|null=null,current:string[]=[];
    const waves:{at:number;events:string[]}[]=[];
    const clock=new PageClock({now:()=>now,visible:()=>true,
      setTimeout:(run,ms)=>{next={at:now+ms,run};return next;},clearTimeout:handle=>{if(next===handle)next=null;}});
    const quota=clock.watch(),axis=clock.watch();
    clock.subscribe(quota,()=>current.push('quota'));clock.subscribe(axis,()=>current.push('axis'));
    clock.due(quota,quotaAt,now);clock.due(axis,boundary,now);
    const scheduled=()=>next;
    for(let i=0;i<4;i++){
      const due=scheduled();if(!due)break;
      next=null;now=due.at+10;current=[];due.run();
      if(current.length)waves.push({at:now,events:current});
    }
    return waves;
  }
  assert.deepEqual(wakes(boundary+1).map(w=>w.events),[['quota','axis']],'axis-aligned quota can hide a separate wave under the real clock');
  const separate=wakes(quotaAt);
  assert.deepEqual(separate.map(w=>w.events),[['quota'],['axis']]);
  assert.equal(separate[1].at-separate[0].at,50_000-1);
});

test('the still benchmark retains every quota value and past reset across grid alignment', () => {
  const original = cards(SETS[0]), stable = cards(panningSet(SETS[0]));
  assert.equal(stable.length, original.length);
  let deferred = 0, past = 0;
  for (const [index, card] of stable.entries()) for (let t = -75 * DAY; t <= 0; t += 300_000) {
    for (const [j, at] of card.windows.entries()) {
      const before = original[index].windows[j](t), after = at(t);
      assert.deepEqual({...after, resetsAt: before.resetsAt}, before);
      if (before.resetsAt !== null && before.resetsAt > 0 && before.resetsAt < STILL_FOR) {
        assert.equal(after.resetsAt, STILL_FOR); deferred++;
      } else {assert.deepEqual(after, before); past++;}
    }
  }
  assert.ok(deferred > 0 && past > 0);
});
