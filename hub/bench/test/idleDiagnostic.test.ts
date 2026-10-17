import {test} from 'node:test';
import assert from 'node:assert/strict';
import {idleSensitivity} from '../idleDiagnostic.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {idleProblems} from '../budget.js';
import {idlePhaseProblems,idlePhaseScript} from '../still.js';
import {idleRetentionProblems,type IdleRetention} from '../idleRetention.js';
import {scriptPerSecond} from '../report.js';

test('measured idle growth can remain below the unchanged absolute budget',()=>{
  const baseline=0.1076399471873742,copies=[0.1407154799641784,0.1331075868202594];
  const result=idleSensitivity(baseline,copies,true);
  assert.equal(result.valid,true);assert.equal(result.growthDetected,true);
  assert.equal(result.overBudget,false);assert.equal(result.threshold,0.3);
  assert.equal(result.scriptMsPerSecond,copies[0]+copies[1]);
  assert.equal(result.increaseMsPerSecond,result.scriptMsPerSecond-baseline);
  assert.equal(result.ratio,result.scriptMsPerSecond/baseline);
  assert.equal(idleSensitivity(.2,[.19,.18],true).overBudget,true);
});

test('a doubled idle fixture without measured growth fails sensitivity',()=>{
  for(const copies of [[.1,.1],[.08,.09]]) {
    const result=idleSensitivity(.2,copies,true);
    assert.equal(result.valid,true);assert.equal(result.growthDetected,false);
  }
});

test('invalid phases, counters or a missing copy cannot demonstrate sensitivity',()=>{
  for(const [baseline,copies,phaseValid] of [
    [.1,[.1,.1],false],[.1,[.2],true],[.1,[.2,.2,.2],true],
    [0,[.1,.1],true],[NaN,[.1,.1],true],[.1,[Infinity,.1],true],[.1,[-.1,.3],true],
  ] as const) {
    const result=idleSensitivity(baseline,copies,phaseValid);
    assert.equal(result.valid,false);assert.equal(result.growthDetected,false);
    assert.equal(result.ratio,null);assert.equal(result.increaseMsPerSecond,null);
  }
});

/** Execute the actual async caller; only browser I/O, counters and waiting are controlled. */
async function doubleControl(options:{missed?:number;scope?:number;cohort?:number;opening?:number;closing?:number;lateCounter?:boolean;dueMismatch?:boolean;cadence?:boolean;costs?:number[]}={}) {
  const at=1_800_000_000_000,day=86_400_000,from=at+240_000,to=at+360_000,boundary=at+300_000,quotaBoundary=at+250_001;
  const before:IdleRetention={at:from,evaluatedAt:from,identity:'board/live',generation:1,revision:1,proofEpoch:1,scopeKey:'quota',
    selection:{mode:'live',periodMs:day},settled:true,retirementAt:quotaBoundary,
    quota:{from:at-day,cut:at,cursor:'same',rows:[{sourceId:'source',windowId:'weekly',count:3,first:at-day,second:at-day+250_000,third:at-day+550_000,last:at-day+550_000}]}};
  const after:IdleRetention={...before,at:to,evaluatedAt:to,retirementAt:at+550_001,
    quota:{...before.quota!,rows:[{...before.quota!.rows[0],count:2,first:before.quota!.rows[0].second,second:before.quota!.rows[0].third,third:null}]}};
  if(options.cadence)before.quota!.rows[0].first=at-day-50_000;
  const baseline=structuredClone(before);
  let now=from,waits=0,closed=0,bootstraps=0;
  const snapshots=[0,1].map(id=>{
    const pair=structuredClone([before,options.missed===id?before:after]);
    if(options.scope===id)for(const value of pair)value.scopeKey='other';
    if(options.cohort===id)for(const value of pair)value.quota!.rows[0].sourceId='other';
    return pair;
  });
  if(options.dueMismatch||options.cadence){
    const row={sourceId:'eco',windowId:'weekly',count:4,first:at-day,second:at-day+310_000,third:at-day+610_000,last:at-day+910_000};
    baseline.quota!.rows.push(structuredClone(row));
    for(const [id,pair] of snapshots.entries()){
      const retired={...row,count:3,first:row.second,second:row.third,third:row.last};
      pair[0].quota!.rows.push(options.dueMismatch&&id===1?retired:row);pair[1].quota!.rows.push(retired);
    }
    if(options.cadence){
      baseline.at=baseline.evaluatedAt=from-300_000;baseline.retirementAt=quotaBoundary-300_000;baseline.quota!.from=at-day-60_000;
      baseline.quota!.rows[0]={...baseline.quota!.rows[0],count:4,first:at-day-350_000,second:at-day-50_000,third:at-day+250_000};
      const completed={...structuredClone(before),at:to-300_000,evaluatedAt:to-300_000,quota:{...structuredClone(baseline.quota!),rows:[before.quota!.rows[0],row]}};
      assert.deepEqual(idleRetentionProblems(baseline,completed,from-300_000,to-300_000,quotaBoundary-300_000),[],'the earlier baseline itself completes its different due set');
    }
  }
  const bootstrapSource='window.__quotumInspectHistoryPool=()=>{};';
  const pages=[0,1].map(id=>{
    let reads=0;
    return {id,evaluate:async(expression:string)=>{
      if(expression.startsWith('document.querySelectorAll'))return expression.includes('>0')?true:2;
      if(expression==='window.__quotumIdleRetention()')return snapshots[id][Number(now===to)];
      if(expression==='__quotumBench.read()'){const count=reads++;return {instrumentMs:0,commits:options.opening===id&&count===0||options.closing===id&&count===2?1:0,renders:[],mutations:[]};}
      if(expression.includes('__quotumIdlePhase.read()'))return {from,to,monotonicFrom:0,monotonicTo:to-from,cellMs:300_000,
        starts:Array(5).fill(Math.floor(from/300_000)),ends:Array(5).fill(Math.floor(to/300_000)),transitions:[1,1,1,1,1]};
      return undefined;
    },send:async(method:string,params:{source?:string})=>{if(method==='Page.addScriptToEvaluateOnNewDocument'){assert.equal(params.source,bootstrapSource);bootstraps++;}return {};}};
  });
  const source=ts.createSourceFile('idleDiagnostic.ts',readFileSync(new URL('../idleDiagnostic.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='doubledIdle');
  assert.ok(declaration);
  const metricReads=[0,0];
  const context={run:undefined as ((...args:unknown[])=>Promise<{valid:boolean;growthDetected:boolean;baselineRetention:IdleRetention;reports:{problems:string[];due:{sourceId:string;windowId:string}[]}[]}> )|undefined,
    openTab:async()=>({cdp:pages[1],close:async()=>{closed++;}}),probeScript:()=>'',Requests:class{count=0;byPath={};counting=false;},
    idleWindow:()=>({from,to,boundary,quotaBoundary,cellMs:300_000}),sleep:async()=>{now=++waits===1?from:to;},Date:{now:()=>now},
    metrics:async(page:{id:number})=>{if(options.lateCounter&&metricReads[page.id]===0)now=quotaBoundary;return {Timestamp:metricReads[page.id]++?to/1000:from/1000,ScriptDuration:metricReads[page.id]>1?(options.costs?.[page.id]??.15)*120/1000:0};},
    scriptPerSecond,idlePhaseScript,idlePhaseProblems,idleRetentionProblems,idleProblems,idleSensitivity};
  runInNewContext(ts.transpileModule(declaration.getText(source).replace(/^export /,'')+'\nglobalThis.run=doubledIdle;',{
    compilerOptions:{target:ts.ScriptTarget.ES2022},
  }).outputText,context);
  assert.ok(context.run);
  const heard={reset:()=>{},counts:()=>({ping:4}),boardCounts:()=>({ping:4}),contacts:()=>({}),hints:()=>({}),calendar:()=>({packets:0,bytes:0,rejected:0,expected:[],received:[],missing:[]})};
  const result=await context.run({owned:true},pages[0],'http://fixture.invalid',120,300_000,{begin:()=>{},save:()=>{}},heard,.1,
    {retention:baseline,bootstrapSource});
  assert.equal(closed,1);assert.equal(bootstraps,1);assert.equal(waits,2,'one planned window, with no search or repeat');
  return result;
}

test('two actual idle callers can show growth above the combined budget while each copy stays within it',async()=>{
  const result=await doubleControl({costs:[.2,.2]});
  assert.equal(result.valid,true);assert.equal(result.growthDetected,true);
});

for(const missed of [0,1])test(`the double control rejects missing retirement in copy ${missed} despite all five axis transitions`,async()=>{
  const result=await doubleControl({missed});
  assert.equal(result.growthDetected,false);assert.equal(result.valid,false);
});

for(const option of ['scope','cohort','opening','closing'] as const)test(`the double control rejects a ${option} mismatch hidden by equal card counts`,async()=>{
  const result=await doubleControl({[option]:1});
  assert.equal(result.growthDetected,false);assert.equal(result.valid,false);
});

test('the double control preserves each copy budget and rejects no growth',async()=>{
  assert.equal((await doubleControl({costs:[.301,.15]})).growthDetected,false);
  assert.equal((await doubleControl({costs:[.04,.04]})).growthDetected,false);
});

test('an opening performance counter after quota retirement invalidates an otherwise moving phase',async()=>{
  const result=await doubleControl({lateCounter:true});
  assert.equal(result.valid,false);assert.ok(result.reports.some(report=>report.problems.includes('idle counters did not include regular quota retirement')));
});

test('matching source cohorts cannot hide different successfully retired due sets between copies',async()=>{
  const result=await doubleControl({dueMismatch:true});
  assert.equal(result.valid,false);assert.ok(result.reports[1].problems.includes('idle copies retired different quota cohorts'));
  assert.ok(result.reports.every(report=>!report.problems.some(problem=>problem.includes('prefix did not retire')||problem.includes('baseline quota cohort'))));
});

test('an earlier calendar window may retire a different subset of the same admitted sources',async()=>{
  const result=await doubleControl({cadence:true}),baseline=result.baselineRetention,day=86_400_000;
  const due=baseline.quota!.rows.filter(row=>row.second!==null&&baseline.at<row.second+1+day&&row.second+1+day<baseline.at+120_000);
  assert.equal(due.length,1);assert.equal(result.reports[0].due.length,2);assert.equal(result.valid,true);assert.equal(result.growthDetected,true);
});
