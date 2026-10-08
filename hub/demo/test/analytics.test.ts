import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ANALYTICS_SCENES} from '../catalogue.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {deepSeekMeasurement} from '../../server/connectors/deepseek.js';
import {decodeZai,mapZai} from '../../server/connectors/zai.js';
import {quotaFixture} from '../quotas.js';
import {deepSeekPayload} from '../deepseek.js';
import {quotaRemaining,subscriptionSelection} from '../../ui/lib/subscription.js';
import {DEFAULT_MONEY,moneySelection} from '../../ui/lib/moneySelection.js';
import {EMPTY_VIEW} from '../../server/domain/view.js';
import {BUDGET_WIDGETS,QUOTA_WIDGETS,showWidgets,widgetVisible} from '../../server/domain/widgets.js';
import type {Card} from '../../ui/lib/types.js';
import {shareConnectorScene, type Stand} from '../setup.js';

test('connector scenes populate the mixed demo board and leave empty and limit-only boards alone', () => {
  const store = new Store(':memory:', 1), directory = new Directory(store.db);
  try {
    const owner = directory.createUser('scenes@fixture.example', 'Owner', 'x', 1);
    const team = directory.createBoard('Team', owner.id, 1), empty = directory.createBoard('Empty', owner.id, 1), limits = directory.createBoard('Limits', owner.id, 1);
    const stand = {boards: new Map([['team', team.id], ['empty', empty.id], ['limits', limits.id]])} as Stand;
    for (const provider of ['openrouter', 'deepseek', 'zai'] as const) {
      const source = store.source(provider, provider, 1); store.hold(source, owner.id, 1);
      shareConnectorScene(store, stand, source, owner.id, 1);
    }
    assert.equal(store.sources(team.id).length, 3);
    for (const board of [empty, limits]) {
      assert.equal(store.sources(board.id).length, 0);
      assert.deepEqual(directory.view(board.id).shown, []);
    }
  } finally {store.close();}
});

test('mixed analytics catalogue keeps both resource families, exact amounts and sticky empty widgets',()=>{
  const store=new Store(':memory:',1),directory=new Directory(store.db),seen=new Set<string>();
  try {
    const owner=directory.createUser('analytics@fixture.example','Reader','x',1),board=directory.boards(owner.id)[0].id;
    assert.ok([...QUOTA_WIDGETS,...BUDGET_WIDGETS].every(id=>!widgetVisible(directory.view(board),id,0)));seen.add('pending-empty');
    const explicit=showWidgets(EMPTY_VIEW,['budget-history']);assert.ok(widgetVisible(explicit,'budget-history',0));seen.add('explicit-empty');
    const native=store.source('codex','native',1),quota=store.source('zai','quota',1),budget=store.source('deepseek','budget',1);
    for(const id of [native,quota,budget])store.hold(id,owner.id,1);
    store.record(native,{observedAt:1,staleAfterMs:300_000,plan:'',resets:null,windows:[{id:'weekly',kind:'weekly',remaining:75,used:25,label:null,resetAt:null,minutes:10080}]});
    store.record(quota,mapZai(decodeZai(JSON.stringify(quotaFixture(1,1))),1).measurement!);
    store.record(budget,deepSeekMeasurement(deepSeekPayload('usd'),1));
    const view=directory.view(board),cards:Card[]=[native,quota,budget].map(id=>({...store.state(id),stale:false,owners:[],measureIntervalMs:null}));
    assert.ok([...QUOTA_WIDGETS,...BUDGET_WIDGETS].every(id=>widgetVisible(view,id,3)));seen.add('four-widgets');
    assert.equal(quotaRemaining(cards[1],'quota:credit:5h'),60);assert.equal(quotaRemaining(cards[0],'weekly'),75);seen.add('quota-percentages');
    assert.equal(cards[2].meters?.find(m=>m.id==='balance:USD')?.amount,'37000000');seen.add('budget-amounts');
    assert.ok(subscriptionSelection(cards,view)?.ids.every(([source])=>source===quota));
    assert.deepEqual(moneySelection(cards,view.hidden,DEFAULT_MONEY).selection?.ids,[[budget,'balance:USD']]);seen.add('independent-units');
    const empty=directory.createBoard('Empty',owner.id,2);directory.saveView(empty.id,view,owner.id,2);
    assert.ok([...QUOTA_WIDGETS,...BUDGET_WIDGETS].every(id=>widgetVisible(directory.view(empty.id),id,0)));seen.add('sticky-placement');
    for(const scene of ANALYTICS_SCENES)for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
  }finally{store.close();}
});
