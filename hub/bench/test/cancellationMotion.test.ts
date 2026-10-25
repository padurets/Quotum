import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createContext,runInContext,runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Pan} from '../../ui/lib/pan';
import {navigationAt} from '../../ui/lib/axisNavigation';
import {axisPresentationFixture} from '../../ui/test/axisPresentationFixture';
import * as budget from '../historyTrafficBudget';

const repoRoot=new URL('../../../',import.meta.url);
const source=(path:string)=>readFileSync(new URL(path,repoRoot),'utf8');
const browser=source('hub/bench/historyTrafficBrowser.ts'),axis=source('hub/ui/components/timeAxis.ts'),history=source('hub/ui/lib/history.ts');
function slice(source:string,start:string,end:string){const i=source.indexOf(start),j=source.indexOf(end,i);assert.ok(i>=0&&j>i,start);assert.equal(source.indexOf(start,i+start.length),-1,start+' unique');return source.slice(i,j);}
const sourceFile=ts.createSourceFile('historyTrafficBrowser.ts',browser,ts.ScriptTarget.Latest,true);
const passive=sourceFile.statements.find((n:any)=>ts.isFunctionDeclaration(n)&&n.name?.text==='passiveHistoryBinding')!.getText(sourceFile);
const stable=sourceFile.statements.find((n:any)=>ts.isFunctionDeclaration(n)&&n.name?.text==='stableHistoryReads')!.getText(sourceFile);
const readEvidence=sourceFile.statements.find((n:any)=>ts.isFunctionDeclaration(n)&&n.name?.text==='trafficReadEvidence')!.getText(sourceFile);
const caller=slice(browser,'export async function browserCancellationTraffic(','/** An instrumented replay');
const samplerAnchor='      const root=document.querySelector(\'[data-widget="quota-history"] .chart>svg\'),originalPush=history.pushState;';
const samplerAt=browser.indexOf(samplerAnchor);assert.ok(samplerAt>=0);assert.equal(browser.indexOf(samplerAnchor,samplerAt+1),-1);
const samplerLiteral=browser.slice(browser.lastIndexOf('`',samplerAt)+1,browser.indexOf('`',samplerAt));
assert.ok(!samplerLiteral.includes('${'),'literal sampler has no substitution');
const actualAxis=[slice(axis,'  const readPose = ','  useLayoutEffect(() => pan.register('),slice(axis,'  const paint = () => {','\n  useLayoutEffect(() => {\n    const unsubscribe'),slice(axis,'  useLayoutEffect(() => pan.onStop(stop => {','  useEffect(() => () => {\n    foldTicket.current++')].join('\n');
const follow=slice(history,'export function followPan(','\nif (typeof window');
// The old counterfactual changes only this boundary; current header/evidence guards stay real.
const boundary=caller.split('\n').find(line=>line.includes("await step('first request'"))!;
assert.ok(boundary.includes('poses.some'));
const oldCaller=caller.replace(boundary,"        await step('first request', () => until(() => reads()[0]?.attemptId !== undefined && proxy.transfers.some(t => t.id === reads()[0].attemptId)));");
const transpile=(s:string)=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const StopAfterFirst=new Error('STOP_AFTER_FIRST_COMPLETED_COHORT');

type Mode={candidate?:boolean,order?:'probe-first'|'production-first',suppressPaint?:boolean,noInput?:boolean,headers?:'before-cancel'|'during-escape',extraFinalPoses?:boolean};
async function run(mode:Mode){
  const DAY=86400000,now=100*DAY,width=270,cell=300000,order:string[]=[],frames=new Map<number,{fn:()=>void;kind:string}>();
  let serial=0,clock=0,selected:any=null,pageCount=0,requestStarted=false,painted=false,escaped=false,pending=false,observerClosed=0,pageClosed=0,extraTimer=false;
  const requestFrame=(fn:()=>void,kind='production')=>{const id=++serial;frames.set(id,{fn,kind});return id;};
  const cancelFrame=(id:any)=>frames.delete(id);
  const batch=(ordering=mode.order??'probe-first')=>{const work=[...frames];for(const [id]of work)frames.delete(id);if(ordering==='production-first')work.sort((a,b)=>Number(a[1].kind==='probe')-Number(b[1].kind==='probe'));for(const [,task]of work){order.push('raf:'+task.kind);task.fn();}};
  const pan=new Pan({now:()=>now,commit:range=>{selected=range;pageContext.history.pushState({},'','?from=1');},requestFrame:fn=>requestFrame(fn),cancelFrame,setTimeout:()=>{extraTimer=true;throw Error('shift-held gesture must not create commit timer');},clearTimeout:()=>{}},()=>1000+clock);
  const fixture=axisPresentationFixture({from:now-DAY,to:now,end:now},{context:'test',range:'live'},600,.5,40,20),chart={current:Symbol('chart')};
  const ctx:any=fixture.context;
  Object.assign(ctx,{pan,source:chart,navigationAt,folding:false,panPointer:{current:null},wheelBounds:{current:null},requestAnimationFrame:(fn:()=>void)=>requestFrame(fn,'final'),cancelAnimationFrame:cancelFrame,useLayoutEffect:(fn:()=>unknown)=>fn(),present:()=>{}});
  Object.assign(ctx.svg.current.classList,{contains:(n:string)=>fixture.classes.has(n),add:(n:string)=>fixture.classes.add(n),remove:(n:string)=>fixture.classes.delete(n)});
  Object.assign(ctx.box.current,{querySelector:()=>fixture.slides[0],querySelectorAll:(s:string)=>s==='.plot-move'?fixture.layers:fixture.slides});
  runInNewContext(transpile(actualAxis),ctx);
  const paint=ctx.paintPan.current;
  pan.subscribe(()=>{const frame=pan.get();if(mode.suppressPaint&&frame&&frame.to<frame.originEnd){order.push('paint:suppressed');return;}paint();if(frame&&frame.to<frame.originEnd){painted=true;order.push('paint:moved');}});
  pan.register(chart.current,()=>({end:now,future:DAY}));
  const reads:any[]=[],transfers:any[]=[],attempts:any={};
  const bodies:any={phase:'',activeCount:0,pending:new Set(),errors:[],reads,get resources(){return reads;}};
  const proxy={transfers,phase:(_p:string,latency:number)=>{assert.equal(latency,400);},settled:async()=>{assert.equal(pending,false);}};
  const followContext:any={};runInNewContext(transpile(follow.replace('export function','function')+'\nglobalThis.follow=followPan;'),followContext);
  followContext.follow({scope:'quota',pan(frame:any){if(frame.direction===0||requestStarted)return;assert.ok(frame.from<now-DAY);requestStarted=true;pending=true;bodies.activeCount=1;order.push('http:first-request-pending');const id='fixture:1';attempts[id]={aborted:false};reads.push({id,attemptId:id,selection:'quota',phase:bodies.phase,from:frame.from,to:frame.to,cell,count:{complete:false,lower:0,id},canceled:false});transfers.push({id,phase:bodies.phase,started:clock,sent:false,finished:false,aborted:false});},endPan(committed:boolean){if(!requestStarted||committed)return;pending=false;bodies.activeCount=0;reads[0].canceled=true;transfers[0].aborted=true;attempts['fixture:1'].aborted=true;order.push('http:aborted-before-headers');}},pan,()=>selected);
  const pageContext:any=createContext({document:{querySelector:()=>ctx.svg.current},history:{pushState(){}},location:{search:''},URLSearchParams,requestAnimationFrame:(fn:()=>void)=>requestFrame(fn,'probe'),__quotumHistoryAttempts:attempts});pageContext.window=pageContext;
  runInContext(samplerLiteral,pageContext);
  const saved=new Map<string,any>();
  const cdp={at(value:string){order.push('stage:'+value.split('/').at(-1));},snapshot(){return {pending:[],failure:null,terminal:null};},async send(method:string,p:any){
    if(method==='Input.dispatchMouseEvent'){
      if(mode.noInput){order.push('input:suppressed');return;}
      assert.equal(p.type,'mouseWheel');assert.equal(p.modifiers,8);assert.equal(p.deltaX,-width*.1);
      assert.equal(pan.wheel({source:chart.current,selected,now,length:DAY,historyStart:0,span:2*DAY,width}, {deltaX:p.deltaX,deltaY:0,deltaMode:0,cancelable:true,shiftKey:true,timeStamp:1000+clock}),true);
      order.push('input:accepted');batch();if(mode.headers==='before-cancel')transfers[0].sent=true;return;
    }
    if(p.key==='Shift'){pan.setShift(p.type==='keyDown');return;}
    if(p.key==='Escape'&&p.type==='keyDown'){escaped=true;if(mode.headers==='during-escape')transfers[0].sent=true;order.push('escape');pan.cancel();}
  },async evaluate(expression:string){
    if(expression==='new Promise(resolve=>setTimeout(resolve,10))'){clock+=10;batch();return;}
    if(mode.extraFinalPoses&&expression.startsWith('({tokens:')){for(let i=0;i<130;i++)pageContext.__historyTraffic.poses.push({end:now-i,origin:now});pageContext.__historyTraffic.poses.push({end:now,origin:now});pageContext.__historyTraffic.poses[10]={end:NaN,origin:now};}
    return structuredClone(runInContext(expression,pageContext));
  }};
  const exports:any={...budget,DAY,createHash,console:{error(){}},assert,Date:{now:()=>clock},process:{env:{}},observeReversal:async()=>({watch:async(_s:string,f:()=>unknown)=>f(),close:async()=>{observerClosed++;}}),historyPage:async()=>{
    if(pageCount++)throw StopAfterFirst;
    return {cdp,bodies,settled:async()=>batch(),geometry:{x:100,y:80,width,series:12},cell,seeds:new Map([['quota',{answer:{run:'fixture',known:{}}}]]),close:async()=>{pageContext.__historyTraffic.running=false;pan.cancel();if(pending){pending=false;bodies.activeCount=0;reads[0].canceled=true;transfers[0].aborted=true;attempts['fixture:1'].aborted=true;order.push('http:owned-page-close');}frames.clear();pageClosed++;}};
  }};
  const exactCaller=mode.candidate===false?oldCaller:caller;
  runInNewContext(transpile(passive+'\n'+stable.replace('export function','function')+'\n'+readEvidence.replace('export function','function')+'\n'+exactCaller.replace('export async function','async function')+'\nglobalThis.execute=browserCancellationTraffic;'),exports);
  let failure:any=null,completed=false;
  try{await exports.execute({},proxy,'fixture-cookie',false,false,{save:(name:string,value:any)=>saved.set(name,structuredClone(value))});assert.fail('finite first-cohort stop expected');}
  catch(error){if(error===StopAfterFirst)completed=true;else failure=error;}
  const receipt=saved.get('traffic-browser-1d-before-headers-take1'),state=structuredClone({tokens:pageContext.__historyTraffic.tokens,poses:pageContext.__historyTraffic.poses,pushes:pageContext.__historyTraffic.pushes,running:pageContext.__historyTraffic.running});
  assert.equal(pageClosed,1);assert.equal(observerClosed,1);assert.equal(frames.size,0);assert.equal(pending,false);assert.equal(extraTimer,false);
  return {mode,completed,error:failure?{message:String(failure),cause:String(failure.cause)}:null,requestStarted,painted,escaped,virtualMs:clock,order,state,receipt,cleanup:{pageClosed,observerClosed,pending,frames:frames.size},httpScope:'stand-in request/admission/abort driven by actual followPan; no browser/HTTP server'};
}


// Only deterministic scheduling and HTTP admission/abort are stand-ins. Pan, axis paint,
// the sampler, followPan and the full first cancellation caller/assertions are actual source.
test('an early probe can lose an actual painted pose; reversing only RAF order observes it',async()=>{
  const missed=await run({candidate:false}),seen=await run({candidate:false,order:'production-first'});
  assert.equal(missed.completed,false);assert.equal(missed.painted,true);assert.equal(missed.requestStarted,true);assert.equal(missed.escaped,true);
  assert.equal(missed.receipt.stage,'read final state');assert.match(missed.error!.cause,/AssertionError/);
  assert.equal(missed.state.tokens.length,1);assert.equal(missed.state.poses.some((p:any)=>p.end<p.origin),false);
  assert.equal(seen.completed,true);assert.equal(seen.receipt.reports[0].aborted,1);
  assert.equal(missed.receipt.movement.tokenCount,1);assert.equal(missed.receipt.movement.poses.length,1);
  assert.equal(missed.receipt.movement.pushes,0);assert.equal(missed.receipt.movement.selected,false);
  assert.deepEqual(missed.receipt.geometry,{x:100,y:80,width:270,series:12});
  assert.equal(Object.hasOwn(missed.receipt.movement,'tokens'),false);
  assert.ok(missed.receipt.movement.poses.every((p:any)=>Number.isFinite(p.end)&&Number.isFinite(p.origin)));
});
for(const order of ['probe-first','production-first'] as const)test(`movement is observed before Escape with ${order}`,async()=>{
  const result=await run({order});assert.equal(result.completed,true);assert.equal(result.painted,true);
  assert.equal(result.virtualMs,order==='probe-first'?10:0);
  assert.equal(result.receipt.transfers[0].sent,false);assert.equal(result.receipt.transfers[0].aborted,true);
  assert.equal(result.receipt.reports[0].aborted,1);assert.equal(result.receipt.reports[0].movement.pushes,0);
  assert.equal(result.receipt.movement.selected,false);
});
for(const fault of ['suppressPaint','noInput'] as const)test(`${fault} cannot pass the existing first-request deadline`,async()=>{
  const result=await run({[fault]:true});assert.equal(result.completed,false);assert.match(result.error!.cause,/lifecycle boundary not reached/);
  assert.equal(result.virtualMs,10010);assert.equal(result.painted,false);assert.equal(result.escaped,false);
  assert.equal(result.requestStarted,fault==='suppressPaint');
});
test('headers sent before cancellation fail the actual caller precondition',async()=>{
  const result=await run({headers:'before-cancel'});assert.equal(result.completed,false);assert.equal(result.escaped,false);
  assert.match(result.error!.cause,/before-headers cancellation request no longer pending/);
});
test('headers sent inside Escape dispatch fail the actual caller postcondition',async()=>{
  const result=await run({headers:'during-escape'});assert.equal(result.completed,false);assert.equal(result.escaped,true);
  assert.match(result.error!.cause,/before-headers cancellation must precede response headers/);
  assert.equal(result.receipt.transfers[0].sent,true);assert.equal(result.receipt.transfers[0].aborted,true);
});
test('saved final poses are numeric, bounded and explicit about omitted or invalid entries',async()=>{
  const result=await run({extraFinalPoses:true});assert.equal(result.completed,true);
  const movement=result.receipt.movement;assert.equal(movement.poses.length,128);assert.equal(movement.posesOmitted,5);assert.equal(movement.invalidPoses,1);
  assert.equal(Object.hasOwn(movement,'tokens'),false);assert.equal(movement.poses[10].end,null);
});
