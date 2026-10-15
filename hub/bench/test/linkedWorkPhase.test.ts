import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {SETS} from '../../demo/catalogue.js';
import {people} from '../../demo/model.js';
import {activityCreditProblems,HISTORY_BYTES_PER_MEASUREMENT,renderProblems} from '../budget.js';
import type {Counted} from '../probe.js';

type Options={setupMs?:number;creditMs?:number;activity?:boolean;reads?:number;bytes?:number;financial?:boolean;ackMs?:number};
/** Run the production phase, including its browser scripts, against a virtual clock and DOM. */
async function phase({setupMs=1500,creditMs=200,activity=true,reads=1,bytes=100,financial=false,ackMs=0}:Options={}) {
  const start=Date.parse('2026-10-15T04:50:58Z'),source='openrouter:linked';
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
  const work=()=>now>=readyAt?{getAttribute:()=>String(value())}:null;
  const totals=()=>now>=readyAt?{getAttribute:()=>String(100+(activity?value():0))}:null;
  const group={getAttribute:(name:string)=>name==='data-series'?source+' balance':'1:56400000',querySelectorAll:()=>[{getAttribute:()=>financialChanged()?'changed':'stable'}]};
  const document={body:{},getAnimations:()=>[],querySelector:(selector:string)=>{
    if(selector.startsWith('[data-work-source='))return work();
    if(selector==='.activity-totals')return totals();
    if(selector.includes('is-loading'))return now<readyAt?{}:null;
    return null;
  },querySelectorAll:(selector:string)=>selector.includes('[data-series]')?[group]:selector==='[data-work-source]'?(work()?[work()]:[]):[]};
  const activityPart:Counted={node:'section.activity',region:'analytics',widget:'activity',time:false,kind:null,count:1};
  const financialPart:Counted={node:'section.budget-history',region:'analytics',widget:'budget',time:false,kind:null,count:1};
  const read=()=>({renders:[...(activity&&updates.some(update=>update.at>=probeFrom&&update.shown<=now)?[activityPart]:[]),...(financialChanged()?[financialPart]:[])],mutations:[]});
  const browser={document,Date:class extends Date {static now(){return now;}},MutationObserver:class {
    constructor(private notify:()=>void){}
    observe(){observers.add(this.notify);}
    disconnect(){observers.delete(this.notify);}
  },__quotumBench:{reset:()=>{probeFrom=now;},read},localStorage:{getItem:()=>null},URLSearchParams,location:{search:''},window:{} as Record<string,unknown>};
  browser.window=browser;
  const cdp={evaluate:async(script:string)=>runInNewContext(script,browser)};
  class Requests {
    counting=false;historyRequests=reads;historyBytes=bytes;
    private initial=calls===0;
    get historyPending(){return this.initial&&now<readyAt?1:0;}
  }
  const owner={base:'http://fixture',cookie:'fixture',get:async()=>({revision:'0'}),post:async()=>({revision:'1',links:[{id:'rule'}]})};
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
