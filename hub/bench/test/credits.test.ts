import {test} from 'node:test';
import assert from 'node:assert/strict';
import {creditSnapshot} from '../credits.js';
import {cards} from '../../demo/model.js';
import {stillSnapshot} from '../still.js';
import {SETS} from '../../demo/catalogue.js';
import {parseBatch,toMeasurement} from '../../server/domain/ingest.js';
import {Store} from '../../server/store/store.js';

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
