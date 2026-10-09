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
import {BUDGET_WIDGETS,QUOTA_WIDGETS,SUBSCRIPTION_FUNDS,showWidgets,widgetVisible} from '../../server/domain/widgets.js';
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
    assert.ok([...QUOTA_WIDGETS,...BUDGET_WIDGETS,SUBSCRIPTION_FUNDS].every(id=>!widgetVisible(directory.view(board),id,0)));seen.add('pending-empty');
    const explicit=showWidgets(EMPTY_VIEW,['budget-history']);assert.ok(widgetVisible(explicit,'budget-history',0));seen.add('explicit-empty');
    const native=store.source('codex','native',1),quota=store.source('zai','quota',1),budget=store.source('deepseek','budget',1);
    for(const id of [native,quota,budget])store.hold(id,owner.id,1);
    store.record(native,{observedAt:1,staleAfterMs:300_000,plan:'',resets:null,windows:[{id:'weekly',kind:'weekly',remaining:75,used:25,label:null,resetAt:null,minutes:10080}]});
    store.record(quota,mapZai(decodeZai(JSON.stringify(quotaFixture(1,1))),1).measurement!);
    store.record(budget,deepSeekMeasurement(deepSeekPayload('usd'),1));
    const view=directory.view(board),cards:Card[]=[native,quota,budget].map(id=>({...store.state(id),stale:false,owners:[],measureIntervalMs:null}));
    assert.ok([...QUOTA_WIDGETS,...BUDGET_WIDGETS,SUBSCRIPTION_FUNDS].every(id=>widgetVisible(view,id,3)));seen.add('five-widgets');
    assert.equal(quotaRemaining(cards[1],'quota:credit:5h'),60);assert.equal(quotaRemaining(cards[0],'weekly'),75);seen.add('quota-percentages');
    assert.equal(cards[2].meters?.find(m=>m.id==='balance:USD')?.amount,'37000000');seen.add('budget-amounts');
    assert.ok(subscriptionSelection(cards,view)?.ids.every(([source])=>source===quota));
    assert.deepEqual(moneySelection(cards,view.hidden,DEFAULT_MONEY).selection?.ids,[[budget,'balance:USD']]);seen.add('independent-units');
    const empty=directory.createBoard('Empty',owner.id,2);directory.saveView(empty.id,view,owner.id,2);
    assert.ok([...QUOTA_WIDGETS,...BUDGET_WIDGETS,SUBSCRIPTION_FUNDS].every(id=>widgetVisible(directory.view(empty.id),id,0)));seen.add('sticky-placement');
    for(const scene of ANALYTICS_SCENES)for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
  }finally{store.close();}
});

test('client scenes show private work and inventory with no quota cards and never on shared boards',async()=>{
  const {seedClients}=await import('../clients.js'),{CLIENT_SCENES}=await import('../catalogue.js');
  const {Ingest}=await import('../../server/ingest.js'),{Duty}=await import('../../server/duty.js'),{Cadence}=await import('../../server/cadence.js');
  const {readHistory}=await import('../../server/test/historyRead.js');
  const {newSecret}=await import('../../server/domain/auth.js');
  const start=Date.parse('2026-09-22T12:00:00Z'),store=new Store(':memory:',start-2*3_600_000),directory=new Directory(store.db),seen=new Set<string>();
  try {
    const owner=directory.createUser('clients@example.com','Reader','x',start),board=directory.boards(owner.id)[0].id,shared=directory.createBoard('Shared',owner.id,start).id;
    const ingest=new Ingest(store,directory,new Duty(),new Cadence()),token=newSecret('qt_m');directory.createToken(token,'hint',owner.id,'fixture',start);
    const credential=ingest.authenticate('Bearer '+token) as import('../../server/ingest.js').Credential;
    const machine={id:'laptop-0123456789',name:'Laptop',os:'linux',arch:'x86_64'};
    let clientSessions:object[]=[],clients:object[]=[];
    const agent={machine,trackClients:(s:object[],c:object[])=>{clientSessions=s;clients=c;},sessions:async(sessions:object[],now:number)=>ingest.sessions(credential,{version:1,agent:'fixture',machine,sentAt:new Date(now).toISOString(),sessions,clientSessions,clients},now)};
    const stand={start,people:new Map([['ana',{id:owner.id,personalBoard:board}]]),agents:new Map([['laptop',agent]])} as unknown as Stand;
    await seedClients(store,directory,stand);
    const history=readHistory(store,board,start-2*3_600_000,60_000,{to:start});
    assert.equal(history.activity.agentMs,2*3_600_000);seen.add('private-work');
    assert.deepEqual(history.activity.by.source.map(g=>g.key),['unknown']);seen.add('unknown-source');
    assert.equal(directory.deviceClients(directory.devices(owner.id)[0].id).length,2);seen.add('inventory');
    assert.equal(store.sources(board).length,0);assert.ok(['agents','activity'].every(id=>widgetVisible(directory.view(board),id,0)));seen.add('empty-widgets');
    assert.equal(readHistory(store,shared,start-2*3_600_000,60_000,{to:start}).activity.agentMs,0);seen.add('shared-exclusion');
    for(const scene of CLIENT_SCENES)for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
  }finally{store.close();}
});
