import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityOracle,assertActivityOverlap,FIXED_ACTIVITY_BUDGET} from '../fixedActivity';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import type {PeriodRequest} from '../../server/domain/periodRead';

test('the shared-filter benchmark oracle clips intervals, unions overlap and deduplicates identities',()=>{
  const trace:WorkTrace={anchor:100,knownFrom:100,cut:200,refs:[0,1,2].map(i=>({ref:String(i),identityRef:i<2?'shared':'other',source:null,project:null,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:100})),spans:[[0,0,30],[1,10,40],[2,50,60]]};
  for(const value of [trace,packWork(trace)]){
    assert.deepEqual(activityOracle(value,115,135),{agentMs:35,activeMs:20,agents:1});
    assert.deepEqual(activityOracle(value,125,155),{agentMs:25,activeMs:20,agents:2});
    assert.deepEqual(activityOracle(value,170,180),{agentMs:0,activeMs:0,agents:0});
  }
  assert.equal(FIXED_ACTIVITY_BUDGET.request,76*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.pool,15*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.body,7*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.combined24h,1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.combined30d,4*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.advancesPerUpdate,1_000_000);
});

test('overlapping work counts its recorded native follow-up without allowing another selected-work reader',()=>{
  const base:PeriodRequest={version:1,selection:{mode:'range',from:123,to:1000},evaluatedAt:2000};
  const work:PeriodRequest={...base,sessions:{}},native:PeriodRequest={...base,quota:{cell:'300000',from:'0',to:'300000',sources:'["source"]',evidence:'skip'}};
  assertActivityOverlap([work,work],2);
  assertActivityOverlap([work,work,native],2);
  assert.throws(()=>assertActivityOverlap([work,work,work],2),'a cancelled third work attempt still counts');
  assert.throws(()=>assertActivityOverlap([work,work,native,native],2));
  assert.throws(()=>assertActivityOverlap([work,work,{...native,quota:{...native.quota!,evidence:'another-ledger'}}],2));
  assert.throws(()=>assertActivityOverlap([work,work,{...native,facets:true}],2));
  assert.throws(()=>assertActivityOverlap([work,work,{...native,selection:{mode:'range',from:123,to:2000}}],2));
});
