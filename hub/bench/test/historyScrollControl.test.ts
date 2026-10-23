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

async function replay(fault?:'throw'|'invalidated'|'budget'){
  const calls:number[]=[],saved=new Map<string,unknown>(),original=new Error('original CDP timeout');
  const context={exports:{},execute:null as unknown as (...args:unknown[])=>Promise<{reports:unknown[];problems:string[]}>,
    browserHistoryTraffic:async(_browser:unknown,_proxy:unknown,_cookie:string,_board:string,evidence:{save(name:string,value:unknown):void},iteration:number)=>{
      calls.push(iteration);evidence.save('traffic-stage',{iteration});
      if(iteration===2&&fault==='throw')throw original;
      return{reports:[iteration],invalidated:iteration===2&&fault==='invalidated'?[{}]:[],problems:iteration===2&&fault==='budget'?['over budget']:[]};
    }};
  runInNewContext(code,context);
  let result:Awaited<ReturnType<typeof context.execute>>|undefined,error:unknown;
  try{result=await context.execute({}, {},'cookie','board',{save(name:string,value:unknown){saved.set(name,value);}});}catch(value){error=value;}
  return{calls,saved,result,error,original};
}

test('the finite scroll control preserves all 24 iteration receipts without claiming a benchmark pass',async()=>{
  const run=await replay();assert.equal(run.error,undefined);assert.equal(run.calls.length,24);assert.equal(run.result?.reports.length,24);
  for(let i=1;i<=24;i++){
    assert.equal(run.calls[i-1],i);assert.ok(run.saved.has(`scroll-${i}-traffic-stage`));assert.ok(run.saved.has(`scroll-${i}-result`));
  }
  const terminal=run.saved.get('scroll-control') as {mode:string;completed:number;total:number};
  assert.equal(terminal.mode,'diagnostic');assert.equal(terminal.completed,24);assert.equal(terminal.total,24);
});

test('the first failed or invalidated cohort stops the control with no retry or completed receipt',async()=>{
  for(const fault of ['throw','invalidated','budget'] as const){
    const run=await replay(fault);assert.equal(run.calls.length,2);assert.ok(!run.saved.has('scroll-3-traffic-stage'));
    assert.equal((run.saved.get('scroll-control') as {completed:number}).completed,1);
    if(fault==='throw')assert.equal(run.error,run.original);
    else if(fault==='invalidated')assert.match(String(run.error),/invalidated; no retry/);
    else{assert.equal(run.error,undefined);assert.equal(run.result?.problems[0],'over budget');}
  }
});
