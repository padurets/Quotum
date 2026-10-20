import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {SETS} from '../../demo/catalogue.js';
import {cards,people} from '../../demo/model.js';
import {cellOf,cellStart} from '../../server/domain/history.js';
import {creditSnapshot} from '../credits.js';
import {safeEvidence} from '../evidence.js';
import {MARGIN_MS,overviewCards,quietAfter,stillProblems,stillSnapshot} from '../still.js';
import {Store} from '../../server/store/store.js';
import {Forecasts,hourShift,type Why} from '../../server/forecasts.js';
import {cadenceChangesAt,cadenceOf,dotChangesAt,dotOf,errorText,problemOf,FADE_FOR,PULSE_FOR} from '../../ui/lib/quota.js';
import {PageClock} from '../../ui/lib/clock.js';
import {countdownChangesAt,earliest,stamp} from '../../ui/lib/format.js';
import {refreshPending} from '../../ui/lib/refresh.js';
import {t} from '../../ui/i18n/index.js';
import {chartProblems,creditRenderProblems,HISTORY_BYTES_PER_MEASUREMENT,measuredProblems} from '../budget.js';

/** The real clock hook and card mark, with only React's hook host and static dependencies supplied. */
function fadingMark(source:{id:string;successAt:number;stale:boolean;error:null;quota:null},now:()=>number) {
  const timers=new Map<object,{at:number;run:()=>void}>(),slots:unknown[]=[],dispose:(()=>void)[]=[],effects:(()=>void)[]=[];
  const changes:{at:number;before:number|null;after:number|null}[]=[];
  let cursor=0,fresh:number|null=null,mounted=false;
  const clock=new PageClock({now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now()+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const stored=(initial:()=>unknown)=>{const index=cursor++;if(!Object.hasOwn(slots,index))slots[index]=initial();return slots[index];};
  const context={exports:{} as Record<string,unknown>,require:()=>jsx,clock,hubNow:clock.hubNow,
    useState:(initial:unknown)=>[stored(()=>typeof initial==='function'?(initial as ()=>unknown)():initial),()=>{}],
    useRef:(initial:unknown)=>stored(()=>({current:initial})),useLayoutEffect:(work:()=>void)=>effects.push(work),
    useSyncExternalStore:(subscribe:(notify:()=>void)=>()=>void,read:()=>unknown)=>{stored(()=>{dispose.push(subscribe(render));return true;});return read();},
    useMine:()=>false,useCadence:()=>null,useRefresh:()=>null,useEffect:()=>{},useBubble:()=>({current:null}),logoOf:()=>'',
    earliest,dotOf,dotChangesAt,cadenceOf,cadenceChangesAt,countdownChangesAt,problemOf,errorText,refreshPending,stamp,t};
  const options={compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}};
  const clockSource=readFileSync(new URL('../../ui/lib/clock.ts',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(clockSource.slice(clockSource.indexOf('export function useClock(')),options).outputText,context);
  Object.assign(context,{useClock:context.exports.useClock});
  const file=ts.createSourceFile('SourceCard.tsx',readFileSync(new URL('../../ui/components/SourceCard.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='CardMark');assert.ok(declaration);
  runInNewContext(ts.transpileModule(declaration.getText(file),options).outputText,context);
  function render() {
    cursor=0;
    const mark=(context.exports.CardMark as (props:unknown)=>{type:string;props:{'data-time':string;children:[unknown,{props:{style?:{'--fresh':number}}}]}})({source});
    assert.equal(mark.type,'span');assert.equal(mark.props['data-time'],'mark');
    const next=mark.props.children[1].props.style?.['--fresh']??null;
    if(mounted)changes.push({at:now(),before:fresh,after:next});
    fresh=next;mounted=true;
    for(const work of effects.splice(0))work();
  }
  render();
  return {changes,timers,close:()=>{for(const stop of dispose)stop();}};
}

/** Execute the whole production phase; the stand and CDP only supply its observations. */
async function phase({resetIn=Infinity,secondResetIn=Infinity,fadesIn=-Infinity,fadingStale=false,forecastIn=Infinity,extraQuota=false,markFault=false,setupDrift=0,legacyFadeWait=false,baselineReset=false}: {resetIn?:number;secondResetIn?:number;fadesIn?:number;fadingStale?:boolean;forecastIn?:number;extraQuota?:boolean;markFault?:boolean;setupDrift?:number;legacyFadeWait?:boolean;baselineReset?:boolean}={},evidence={save(_name:string,_value:unknown){}}) {
  const source='codex:credit',hour=3_600_000,anchor=Date.parse('2026-10-15T05:00:00Z');
  const forecastStore=Number.isFinite(forecastIn)?new Store(':memory:',anchor-hour):undefined;
  let mark:ReturnType<typeof fadingMark>|undefined;
  try {
  const forecastSource=forecastStore?.source('antigravity','credit-forecast-fixture',anchor-hour);
  const forecastAt=forecastSource?anchor+hourShift(forecastSource):null;
  const start=forecastAt===null?Date.parse('2026-10-15T04:50:58Z'):forecastAt-forecastIn;
  let boundary=start+resetIn;
  let now=start,probeFrom=now,amount='0',rows=0,coverage=0,lastChange=0,changedBalance=false;
  const advance=(ms:number)=>{
    const to=now+ms;
    for(;;){const next=mark&&[...mark.timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>to)break;mark!.timers.delete(next[0]);now=next[1].at;next[1].run();}
    now=to;
  };
  const worked:{source:string;window:string;asOf:number;why:Why}[]=[];
  const forecasts=forecastStore?new Forecasts(forecastStore,{observe:value=>worked.push(value)}):undefined;
  if(forecastStore&&forecastSource){
    const record=(at:number)=>forecastStore.record(forecastSource,{observedAt:at,plan:'pro',staleAfterMs:3*hour,resets:null,
      windows:[{id:'weekly',kind:'weekly',label:null,used:10,remaining:90,resetAt:null,minutes:10080}]});
    record(anchor-hour+1000);forecasts!.of(forecastSource,anchor-hour+60_000);
    record(start-600_000); // A later real sample leaves this no-reset forecast due at its source's next hour.
  }
  const selected=cards(SETS[0]).find(card=>card.provider==='codex'&&card.windows.length)!;
  const waits:number[]=[];let overviewReads=0;
  const overview={board:{id:'board'},sources:[
    {id:source,successAt:start,staleAfterMs:3_600_000,windows:[{resetAt:null}]},
    {id:'claude:reset',successAt:start-600_000,staleAfterMs:3_600_000,windows:[{resetAt:Number.isFinite(boundary)?boundary:null},...(Number.isFinite(secondResetIn)?[{resetAt:start+secondResetIn}]:[])]},
    ...(Number.isFinite(fadesIn)?[{id:'antigravity:measured',provider:'antigravity',successAt:start+fadesIn-PULSE_FOR-FADE_FOR,staleAfterMs:3_600_000,windows:[],stale:fadingStale,error:null,quota:null}]:[]),
    ...(forecastStore&&forecastSource?[forecastStore.state(forecastSource)]:[]),
  ],forecast:{}};
  if(Number.isFinite(fadesIn))mark=fadingMark(overview.sources[2] as Parameters<typeof fadingMark>[0],()=>now);
  const owner={get:async()=>{
    if(++overviewReads===3&&baselineReset){boundary=now+1000;overview.sources[1].windows[0].resetAt=boundary;}
    return {...overview,forecast:forecasts&&forecastSource?{[forecastSource]:forecasts.of(forecastSource,now).value}:{}};
  }};
  const agent={ingest:async(snapshots: {balances?:{amount:string}[]}[])=>{
    advance(200);
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
      const count=markFault?3:mark?.changes.filter(change=>change.at>probeFrom&&change.at<=now).length??0;
      const timed=count?[{node:'span[data-time=mark]',time:true,kind:'mark',region:'card:antigravity:measured',count}]:[];
      return{renders:[...own,...parts(),...timed],mutations:[...own,...parts(),...timed]};
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
  const context={Date:class extends Date {static now(){return now;}},path,createHash,DatabaseSync:Ledger,Requests,SHOWN_WITHIN:5000,MARGIN_MS,FADE_FOR,PULSE_FOR,dotOf,dotChangesAt,HISTORY_BYTES_PER_MEASUREMENT,Stop:Error,
    cards,people,creditSnapshot,stillSnapshot,overviewCards,quietAfter,stillProblems,cellOf,cellStart,chartProblems,creditRenderProblems,measuredProblems,say:()=>{},
    sleep:async(ms:number)=>{waits.push(ms);advance(ms);},drain:async()=>{advance(100);},
    selectMoney:async()=>{advance(50+setupDrift);},
  };
  const caller=declaration.getText(sourceFile);
  if(legacyFadeWait){
    const admission=context.quietAfter;
    context.quietAfter=(cards,from,to)=>{
      const quiet=admission(cards,from,to),fades=cards.filter(card=>card.id!==source&&card.successAt!==null)
        .map(card=>card.successAt!+PULSE_FOR+FADE_FOR).filter(at=>at>=from);
      if(!fades.length)return quiet;
      return {resets:quiet?.resets??[],forecasts:quiet?.forecasts??[],until:Math.max(quiet?.until??-Infinity,...fades.map(at=>at+MARGIN_MS))};
    };
  }
  const code=ts.transpileModule(caller+'\nglobalThis.phase=creditPhase;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  runInNewContext(code,context);
  const result=await (context as unknown as {phase:(demo:unknown,stand:unknown,cdp:unknown,evidence:unknown)=>Promise<{qualification:{from:number;to:number;waits:unknown[]};updates:{amount:string;from:number;to:number;renders:unknown[];mutations:unknown[]}[];problems:string[]}>}).phase({dir:'/unused'},stand,cdp,evidence);
  return{result,waits,boundary,forecastAt,worked,markChanges:mark?.changes??[]};
  } finally {mark?.close();forecastStore?.close();}
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
  const {result}=await phase({extraQuota:true,fadesIn:60_650});
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
  const {result,forecastAt}=await phase({forecastIn:1900});
  assert.ok(forecastAt!==null);
  assert.deepEqual(Array.from(result.problems),[]);assert.equal(result.qualification.waits.length,1);
  assert.equal(result.updates.length,4);assert.ok(result.updates.every(update=>update.from>forecastAt));
});

test('credit setup still rejects a reset introduced after the interval was qualified',async()=>{
  await assert.rejects(phase({baselineReset:true}),/baseline changes independently: claude:reset has a limit that resets/);
});

for(const fadesIn of [8000,40_000,55_400])test(`credit setup settles a reset without waiting for the ${fadesIn}ms dot clock`,async()=>{
  const {result,boundary}=await phase({fadesIn,resetIn:1900});
  assert.deepEqual(Array.from(result.problems),[]);
  assert.equal(result.updates.length,4);
  assert.equal(result.qualification.waits.length,1,'only the unrelated quota reset needs to settle');
  const started=Date.parse('2026-10-15T04:50:58Z');
  assert.ok(result.updates[0].from<started+fadesIn+MARGIN_MS);
  for(const update of result.updates)assert.ok(update.from>boundary+MARGIN_MS);
});

test('the previous complete-fade admission rejects the same natural clock fixture',async()=>{
  await assert.rejects(phase({fadesIn:60_650,legacyFadeWait:true}),/credit measurement has no quiet quota interval/);
});

test('the actual card mark fades during a credit update under the unchanged render budget',async()=>{
  const {result,markChanges}=await phase({fadesIn:60_650});
  assert.deepEqual(Array.from(result.problems),[]);
  assert.deepEqual(Array.from(result.updates,update=>update.amount),['2499','2498','2498','2498']);
  assert.equal(result.qualification.waits.length,0);
  assert.equal(markChanges.length,1,'one persistent clock subscription reaches its next real fade step');
  assert.deepEqual([markChanges[0].before,markChanges[0].after],[.3*.3,.2*.2]);
  const first=result.updates[0];assert.ok(first.from<markChanges[0].at&&markChanges[0].at<first.to);
  for(const parts of [first.renders,first.mutations]){
    const marks=parts.filter(part=>(part as {kind?:string}).kind==='mark') as {time:boolean;region:string;count:number}[];
    assert.deepEqual(marks.map(part=>[part.time,part.region,part.count]),[[true,'card:antigravity:measured',1]]);
  }
});

test('credit admission does not relax the frequency guard for a faulty mark',async()=>{
  const {result}=await phase({fadesIn:60_650,markFault:true});
  assert.equal(result.updates.length,4);
  assert.match(result.problems.join('\n'),/card:antigravity:measured .*rendered 3 times, more than 2/);
  assert.match(result.problems.join('\n'),/card:antigravity:measured .*changed 3 times, more than 2/);
});

for(const fadingStale of [false,true])test(`credit setup keeps its reset deadline and records the permitted dot state (stale=${fadingStale})`,async()=>{
  const failures:{name:string;value:{from:number;until:number;setupUntil:number;windowMs:number;resets:number[];fades:number[];forecasts:number[];waits:{until:number}[];fadingCards:{id:string;successAt:number;stale:boolean;warning:boolean;nextChangeAt:number|null}[]}}[]=[];
  await assert.rejects(phase({resetIn:40_000,secondResetIn:55_450,fadesIn:55_450,fadingStale},{save(name,value){failures.push({name,value:safeEvidence(value) as typeof failures[number]['value']});}}),/credit measurement has no quiet quota interval/);
  assert.equal(failures.length,1);
  assert.equal(failures[0].name,'credit-setup-failure');
  const failed=failures[0].value;
  assert.equal(failed.until,failed.setupUntil+1);
  assert.deepEqual(Array.from(failed.fades),[failed.until-MARGIN_MS-1]);
  assert.equal(failed.windowMs,40_400);
  assert.deepEqual(Array.from(failed.resets),[failed.until-MARGIN_MS-1]);
  assert.deepEqual(Array.from(failed.forecasts),[]);
  assert.deepEqual(Array.from(failed.waits,wait=>wait.until),[failed.from],'only the first completed reset wait is retained, not the failed wait');
  assert.equal(failed.fadingCards.length,1,'the target credit source must not enter the unrelated fade evidence');
  assert.equal(failed.fadingCards[0].id,'antigravity:measured');
  assert.equal(failed.fadingCards[0].successAt,failed.until-MARGIN_MS-1-PULSE_FOR-FADE_FOR);
  assert.equal(failed.fadingCards[0].stale,fadingStale);
  assert.equal(failed.fadingCards[0].warning,fadingStale);
  assert.equal(failed.fadingCards[0].nextChangeAt,fadingStale?null:failed.from+10_449);
});

test('an already faded measurement adds no setup wait',async()=>{
  const {result}=await phase({fadesIn:-1});
  assert.equal(result.qualification.waits.length,0);
  assert.deepEqual(Array.from(result.problems),[]);
});

test('credit setup admits a fade ending exactly at its opening boundary',async()=>{
  const {result}=await phase({fadesIn:400});
  assert.equal(result.qualification.waits.length,0);
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

test('a forecast entering after a quota reset cannot extend the shared credit setup deadline',async()=>{
  await assert.rejects(phase({resetIn:40_000,fadesIn:40_000,forecastIn:85_000}),/credit measurement has no quiet quota interval/);
});

test('credit phase qualifies after page preparation and waits when that setup approaches a forecast',async()=>{
  const {result,forecastAt}=await phase({forecastIn:50_000,setupDrift:10_000});
  assert.ok(forecastAt!==null);
  assert.deepEqual(Array.from(result.problems),[]);assert.equal(result.qualification.waits.length,1);
  assert.equal(result.updates.length,4);
  for(const update of result.updates)assert.ok(update.from>forecastAt+MARGIN_MS&&update.to<=result.qualification.to);
});
