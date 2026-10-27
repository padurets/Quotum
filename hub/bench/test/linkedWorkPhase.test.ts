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
import {Requests} from '../requests.js';

type Audit={events:string[];saved:Map<string,any>};
type Options={setupMs?:number;creditMs?:number;activity?:boolean;reads?:number;bytes?:number;financial?:boolean;ackMs?:number;invalidationMs?:number;retiring?:boolean;captureFails?:boolean;cleanupReportFails?:boolean;cleanupLinkFails?:boolean;checkerFails?:boolean;audit?:Audit};
/** Run the production phase, including its browser scripts, against a virtual clock and DOM. */
async function phase({setupMs=1500,creditMs=200,activity=true,reads=1,bytes=100,financial=false,ackMs=0,invalidationMs=0,retiring=false,captureFails=false,cleanupReportFails=false,cleanupLinkFails=false,checkerFails=false,audit={events:[],saved:new Map()}}:Options={}) {
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
  const listeners=new Map<string,((value:any)=>void)[]>(),body=JSON.stringify({basis:{run:'fixture',revision:'1',evaluatedAt:start,range:{from:start-86_400_000,to:start}},quota:{state:'complete',value:{chunks:[]}}});
  const emit=(name:string,value:unknown)=>{for(const listener of listeners.get(name)??[])listener(value);};
  const originalCommandFailure={method:'Runtime.evaluate',status:'failed'};
  const cdp={evaluate:async(script:string)=>{if(checkerFails&&calls===2&&script==='__quotumBench.read()')throw Error('original checker failed');return runInNewContext(script,browser);},
    on:(name:string,listener:(value:any)=>void)=>{const group=listeners.get(name)??[];group.push(listener);listeners.set(name,group);},
    snapshot:()=>({failure:originalCommandFailure}),at:(stage:string)=>{audit.events.push(stage);},
    send:async(method:string)=>{
      assert.equal(method,'Network.getResponseBody');assert.equal(calls,5,'all three credits and the cleanup report precede capture');
      assert.ok(audit.events.includes('cleanup-link'),'link cleanup precedes capture');assert.ok(audit.saved.has('linked-wallet'),'original verdict is saved before capture');
      audit.events.push(method);if(captureFails)throw Error('body capture unavailable');return{body,base64Encoded:false};
    }};
  const owner={base:'http://fixture',cookie:'fixture',get:async()=>({revision:'0',workAuthority:'new'}),post:async()=>({revision:'1',links:[{id:'rule'}]})};
  const demo={reportNow:async()=>{
    calls++;const at=now;
    if(calls===5){audit.events.push('cleanup-report');if(cleanupReportFails)throw Error('original cleanup report failed');}
    if(calls<=4)for(let index=0;index<reads;index++){
      const requestId=`${calls}:${index}`,wireBytes=index===0?bytes:0;
      emit('Network.requestWillBeSent',{requestId,type:'Fetch',request:{url:'http://fixture/api/boards/b/period',postData:JSON.stringify({selection:{mode:'live',periodMs:86_400_000},evaluatedAt:at,quota:{cell:'300000',from:String(at-300000),to:String(at+300000)},sessions:{cursor:'private-cursor'}})}});
      emit('Network.responseReceived',{requestId,response:{status:200,headers:{'content-length':String(body.length)}}});
      emit('Network.dataReceived',{requestId,encodedDataLength:body.length,dataLength:body.length});
      emit('Network.loadingFinished',{requestId,encodedDataLength:wireBytes});
    }
    if(calls===1)readyAt=now+setupMs;
    else if(calls<=4)updates.push({at,shown:at+creditMs});
    advance(ackMs);return at;
  }};
  const stand={set:SETS[0],people:new Map([[people(SETS[0])[0].id,owner]]),agents:new Map([['laptop',{trackClients:()=>{}}]])};
  const file=ts.createSourceFile('index.ts',readFileSync(new URL('../index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='workLinkedWallet');assert.ok(declaration);
  class Stop extends Error {at=now;reports=calls;}
  const context={Date:browser.Date,Requests,SHOWN_WITHIN:5000,Stop,people,randomUUID:()=> 'request',URL,fetch:async()=>{audit.events.push('cleanup-link');return{ok:!cleanupLinkFails};},console:{error:()=>{}},say:()=>{},
    activityCreditProblems,HISTORY_BYTES_PER_MEASUREMENT,renderProblems,sleep:async(ms:number)=>advance(ms),drain:async()=>advance(500)};
  runInNewContext(ts.transpileModule(declaration.getText(file)+'\nglobalThis.phase=workLinkedWallet;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const result=await (context as unknown as {phase:(...args:unknown[])=>Promise<{setup:{waitMs:number};reports:{at:number;activeMs:number}[];problems:string[];traffic:{originalCommandFailure:unknown;reports:{status:string;body?:{partition:number;decodedBytes:number}}[]}}>}).phase(demo,stand,cdp,source,{save:(name:string,value:unknown)=>{audit.events.push('save/'+name);audit.saved.set(name,structuredClone(value));}});
  return{result,calls,now,start,audit,originalCommandFailure};
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

test('linked wallet freezes all original verdicts and cleanup before three actual response partitions',async()=>{
  const {result,audit,originalCommandFailure}=await phase({bytes:HISTORY_BYTES_PER_MEASUREMENT+1});
  const original=audit.saved.get('linked-wallet');
  assert.equal(original.reports.length,3);assert.equal(original.problems.length,3);
  assert.ok(original.problems.every((problem:string)=>problem.includes(String(HISTORY_BYTES_PER_MEASUREMENT+1))));
  assert.deepEqual(Array.from(result.problems),original.problems);
  assert.deepEqual(result.traffic.originalCommandFailure,originalCommandFailure);
  assert.equal(audit.events.filter(event=>event==='Network.getResponseBody').length,3);
  assert.ok(audit.events.indexOf('cleanup-report')<audit.events.indexOf('cleanup-link'));
  assert.ok(audit.events.indexOf('cleanup-link')<audit.events.indexOf('save/linked-wallet'));
  assert.ok(audit.events.indexOf('save/linked-wallet')<audit.events.indexOf('Network.getResponseBody'));
  for(const report of result.traffic.reports){assert.equal(report.status,'complete');assert.equal(report.body!.partition,report.body!.decodedBytes);}
  assert.equal(JSON.stringify(audit.saved.get('linked-wallet-traffic').reports),JSON.stringify(result.traffic.reports));
  assert.equal(original.traffic.reports.length,3);
  for(const report of original.traffic.reports){assert.equal(report.reads[0].request.sections[0].cells,'read');assert.equal(report.reads[0].request.sessionsCursor,true);}
});

test('unavailable linked bodies retain the same saved original byte failures and timestamps',async()=>{
  const successful=await phase({bytes:4953}),unavailable=await phase({bytes:4953,captureFails:true});
  assert.deepEqual(JSON.parse(JSON.stringify(unavailable.result.reports)),JSON.parse(JSON.stringify(successful.result.reports)));
  assert.deepEqual(Array.from(unavailable.result.problems),Array.from(successful.result.problems));
  assert.equal(unavailable.result.problems.length,3);
  assert.deepEqual(unavailable.audit.saved.get('linked-wallet').reports,successful.audit.saved.get('linked-wallet').reports);
  assert.ok(unavailable.result.traffic.reports.every(report=>report.status==='insufficient-evidence'));
  assert.equal(unavailable.audit.events.filter(event=>event==='Network.getResponseBody').length,3);
});

for(const failure of ['checker','cleanup report','cleanup link'] as const)test('linked diagnostics cannot replace an original '+failure+' failure',async()=>{
  const audit:Audit={events:[],saved:new Map()};
  await assert.rejects(phase({audit,captureFails:true,checkerFails:failure==='checker',cleanupReportFails:failure==='cleanup report',cleanupLinkFails:failure==='cleanup link'}),new RegExp(failure==='cleanup link'?'could not remove its rule':'original '+failure+' failed'));
  assert.equal(audit.events.filter(event=>event==='Network.getResponseBody').length,0);
  assert.equal(audit.saved.has('linked-wallet-traffic'),false);
});
