import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import {SETS} from '../../demo/catalogue.js';
import {cards,people} from '../../demo/model.js';
import {cellOf,cellStart} from '../../server/domain/history.js';
import {creditSnapshot} from '../credits.js';
import {MARGIN_MS,foreseenAt,overviewCards,stillProblems,stillSnapshot} from '../still.js';
import {Store} from '../../server/store/store.js';
import {Forecasts,hourShift,type Why} from '../../server/forecasts.js';
import {FADE_FOR,PULSE_FOR} from '../../ui/lib/quota.js';
import {chartProblems,creditRenderProblems,HISTORY_BYTES_PER_MEASUREMENT,measuredProblems} from '../budget.js';

/** Execute the whole production phase; the stand and CDP only supply its observations. */
async function phase({resetIn=Infinity,fadesIn=-Infinity,forecastIn=Infinity,extraQuota=false,setupDrift=0}: {resetIn?:number;fadesIn?:number;forecastIn?:number;extraQuota?:boolean;setupDrift?:number}={},evidence={save(_name:string,_value:unknown){}}) {
  const hour=3_600_000,anchor=Date.parse('2026-10-15T05:00:00Z');
  const forecastStore=Number.isFinite(forecastIn)?new Store(':memory:',anchor-hour):undefined;
  try {
  const forecastSource=forecastStore?.source('antigravity','credit-forecast-fixture',anchor-hour);
  const forecastAt=forecastSource?anchor+hourShift(forecastSource):null;
  const start=forecastAt===null?Date.parse('2026-10-15T04:50:58Z'):forecastAt-forecastIn,boundary=start+resetIn;
  let now=start,probeFrom=now,amount='0',rows=0,coverage=0,lastChange=0,changedBalance=false;
  const worked:{source:string;window:string;asOf:number;why:Why}[]=[];
  const forecasts=forecastStore?new Forecasts(forecastStore,{observe:value=>worked.push(value)}):undefined;
  if(forecastStore&&forecastSource){
    const record=(at:number)=>forecastStore.record(forecastSource,{observedAt:at,plan:'pro',staleAfterMs:3*hour,resets:null,
      windows:[{id:'weekly',kind:'weekly',label:null,used:10,remaining:90,resetAt:null,minutes:10080}]});
    record(anchor-hour+1000);forecasts!.of(forecastSource,anchor-hour+60_000);
    record(start-600_000); // A later real sample leaves this no-reset forecast due at its source's next hour.
  }
  const selected=cards(SETS[0]).find(card=>card.provider==='codex'&&card.windows.length)!;
  const source='codex:credit',waits:number[]=[];
  const overview={board:{id:'board'},sources:[
    {id:source,successAt:start,staleAfterMs:3_600_000,windows:[{resetAt:null}]},
    {id:'claude:reset',successAt:start-600_000,staleAfterMs:3_600_000,windows:[{resetAt:Number.isFinite(boundary)?boundary:null}]},
    ...(Number.isFinite(fadesIn)?[{id:'antigravity:measured',successAt:start+fadesIn-PULSE_FOR-FADE_FOR,staleAfterMs:3_600_000,windows:[]}]:[]),
    ...(forecastStore&&forecastSource?[forecastStore.state(forecastSource)]:[]),
  ],forecast:{}};
  const owner={get:async()=>({...overview,forecast:forecasts&&forecastSource?{[forecastSource]:forecasts.of(forecastSource,now).value}:{}})};
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
    if(script.includes("getAttribute('data-last')"))return {present:true,at:cellStart(now,cellOf(86_400_000)),value:Number(BigInt(amount)*40_000n),ready:true,paths:['M0,'+amount+'H100']};
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
  const context={Date:class extends Date {static now(){return now;}},path,createHash,DatabaseSync:Ledger,Requests,SHOWN_WITHIN:5000,MARGIN_MS,FADE_FOR,PULSE_FOR,HISTORY_BYTES_PER_MEASUREMENT,Stop:Error,
    cards,people,creditSnapshot,stillSnapshot,overviewCards,foreseenAt,stillProblems,cellOf,cellStart,chartProblems,creditRenderProblems,measuredProblems,say:()=>{},
    sleep:async(ms:number)=>{waits.push(ms);now+=ms;},drain:async()=>{now+=100;},
    selectMoney:async()=>{now+=50+setupDrift;},
  };
  const code=ts.transpileModule(declaration.getText(sourceFile)+'\nglobalThis.phase=creditPhase;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,context);
  const result=await (context as unknown as {phase:(demo:unknown,stand:unknown,cdp:unknown,evidence:unknown)=>Promise<{qualification:{from:number;to:number;waits:unknown[]};updates:{amount:string;from:number;to:number;renders:unknown[];mutations:unknown[]}[];problems:string[]}>}).phase({dir:'/unused'},stand,cdp,evidence);
  return{result,waits,boundary,forecastAt,worked};
  } finally {forecastStore?.close();}
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

test('credit setup rejects a reset entering the interval during page preparation',async()=>{
  await assert.rejects(phase({resetIn:50_000,setupDrift:10_000}),/baseline changes independently: claude:reset has a limit that resets/);
});

for(const fadesIn of [8000,40_000,55_400])test(`credit setup waits for the earlier measured card to finish fading in ${fadesIn}ms`,async()=>{
  const {result}=await phase({fadesIn,resetIn:1900});
  assert.deepEqual(Array.from(result.problems),[]);
  assert.equal(result.updates.length,4);
  assert.equal(result.qualification.waits.length,1,'reset and fade share the existing setup wait');
  const started=Date.parse('2026-10-15T04:50:58Z');
  for(const update of result.updates)assert.ok(update.from>started+fadesIn+MARGIN_MS);
});

test('credit setup keeps its original shared deadline when another card cannot finish fading',async()=>{
  const failures:{name:string;value:{from:number;until:number;setupUntil:number;windowMs:number;resets:number[];fades:number[];forecasts:number[];waits:unknown[]}}[]=[];
  await assert.rejects(phase({fadesIn:55_401},{save(name,value){failures.push({name,value:value as typeof failures[number]['value']});}}),/credit measurement has no quiet quota interval/);
  assert.equal(failures.length,1);
  assert.equal(failures[0].name,'credit-setup-failure');
  const failed=failures[0].value;
  assert.equal(failed.until,failed.setupUntil+1);
  assert.deepEqual(Array.from(failed.fades),[failed.until-MARGIN_MS]);
  assert.equal(failed.windowMs,40_400);
  assert.deepEqual(Array.from(failed.resets),[]);
  assert.deepEqual(Array.from(failed.forecasts),[]);
  assert.deepEqual(Array.from(failed.waits),[],'the failed wait is never slept or added to completed waits');
});

test('an already faded measurement adds no setup wait',async()=>{
  const {result}=await phase({fadesIn:-1});
  assert.equal(result.qualification.waits.length,0);
  assert.deepEqual(Array.from(result.problems),[]);
});

test('credit setup settles a fade ending exactly at its opening boundary',async()=>{
  const {result}=await phase({fadesIn:400});
  assert.equal(result.qualification.waits.length,1);
  assert.deepEqual(Array.from(result.problems),[]);
});

test('credit setup lets an actual earlier forecast reach its source hour before all four updates',async()=>{
  const {result,forecastAt,worked}=await phase({forecastIn:13_000});
  assert.ok(forecastAt!==null);
  assert.deepEqual(Array.from(result.problems),[]);
  assert.deepEqual(Array.from(result.updates,update=>update.amount),['2499','2498','2498','2498']);
  assert.equal(result.qualification.waits.length,1);
  assert.deepEqual(worked.map(value=>value.why),['first','hour'],'owner.get performs the actual hourly refresh');
  for(const update of result.updates)assert.ok(update.from>forecastAt+MARGIN_MS&&update.to<=result.qualification.to);
});

test('a forecast entering after a fade cannot extend the shared credit setup deadline',async()=>{
  await assert.rejects(phase({fadesIn:40_000,forecastIn:85_000}),/credit measurement has no quiet quota interval/);
});

test('credit setup still rejects a forecast entering the interval during page preparation',async()=>{
  await assert.rejects(phase({forecastIn:50_000,setupDrift:10_000}),/baseline changes independently: antigravity:[^ ]+ has its forecasts worked out again/);
});
