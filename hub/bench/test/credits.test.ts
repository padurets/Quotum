import {test} from 'node:test';
import assert from 'node:assert/strict';
import {creditChartAnchors,creditSnapshot} from '../credits.js';
import {cards} from '../../demo/model.js';
import {stillSnapshot} from '../still.js';
import {SETS} from '../../demo/catalogue.js';
import {parseBatch,toMeasurement} from '../../server/domain/ingest.js';
import {Store} from '../../server/store/store.js';
import {composeMeters} from '../../server/domain/meterHistory.js';
import {displayHistory} from '../../server/currencies/history.js';
import {Directory} from '../../server/store/directory.js';

test('the live credit benchmark wire updates only independent balances behind newer quotas',t=>{
  const now=Date.parse('2026-10-08T12:00:00Z'),card=cards(SETS[0]).find(card=>card.provider==='codex'&&card.windows.length)!;
  const store=new Store(':memory:',now),source=store.source('codex','a'.repeat(24),now);
  t.after(()=>store.close());
  const record=(wire:object)=>store.record(source,toMeasurement(parseBatch({version:1,agent:'quotum-demo/1',machine:{id:'bench-machine-0123456789',name:'Bench',os:'linux',arch:'x86_64'},sentAt:new Date(now).toISOString(),snapshots:[wire],failures:[]}).snapshots[0]));
  assert.equal(record(stillSnapshot(card,now,now)).windows,true);
  const before=store.state(source);
  const rows=()=>Number(store.db.prepare('SELECT count(*) n FROM readings WHERE source_id=?').get(source)!.n);
  const coverage=()=>Number(store.db.prepare('SELECT max(to_at) at FROM meter_spans WHERE source_id=?').get(source)!.at);
  for(const [index,amount] of ['2500','2499','2498','2498','2498'].entries()) {
    const at=now-25_000+index*2000,count=rows(),covered=coverage();
    const result=record(creditSnapshot(card,now,at,amount)),after=store.state(source);
    assert.deepEqual(result,{accepted:true,windows:false,unavailable:false,resets:false,budget:true,delivery:false});
    assert.deepEqual(after.windows,before.windows);assert.deepEqual(after.resources,before.resources);
    assert.equal(after.successAt,now);assert.equal(after.creditBalance?.at,at);
    assert.ok(coverage()>covered);if(index>=3)assert.equal(rows(),count,'an unchanged heartbeat adds no ledger row');
  }
});

for(const offset of [10_000,40_000])test(`credit chart expectations follow actual cells for late observations at +${offset}ms`,t=>{
  const cell=300_000,boundary=Date.parse('2026-10-08T12:00:00Z'),now=boundary+offset,from=boundary-cell;
  const card=cards(SETS[0]).find(card=>card.provider==='codex'&&card.windows.length)!;
  const store=new Store(':memory:',from),source=store.source('codex','a'.repeat(24),from);
  const owner=new Directory(store.db).createUser('bench@example.com','Bench','unused',from).id;
  t.after(()=>store.close());
  const selection={unit:'credits:codex',ids:[[source,'balance:credits'] as [string,string]]};
  for(const [index,amount] of ['2500','2499','2498','2498','2498'].entries()) {
    const at=now-25_000+index*2000;
    store.record(source,toMeasurement(parseBatch({version:1,agent:'quotum-demo/1',machine:{id:'bench-machine-0123456789',name:'Bench',os:'linux',arch:'x86_64'},sentAt:new Date(now).toISOString(),snapshots:[creditSnapshot(card,now,at,amount)],failures:[]}).snapshots[0]));
    for(const drawnAt of [now,boundary+cell+1]) {
      const packed=store.meters.cells(selection,from,drawnAt,cell);
      const times=[...store.meters.readings(source,'balance:credits',from,drawnAt).map(row=>row.at),...store.meters.spans(source,'balance:credits',from,drawnAt).flatMap(span=>[span.from,span.to])].sort((a,b)=>a-b);
      const shown=displayHistory([{from,to:drawnAt,series:[],activity:{devices:{},sessions:[],cells:[]},resets:[],grants:[],meterSeries:packed}],store.currencies,owner,'USD',cell,(_source,_meter,until)=>times.filter(at=>at<=until).at(-1)??null);
      const points=composeMeters(shown,cell,from,drawnAt)[0].points;
      const latest=points.at(-1)!;
      assert.equal(latest.value,String(BigInt(amount)*40_000n));
      assert.ok(creditChartAnchors(at,now,drawnAt,cell).includes(latest.at),'changed balances and unchanged heartbeats match the rendered anchor');
      if(at<boundary)assert.ok(!creditChartAnchors(at,now,drawnAt,cell).includes(at),'the previous cell cannot be mistaken for the current drawing');
    }
  }
});
