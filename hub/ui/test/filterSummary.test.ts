import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {excludedCount,excludedResources,resourcesRestricted} from '../lib/filterSummary';
import type {Card} from '../lib/types';

const source=(id:string,provider='codex'):Card=>({id,provider,plan:'',successAt:1,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:60_000,measureIntervalMs:null});

test('exclusion badges count visible omissions in saved subsets and explicit off choices',()=>{
  assert.equal(excludedCount({mode:'exclude',values:['A']},['A','B','C']),1);
  assert.equal(excludedCount({mode:'include',values:['A']},['A','B','C']),2);
  assert.equal(excludedCount({mode:'include',values:[]},['A',null]),2);
  assert.equal(excludedCount({mode:'exclude',values:[]},['A',null]),0);
});

test('a disabled resource counts once while preserving independent child choices',()=>{
  const filters=defaultFilters(),card=source('s');
  card.windows=[{id:'session',kind:'session',minutes:300,label:null,used:10,remaining:90,resetAt:300_000},{id:'weekly',kind:'weekly',minutes:10080,label:null,used:20,remaining:80,resetAt:600_000}];
  filters.windows.values=[['s','session'],['s','weekly']];
  assert.equal(excludedResources(filters,[card],null),2);
  filters.sources.values=[{source:'s'}];
  assert.equal(excludedResources(filters,[card],null),1);
  filters.sources.values=[];
  assert.equal(excludedResources(filters,[card],null),2,'re-enabling the parent restores its previous child choices');
});

test('resource badges cover neutral funding, wallet exclusions and legacy funds without inventing automatic exclusions',()=>{
  const filters=defaultFilters(),wallet=source('w','openrouter'),funds=source('f');
  funds.creditBalance={id:'balance:credits',unit:'credits:codex',status:'finite',at:1,staleAfterMs:60_000,hasCredits:true};
  assert.equal(excludedResources(filters,[wallet,funds],null),0);
  assert.equal(resourcesRestricted(filters),false);
  filters.sources.values=[{status:'unknown'}];filters.wallet={mode:'auto',include:[],exclude:[{source:'w',kind:'keyCap',key:'a'}]};
  filters.legacy={fundsByUnit:{USD:{mode:'include',values:[]}}};
  assert.equal(excludedResources(filters,[wallet,funds],null,'USD','USD'),3);
  assert.equal(resourcesRestricted(filters),true);
  filters.sources.values.push({source:'w'});
  assert.equal(excludedResources(filters,[wallet,funds],null,'USD','USD'),3,'the disabled wallet hides its excluded key from the badge total');
});
