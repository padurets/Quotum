import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {displayHistory} from '../../server/currencies/history.js';
import {cellStart, type Chunk, type HistoryScope} from '../../server/domain/history.js';
import type {MeterSelection} from '../../server/domain/meterHistory.js';
import {seedPanningBudgets} from '../fixture.js';
import type {Stand} from '../../demo/setup.js';
import {HistoryStore} from '../../ui/lib/history.js';
import {HistoryPool} from '../../ui/lib/historyPool.js';

test('three production readers retain the dense 30d credit pan and cached return within the shared pool',async()=>{
  const day=86_400_000,now=Date.parse('2026-10-08T12:00:00Z'),length=30*day;
  const dir=mkdtempSync(join(tmpdir(),'quotum-credit-memory-')),file=join(dir,'fixture.sqlite');
  let store=new Store(file),directory=new Directory(store.db);
  const user=directory.createUser('fixture@example.com','Fixture','fixture',now-75*day),owner={...user,personalBoard:directory.boards(user.id)[0].id};
  store.close();
  seedPanningBudgets(file,{start:now,people:new Map([['fixture',owner]])} as unknown as Stand);
  store=new Store(file);
  const pool=new HistoryPool(),readers:HistoryStore[]=[],reads:number[]=[0,0,0];let peak=0;
  try {
    store.db.exec('BEGIN');
    const quotas:string[]=[];
    for(let i=0;i<12;i++) {
      const source=store.source('claude',`quota-fixture-${i}`,now-75*day);quotas.push(source);store.hold(source,user.id,now-75*day);
      for(let at=now-75*day;at<=now;at+=3*3_600_000)store.record(source,{observedAt:at,staleAfterMs:6*3_600_000,plan:'pro',resets:null,
        windows:[{id:'weekly',kind:'weekly',used:20+i,remaining:80-i,minutes:10080,resetAt:now+7*day,label:null}]});
    }
    store.db.exec('COMMIT');
    const sources=store.sources(owner.personalBoard),known=store.historyKnown(store.shown(owner.personalBoard,[]));
    const wallet:MeterSelection={unit:'USD',ids:sources.filter(s=>s.provider==='openrouter').map(s=>[s.id,'balance'])};
    const funds:MeterSelection={unit:'USD',displayCurrency:'USD',ids:sources.filter(s=>s.provider==='codex').map(s=>[s.id,'balance:credits'])};
    const observations=new Map(funds.ids.map(([id,meter])=>[id,store.meters.readings(id,meter,now-75*day,now+1).map(row=>row.at)]));
    for(const [index,scope] of ['quota','budget','budget'].entries()) {
      const reader=new HistoryStore({now:()=>now,preparations:null,
        setTimeout:run=>{const timer={cancelled:false};queueMicrotask(()=>{if(!timer.cancelled)run();});return timer;},clearTimeout:timer=>{(timer as {cancelled:boolean}).cancelled=true;},dropTimeRange:()=>assert.fail('the fixture is inside retention'),
        read:async(board,cell,from,to,_signal,meters)=>{
          reads[index]++;peak=Math.max(peak,pool.activeFlights);assert.ok(pool.activeFlights<=2);
          const end=Math.min(to,cellStart(now+30_000,cell)+cell);
          const native=meters?.displayCurrency?{...meters,unit:'credits:codex'}:meters;
          let chunks:Chunk[]=store.cells(board,cell,from,end,{now,scope:scope as HistoryScope,meters:native}).map(chunk=>({...chunk,activity:{...chunk.activity,sessions:chunk.activity.sessions.map(([id,...rest])=>[String(id),...rest])}}));
          if(meters?.displayCurrency)chunks=displayHistory(chunks,store.currencies,user.id,meters.displayCurrency,cell,(source,_meter,at)=>observations.get(source)?.filter(value=>value<=at).at(-1)??null);
          return {run:'run',now,historyStart:now-75*day,known,chunks};
        },
      },undefined,scope as HistoryScope,pool);
      readers.push(reader);reader.choose('30d',null);reader.setMeters(index===1?wallet:index===2?funds:undefined);
      reader.open(owner.personalBoard);reader.hello('run');reader.snapshot(sources.map(s=>s.id),quotas.map(id=>`${id} weekly`),now-75*day);
    }
    const settle=async()=>{
      for(let n=0;n<200;n++) {
        await Promise.resolve();assert.ok(pool.estimatedBytes<=pool.budget);
        for(const reader of readers)assert.equal(reader.get().error,undefined);
        if(n>10&&!pool.activeFlights){await Promise.resolve();if(!pool.activeFlights)return;}
      }
      assert.fail('history did not settle');
    };
    await settle();assert.equal(readers[0].get().history?.series.length,12);
    assert.equal(readers[1].get().history?.meterSeries?.length,12);assert.equal(readers[2].get().history?.meterSeries?.length,12);
    for(const fraction of [.25,.5,.75,1,1.25]) {
      for(const reader of readers)reader.pan({token:1,length,from:now-length-fraction*length,to:now-fraction*length,direction:-1});
      await settle();
    }
    const far={from:now-2.25*length,to:now-1.25*length};
    for(const reader of readers){reader.choose('30d',far);reader.endPan(true);}await settle();
    assert.ok(readers.every(reader=>reader.get().history?.range===`${far.from}-${far.to}`));
    const cold=[...reads];
    for(const fraction of [1,.75,.5,.25,0]) {
      for(const reader of readers)reader.pan({token:2,length,from:now-length-fraction*length,to:now-fraction*length,direction:1});
      await settle();
    }
    for(const reader of readers){reader.choose('30d',null);reader.endPan(true);}await settle();
    assert.deepEqual(reads,cold,'returning through retained frames starts no history reads');
    assert.ok(readers.every(reader=>reader.get().history?.range==='30d'));assert.equal(peak,2);
  }finally{for(const reader of readers)reader.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
