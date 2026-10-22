import test from 'node:test';
import assert from 'node:assert/strict';
import {PeriodActivity} from '../domain/periodActivity.js';
import type {History} from '../domain/history.js';
import type {WorkTrace} from '../domain/periodWork.js';
import {workedSessions} from '../domain/periodWork.js';

type Activity=History['activity'];
const blank:Activity={since:0,known:{from:0,to:100},barMs:10,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
const range={from:15,to:45};
const fixed=(activity:Activity,selected=range)=>new PeriodActivity({anchor:0,knownFrom:0,refs:[],spans:[],fixed:{range:selected,totals:[],activity}} satisfies WorkTrace);

test('live activity reuses full cells while reading fractional endpoints from actual work',()=>{
  for(const count of [1,64]){
    const size=count===1?6:720,cut=size*10,selected={from:5.25,to:cut-4.25};
    const trace:WorkTrace={anchor:0,knownFrom:0,cut,refs:Array.from({length:count},(_,i)=>({ref:'r'+i,source:'s'+i,project:'p'+i,device:{id:'d'+i,name:'D'+i},origin:'terminal',folder:null,startedAt:0})),spans:Array.from({length:count},(_,i)=>[i,0,cut])};
    const projector=new PeriodActivity(trace);projector.update(workedSessions(trace,selected,selected.to));
    const cells:Activity['cells']=Array.from({length:size},(_,i)=>[i*10,10,10*count,count]);
    const old={...blank,cells,by:{source:[],project:[],device:[]} as Activity['by']};
    for(const dimension of ['source','project','device'] as const)old.by[dimension]=trace.refs.map(ref=>({key:dimension==='source'?ref.source!:dimension==='project'?JSON.stringify(ref.project):ref.device.id,name:dimension==='source'?null:dimension==='project'?ref.project:ref.device.name,agentMs:0,activeMs:0,agents:1,cells:cells.map(([at])=>[at,10])}));
    const before=structuredClone({old,trace}),projected=projector.project(old,selected),total=selected.to-selected.from;
    assert.equal(projected.activeMs,total);assert.equal(projected.agentMs,total*count);assert.equal(projected.agents,count);
    assert.deepEqual(projected.cells[0],[0,4.75,4.75*count,count]);
    assert.deepEqual(projected.cells.at(-1),[cut-10,5.75,5.75*count,count]);
    assert.notEqual(projected.cells[0],cells[0]);assert.notEqual(projected.cells.at(-1),cells.at(-1));
    for(let i=1;i<size-1;i++)assert.equal(projected.cells[i],cells[i],'full activity cells retain their tuple');
    for(const dimension of ['source','project','device'] as const)for(const group of projected.by[dimension]){
      const original=old.by[dimension].find(old=>old.key===group.key)!;
      assert.equal(group.agentMs,total);assert.equal(group.activeMs,total);assert.equal(group.agents,1);
      assert.deepEqual(group.cells[0],[0,4.75]);assert.deepEqual(group.cells.at(-1),[cut-10,5.75]);
      for(let i=1;i<size-1;i++)assert.equal(group.cells[i],original.cells[i],'full group cells retain their tuple');
    }
    assert.deepEqual({old,trace},before);
  }
});

test('fixed activity retains interior cells and exact endpoint replacements in every dimension',()=>{
  const cells:Activity['cells']=[[10,1,2,3],[20,4,5,6],[30,7,8,9],[40,10,11,12]];
  const edges:Activity['cells']=[[10,.5,1.25,1],[40,1.5,2.75,2]];
  const groups=[{key:'g',name:'old',agentMs:0,activeMs:0,agents:0,cells:[[10,1],[20,2],[30,3],[40,4]] as [number,number][]}];
  const replacements=[{key:'g',name:'exact',agentMs:12.25,activeMs:9.75,agents:2,cells:[[10,.25],[40,.75]] as [number,number][]}];
  const old={...blank,cells,by:{source:groups,project:groups,device:groups}};
  const exact={...blank,cells:edges,by:{source:replacements,project:replacements,device:replacements}};
  const before=structuredClone({old,exact}),projected=fixed(exact).project(old,range);
  assert.deepEqual(projected.cells,[edges[0],cells[1],cells[2],edges[1]]);
  for(const dimension of ['source','project','device'] as const){
    assert.deepEqual(projected.by[dimension],[{...replacements[0],cells:[[10,.25],[20,2],[30,3],[40,.75]]}]);
  }
  assert.deepEqual({old,exact},before);
  assert.equal(fixed(exact).project(old,{...range,to:46}),old);
});

test('unordered activity and duplicate times retain stable order and the first matching group',()=>{
  const cells:Activity['cells']=[[30,3,3,3],[20,2,2,2],[20,1,1,1],[10,0,0,0]];
  const edges:Activity['cells']=[[40,4,4,4],[10,5,5,5],[20,6,6,6]];
  const first={key:'g',name:null,agentMs:0,activeMs:0,agents:0,cells:[[30,3],[20,2],[20,1]] as [number,number][]};
  const other={...first,cells:[[20,999]] as [number,number][]};
  const replacement={...first,cells:[[40,4],[10,5],[20,6]] as [number,number][]};
  const old={...blank,cells,by:{...blank.by,source:[first,other]}};
  const exact={...blank,cells:edges,by:{...blank.by,source:[replacement,{...replacement,key:'missing'}]}};
  const projected=fixed(exact).project(old,range);
  assert.deepEqual(projected.cells,[edges[1],cells[1],cells[2],edges[2],cells[0],edges[0]]);
  assert.deepEqual(projected.by.source[0].cells,[[10,5],[20,2],[20,1],[20,6],[30,3],[40,4]]);
  assert.deepEqual(projected.by.source[1].cells,[[10,5],[20,6],[40,4]]);
});

test('ordered fixed activity does not sort the retained interior of a dense frame',()=>{
  const selected={from:5,to:7205},cells:Activity['cells']=Array.from({length:721},(_,i)=>[i*10,i,i*2,1]);
  const groups=Array.from({length:64},(_,i)=>({key:String(i),name:null,agentMs:i,activeMs:i,agents:1,cells:cells.map(([at])=>[at,i] as [number,number])}));
  const old={...blank,cells,by:{source:groups,project:groups,device:groups}};
  const edges:Activity['cells']=[[0,.5,1,1],[7200,.75,1.5,1]];
  const replacements=groups.map(group=>({...group,cells:edges.map(([at])=>[at,.5] as [number,number])}));
  const exact={...blank,cells:edges,by:{source:replacements,project:replacements,device:replacements}},projector=fixed(exact,selected);
  const sort=Array.prototype.sort;let interiorComparisons=0;
  Array.prototype.sort=function(this:unknown[],compare?:(a:any,b:any)=>number){
    return sort.call(this,compare?(a:any,b:any)=>{if(a[0]>=10&&a[0]<7200||b[0]>=10&&b[0]<7200)interiorComparisons++;return compare(a,b);}:undefined);
  };
  try {
    const projected=projector.project(old,selected);
    assert.equal(projected.cells.length,721);
    assert.equal(projected.cells[1],cells[1]);
    assert.equal(projected.by.source.length,64);
    assert.deepEqual(projected.by.source[0].cells[1],[10,0]);
    assert.equal(interiorComparisons,0);
  } finally {Array.prototype.sort=sort;}
});
