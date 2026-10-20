import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityOracle,FIXED_ACTIVITY_BUDGET,fixedActivityScript} from '../fixedActivity';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';
import {HistoryPool} from '../../ui/lib/historyPool';
import vm from 'node:vm';

for(const period of ['24h','30d'])test(`the complete fixed Activity script installs before the page loads: ${period}`,async()=>{
  class Storage {values=new Map<string,string>();setItem(key:string,value:string){this.values.set(key,value);}getItem(key:string){return this.values.get(key)??null;}}
  const localStorage=new Storage(),pool=new HistoryPool(),sent:Headers[]=[];
  const context=vm.createContext({Storage,localStorage,Map,Set,WeakMap,WeakRef,Headers,Request,URL,pool,
    performance:{now:()=>0},location:{href:'http://fixture.invalid/'},document:{querySelector:()=>null},
    fetch:async(_url:string,init:{headers:Headers})=>{sent.push(init.headers);return 'stand-in';}});
  vm.runInContext('window=globalThis;',context);
  vm.runInContext(fixedActivityScript(period),context);
  vm.runInContext('__quotumInspectHistoryPool(pool);',context);
  assert.equal(typeof context.__quotumInspectPreparations,'function');
  assert.equal(vm.runInContext('__quotumFixedActivity.ready()',context),false);
  assert.equal(vm.runInContext('__quotumFixedActivity.sample()',context),null);
  assert.deepEqual(JSON.parse(localStorage.getItem('quotum.prefs')!),{range:period,horizon:'1d',activityBy:'project'});
  assert.equal(localStorage.getItem('quotum.locale'),'en');
  await context.fetch('/api/boards/synthetic/period',{headers:{'content-type':'application/json'}});
  assert.match(sent[0].get('x-quotum-bench-attempt')!,/^b\d+:\d+$/);
  const receipt=vm.runInContext('__quotumHistoryPoolReceipt.read()',context);
  assert.equal(receipt.entries.find((entry:{kind:string})=>entry.kind==='http').attemptId,sent[0].get('x-quotum-bench-attempt'),'identity wraps the observer before fetch reaches it');
});

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
