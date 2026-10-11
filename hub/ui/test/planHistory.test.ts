import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryTile} from '../lib/historyTiles';
import {HistoryStore} from '../lib/history';
import {PageClock} from '../lib/clock';
import {compose,targetOf,planRowBytes,type Chunk} from '../../server/domain/history';
import {plotOf} from '../lib/historyPlot';
import {drain} from '../lib/prepare';
const M=60_000,H=60*M,known={work:0,sources:{s:0}};
const chunk=(plans:NonNullable<Chunk['plans']>):Chunk=>({from:0,to:H,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],plans});
test('plan facts survive packing, exact frame composition and plot extraction without duplicate source markers',()=>{
  const raw=chunk([['s',M,'max',{at:0,plan:'pro'},H+M+1]]),tile=new HistoryTile(0,M);tile.readTo=H;tile.merge(raw,known);
  const meta={known,now:H,historyStart:0},target=targetOf(H,H,'test',{from:0,to:H}),accepted=tile.chunk(known,false,H);
  assert.deepEqual(accepted.plans,raw.plans);assert.equal(tile.bytes,new HistoryTile(0,M).bytes+planRowBytes(raw.plans![0]));
  assert.equal(compose([accepted,accepted],meta,target,new Set()).events.length,1);assert.equal(plotOf([accepted],meta,target,[[0,H]],new Set(),1,1,1).events.length,1);
  const redacted=tile.retirePlans(H+1)!;
  assert.equal(redacted.chunk(known,false,H+1).plans![0][3],null);assert.deepEqual(accepted.plans,raw.plans,'published predecessor remains untouched');
  assert.equal(tile.chunk(known,false,H+1).plans![0][3],null,'an inactive cache redacts before its next read');
  const expired=redacted.retirePlans(H+M+1)!;assert.equal(expired.chunk(known,false,H+M+1).plans,undefined);
  const replacement=drain(tile.staged(chunk([]),known));assert.equal(replacement.chunk(known,false,H).plans,undefined);assert.deepEqual(tile.chunk(known,false,H).plans,raw.plans);
  assert.equal(drain(new HistoryTile(0,M).staged(raw,known,()=>false)),null,'failed bounded staging cannot publish a partial plan generation');
});
test('the actual history owner redacts active and sleeping facts through the shared clock without HTTP',async()=>{
  let now=H,reads=0;
  const timers=new Map<object,{at:number;run:()=>void}>();
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const store=new HistoryStore({clock,now:()=>now,preparations:null,read:async(_board,_cell,from,to)=>{reads++;return {run:'r',now,historyStart:0,known,chunks:[{...chunk([['s',M,'max',{at:0,plan:'pro'},H+M+1]]),from,to}]};},dropTimeRange:()=>{},setTimeout:()=>null,clearTimeout:()=>{}},undefined,'quota');
  store.choose('1h',null);store.open('b');store.hello('r');store.snapshot(['s'],[],0);for(let i=0;i<30;i++)await Promise.resolve();
  const initial=store.get().history!;assert.equal(initial.events.length,1);assert.equal(initial.events[0].kind,'plan');const initialReads=reads;
  now=H+1;clock.wakeDue();const changed=store.get().history!;assert.equal(changed.events[0].kind==='plan'&&changed.events[0].previous,null);assert.equal(initial.events[0].kind==='plan'&&initial.events[0].previous?.plan,'pro');assert.equal(reads,initialReads);
  // Eviction can leave a published frame alive after its supporting tile is gone.
  (store as unknown as {grids:Map<number,unknown>}).grids.clear();
  store.setActive(false);assert.equal(timers.size,0);now=H+M+1;assert.deepEqual(store.get().history!.events,[]);assert.equal(reads,initialReads);store.close();assert.equal(timers.size,0);
});
