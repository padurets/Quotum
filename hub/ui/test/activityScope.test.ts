import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityScope,selectActivityWork} from '../../server/domain/activityScope';
import {defaultFilters,workFilter,matchesWork} from '../../server/domain/dataFilters';
import {drain} from '../lib/prepare';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import {PeriodActivity} from '../lib/periodActivity';

test('legend exclusions intersect each typed board family without changing its opening filters',()=>{
  const base=workFilter(defaultFilters());base.projects={mode:'include',values:['A','B']};
  const before=JSON.stringify(base),selected=activityScope(base,'project',['"B"','"C"','"B"']);
  assert.deepEqual(selected.projects,{mode:'include',values:['A']});assert.equal(JSON.stringify(base),before);
  assert.deepEqual(activityScope({...base,projects:{mode:'exclude',values:['A']}},'project',['"B"','"C"']).projects,{mode:'exclude',values:['A','B','C']});
  const sources=activityScope(base,'source',['unknown','notProvided','s']);
  assert.equal(matchesWork(sources,{source:null,project:'A',device:'d'}),false);
  assert.equal(matchesWork(sources,{source:null,sourceStatus:'notProvided',project:'A',device:'d'}),false);
  assert.equal(matchesWork(sources,{source:'other',project:'A',device:'d'}),true);
  const projects=activityScope(workFilter(defaultFilters()),'project',['null']);
  assert.equal(matchesWork(projects,{source:null,project:null,device:'d'}),false);
  assert.equal(matchesWork(projects,{source:null,project:'No project',device:'d'}),true);
  assert.equal(matchesWork(activityScope(base,'device',['d']),{source:null,project:'A',device:'d'}),false);
});

test('selected live work preserves overlap, split identity, packed boundaries and confirmed zero',()=>{
  const trace:WorkTrace={anchor:0,cut:100,knownFrom:0,refs:['A','B','C'].map((project,i)=>({ref:String(i),identityRef:i<2?'same':'other',source:'s',project,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:0})),spans:[[0,0,30],[1,10,40],[2,20,60]]};
  for(const input of [trace,packWork(trace)]){
    const selected=drain(selectActivityWork(input,'project',new Set(['"C"']))),activity=new PeriodActivity(selected);
    const values=activity.summary({from:5,to:35},'project');
    assert.deepEqual([values.agentMs,values.activeMs,values.agents],[50,30,1]);
    assert.equal(values.by.project.reduce((sum,g)=>sum+g.activeMs,0),50,'group unions cannot produce the selected union');
    const bar=activity.summary({from:15,to:25},'project');assert.deepEqual([bar.agentMs,bar.activeMs,bar.agents],[20,10,1]);
    const zero=activity.summary({from:70,to:80},'project');assert.deepEqual([zero.agentMs,zero.activeMs,zero.agents],[0,0,0]);assert.ok(zero.known);
    assert.equal(input.refs.length,3);
  }
});
