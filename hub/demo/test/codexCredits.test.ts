import {test} from 'node:test';
import assert from 'node:assert/strict';
import {widgetVisible} from '../../server/domain/widgets.js';
import {moneySelection,DEFAULT_MONEY} from '../../ui/lib/moneySelection.js';
import {CODEX_CREDIT_SCENES,creditHistory} from '../codexCredits.js';
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
      const history=creditHistory(scene.id,24*3_600_000);
      for(const sample of history)store.record(source,sample);
      const state=store.state(source),meter=state.meters?.[0],seen=new Set<string>();
      seen.add(state.windows.length?'mixed':'quota-missing');
      assert.ok(widgetVisible(directory.view(directory.boards(owner.id).find(b=>b.personal)!.id),'subscription-funds',1));
      const cards=[{...state,owners:[],stale:false,measureIntervalMs:null}];
      assert.deepEqual(moneySelection(cards,[],DEFAULT_MONEY).selection?.ids,[]);
      assert.deepEqual(moneySelection(cards,[],DEFAULT_MONEY,undefined,'funds').selection?.ids,[[source,'balance:credits']]);
      seen.add('dedicated-funds-chart');
      seen.add(state.creditBalance!.status);
      if(new Set(history.flatMap(sample=>sample.balances?.flatMap(balance=>balance.status==='finite'?[balance.amount]:[])??[])).size>1)seen.add('changing-balance');
      if(meter){seen.add(scalarDecimal({amount:meter.amount,scale:meter.scale??6}));if(meter.stale||state.creditBalance!.staleAfterMs<60_000)seen.add('last-known');}
      if(state.creditBalance!.staleAfterMs<60_000)seen.add('stale');
      if(!store.sources(board.id)[0].budget?.enabled)seen.add('shared-funds-off');
      if(meter&&!meter.stale){const context=store.currencies.context(owner.id,{[source]:[{unit:meter.unit,at:meter.at}]});const value=displayMeter(meter,source,context)!;assert.equal(value.conversion?.rate.source,'codex-default');seen.add('default-USD');}
      for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
    }finally{store.close();}
  }
});
