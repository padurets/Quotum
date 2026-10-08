import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {convertBy} from '../../server/domain/currency.js';
import {CURRENCY_SCENES,seedCurrencyOwner} from '../currencies.js';

test('currency catalogue states use the real private registry and exact paths',()=>{
  const store=new Store(':memory:',1);try {
    const directory=new Directory(store.db),a=directory.createUser('a@example.com','A','fixture',1).id,b=directory.createUser('b@example.com','B','fixture',1).id,now=200_000;
    const {points,stopped,archived,precision}=seedCurrencyOwner(store,a,now),c=store.currencies,seen=new Set<string>();
    if(c.manage(a).personal.some(row=>row.definition.id===points.id&&row.archivedAt===null))seen.add('personal-active');
    if(c.rateHistory(a,points.id,undefined).changes.length===2)seen.add('versioned-rate');
    c.select(a,points.id);assert.throws(()=>c.archive(a,points.id,undefined,now),/currency_selected/);seen.add('explicit-replacement');c.select(a,'USD');
    if(c.rateHistory(a,stopped.id,undefined).pairs[0].kind==='stop')seen.add('rate-stopped');
    if(c.binding(a,'USD',stopped.id,now)===null)seen.add('missing-not-zero');
    if(c.manage(a).personal.find(row=>row.definition.id===archived.id)?.archivedAt===now)seen.add('currency-archived');
    c.restore(a,archived.id);if(c.definition(a,archived.id))seen.add('restorable');
    if(c.definition(a,precision.id).fractionDigits===6)seen.add('six-decimals');
    assert.throws(()=>convertBy('37000000',c.binding(a,'USD',precision.id,now)!));assert.equal(convertBy('0',c.binding(a,'USD',precision.id,now)!),'0');seen.add('overflow-distinct');
    if(c.preference(a).id==='USD')seen.add('default-USD');
    const own=c.create(b,{name:'Private',symbol:'BP',fractionDigits:2},'USD','4000000',now);c.select(b,own.id);
    if(c.preference(b).id===own.id&&!JSON.stringify(c.manage(a)).includes(own.id))seen.add('private-selected');
    for(const scene of CURRENCY_SCENES)for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
  }finally{store.close();}
});
