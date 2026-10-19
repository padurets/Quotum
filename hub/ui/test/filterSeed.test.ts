import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seedDataFilters,seedConflicts} from '../lib/filterSeed';
import {readMoney} from '../lib/moneySelection';
import {defaultFilters,walletRule,type FilterEnvelope,type FilterUpdate} from '../../server/domain/dataFilters';
import {DataFilterState} from '../lib/filterState';

test('legacy unit subsets stay distinct until the actual family edit materializes its captured unit',async()=>{
  const saved=defaultFilters();saved.wallet={mode:'auto',include:[{source:'s',kind:'keyCap',key:'pinned'}],exclude:[{source:'s',kind:'keyCap',key:'C'}]};
  const money=readMoney({selected:{USD:[['s','key:C:cap'],['s','key:U:cap']],EUR:[['s','fx:EUR:key:C:cap'],['s','fx:EUR:key:E:cap']]}});
  const before=structuredClone(money),seed=seedDataFilters(saved,[],money,readMoney({}));
  assert.deepEqual(walletRule(seed,'USD'),{mode:'only',values:[{source:'s',kind:'keyCap',key:'U'}]});
  assert.deepEqual(walletRule(seed,'EUR'),{mode:'only',values:[{source:'s',kind:'keyCap',key:'E'}]});
  assert.equal(seedConflicts(saved,money),2);assert.deepEqual(money,before);
  const writes:FilterUpdate[]=[],envelope:FilterEnvelope={filters:saved,revision:0,authority:'seed-authority-test',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}};
  const state=new DataFilterState({seed:()=>seed,save:async(_board,_revision,update)=>{writes.push(update);return {...envelope,filters:update.filters,revision:writes.length};}});
  state.open('u','b');state.accept(envelope);await state.save();
  assert.deepEqual(writes[0].materialize,{});assert.ok(writes[0].filters.legacy?.walletByUnit?.EUR);
  state.toggle('wallet',{source:'s',kind:'keyCap',key:'U'},false,'USD');await state.save();
  assert.equal(writes[1].materialize?.wallet,'USD');assert.equal(writes[1].filters.legacy?.walletByUnit,undefined);
  assert.deepEqual(writes[1].filters.wallet,{mode:'only',values:[]});assert.deepEqual(money,before);
});
