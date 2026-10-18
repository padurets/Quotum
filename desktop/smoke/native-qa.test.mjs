import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchChecked} from './native-qa.mjs';
const actual={id:'1001',home:'/home/disposable'},receipt={schemaVersion:1,...actual,ownerId:'1000',ownerHome:'/home/owner'};
test('unknown and owner OS boundaries refuse before any native child starts',()=>{
  let starts=0;
  for(const invalid of [null,{}, {...receipt,id:'1000'}, {...receipt,ownerId:'1001'}, {...receipt,home:'/home/another'}, {...receipt,ownerHome:actual.home}]) {
    assert.throws(()=>launchChecked(actual,invalid,()=>starts++));
  }
  assert.equal(starts,0);
});
test('a dedicated OS boundary preserves normal and hidden startup instead of smoke bootstrap',()=>{
  const calls=[];
  for(const args of [[],['--hidden']])launchChecked(actual,receipt,()=>calls.push(args));
  assert.deepEqual(calls,[[],['--hidden']]);
  assert.throws(()=>launchChecked({...actual,localAppData:'C:\\Users\\one\\AppData\\Local'},{...receipt,localAppData:'C:\\Users\\other\\AppData\\Local'},()=>{}));
  assert.throws(()=>launchChecked(actual,{...receipt,home:'/home/Disposable'},()=>{}));
});
