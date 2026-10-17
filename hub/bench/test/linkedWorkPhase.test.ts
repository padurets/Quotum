import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {SETS} from '../../demo/catalogue.js';
import {people} from '../../demo/model.js';
import {activityCreditProblems,HISTORY_BYTES_PER_MEASUREMENT,renderProblems} from '../budget.js';
import type {Counted} from '../probe.js';
import {PeriodActivity} from '../../server/domain/periodActivity.js';
import type {WorkTrace} from '../../server/domain/periodWork.js';

type Options={setupMs?:number;creditMs?:number;activity?:boolean;reads?:number;bytes?:number;financial?:boolean;ackMs?:number;invalidationMs?:number;retiring?:boolean};
/** Run the production phase, including its browser scripts, against a virtual clock and DOM. */
async function phase({setupMs=1500,creditMs=200,activity=true,reads=1,bytes=100,financial=false,ackMs=0,invalidationMs=0,retiring=false}:Options={}) {
  const start=Date.parse('2026-10-15T04:50:58Z'),source='openrouter:linked';
  const invalidatedAt=start+invalidationMs;
  let now=start,readyAt=Infinity,probeFrom=now,calls=0;
  const updates:{at:number;shown:number}[]=[],observers=new Set<()=>void>();
  const advance=(ms:number)=>{
    const until=now+Math.max(0,ms);
    for(const at of updates.map(update=>update.shown).filter(at=>at>now&&at<=until).sort((a,b)=>a-b)){
      now=at;for(const notify of observers)notify();
    }
    now=until;
  };
  const value=()=>updates.filter(update=>update.shown<=now).length*500;
  const financialChanged=()=>financial&&updates.some(update=>update.at>=probeFrom&&update.at+1200<=now);
  const loading=()=>now>=invalidatedAt&&now<readyAt;
  const work=()=>!loading()?{getAttribute:()=>String(value())}:null;
  const totals=()=>!loading()?{getAttribute:()=>String(100_000+(activity?value():0)-(retiring?value()*12:0))}:null;
  const project=()=>!loading()&&activity&&value()>0?{getAttribute:()=>String(value())}:null;
  const group={getAttribute:(name:string)=>name==='data-series'?source+' balance':'1:56400000',querySelectorAll:()=>[{getAttribute:()=>financialChanged()?'changed':'stable'}]};
  const document={body:{},getAnimations:()=>[],querySelector:(selector:string)=>{
    if(selector.startsWith('[data-work-source='))return work();
    if(selector==='.activity-totals')return totals();
    if(selector.startsWith('.activity [data-series-key='))return project();
    if(selector.includes('is-loading'))return loading()?{}:null;
    return null;
  },querySelectorAll:(selector:string)=>selector.includes('[data-series]')?[group]:selector==='[data-work-source]'?(work()?[work()]:[]):[]};
  const activityPart:Counted={node:'section.activity',region:'analytics',widget:'activity',time:false,kind:null,count:1};
  const financialPart:Counted={node:'section.budget-history',region:'analytics',widget:'budget',time:false,kind:null,count:1};
  const read=()=>({renders:[...(activity&&updates.some(update=>update.at>=probeFrom&&update.shown<=now)?[activityPart]:[]),...(financialChanged()?[financialPart]:[])],mutations:[]});
  const browser={document,Date:class extends Date {static now(){return now;}},MutationObserver:class {
    constructor(private notify:()=>void){}
    observe(){observers.add(this.notify);}
    disconnect(){observers.delete(this.notify);}
  },__quotumWalletState:(_source:string,authority:string)=>({authorityReady:now>=invalidatedAt&&authority==='new',periodLoading:loading(),workNeeded:loading(),work:work()?{activeMs:value()}:null}),
  __quotumBench:{reset:()=>{probeFrom=now;},read},localStorage:{getItem:()=>null},URLSearchParams,location:{search:''},window:{} as Record<string,unknown>};
  browser.window=browser;
  const cdp={evaluate:async(script:string)=>runInNewContext(script,browser)};
  class Requests {
    counting=false;historyRequests=reads;historyBytes=bytes;
    private initial=calls===0;
    get historyPending(){return this.initial&&loading()?1:0;}
  }
  const owner={base:'http://fixture',cookie:'fixture',get:async()=>({revision:'0',workAuthority:'new'}),post:async()=>({revision:'1',links:[{id:'rule'}]})};
  const demo={reportNow:async()=>{
    calls++;const at=now;
    if(calls===1)readyAt=now+setupMs;
    else if(calls<=4)updates.push({at,shown:at+creditMs});
    advance(ackMs);return at;
  }};
  const stand={set:SETS[0],people:new Map([[people(SETS[0])[0].id,owner]]),agents:new Map([['laptop',{trackClients:()=>{}}]])};
  const file=ts.createSourceFile('index.ts',readFileSync(new URL('../index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='workLinkedWallet');assert.ok(declaration);
  class Stop extends Error {at=now;reports=calls;}
  const context={Date:browser.Date,Requests,SHOWN_WITHIN:5000,Stop,people,randomUUID:()=> 'request',URL,fetch:async()=>({ok:true}),console:{error:()=>{}},say:()=>{},
    activityCreditProblems,HISTORY_BYTES_PER_MEASUREMENT,renderProblems,sleep:async(ms:number)=>advance(ms),drain:async()=>advance(500)};
  runInNewContext(ts.transpileModule(declaration.getText(file)+'\nglobalThis.phase=workLinkedWallet;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const result=await (context as unknown as {phase:(...args:unknown[])=>Promise<{setup:{waitMs:number};reports:{at:number;activeMs:number}[];problems:string[]}>}).phase(demo,stand,cdp,source);
  return{result,calls,now,start};
}

test('linked wallet qualifies a cold baseline separately from three work credits',async()=>{
  const {result}=await phase();
  assert.deepEqual(Array.from(result.problems),[]);
  assert.equal(result.reports.length,3);
  assert.ok(result.setup.waitMs>=1500&&result.setup.waitMs<=5000);
});

test('linked wallet cannot qualify a stale ready row before the new authority arrives',async()=>{
  const {result}=await phase({invalidationMs:100});
  assert.deepEqual(Array.from(result.problems),[]);
  assert.ok(result.setup.waitMs>=1500);
});

test('linked wallet observes its Activity project even while old board work expires',async()=>{
  const {result}=await phase({retiring:true});
  assert.deepEqual(Array.from(result.problems),[]);
  assert.equal(result.reports.length,3);
});

test('the production Activity curve credits a project while the rolling board total decreases',()=>{
  const period=86_400_000,now=period+60_000,from=now-period;
  const refs=Array.from({length:13},(_,i)=>({ref:String(i),source:i===12?'wallet':'old',device:{id:String(i),name:'Device'},origin:'terminal' as const,project:i===12?'Linked benchmark':'Old '+i,folder:null,startedAt:0}));
  const trace:WorkTrace={anchor:0,knownFrom:0,cut:now+1000,refs,spans:[...Array.from({length:12},(_,i)=>[i,from-60_000,from+60_000] as [number,number,number]),[12,now,now+1000]]};
  const activity=new PeriodActivity(trace),before=activity.summary({from,to:now},'project'),after=activity.summary({from:from+1000,to:now+1000},'project');
  assert.equal(after.agentMs-before.agentMs,-11_000);
  assert.equal(after.by.project.find(group=>group.key===JSON.stringify('Linked benchmark'))?.agentMs,1000);
  assert.equal(activity.summary({from,to:now+1000},'project').agentMs-before.agentMs,1000);
});

test('linked wallet never-ready baseline fails within the existing setup bound',async()=>{
  await assert.rejects(phase({setupMs:6000}),(error:Error&{at:number;reports:number})=>{
    assert.match(error.message,/linked wallet.*(ready|visible)/);
    assert.equal(error.reports,1,'no measured report starts');
    assert.equal(error.at-Date.parse('2026-10-15T04:50:58Z'),5000);
    return true;
  });
});

test('linked wallet rejects a credit arriving during the post-measurement drain',async()=>{
  const {result}=await phase({setupMs:0,creditMs:1200});
  assert.ok(result.problems.some(problem=>problem.includes('active time')));
});

test('linked wallet measures from the report timestamp, including acknowledgement delay',async()=>{
  const {result}=await phase({setupMs:0,creditMs:1200,ackMs:1400});
  assert.ok(result.problems.some(problem=>problem.includes('active time')));
});

test('linked wallet preserves an on-time DOM credit even when acknowledgement is delayed',async()=>{
  const {result}=await phase({setupMs:0,creditMs:200,ackMs:1400});
  assert.deepEqual(Array.from(result.problems),[]);
});

test('linked wallet requires Activity growth independently of wallet work',async()=>{
  const {result}=await phase({activity:false});
  assert.ok(result.problems.some(problem=>problem.includes('Activity')));
});

for(const options of [{reads:2},{bytes:HISTORY_BYTES_PER_MEASUREMENT+1},{financial:true}])test('linked wallet retains traffic and financial isolation guards '+JSON.stringify(options),async()=>{
  const {result}=await phase(options);assert.ok(result.problems.length>0);
});
