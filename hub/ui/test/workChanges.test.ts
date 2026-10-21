import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workChange} from '../lib/workChanges';

test('shared work retirement distinguishes source-free, quota, legacy and financial news',()=>{
  const base={sources:['a'],since:50};
  for(const data of [
    {...base,sources:[],workSince:0},
    {...base,changes:[{source:'a',scope:'quota' as const,since:0}]},
    {...base,changes:[{source:'a',scope:'quota' as const,since:50,workSince:0}]},
    {...base,since:0},
  ])assert.equal(workChange(data,['a'],100).retired,true);
  for(const data of [
    {...base,since:0,changes:[{source:'a',scope:'budget' as const,since:0}]},
    {...base,sources:['b'],since:0,changes:[{source:'b',scope:'quota' as const,since:0}]},
    {...base,since:0,workSince:50},
    {...base,workSince:100},
  ])assert.equal(workChange(data,['a'],100).retired,false);
  assert.equal(workChange({...base,changes:[{source:'a',scope:'quota',since:50}]},['a']).since,Infinity,'measurement-only news adds no subset demand');
});
