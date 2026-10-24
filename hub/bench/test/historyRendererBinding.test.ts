import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {rendererDocument} from '../rendererIdentity.js';
import {RunOwner} from '../runOwner.js';

const source=ts.createSourceFile('historyTrafficBrowser.ts',readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
type Call=(...args:unknown[])=>Promise<any>;
// Execute complete production callers; only browser/HTTP boundaries are stand-ins.
function caller(name:string,bindings:Record<string,unknown>):Call {
  const names=name==='historyPage'?[name]:['passiveHistoryBinding',name];
  const declarations=names.map(name=>{const node=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(node);return node.getText(source).replace(/^export /,'');});
  return runInNewContext(ts.transpileModule(declarations.join('\n')+'\n'+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,bindings);
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

async function pageFixture(passive:boolean,observed=true,strict=false,seedFailure?:Error,poolMode=false,pressure=true){
  const order:string[]=[],commands:string[]=[],saved:string[]=[],pressureScripts:boolean[]=[],listeners=new Map<string,(value:any)=>void>(),owner=new RunOwner({save(){}}),navigation={frameId:'main',loaderId:'loader'};
  let targetCloses=0,resolves=0,rendererDisposes=0,removed=0,pinned:unknown;
  const tabClose=owner.resource(async()=>{targetCloses++;});
  const renderer={pid:7,birth:'8',valid:()=>true,evidence:()=>({status:'known'}),dispose:async()=>{}};
  const cdp={at(){},on(name:string,read:(value:any)=>void){order.push('on:'+name);listeners.set(name,read);},off(name:string){if(listeners.delete(name))removed++;},
    async send(method:string){commands.push(method);order.push(method);if(seedFailure&&method==='Network.enable')throw seedFailure;if(method==='Page.navigate'){if(observed){listeners.get('Page.frameStartedNavigating')?.({frameId:'main',loaderId:'loader',navigationType:'differentDocument'});listeners.get('Page.frameNavigated')?.({frame:{id:'main',loaderId:'loader'}});}return navigation;}},
    async evaluate(expression:string){if(expression.includes('return {x:r.left'))return{x:1,y:1,width:100,series:12};if(expression.includes('const root=document.querySelector'))order.push('seed-probe');return true;}};
  class Bodies {
    phase='';errors:unknown[]=[];reads:unknown[]=[];activeCount=0;pending=new Set();diagnostic(){return{};}
    get resources(){return[{phase:this.phase,count:{complete:true},cell:300000,selection:'quota',answer:{now:0},chunks:[[0,300000]]}];}
  }
  const run=caller('historyPage',{assert,DAY:86400000,process:{env:{...(strict?{QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX:'1'}:{}),...(poolMode?{QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL:'1'}:{})}},openTab:async()=>({cdp,close:tabClose}),HistoryBodies:Bodies,
    historyPageScript:(_period:string,pressure:boolean)=>{pressureScripts.push(pressure);return'';},hasSeededHistory:()=>true,prepareHistoryTarget:async()=>{},
    saveHistoryPressure:async()=>{order.push('pressure-export');},
    rendererDocument:(page:Parameters<typeof rendererDocument>[0])=>{order.push('document');const document=rendererDocument(page),pin=document.pin;document.pin=reply=>{order.push('pin');pinned=reply;pin(reply);};return document;},
    rendererIdentity:async()=>{resolves++;renderer.dispose=owner.resource(async()=>{rendererDisposes++;});return renderer;}});
  const args=[{owned:true,owner},{url:'http://fixture.invalid',phase(){}},'cookie=fixture','fixture',86400000,0,undefined,{save:(name:string)=>saved.push(name)},undefined,undefined,passive,pressure];
  return{run:()=>run(...args),owner,order,commands,saved,pressureScripts,listeners,navigation,pinned:()=>pinned,resolves:()=>resolves,targetCloses:()=>targetCloses,rendererDisposes:()=>rendererDisposes,removed:()=>removed};
}

test('passive document binding precedes Page.enable, pins the existing seed navigation and adds no preflight command',async()=>{
  let originalCommands:string[]|undefined;
  for(const passive of [false,true])for(const observed of [true,false]){
    const f=await pageFixture(passive,observed),page=await f.run();
    if(!originalCommands)originalCommands=f.commands;else assert.deepEqual(f.commands,originalCommands);
    assert.equal(f.resolves(),0);assert.deepEqual(f.saved,[]);
    assert.deepEqual(f.pressureScripts,[passive]);assert.ok(!f.order.includes('pressure-export'));
    if(passive){assert.ok(f.order.indexOf('document')<f.order.indexOf('Page.enable'));assert.ok(f.order.indexOf('on:Page.frameNavigated')<f.order.indexOf('Page.navigate'));assert.ok(f.order.indexOf('seed-probe')<f.order.indexOf('pin'));assert.equal(f.pinned(),f.navigation);assert.equal(page.lateRenderer.requireBeforeInput,false);assert.equal(page.lateRenderer.validDocument(),observed);}
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
