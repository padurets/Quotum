import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CODEX_CREDIT_SCENES,creditMeasurement} from '../codexCredits.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {scalarDecimal} from '../../server/domain/amount.js';
import {displayMeter} from '../../server/domain/currencyPresentation.js';

test('every durable Codex credit scene has real resource, precision and consent evidence',()=>{
  for(const scene of CODEX_CREDIT_SCENES) {
    const store=new Store(':memory:',1);
    try {
      const directory=new Directory(store.db),owner=directory.createUser('credits@example.test','Credits','fixture',1),board=directory.createBoard('Shared',owner.id,1);
      const source=store.source('codex','a'.repeat(24),1);store.hold(source,owner.id,1);
      store.share(board.id,source,owner.id,1,scene.id!=='quota-only-share');
      store.record(source,creditMeasurement(scene.id,1,true));
      store.record(source,creditMeasurement(scene.id,60_001));
      const state=store.state(source),meter=state.meters?.[0],seen=new Set<string>();
      seen.add(state.windows.length?'mixed':'quota-missing');
      seen.add(state.creditBalance!.status);
      if(meter){seen.add(scalarDecimal({amount:meter.amount,scale:meter.scale??6}));if(meter.stale||state.creditBalance!.staleAfterMs<60_000)seen.add('last-known');}
      if(state.creditBalance!.staleAfterMs<60_000)seen.add('stale');
      if(!store.sources(board.id)[0].budget?.enabled)seen.add('shared-funds-off');
      if(meter&&!meter.stale){const context=store.currencies.context(owner.id,{[source]:[{unit:meter.unit,at:meter.at}]});const value=displayMeter(meter,source,context)!;assert.equal(value.conversion?.rate.source,'codex-default');seen.add('default-USD');}
      for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
    }finally{store.close();}
  }
});
