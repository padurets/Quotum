import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const file=ts.createSourceFile('historyTrafficBrowser.ts',readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const fn=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='historyScrollControl')!;
const code=ts.transpileModule(fn.getText(file)+'\nglobalThis.execute=historyScrollControl;',{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;

async function replay(fault?:'throw'|'invalidated'|'budget'|'missing'){
  const calls:boolean[]=[],saved=new Map<string,unknown>(),original=new Error('original CDP timeout');
  const context={exports:{},execute:null as unknown as (...args:unknown[])=>Promise<{reports:unknown[];problems:string[]}>,
    browserHistoryTraffic:async(_browser:unknown,_proxy:unknown,_cookie:string,_board:string,evidence:{save(name:string,value:unknown):void},firstCohort:boolean)=>{
      calls.push(firstCohort);evidence.save('traffic-stage',{firstCohort});
      if(fault==='throw')throw original;
      return{reports:fault==='missing'?[]:[{name:'browser/1d/history/0ms/0.5/take1/all-accounting'}],invalidated:fault==='invalidated'?[{}]:[],problems:fault==='budget'?['over budget']:[]};
    }};
  runInNewContext(code,context);
  let result:Awaited<ReturnType<typeof context.execute>>|undefined,error:unknown;
  try{result=await context.execute({}, {},'cookie','board',{save(name:string,value:unknown){saved.set(name,value);}});}catch(value){error=value;}
  return{calls,saved,result,error,original};
}

test('each scroll control process completes exactly its original first cohort without claiming a benchmark pass',async()=>{
  const run=await replay();assert.equal(run.error,undefined);assert.deepEqual(run.calls,[true]);assert.equal(run.result?.reports.length,1);
  assert.ok(run.saved.has('traffic-stage'));assert.ok(run.saved.has('scroll-result'));
  const terminal=run.saved.get('scroll-control') as {mode:string;completed:number;total:number};
  assert.equal(terminal.mode,'diagnostic');assert.equal(terminal.completed,1);assert.equal(terminal.total,1);
});

test('a failed, invalidated or missing first cohort cannot retry or receive a completed receipt',async()=>{
  for(const fault of ['throw','invalidated','budget','missing'] as const){
    const run=await replay(fault);assert.deepEqual(run.calls,[true]);
    assert.equal((run.saved.get('scroll-control') as {completed:number}).completed,0);
    if(fault==='throw')assert.equal(run.error,run.original);
    else if(fault==='invalidated')assert.match(String(run.error),/invalidated; no retry/);
    else if(fault==='missing')assert.match(String(run.error),/cohort missing/);
    else{assert.equal(run.error,undefined);assert.equal(run.result?.problems[0],'over budget');}
  }
});
