import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {rendererDocument,historyRendererIdentity,networkRendererProfile} from '../rendererIdentity.js';
import {prepareHistoryTarget} from '../historyTrafficBrowser.js';
import type {ProcessIdentity} from '../browserProcess.js';
import {observeReversal} from '../reversalDiagnostic.js';
import {Cdp} from '../cdp.js';
import {nativePostmortem} from '../nativePostmortem.js';
import {RunOwner} from '../runOwner.js';

const source=ts.createSourceFile('historyTrafficBrowser.ts',readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
type Call=(...args:unknown[])=>Promise<any>;
const callerCode=new Map<string,string>();
// Execute complete production callers; only browser/HTTP boundaries are stand-ins.
function caller(name:string,bindings:Record<string,unknown>):Call {
  let code=callerCode.get(name);
  if(code===undefined){
    const names=name==='historyPage'?[name]:['passiveHistoryBinding',name];
    const declarations=names.map(name=>{const node=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(node);return node.getText(source).replace(/^export /,'');});
    code=ts.transpileModule(declarations.join('\n')+'\n'+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;callerCode.set(name,code);
  }
  return runInNewContext(code,bindings);
}

test('both actual history callers retain passive binding for ordinary and pool-observed owned Chrome',async()=>{
  const flags=['QUOTUM_BENCH_HISTORY_SCROLL_CONTROL','QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL','QUOTUM_BENCH_DIAGNOSE_NATIVE','QUOTUM_BENCH_REVERSAL_PROBE','QUOTUM_BENCH_DIAGNOSE_IDLE_CPU'];
  const environments=[{},Object.fromEntries(flags.map(key=>[key,''])),...flags.map(key=>({[key]:'1'}))];
  const hooks={owner:{},observeProcesses:async()=>[],launchReport:()=>({pid:1})};
  const browsers=[{value:{...hooks,owned:true},eligible:true},...[false,undefined].map(owned=>({value:{...hooks,owned},eligible:false})),
    ...['owner','observeProcesses','launchReport'].map(key=>({value:{...hooks,owned:true,[key]:undefined},eligible:false}))];
  for(const name of ['browserHistoryTraffic','browserCancellationTraffic'])for(const browser of browsers)for(const env of environments){
    const seen:unknown[][]=[],original=new Error('original seed stop'),run=caller(name,{DAY:86400000,HISTORY_COHORT_TAKES:1,process:{env},console:{error(){}},historyPage:async(...args:unknown[])=>{seen.push(args);throw original;}});
    await assert.rejects(name==='browserHistoryTraffic'?run(browser.value,{},'','board'):run(browser.value,{},'',false,false),error=>error===original);
    assert.equal(seen.length,1);assert.equal(seen[0].length,name==='browserHistoryTraffic'?12:11);assert.equal(seen[0][11],name==='browserHistoryTraffic'?true:undefined);assert.equal(seen[0][10],browser.eligible&&!flags.filter(key=>key!=='QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL').some(key=>env[key as keyof typeof env]));
  }
  for(const diagnostic of [true,false])for(const profile of [true,false]){
    const seen:unknown[][]=[],original=new Error('original cancellation stop'),run=caller('browserCancellationTraffic',{DAY:86400000,HISTORY_COHORT_TAKES:1,process:{env:{}},console:{error(){}},historyPage:async(...args:unknown[])=>{seen.push(args);throw original;}});
    await assert.rejects(run({...hooks,owned:true},{},'',diagnostic,profile),error=>error===original);assert.equal(seen[0][10],!diagnostic&&!profile);
  }
});

async function pageFixture(passive:boolean,observed=true,strict=false,seedFailure?:Error,poolMode=false,pressure=true,actual=false,setupFailure?:Error){
  const order:string[]=[],commands:string[]=[],evaluations:string[]=[],saved:string[]=[],pressureScripts:boolean[]=[],listeners=new Map<string,(value:any)=>void>(),owner=new RunOwner({save(){}}),navigation={frameId:'main',loaderId:'loader'};
  let targetCloses=0,resolves=0,rendererDisposes=0,removed=0,pinned:unknown;
  const tabClose=owner.resource(async()=>{targetCloses++;listeners.clear();});
  const renderer={pid:7,birth:'8',valid:()=>true,evidence:()=>({status:'known'}),dispose:async()=>{}};
  const cdp={at(){},on(name:string,read:(value:any)=>void){order.push('on:'+name);listeners.set(name,read);},off(name:string){if(listeners.delete(name))removed++;},
    snapshot:()=>({pending:[],socketState:1}),close(){},
    async send(method:string){commands.push(method);order.push(method);if(seedFailure&&method==='Network.enable')throw seedFailure;if(method==='Page.navigate'){if(observed){listeners.get('Page.frameStartedNavigating')?.({frameId:'main',loaderId:'loader',navigationType:'differentDocument'});listeners.get('Page.frameNavigated')?.({frame:{id:'main',loaderId:'loader'}});}return navigation;}},
    async evaluate(expression:string){evaluations.push(expression);if(expression.includes('return {x:r.left'))return{x:1,y:1,width:100,series:12};if(expression.includes('const chart=document.querySelector'))order.push('reachable-ack');if(expression.includes('const root=document.querySelector')){order.push('seed-probe');if(setupFailure)throw setupFailure;}return true;}};
  class Bodies {
    phase='';errors:unknown[]=[];reads:unknown[]=[];activeCount=0;pending=new Set();diagnostic(){return{};}
    get resources(){return[{phase:this.phase,count:{complete:true},cell:300000,selection:'quota',answer:{now:0},chunks:[[0,300000]]}];}
  }
  const run=caller('historyPage',{assert,URL,pageSerial:1,DAY:86400000,process:{env:{...(strict?{QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX:'1'}:{}),...(poolMode?{QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL:'1'}:{})}},openTab:async()=>({cdp,close:tabClose}),HistoryBodies:Bodies,
    historyPageScript:(_period:string,pressure:boolean)=>{pressureScripts.push(pressure);return'';},hasSeededHistory:()=>true,prepareHistoryTarget:actual?prepareHistoryTarget:async()=>{},
    saveHistoryPressure:async()=>{order.push('pressure-export');},
    rendererDocument:(page:Parameters<typeof rendererDocument>[0])=>{order.push('document');const document=rendererDocument(page),pin=document.pin;document.pin=reply=>{order.push('pin');pinned=reply;pin(reply);};return document;},
    historyRendererIdentity:actual?historyRendererIdentity:()=>({requireBeforeInput:false,prohibitFallback:true,validDocument:()=>observed,before:async()=>{order.push('before');},setupSent:()=>order.push('setup-send'),setupComplete:()=>order.push('setup-reply'),dispose:async()=>{},resolve:async()=>{resolves++;renderer.dispose=owner.resource(async()=>{rendererDisposes++;});return renderer;}}),
    rendererIdentity:async()=>{resolves++;renderer.dispose=owner.resource(async()=>{rendererDisposes++;});return renderer;}});
  const rows:ProcessIdentity[]=[process.pid,process.pid+1].map(pid=>({pid,parent:process.pid,group:process.pid,session:process.pid,birth:String(pid),state:'S',minorFaults:null,majorFaults:null,userTicks:null,systemTicks:null,blockIoTicks:null}));
  const hooks=actual?{launchReport:()=>({pid:process.pid,version:'Chrome/155.0.8059.39',sourceRevisionHash:'3ff7ac5a9224be9156d7f8703a06e22890aafd34'}),observeProcesses:async()=>{order.push('before-scan');return rows;}}:{};
  const browser={owned:true,owner,endpoint:'http://fixture.invalid',close:async()=>{},...hooks};
  const args=[browser,{url:'http://fixture.invalid',phase(){}},'cookie=fixture','fixture',86400000,0,undefined,{save:(name:string)=>saved.push(name)},undefined,undefined,passive,pressure];
  return{run:()=>run(...args),browser,owner,order,commands,evaluations,saved,pressureScripts,listeners,navigation,rows,pinned:()=>pinned,resolves:()=>resolves,targetCloses:()=>targetCloses,rendererDisposes:()=>rendererDisposes,removed:()=>removed};
}

test('passive document binding precedes Page.enable, pins the existing seed navigation and adds no preflight command',async()=>{
  let originalCommands:string[]|undefined;
  for(const passive of [false,true])for(const observed of [true,false]){
    const f=await pageFixture(passive,observed),page=await f.run();
    if(!originalCommands)originalCommands=f.commands;else assert.deepEqual(f.commands,originalCommands);
    assert.equal(f.resolves(),0);assert.deepEqual(f.saved,[]);
    assert.deepEqual(f.pressureScripts,[passive]);assert.ok(!f.order.includes('pressure-export'));
    if(passive){assert.ok(f.order.indexOf('document')<f.order.indexOf('Page.enable'));assert.ok(f.order.indexOf('on:Page.frameNavigated')<f.order.indexOf('Page.navigate'));assert.ok(f.order.indexOf('before')<f.order.indexOf('setup-send'));assert.ok(f.order.indexOf('setup-send')<f.order.indexOf('seed-probe'));assert.ok(f.order.indexOf('seed-probe')<f.order.indexOf('setup-reply'));assert.ok(f.order.indexOf('setup-reply')<f.order.indexOf('pin'));assert.equal(f.pinned(),f.navigation);assert.equal(page.lateRenderer.requireBeforeInput,false);assert.equal(page.lateRenderer.prohibitFallback,true);assert.equal(page.lateRenderer.validDocument(),observed);}
    else assert.equal(page.lateRenderer,undefined);
    await page.close();await f.owner.close();assert.equal(f.targetCloses(),1);assert.equal(f.listeners.size,0);assert.equal(f.removed(),passive?5:0);assert.equal(f.resolves(),0);assert.equal(f.rendererDisposes(),0);
  }
});

test('only the ordinary owned page can export pressure after failure; the strict route stays unchanged',async()=>{
  for(const passive of [false,true])for(const strict of [false,true]){
    const f=await pageFixture(passive,true,strict),page=await f.run();
    assert.deepEqual(f.pressureScripts,[passive&&!strict]);assert.ok(!f.order.includes('pressure-export'));
    await page.capturePressure();assert.equal(f.order.filter(value=>value==='pressure-export').length,passive&&!strict?1:0);
    await page.close();await f.owner.close();
  }
  for(const [poolMode,pressure] of [[true,true],[false,false]]){
    const f=await pageFixture(true,true,false,undefined,poolMode,pressure),page=await f.run();
    assert.deepEqual(f.pressureScripts,[false]);await page.capturePressure();assert.ok(!f.order.includes('pressure-export'));
    await page.close();await f.owner.close();
  }
});

test('a known late renderer resolves once and both renderer and target release through their owned cleanup',async()=>{
  const f=await pageFixture(true),page=await f.run(),signal=new AbortController().signal;
  assert.equal(f.resolves(),0);const first=page.lateRenderer.resolve(signal),second=page.lateRenderer.resolve(signal);assert.equal(first,second);assert.equal(await first,await second);assert.equal(f.resolves(),1);
  await page.close();await page.close();await f.owner.close();assert.equal(f.rendererDisposes(),1);assert.equal(f.targetCloses(),1);assert.equal(f.listeners.size,0);assert.equal(f.removed(),5);
});

test('strict suffix document checks and their original artifact remain required before input',async()=>{
  const known=await pageFixture(false,true,true),page=await known.run();assert.equal(page.lateRenderer.requireBeforeInput,true);assert.equal(page.lateRenderer.validDocument(),true);assert.deepEqual(known.saved,['traffic-document-fixture']);assert.equal(known.resolves(),0);await page.close();await known.owner.close();assert.equal(known.targetCloses(),1);
  const missing=await pageFixture(false,false,true);await assert.rejects(missing.run(),/document identity unavailable/);await missing.owner.close();assert.deepEqual(missing.saved,['traffic-seed-failure-fixture']);assert.equal(missing.resolves(),0);assert.equal(missing.targetCloses(),1);assert.equal(missing.listeners.size,0);
});

test('a seed exception retains its original error while disposing passive listeners and the owned target',async()=>{
  const original=new Error('original Network.enable failure'),f=await pageFixture(true,true,false,original);await assert.rejects(f.run(),error=>error===original);await f.owner.close();assert.deepEqual(f.saved,['traffic-seed-failure-fixture']);assert.equal(f.targetCloses(),1);assert.equal(f.listeners.size,0);assert.equal(f.removed(),5);assert.equal(f.resolves(),0);
});

const historyProfiles=[
  {version:'Chrome/155.0.8059.39',sourceRevisionHash:'3ff7ac5a9224be9156d7f8703a06e22890aafd34'},
  {version:'Chrome/155.0.8059.12',sourceRevisionHash:'384c82079f60e0b79cdca6e49efd5cfceefa5b74'},
  {version:'Chrome/156.0.8078.47',sourceRevisionHash:'1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775'},
];

for(const profile of historyProfiles)test('the actual historyPage sandwich produces a document-lived exact PID without a late trace: '+profile.version,async()=>{
  for(const setupFailure of [undefined,new Error('original setup evaluation failed')]){
    const f=await pageFixture(true,true,false,undefined,false,true,true,setupFailure);
    f.browser.launchReport=()=>({pid:process.pid,...profile});
    if(setupFailure){await assert.rejects(f.run(),value=>value===setupFailure);await f.owner.close();assert.equal(f.listeners.size,0);assert.equal(f.targetCloses(),1);continue;}
    const page=await f.run();assert.ok(f.order.indexOf('reachable-ack')<f.order.indexOf('before-scan'));assert.ok(f.order.indexOf('before-scan')<f.order.indexOf('seed-probe'));
    const ordinary=await pageFixture(false,true,false,undefined,false,true,true),baseline=await ordinary.run();assert.deepEqual(f.commands,ordinary.commands);assert.deepEqual(f.evaluations,ordinary.evaluations);await baseline.close();await ordinary.owner.close();
    page.lateRenderer.input('cold scroll',performance.now());
    f.listeners.get('Network.requestWillBeSent')!({type:'Fetch',frameId:'main',loaderId:'loader',requestId:(process.pid+1)+'.1',request:{url:'http://fixture.invalid/api/boards/private-canary/period',method:'POST',headers:{'x-quotum-bench-attempt':'b1:1'}}});
    page.lateRenderer.input('warm cached return',performance.now());const failedStart=performance.now(),fromMs=performance.now();
    const h=await page.lateRenderer.resolve(new AbortController().signal,{browserPid:process.pid,failedStart,after:{status:'observed',fromMs,toMs:performance.now(),omitted:0,processes:f.rows}});
    assert.equal(h.valid(),true);assert.equal(h.pid,process.pid+1);assert.equal(h.birth,String(process.pid+1));assert.ok(!f.commands.some(value=>/Tracing|Inspector|Page.getFrameTree/.test(value)));
    await page.close();await f.owner.close();assert.equal(h.signal.aborted,true);assert.equal(h.pid,null);assert.equal(f.targetCloses(),1);assert.equal(f.listeners.size,0);
  }
});

for(const profile of historyProfiles)for(const mode of ['bound','navigation','reused-birth','browser-root-mismatch','malformed-signal','disposal','missing-renderer-role','duplicate-renderer-role','before-capture','during-capture','after-capture-readback'] as const)test('actual historyPage and observer retain the cold witness through successful input and zero-HTTP warm timeout: '+profile.version+'/'+mode,async t=>{
  const f=await pageFixture(true,true,false,undefined,false,true,true);f.browser.launchReport=()=>({pid:process.pid,...profile});
  const page=await f.run(),logs:string[]=[],commands=[...f.commands],evaluations=[...f.evaluations];
  const native=await nativePostmortem({root:100,live:()=>false,observe:async()=>[]},[],new AbortController().signal);
  t.mock.timers.enable({apis:['setTimeout']});t.mock.method(console,'error',(line:string)=>logs.push(line));
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://fixture.invalid/browser'})));
  t.mock.method(Cdp,'connect',async()=>({send:async()=>({processInfo:[{type:'browser',id:mode==='browser-root-mismatch'?99:process.pid,cpuTime:1},
    ...(mode==='missing-renderer-role'?[]:[{type:'renderer',id:process.pid+1,cpuTime:1}]),
    ...(mode==='duplicate-renderer-role'?[{type:'renderer',id:process.pid+1,cpuTime:2}]:[]),{type:'renderer',id:process.pid+2,cpuTime:999}]}),close(){}} as unknown as Cdp));
  const invalidate=()=>f.listeners.get('Page.frameStartedNavigating')!({frameId:'main',loaderId:'replacement',navigationType:'reload'});
  let calls=0,requests=0,nativeFinished=false,captureSignal:AbortSignal|undefined;
  const lateRenderer=mode==='malformed-signal'?{...page.lateRenderer,signal:{aborted:false}}:page.lateRenderer;
  if(mode==='before-capture'||mode==='after-capture-readback'){
    const resolve=lateRenderer.resolve.bind(lateRenderer);
    lateRenderer.resolve=async(...args:Parameters<typeof resolve>)=>{
      const handle=await resolve(...args);assert.equal(handle.valid(),true);
      if(mode==='before-capture')invalidate();
      else{
        const evidence=handle.evidence.bind(handle);
        handle.evidence=()=>{const snapshot=evidence();if(nativeFinished)invalidate();return snapshot;};
      }
      return handle;
    };
  }
  const observer=await observeReversal(page.cdp,{...f.browser,nativePostmortem:async(candidates,signal)=>{
    calls++;captureSignal=signal;assert.equal(signal.aborted,false);assert.deepEqual(candidates,[{pid:process.pid+1,birth:String(process.pid+1),cpuTime:1}]);
    if(mode==='during-capture'){invalidate();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(signal.aborted,true);}
    nativeFinished=true;return{...native,pid:process.pid+1,birth:String(process.pid+1),status:'observed',intervened:true,released:true,reaped:true,pipesClosed:true};
  }},{postmortem:true,lateRenderer});
  await observer.watch('cold scroll',async()=>{
    requests++;f.listeners.get('Network.requestWillBeSent')!({type:'Fetch',frameId:'main',loaderId:'loader',requestId:(process.pid+1)+'.1',request:{url:'http://fixture.invalid/api/boards/private-canary/period',method:'POST',headers:{'x-quotum-bench-attempt':'b1:1'}}});
  });
  assert.equal(calls,0);const commandStart=performance.now();
  if(mode==='navigation')invalidate();
  if(mode==='reused-birth')f.rows[1]={...f.rows[1],birth:'999'};
  if(mode==='disposal')await page.lateRenderer.dispose();
  page.cdp.snapshot=()=>({failure:{id:196,method:'Input.synthesizeScrollGesture',started:commandStart},pending:[],socketState:1});
  page.cdp.evaluate=async(_expression:string,signal:AbortSignal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const original=new Error('original30s warm command failure'),failed=assert.rejects(observer.watch('warm/cached return',async()=>{throw original;}),error=>error===original);
  await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(2000);await failed;await observer.close();
  const report=JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  // The same full fixture exposes the old profile rejection before expecting capture.
  if(mode==='bound'&&!networkRendererProfile(f.browser.launchReport!())){
    const receipt=(await page.lateRenderer.resolve(new AbortController().signal,{browserPid:process.pid,failedStart:commandStart,after:report.failedProcesses})).evidence();
    assert.equal(receipt.profile,false);assert.equal(receipt.status,'unknown');assert.equal(receipt.pid,null);assert.equal(calls,0);assert.equal(report.nativeBinding,false);
    t.diagnostic(JSON.stringify({profile:receipt.profile,status:receipt.status,pid:receipt.pid,nativeCalls:calls,nativeBinding:report.nativeBinding}));
  }
  assert.equal(requests,1);assert.equal(calls,['bound','during-capture','after-capture-readback'].includes(mode)?1:0);assert.ok(!f.commands.some(command=>/Tracing|Inspector|Debugger|Profiler/.test(command)));
  assert.deepEqual(f.commands,commands);assert.deepEqual(f.evaluations,evaluations);assert.equal(f.order.filter(value=>value==='before-scan').length,2);
  assert.equal(report.nativeBinding,mode==='bound');assert.equal(report.command.failure.started,commandStart);
  if(report.rendererAtCapture)assert.equal(report.rendererAtCapture.profile,true);
  if(mode==='bound'){
    assert.equal(report.rendererAtCapture.status,'known');assert.equal(report.rendererAtCapture.pid,process.pid+1);assert.equal(report.rendererAtCapture.birth,String(process.pid+1));
    assert.equal(report.rendererAtCapture.witness.input.scenario,'cold scroll');assert.ok(report.rendererAtCapture.witness.received<=commandStart);assert.equal(report.rendererAtCapture.failedCommand.started,commandStart);assert.equal(report.rendererAtCapture.after.status,'observed');
  }
  if(mode==='during-capture'||mode==='after-capture-readback'){
    assert.equal(captureSignal!.aborted,true);assert.equal(report.nativeWait.intervened,true);assert.equal(report.nativeWait.released,true);assert.equal(report.nativeWait.reaped,true);assert.equal(report.nativeWait.pipesClosed,true);assert.equal(report.nativeCleanup,undefined);assert.deepEqual(f.owner.failures,[]);
    if(mode==='after-capture-readback')assert.equal(report.rendererAfterCapture.status,'known');
  }
  assert.doesNotMatch(logs.join(''),/private-canary/);await page.close();await f.owner.close();assert.equal(f.listeners.size,0);assert.equal(f.targetCloses(),1);
});
