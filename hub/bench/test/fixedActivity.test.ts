import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityOracle,FIXED_ACTIVITY_BUDGET} from '../fixedActivity';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('the fixed-subset benchmark oracle clips intervals, unions overlap and deduplicates identities',()=>{
  const trace:WorkTrace={anchor:100,knownFrom:100,cut:200,refs:[0,1,2].map(i=>({ref:String(i),identityRef:i<2?'shared':'other',source:null,project:null,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:100})),spans:[[0,0,30],[1,10,40],[2,50,60]]};
  for(const value of [trace,packWork(trace)]){
    assert.deepEqual(activityOracle(value,115,135),{agentMs:35,activeMs:20,agents:1});
    assert.deepEqual(activityOracle(value,125,155),{agentMs:25,activeMs:20,agents:2});
    assert.deepEqual(activityOracle(value,170,180),{agentMs:0,activeMs:0,agents:0});
  }
  assert.equal(FIXED_ACTIVITY_BUDGET.request,76*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.pool,15*1024*1024);
  assert.equal(FIXED_ACTIVITY_BUDGET.body,7*1024*1024);
  assert.ok(FIXED_ACTIVITY_BUDGET.subset30d<FIXED_ACTIVITY_BUDGET.body);
});

test('the mounted fixed-subset probe cannot count retained pending or failed evidence as settled',()=>{
  const source=readFileSync(new URL('../fixedActivity.ts',import.meta.url),'utf8');
  const start=source.indexOf('function observationScript('),code=source.slice(start,source.indexOf('/** Physical requests',start));
  const state={model:{},loading:false,error:null as string|null},reader={tiles:new Map(),numbers:()=>null,get:()=>state,flight:null as object|null};
  class Storage {setItem(){}}
  let drawing:object|null=null;
  const context={Map,window:{} as any,Storage,localStorage:new Storage(),document:{querySelector:()=>drawing},historyPoolReceiptScript:()=> 'window.__quotumInspectHistoryPool=()=>{};',script:''};
  runInNewContext(ts.transpileModule(code+'\nglobalThis.script=observationScript("24h");',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  runInNewContext(context.script,context);
  const pool={members:new Set([reader]),activeFlights:0,reserve:()=>true,request:()=>{}};
  context.window.__quotumInspectHistoryPool(pool);const ready=context.window.__quotumFixedActivity.ready;
  assert.equal(ready(),true);
  state.loading=true;assert.equal(ready(),false,'a retained model is not a completed replacement');
  state.loading=false;state.error='history_failed';assert.equal(ready(),false);
  state.error=null;reader.flight={};assert.equal(ready(),false);
  reader.flight=null;pool.activeFlights=1;assert.equal(ready(),false);
  pool.activeFlights=0;drawing={};assert.equal(ready(),false);
  drawing=null;assert.equal(ready(),true);
});
