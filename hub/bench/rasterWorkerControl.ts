import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Demo,addressOf,prepare} from '../demo/index.js';
import {SETS} from '../demo/catalogue.js';
import {people} from '../demo/model.js';
import type {Snapshot} from '../server/projection.js';
import {Cdp,findChrome,launchChrome,openTab,type Browser} from './cdp.js';
import {deadline,devtoolsJson} from './deadline.js';
import {Evidence,clientIdentity} from './evidence.js';
import {panningSet,seedPanningBudgets} from './fixture.js';
import {panning} from './panning.js';
import {probeScript} from './probe.js';
import {percentile} from './budget.js';
import {RunOwner} from './runOwner.js';
import {ScriptBinding} from './scriptBinding.js';
import {fixtureTiming,overviewCards,warmUntil} from './still.js';
import {hear,type Heard} from './stream.js';

const evidence=new Evidence(),root=path.resolve(import.meta.dirname,'../..'),abort=new AbortController();
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fail=(error:unknown)=>({name:error instanceof Error?error.name:'Error',reason:error instanceof Error?error.message:'Unavailable error'});
const source=process.env.QUOTUM_BENCH_SOURCE_SHA,expected=process.env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256;
const sourceFiles=['hub/bench/rasterWorkerControl.ts','hub/bench/panning.ts','hub/bench/panningBudget.ts','hub/bench/panEvidence.ts','hub/bench/panningReload.ts','hub/bench/panningFailure.ts','hub/bench/reversalDiagnostic.ts','hub/bench/probe.ts','hub/bench/budget.ts','hub/bench/deadline.ts','hub/bench/chrome.ts','hub/bench/cdp.ts','hub/bench/browserProcess.ts','hub/bench/runOwner.ts','hub/bench/scriptBinding.ts','hub/bench/evidence.ts','hub/bench/fixture.ts','hub/bench/still.ts','hub/bench/stream.ts','hub/demo/index.ts','hub/demo/model.ts','hub/demo/setup.ts','hub/demo/catalogue.ts','hub/ui/lib/prepare.ts','hub/server/domain/history.ts'];
const pins=()=>sourceFiles.map(name=>{const bytes=readFileSync(path.join(root,name));return {name,bytes:bytes.length,sourceHash:hash(bytes)};});
let originalPins:ReturnType<typeof pins>=[];
const guard=()=>{assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source);assert.deepEqual(pins(),originalPins);};
let owner:RunOwner|undefined,demo:Demo|undefined,heard:Heard|undefined,temporary:string|undefined,emergency:Promise<unknown>|undefined;
let stopped=false,completed=0,budgetFailures=0,cohort:unknown,geometry:unknown,browserIdentity:unknown;
const summaries:{name:string;forced:boolean;p95:number;p99:number;input95:number;budgetFailures:number}[]=[];
const cancel=()=>{abort.abort(Error('Raster control cancelled or eighteen-minute deadline'));emergency??=(async()=>{await owner?.close();await demo?.stop();})().catch(error=>evidence.save('emergency-cleanup',fail(error)));};
const timer=setTimeout(cancel,18*60_000);
for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.once(signal,cancel);
const geometrySource=`(()=>({widgets:[...document.querySelectorAll('.widget')].map((e,index)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {index,hidden:s.display==='none',order:Number(s.order),x:r.x,y:r.y,width:r.width,height:r.height};}),charts:['quota-history','quota-session-history','activity','budget-history','subscription-funds'].map(id=>{const e=document.querySelector('[data-widget="'+id+'"] .chart>svg');if(!e)throw Error('Missing chart geometry');const r=e.getBoundingClientRect(),v=e.viewBox.baseVal;return {x:r.x,y:r.y,width:r.width,height:r.height,viewX:v.x,viewY:v.y,viewWidth:v.width,viewHeight:v.height};})}))()`;

// SystemInfo identifies renderers; only a sole owned renderer identifies this page without tracing.
async function inventory(browser:Browser,parent:AbortSignal){
  let control:Cdp|undefined;
  try{return await deadline(5000,async signal=>{
    const identities=await browser.observeProcesses!(signal),owned=new Map(identities.map(row=>[row.pid,row.birth]));
    const version=await devtoolsJson(browser.endpoint+'/json/version',signal) as {webSocketDebuggerUrl:string};
    control=await Cdp.connect(version.webSocketDebuggerUrl,signal);
    const info=await control.send<{processInfo:{type:string;id:number}[]}>('SystemInfo.getProcessInfo',{},signal);
    const renderers=info.processInfo.filter(row=>row.type==='renderer'&&owned.has(row.id)),ids=renderers.map(row=>row.id);
    const raw=await browser.diagnostics!(ids,undefined,signal) as {processes:{pid:number;state:string[];threads:{id:number;state:string[]}[]}[]};
    const after=new Map((await browser.observeProcesses!(signal)).map(row=>[row.pid,row.birth]));
    const rows=raw.processes.map(row=>{const total=Number(row.state.find(s=>s.startsWith('Threads:'))?.split(':')[1]),names=row.threads.map(t=>t.state.find(s=>s.startsWith('Name:'))?.split(':')[1].trim());return {pid:row.pid,birth:owned.get(row.pid),declaredThreads:Number.isSafeInteger(total)?total:null,inspectedThreads:row.threads.length,tileWorkerTotal:names.filter(name=>name==='CompositorTileW'||name==='CompositorTileWorker').length,complete:owned.get(row.pid)===after.get(row.pid)&&Number.isSafeInteger(total)&&total===row.threads.length&&total<50&&names.every(Boolean)};});
    const exact=renderers.length===1&&ids.length<=32&&rows.length===1&&rows[0].pid===ids[0]&&rows[0].complete;
    return {status:exact?'complete':'unknown',rendererPid:exact?ids[0]:null,tileWorkerTotal:exact?rows[0].tileWorkerTotal:null,rendererCandidates:ids.length,rows,native:'Matching truncated kernel names include background workers; no foreground N claim; caps and ambiguous renderer ownership remain unknown'};
  },parent);}catch(error){return {status:'unknown',rendererPid:null,tileWorkerTotal:null,...fail(error)};}finally{control?.close();}
}

try{
  assert.equal(process.platform,'linux');assert.ok(process.env.CI);assert.ok(process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR);
  assert.match(source??'',/^[a-f0-9]{40}$/);assert.match(expected??'',/^[a-f0-9]{64}$/);originalPins=pins();guard();
  const client=clientIdentity();assert.ok(client.status==='available'&&client.sha256===expected);
  const chrome=findChrome(process.env);assert.ok(chrome&&path.isAbsolute(chrome));const executableHash=hash(readFileSync(chrome));
  evidence.save('source',{sha:source,tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim(),pins:originalPins,client:{...client,clientHash:client.sha256},executableHash,mode:'forced1-default-default-forced1',native:'Diagnostic Activity24 only; idle/update prefix skipped; not canonical acceptance'});
  temporary=mkdtempSync(path.join(os.tmpdir(),'quotum-raster-control-'));
  const wrapper=path.join(temporary,'chrome-default'),quoted="'"+chrome.replaceAll("'","'\"'\"'")+"'";
  writeFileSync(wrapper,'#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  if [[ "$arg" != "--num-raster-threads=1" ]]; then args+=("$arg"); fi\ndone\nexec '+quoted+' "${args[@]}"\n',{mode:0o700,flag:'wx'});
  evidence.save('wrapper',{wrapperHash:hash(readFileSync(wrapper)),native:'Removes only the exact raster flag; exec preserves the owned process identity'});
  const port=await new Promise<number>((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const value=probe.address();assert.ok(value&&typeof value!=='string');probe.close(error=>error?reject(error):resolve(value.port));});});
  const address=addressOf({...process.env,QUOTUM_BIND:'127.0.0.1',QUOTUM_PORT:String(port)});await prepare(address);
  const set=panningSet(SETS[0]),timing=fixtureTiming(Date.now());evidence.save('fixture-timing',timing);
  demo=new Demo({set,scene:set.scene,still:true,idleAgents:true,money:false,start:timing.start,address,onExit:cancel});
  const stand=await demo.run();abort.signal.throwIfAborted();seedPanningBudgets(path.join(demo.dir,'quotum.sqlite'),stand);
  const ana=stand.people.get(people(set)[0].id)!;heard=await hear(address.base,ana.cookie,ana.personalBoard);
  for(const [name,forced] of [['a1',true],['b1',false],['b2',false],['a2',true]] as const){
    guard();abort.signal.throwIfAborted();assert.equal(hash(readFileSync(chrome)),executableHash);
    evidence.begin(name);owner=new RunOwner();let browser:Browser|undefined,binding:ScriptBinding|undefined,armError:unknown,lastBinding:unknown,preflight=false,reading:Awaited<ReturnType<typeof panning>>|undefined;
    try{
      browser=await owner.start(signal=>launchChrome(forced?chrome:wrapper,false,AbortSignal.any([abort.signal,signal]),report=>evidence.save(name+'-launch',report)));
      const activeBrowser=browser;
      const tab=await openTab(browser),cdp=tab.cdp,signal=AbortSignal.any([abort.signal,owner.signal]);
      binding=new ScriptBinding(cdp,client,(file,value)=>{evidence.save(name+'-'+file,value);if(file.startsWith('source-family-'))lastBinding=value;});
      const bind=async()=>{await binding!.afterFamily([], 'after-family',signal);assert.ok((lastBinding as {status:string;debuggerDisabled:boolean})?.status==='complete'&&(lastBinding as {debuggerDisabled:boolean}).debuggerDisabled);};
      await cdp.send('Page.enable',{},signal);await cdp.send('Network.enable',{},signal);await cdp.send('Performance.enable',{},signal);
      await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},signal);
      const split=ana.cookie.indexOf('=');await cdp.send('Network.setCookie',{name:ana.cookie.slice(0,split),value:ana.cookie.slice(split+1),url:address.base,httpOnly:true,sameSite:'Lax'},signal);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('quotum.locale','en');localStorage.setItem('quotum.prefs',JSON.stringify({...JSON.parse(localStorage.getItem('quotum.prefs')||'{}'),agentsSort:{column:'project',descending:false}}));`+probeScript()},signal);
      await cdp.send('Page.navigate',{url:address.base},signal);
      await deadline(30_000,async pending=>{while(!await cdp.evaluate<boolean>(`document.querySelectorAll('.card:not(.is-loading)').length>0&&!!document.querySelector('.agent-hours-heatmap[data-calendar-ready="true"]')`,pending))await sleep(100,undefined,{signal:pending});},signal);
      const opened=Date.now();await bind();
      await cdp.evaluate(`(async()=>{const t=document.querySelector('.filter-toggle > button');if(t?.getAttribute('aria-expanded')==='false')t.click();await new Promise(requestAnimationFrame);if(!document.querySelector('.analytics-head:not([hidden]) .period'))throw Error('Shared filters did not open');})()`,signal);
      const warm=Math.max(warmUntil(await overviewCards(request=>ana.get<Snapshot>(request),ana.personalBoard),opened),timing.warmAt);
      evidence.save(name+'-warm',{opened,warm,timing});await sleep(Math.max(0,warm-Date.now()),undefined,{signal});assert.equal(heard.counts().history??0,0);
      const version=await cdp.send<{product:string;revision:string;protocolVersion:string;jsVersion:string}>('Browser.getVersion',{},signal);if(browserIdentity)assert.deepEqual(version,browserIdentity);else browserIdentity=version;evidence.save(name+'-browser',{version:version.product,revision:{sha:version.revision.replace(/^@/,'')},protocol:{version:version.protocolVersion},v8:{version:version.jsVersion}});
      const send:Cdp['send']=async <T>(method:string,params:object={},parent?:AbortSignal):Promise<T>=>{
        const current=parent?AbortSignal.any([signal,parent]):signal;
        if(method==='Emulation.setCPUThrottlingRate'&&(params as {rate?:number}).rate===4){
          assert.equal(preflight,false);await bind();const before=await cdp.evaluate(geometrySource,current);if(geometry)assert.deepEqual(before,geometry);else geometry=before;evidence.save(name+'-geometry',before);
          evidence.save(name+'-workers-before',await inventory(activeBrowser,current));preflight=true;
        }
        return cdp.send<T>(method,params,current);
      };
      reading=await deadline(90_000,pending=>panning({send,evaluate:<T>(expression:string,parent?:AbortSignal)=>cdp.evaluate<T>(expression,AbortSignal.any([signal,pending,...(parent?[parent]:[])])),on:cdp.on.bind(cdp),off:cdp.off.bind(cdp),at:stage=>cdp.at(name+'/'+stage),snapshot:()=>cdp.snapshot()},undefined,{selection:'activity24',save:(file,value)=>evidence.save(name+'-'+file,value)}),signal);
      evidence.save(name+'-original',{...reading,problems:reading.problems.map(reason=>({reason}))});assert.ok(preflight);assert.equal(reading.reports.length,1);
      const report=reading.reports[0];assert.equal(report.initiator,'activity');assert.equal(report.period,'24h');
      assert.ok(report.frames.length>=30&&report.frames.length<=10_000&&report.frames.every(value=>Number.isFinite(value)&&value>0));
      assert.ok(Number.isSafeInteger(report.inputs)&&report.inputs>0&&report.inputs<=10_000&&report.latency.length===report.inputs&&report.latency.every(value=>Number.isFinite(value)&&value>=0));
      assert.ok(Number.isSafeInteger(report.updated)&&report.updated>=30&&report.chartUpdates.length===5&&report.chartUpdates.every(value=>Number.isSafeInteger(value)&&value>=30));
      const timingFailures=new Set(['activity/24h moving-frame p95 exceeds 34 ms','activity/24h moving-frame p99 exceeds 50 ms','activity/24h input-to-updated-frame p95 exceeds 34 ms']);
      assert.deepEqual(reading.problems.filter(problem=>!timingFailures.has(problem)),[]);
      const current={series:report.series,sessionSeries:report.sessionSeries,budgetSeries:report.budgetSeries,fundsSeries:report.fundsSeries,charts:report.charts,edgeSeries:report.edgeSeries};if(cohort)assert.deepEqual(current,cohort);else cohort=current;
      evidence.save(name+'-workers-after',await inventory(browser,signal));assert.equal(heard.counts().history??0,0);guard();
      const metrics={name,forced,p95:percentile(report.frames,.95),p99:percentile(report.frames,.99),input95:percentile(report.latency,.95),budgetFailures:reading.problems.length};summaries.push(metrics);
      budgetFailures+=reading.problems.length;completed++;evidence.save(name+'-summary',{status:reading.problems.length?'over-budget':'complete',...metrics,cohort:current,frames:report.frames.length,inputs:report.inputs,problems:reading.problems.map(reason=>({reason}))});
    }catch(error){armError=error;stopped=true;evidence.save(name+'-failure',{status:'incomplete',...fail(error)});}
    finally{binding?.close();try{await owner.close();}catch(error){stopped=true;evidence.save(name+'-cleanup-failure',fail(error));}evidence.save(name+'-cleanup',{status:owner.failures.length?'incomplete':'closed',failures:owner.failures.map(reason=>({reason})),browser:browser?.launchReport?.()});owner=undefined;}
    if(stopped||armError)break;
  }
}catch(error){stopped=true;evidence.save('first-failure',{status:'incomplete',...fail(error)});}
finally{
  clearTimeout(timer);heard?.close();try{await owner?.close();await emergency;await demo?.stop();}catch(error){stopped=true;evidence.save('final-cleanup-failure',fail(error));}
  try{if(temporary)rmSync(temporary,{recursive:true,force:true});}catch(error){stopped=true;evidence.save('wrapper-cleanup-failure',fail(error));}for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.removeListener(signal,cancel);
  const a=summaries.filter(row=>row.forced),b=summaries.filter(row=>!row.forced),complete=!stopped&&completed===4;
  const median=(rows:typeof summaries,key:'p99'|'input95')=>rows.reduce((sum,row)=>sum+row[key],0)/rows.length;
  const effect=complete&&b.every(row=>!row.budgetFailures)&&Math.max(...b.map(row=>row.p99))<Math.min(...a.map(row=>row.p99))&&median(b,'p99')<=.9*median(a,'p99')&&Math.max(...b.map(row=>row.input95))<=Math.min(...a.map(row=>row.input95))&&Math.max(...b.map(row=>row.p95))<=Math.max(...a.map(row=>row.p95));
  evidence.save('decision',{status:complete?effect?'supported-config-effect':'rejected':'incomplete',adopt:false,retry:false,summaries,budgetFailures,baselineBudgetFailure:a.some(row=>row.budgetFailures>0),native:'B p99 below both A, median gain at least10%, both B original budgets pass, max B input95 no greater than min A input95; passing A is not failing-CI reproduction; no retry or old154-hang claim'});
  evidence.finish('diagnostic',{status:complete?'complete':'incomplete',completed,budgetFailures,native:'One ABBA worker-configuration control; no adoption, retry, canonical acceptance or causal CPU claim'});
  process.exitCode=stopped||completed!==4||budgetFailures?1:0;
}
