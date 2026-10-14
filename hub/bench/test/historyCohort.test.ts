import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as budget from '../historyTrafficBudget';
import {historyScroll,stableHistoryReads} from '../historyTrafficBrowser';
import {cellStart} from '../../server/domain/history';

const source=readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8');
const start=source.indexOf('export async function browserCancellationTraffic(');
const end=source.indexOf('/** An instrumented replay',start);
const code=ts.transpileModule(source.slice(start,end).replace('export async function','async function')+'\nglobalThis.execute=browserCancellationTraffic;',
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const cell=300_000,before=Date.parse('2026-10-14T12:29:27.773Z'),after=Date.parse('2026-10-14T12:29:33Z');
const known={work:0,sources:{s:0}};

/** Drive the production cancellation cohort through its HTTP and native-input boundaries. */
async function replay(mode:'stable'|'cross-once'|'always-cross'|'changed-known'|'bad-body',fault?:'tokens'|'poses'|'pushes'|'range'|'abort') {
  let pages=0,closed=0,observersClosed=0;
  let settle=()=>{};
  const proxy={transfers:[] as any[],phase(){},async settled(){settle();}};
  const context={DAY:86_400_000,assert,...budget,stableHistoryReads,console:{error(){}},
    historyPage:async()=>{
      assert.equal(pages,closed,'the previous page must close before a fresh seed');
      const page=++pages,seedNow=mode==='cross-once'&&page>1?after:before;
      const seed={run:'same-run',now:seedNow,known};
      const reads:any[]=[],bodies={phase:'',activeCount:0,pending:new Set(),errors:[],reads,get resources(){return reads;}};
      settle=()=>{if(fault==='abort'&&page===1)reads[0].canceled=false;};
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
        {tokens:fault==='tokens'&&page===1?['one','two']:['one'],poses:[{end:fault==='poses'&&page===1?1000:900,origin:1000}],
          pushes:fault==='pushes'&&page===1?0:1,selected:!(fault==='range'&&page===1),attempts:{}}:
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

test('a cutoff crossing cannot mask an independent native movement or cancellation failure',async()=>{
  for(const fault of ['tokens','poses','pushes','range','abort'] as const){
    const failed=await replay('cross-once',fault);
    assert.ok(failed.error,fault+' must fail before invalidating the reference');
    assert.ok(!((failed.error as Error).cause instanceof budget.HistoryCutChanged));
    assert.equal(failed.pages,1,fault+' must not create a replacement cohort');
    assert.equal(failed.closed,1);assert.equal(failed.observersClosed,1);
  }
});

const coldStart=source.indexOf('export async function browserHistoryTraffic(');
const coldEnd=source.indexOf('/** Native cancellation/reversal',coldStart);
const coldCode=ts.transpileModule(source.slice(coldStart,coldEnd).replace('export async function','async function')+'\nglobalThis.execute=browserHistoryTraffic;',
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

/** Stand in browser IO while running the complete production traffic cohort. */
async function coldReplay(mode:'stable'|'cross-only'|'bad-first'|'bad-second'|'physical-only-body'|'later-run'|'later-known'|'optional'|'attempts') {
  let pages=0,closed=0,observersClosed=0;
  const proxy={transfers:[] as any[],phase(){},async settled(){}};
  const context={DAY:86_400_000,assert,...budget,cellStart,historyScroll,stableHistoryReads,URLSearchParams,
    process:{env:{}},console:{error(){}},writeFileSync(){},
    observeReversal:async()=>({watch:async(_name:string,work:()=>Promise<unknown>)=>work(),async close(){observersClosed++;}}),
    historyBody:async(_url:string,_cookie:string,_signal:unknown,onBody?:(body:unknown)=>void)=>{
      onBody?.({complete:true,decoded:100,lower:40});
      return {run:'r',now:mode!=='stable'&&pages===1?after:before,known,chunks:[]};
    },
    historyPage:async(_browser:unknown,_proxy:unknown,_cookie:string,_name:string,length:number,future:number)=>{
      assert.equal(pages,closed,'a replacement must await previous-page cleanup');
      const page=++pages,origin=before,geometry={x:0,y:0,width:1000,series:12},reads:any[]=[];
      const selections=['board=b&scope=quota','board=b&scope=budget'];
      const seeds=new Map(selections.map(selection=>[selection,{answer:{run:'r',now:before,known},initial:new Set()}]));
      const bodies={phase:'',reads,get resources(){return reads.filter(read=>read.selection);},diagnostic(){return {};}};
      let distance=0;
      const cdp={at(){},async send(method:string,args:any){
        if(method==='Performance.getMetrics')return {metrics:[]};
        if(method==='Input.synthesizeScrollGesture'&&bodies.phase.endsWith('/cold')){
          distance=args.xDistance;
          for(let i=0;i<(page===1&&mode==='attempts'?9:2);i++){
            const id=page+'/'+i,bad=page===1&&(mode==='bad-first'&&i===0||mode==='bad-second'&&i===1);
            reads.push({phase:bodies.phase,selection:selections[Math.min(i,1)],from:0,
              to:page===1&&mode==='optional'&&i===0?61*cell:cell,cell,
              count:{id,complete:true,lower:40,length:40,decoded:100,coding:bad?'identity':'br'},
              answer:{run:page===1&&mode==='later-run'&&i===1?'changed':'r',now:page===1&&mode!=='stable'&&i===0?after:before,
                known:page===1&&mode==='later-known'&&i===1?{work:1,sources:{s:0}}:known}});
            proxy.transfers.push({id,phase:bodies.phase,sent:true,finished:true,aborted:false,encoded:40,decoded:100});
          }
          if(page===1&&mode==='physical-only-body'){
            const id=page+'/detail';
            reads.push({phase:bodies.phase,selection:null,from:0,to:0,cell:0,count:{id,complete:true,lower:40,length:40,decoded:100,coding:'identity'}});
            proxy.transfers.push({id,phase:bodies.phase,sent:true,finished:true,aborted:false,encoded:40,decoded:100});
          }
        }
        return {};
      },async evaluate(expression:string){
        if(expression.includes('tokens:')){
          const to=origin-(length+future)*distance/geometry.width;
          return {tokens:['one'],pushes:1,poses:[{end:origin-1,origin},{end:to,origin}],from:to-length,to};
        }
        if(expression.includes('new URLSearchParams'))return false;
        throw new Error('Unexpected evaluation: '+expression);
      }};
      return {cdp,bodies,settled:async()=>{},geometry,cell,seeds,close:async()=>{closed++;}};
    },execute:null as any};
  runInNewContext(coldCode,context);
  try{return {result:await context.execute({},proxy,'cookie','b'),pages,closed,observersClosed,error:null};}
  catch(error){return {error,pages,closed,observersClosed};}
}

test('cold traffic retries only a changed reference after validating every resource and physical attempt',async()=>{
  const stable=await coldReplay('stable');assert.equal(stable.error,null);assert.equal(stable.pages,24);
  assert.equal(stable.result.reports.length,72);assert.equal(stable.result.problems.length,0);
  const recovered=await coldReplay('cross-only');assert.equal(recovered.error,null);assert.equal(recovered.pages,25);
  assert.equal(recovered.result.reports.length,72);assert.equal(recovered.result.invalidated.length,1);
  assert.equal(recovered.result.problems.length,0);
  for(const result of [stable,recovered]){assert.equal(result.closed,result.pages);assert.equal(result.observersClosed,result.pages);}
  for(const mode of ['bad-first','bad-second','physical-only-body','later-run','later-known','optional','attempts'] as const){
    const failed=await coldReplay(mode);assert.ok(failed.error,mode+' must fail before invalidating the reference');
    assert.ok(!((failed.error as Error).cause instanceof budget.HistoryCutChanged));
    assert.equal(failed.pages,1,mode+' must not create a replacement cohort');
    assert.equal(failed.closed,1);assert.equal(failed.observersClosed,1);
  }
});
