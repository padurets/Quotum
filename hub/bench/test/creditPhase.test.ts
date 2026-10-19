import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import {SETS} from '../../demo/catalogue.js';
import {cards,people} from '../../demo/model.js';
import {cellOf,cellStart} from '../../server/domain/history.js';
import {creditSnapshot} from '../credits.js';
import {hourShift} from '../../server/forecasts.js';
import {overviewCards,quietAfter,stillProblems,stillSnapshot} from '../still.js';
import {chartProblems,creditRenderProblems,HISTORY_BYTES_PER_MEASUREMENT,measuredProblems} from '../budget.js';

/** Execute the whole production phase; the stand and CDP only supply its observations. */
async function phase({resetIn=Infinity,extraQuota=false,setupDrift=0,forecastEdge=false,baselineReset=false}: {resetIn?:number;extraQuota?:boolean;setupDrift?:number;forecastEdge?:boolean;baselineReset?:boolean}={}) {
  const source='codex:credit',forecastAt=Date.parse('2026-10-15T05:00:00Z')+hourShift(source);
  const start=forecastEdge?forecastAt-1900:Date.parse('2026-10-15T04:50:58Z');let boundary=start+resetIn;
  let now=start,probeFrom=now,amount='0',rows=0,coverage=0,lastChange=0,changedBalance=false;
  const selected=cards(SETS[0]).find(card=>card.provider==='codex'&&card.windows.length)!;
  const waits:number[]=[];let overviewReads=0;
  const overview={board:{id:'board'},sources:[
    {id:source,successAt:start,staleAfterMs:3_600_000,windows:[{resetAt:null}]},
    {id:'claude:reset',successAt:start-600_000,staleAfterMs:3_600_000,windows:[{resetAt:Number.isFinite(boundary)?boundary:null}]},
  ],forecast:forecastEdge?{[source]:{weekly:{asOf:Math.floor(forecastAt/3_600_000)*3_600_000-3_600_000}}}:{}};
  const owner={get:async()=>{if(++overviewReads===3&&baselineReset){boundary=now+1000;overview.sources[1].windows[0].resetAt=boundary;}return overview;}};
  const agent={ingest:async(snapshots: {balances?:{amount:string}[]}[])=>{
    now+=200;
    const balance=snapshots[0].balances?.[0];
    if(balance){
      changedBalance=balance.amount!==amount;
      if(changedBalance)rows++;
      amount=balance.amount;coverage++;lastChange=now;
    }
  }};
  const stand={set:SETS[0],start:start-20*60_000,people:new Map([[people(SETS[0])[0].id,owner]]),sources:new Map([[selected.id,source]]),agents:new Map([[selected.machines[0],agent]])};
  const parts=()=>extraQuota||probeFrom<=boundary&&boundary<=now?[
    {node:'section.panel.forecast',time:false,kind:null,region:'analytics',widget:'session',count:1},
    {node:'section.panel.history[data-time=chart]',time:true,kind:'chart',region:'analytics',widget:'session',count:1},
  ]:[];
  const cdp={evaluate:async(script:string)=>{
    if(script==='__quotumBench.reset()'){probeFrom=now;return;}
    if(script==='__quotumBench.read()'){
      const own=changedBalance?[{node:'article.card',time:false,kind:null,region:'card:'+source,widget:null,count:1}]:[];
      return{renders:[...own,...parts()],mutations:[...own,...parts()]};
    }
    if(script.includes('seriesChanged('))return lastChange;
    if(script.includes('moneyChanged('))return changedBalance?lastChange:null;
    if(script.includes('[data-money]'))return String(BigInt(amount)*40_000n);
  }};
  class Ledger {
    prepare(sql:string){return{get:()=>sql.includes('count(*)')?{n:rows}:{at:coverage}};}
    close(){}
  }
  class Requests {
    counting=false;historyRequests=1;historyBytes=100;
    history=[{scope:'budget',meters:JSON.stringify([[source,'balance:credits']]),from:cellStart(start-60_000,cellOf(86_400_000))}];
  }
  const sourceFile=ts.createSourceFile('index.ts',readFileSync(new URL('../index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=sourceFile.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='creditPhase');
  assert.ok(declaration);
  const context={Date:class extends Date {static now(){return now;}},path,DatabaseSync:Ledger,Requests,SHOWN_WITHIN:5000,HISTORY_BYTES_PER_MEASUREMENT,Stop:Error,
    cards,people,creditSnapshot,stillSnapshot,overviewCards,quietAfter,stillProblems,cellOf,cellStart,chartProblems,creditRenderProblems,measuredProblems,say:()=>{},
    sleep:async(ms:number)=>{waits.push(ms);now+=ms;},drain:async()=>{now+=100;},
    selectMoney:async()=>{now+=50+setupDrift;},
  };
  const code=ts.transpileModule(declaration.getText(sourceFile)+'\nglobalThis.phase=creditPhase;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,context);
  const result=await (context as unknown as {phase:(demo:unknown,stand:unknown,cdp:unknown)=>Promise<{qualification:{from:number;to:number;waits:unknown[]};updates:{amount:string;from:number;to:number;renders:unknown[];mutations:unknown[]}[];problems:string[]}>}).phase({dir:'/unused'},stand,cdp);
  return{result,waits,boundary,forecastAt};
}

test('credit phase waits past a natural quota reset before counting all four updates',async()=>{
  const {result,waits,boundary}=await phase({resetIn:1900});
  assert.deepEqual(Array.from(result.problems),[]);
  assert.deepEqual(Array.from(result.updates,update=>update.amount),['2499','2498','2498','2498']);
  assert.equal(result.qualification.waits.length,1);
  assert.ok(waits.some(ms=>ms>1000));
  for(const update of result.updates){
    assert.ok(update.from>boundary&&update.to<=result.qualification.to);
  }
});

test('a qualified credit phase still fails unrelated quota renders and mutations',async()=>{
  const {result}=await phase({extraQuota:true});
  assert.equal(result.updates.length,4);
  assert.equal(result.problems.length,16,'all four original isolation guards run for each update');
  assert.ok(result.problems.every(problem=>problem.startsWith('subscription credit ')));
});

test('credit phase qualifies after page preparation and waits when that setup approaches a reset',async()=>{
  const {result,boundary}=await phase({resetIn:50_000,setupDrift:10_000});
  assert.deepEqual(Array.from(result.problems),[]);assert.equal(result.qualification.waits.length,1);
  assert.equal(result.updates.length,4);assert.ok(result.updates.every(update=>update.from>boundary));
});

test('credit phase waits past an hourly forecast before counting the same four isolated updates',async()=>{
  const {result,forecastAt}=await phase({forecastEdge:true});
  assert.deepEqual(Array.from(result.problems),[]);assert.equal(result.qualification.waits.length,1);
  assert.equal(result.updates.length,4);assert.ok(result.updates.every(update=>update.from>forecastAt));
});

test('credit setup still rejects a reset introduced after the interval was qualified',async()=>{
  await assert.rejects(phase({baselineReset:true}),/baseline changes independently: claude:reset has a limit that resets/);
});
