import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as budget from '../historyTrafficBudget';
import {stableHistoryReads} from '../historyTrafficBrowser';

const source=readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8');
const start=source.indexOf('export async function browserCancellationTraffic(');
const end=source.indexOf('/** An instrumented replay',start);
const code=ts.transpileModule(source.slice(start,end).replace('export async function','async function')+'\nglobalThis.execute=browserCancellationTraffic;',
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const cell=300_000,before=Date.parse('2026-10-14T12:29:27.773Z'),after=Date.parse('2026-10-14T12:29:33Z');
const known={work:0,sources:{s:0}};

/** Drive the production cancellation cohort through its HTTP and native-input boundaries. */
async function replay(mode:'stable'|'cross-once'|'always-cross'|'changed-known'|'bad-body') {
  let pages=0,closed=0,observersClosed=0;
  const proxy={transfers:[] as any[],phase(){},async settled(){}};
  const context={DAY:86_400_000,assert,...budget,stableHistoryReads,console:{error(){}},
    historyPage:async()=>{
      assert.equal(pages,closed,'the previous page must close before a fresh seed');
      const page=++pages,seedNow=mode==='cross-once'&&page>1?after:before;
      const seed={run:'same-run',now:seedNow,known};
      const reads:any[]=[],bodies={phase:'',activeCount:0,pending:new Set(),errors:[],reads,get resources(){return reads;}};
      const cdp={at(){},async send(method:string,params:any){
        if(method!=='Input.dispatchMouseEvent')return;
        if(!reads.length){
          const id=`${page}/first`;
          reads.push({phase:bodies.phase,selection:'quota',from:1000,to:2000,canceled:false,attemptId:id,count:{id,complete:false,lower:0}});
          proxy.transfers.push({id,phase:bodies.phase,cell,from:1000,to:2000,sent:false,finished:false,aborted:true,encoded:40,decoded:100});
        }else if(params.deltaX>0)reads[0].canceled=true;
        else{
          const id=`${page}/repeat`,cross=mode==='always-cross'||mode==='cross-once'&&page===1;
          reads.push({phase:bodies.phase,selection:'quota',from:1000,to:2000,attemptId:id,
            answer:{...seed,now:cross?after:seedNow+1000,known:mode==='changed-known'?{work:1,sources:{s:0}}:known},
            count:{id,complete:true,lower:40,decoded:100,length:40,coding:mode==='bad-body'?'identity':'br'}});
          proxy.transfers.push({id,phase:bodies.phase,cell,from:1000,to:2000,sent:true,finished:true,aborted:false,encoded:40,decoded:100});
        }
      },async evaluate(expression:string){return expression.includes('tokens:')?
        {tokens:['one'],poses:[{end:900,origin:1000}],pushes:1,selected:true,attempts:{}}:
        {visibility:'visible',ready:'complete',charts:[],selected:true};}};
      return {cdp,bodies,settled:async()=>{},geometry:{x:0,y:0,width:1000},cell,
        seeds:new Map([['quota',{answer:seed}]]),close:async()=>{closed++;}};
    },
    observeReversal:async()=>({watch:async(_name:string,work:()=>Promise<unknown>)=>work(),close:async()=>{observersClosed++;}}),
    execute:null as any};
  runInNewContext(code,context);
  try{return {result:await context.execute({},proxy,'cookie',true,false),pages,closed,observersClosed,error:null};}
  catch(error){return {error,pages,closed,observersClosed};}
}

test('a cancellation cutoff crossing gets a fresh complete cohort and retains its invalidation',async()=>{
  const stable=await replay('stable');
  assert.equal(stable.error,null);assert.equal(stable.pages,1);assert.equal(stable.result.reports.length,1);
  const recovered=await replay('cross-once');
  assert.equal(recovered.error,null);assert.equal(recovered.pages,2);
  assert.equal(recovered.closed,2);assert.equal(recovered.observersClosed,2);
  assert.equal(recovered.result.reports.length,1);assert.equal(recovered.result.reports[0].movement.tokens,1);
  assert.equal(recovered.result.reports[0].aborted,1);
  assert.equal(recovered.result.invalidated.length,1);
  const cut=recovered.result.invalidated[0];
  assert.equal(cut.seedNow,before);assert.equal(cut.answerNow,after);assert.equal(cut.cell,cell);
  assert.equal(cut.seedCut,Date.parse('2026-10-14T12:25Z'));assert.equal(cut.answerCut,Date.parse('2026-10-14T12:30Z'));
  assert.ok(cut.reads.length>0);
});

test('persistent cutoff changes and actual cancellation assertions remain failures',async()=>{
  const exhausted=await replay('always-cross');
  assert.ok((exhausted.error as Error)?.cause instanceof budget.HistoryCutChanged);
  assert.equal(exhausted.pages,3);assert.equal(exhausted.closed,3);assert.equal(exhausted.observersClosed,3);
  for(const mode of ['changed-known','bad-body'] as const){
    const failed=await replay(mode);assert.ok(failed.error);
    assert.ok(!((failed.error as Error).cause instanceof budget.HistoryCutChanged));
    assert.equal(failed.pages,1);assert.equal(failed.closed,1);assert.equal(failed.observersClosed,1);
  }
});
