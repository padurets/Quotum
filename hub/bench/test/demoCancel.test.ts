import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {HistoryLimitOutput,type HistoryLimitReport} from '../../demo/historyLimit.js';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const canonical=path.join(repository,'hub/demo/index.ts'),source=readFileSync(canonical,'utf8');
const ast=ts.createSourceFile(canonical,source,ts.ScriptTarget.Latest,true);
const demo=ast.statements.find((node):node is ts.ClassDeclaration=>ts.isClassDeclaration(node)&&node.name?.text==='Demo');
const method=demo?.members.find((node):node is ts.MethodDeclaration=>ts.isMethodDeclaration(node)&&node.name.getText(ast)==='run');assert.ok(method);
// Bind only the module URL; execute the actual method with stand-in owned resources.
const actual=method.getText(ast);assert.equal(actual.split('import.meta.url').length-1,1);
const bound=actual.replace('import.meta.url',JSON.stringify(pathToFileURL(canonical).href));
const code=ts.transpileModule('globalThis.actualRun=({'+bound+'}).run;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const gate=()=>{let resolve!:(value?:any)=>void,reject!:(error:unknown)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve)); // Drain promise jobs at a phase barrier, without a timing assertion.

function fixture({pendingTrackers=false,pendingReady=false,delayedExit=false,stopFailure=false}={}){
  const trace:string[]=[],trackerGate=gate(),trackerEntered=gate(),readyGate=gate(),readyEntered=gate(),exitGate=gate();
  if(!delayedExit)exitGate.resolve();
  let trackerCloses=0,spawns=0,stops=0,stopCalls=0,completedStops=0,timers=0,spawnArgs:any[]=[];
  const tracker={urls:()=>{trace.push('urls');return{codex:'synthetic',claude:'synthetic'};},close:async()=>{trackerCloses++;trace.push('tracker-close');}};
  const hub=Object.assign(new EventEmitter(),{pid:123,exitCode:null as number|null,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter()});
  const stand={synthetic:true},cleanupError=new Error('cleanup-original');
  const subject:any={options:{set:{id:'all'},scene:'synthetic',still:true,idleAgents:true,money:false,address:{port:1,base:'synthetic',hosts:'synthetic'},onExit:()=>trace.push('unexpected-exit')},start:1000,dir:'/synthetic/demo',output:{add(){},toString:()=>''},reporting:Promise.resolve(),reports:new Set(),benchWork:false,stopping:false,
    settled:async()=>{},async stop(){stopCalls++;if(this.stopping)return;this.stopping=true;stops++;trace.push('stop');await exitGate.promise;
      hub.exitCode=0;hub.emit('exit',0);hub.emit('close',0,null);await this.trackers?.close();completedStops++;trace.push('stopped');if(stopFailure)throw cleanupError;}};
  const context:any={path,fileURLToPath,Buffer,HistoryLimitOutput,process:{execPath:'/synthetic/node',env:{KEEP:'fixture',QUOTUM_PRIVATE:'must-not-inherit',QUOTUM_DEMO_HISTORY_LIMITS:'1'}},Date:{now:()=>1100},SCENES:[],ADDRESS:[],SETUP_CODE:'synthetic',HUB:'/synthetic/hub',TICK:15000,
    Trackers:{start:()=>{trace.push('trackers');trackerEntered.resolve();return pendingTrackers?trackerGate.promise:Promise.resolve(tracker);}},
    spawn:(...args:any[])=>{spawns++;spawnArgs=args;trace.push('spawn');return hub;},ready:async()=>{trace.push('ready');readyEntered.resolve();if(pendingReady)await readyGate.promise;},
    setUp:async()=>{trace.push('setup');return stand;},Store:class{db={};constructor(){trace.push('store');}close(){trace.push('store-close');}},
    seedWork:()=>trace.push('seed'),selfCheck:async()=>{trace.push('self-check');},Live:class{constructor(){trace.push('live');}async report(){trace.push('report');}},
    liveStep:()=>0,setTimeout:()=>{timers++;trace.push('timer');return timers;},console:{error:()=>trace.push('console-error')}};
  runInNewContext(code,context);subject.run=context.actualRun;
  return{subject,stand,tracker,hub,trace,trackerGate,trackerEntered,readyGate,readyEntered,exitGate,
    stats:()=>({trackerCloses,spawns,stops,stopCalls,completedStops,timers}),spawnArgs:()=>spawnArgs,
    dispose:async()=>{trackerGate.resolve(tracker);readyGate.resolve();exitGate.resolve();try{await subject.stop();}catch{}}};
}

test('no-argument Demo.run preserves the ordinary preparation and reporting trace',async()=>{
  const h=fixture();try{
    assert.equal(await h.subject.run(),h.stand);
    assert.deepEqual(h.trace,['trackers','urls','spawn','ready','setup','store','seed','store-close','self-check','live','report','timer']);
    assert.equal(h.stats().stops,0);assert.equal(h.stats().timers,1);
    const [executable,args,options]=h.spawnArgs();assert.equal(executable,'/synthetic/node');assert.equal(args[0],'--import');assert.equal(args[1],'tsx');assert.equal(path.basename(args[2]),'hub.ts');
    assert.equal(options.env.KEEP,'fixture');assert.equal(options.env.QUOTUM_PRIVATE,undefined);
  }finally{await h.dispose();}
});
for(const enabled of [false,true])test('Demo.run enables bounded backend refusals only through its explicit observer: '+enabled,async()=>{
  const h=fixture(),reports:HistoryLimitReport[]=[];
  const report:HistoryLimitReport={event:'history_limit',physicalAttemptBound:false,stage:'input',limit:{requested:11,reserved:90,budget:100},evaluatedAt:1100,selection:{mode:'live',periodMs:86400000},quota:true,wallet:false,funds:false,sessions:true,sourceWork:true,calendar:true};
  if(enabled)h.subject.options.onHistoryLimit=(value:HistoryLimitReport)=>reports.push(value);
  try{
    await h.subject.run();assert.equal(h.spawnArgs()[2].env.QUOTUM_DEMO_HISTORY_LIMITS,enabled?'1':'');
    const line=Buffer.from(JSON.stringify(report)+'\n');
    h.hub.stdout.emit('data',line);h.hub.stderr.emit('data',Buffer.from('arbitrary backend text\n'));
    h.hub.stderr.emit('data',line.subarray(0,17));h.hub.stderr.emit('data',line.subarray(17));
    assert.deepEqual(reports,enabled?[report]:[]);assert.equal(h.trace.includes('console-error'),false);
  }finally{await h.dispose();}
});
test('preaborted Demo.run allocates no tracker, hub, store or reporter',async()=>{
  const h=fixture(),abort=new AbortController(),primary=new Error('preabort');abort.abort(primary);
  try{await assert.rejects(h.subject.run(abort.signal),(error:unknown)=>error===primary);assert.deepEqual(h.trace,[]);}
  finally{await h.dispose();}
});
test('the factory can close a tracker resolved after cancellation, before any hub spawn',async()=>{
  const h=fixture({pendingTrackers:true}),abort=new AbortController(),primary=new Error('tracker-abort');
  const running=h.subject.run(abort.signal).catch(async(error:unknown)=>{await h.subject.stop();throw error;});
  const outcome:Promise<any>=running.then((value:unknown)=>({value}),(error:unknown)=>({error}));
  try{
    await h.trackerEntered.promise;abort.abort(primary);h.trackerGate.resolve(h.tracker);
    assert.equal((await outcome).error,primary);assert.equal(h.stats().spawns,0);assert.equal(h.stats().trackerCloses,1);assert.equal(h.stats().completedStops,1);
  }finally{await h.dispose();await outcome;}
});
test('aborting pending ready joins the first idempotent stop until owned hub exit',async()=>{
  const h=fixture({pendingReady:true,delayedExit:true}),abort=new AbortController(),primary=new Error('ready-original');
  let settled=false;const outcome:Promise<any>=h.subject.run(abort.signal).then((value:unknown)=>{settled=true;return{value};},(error:unknown)=>{settled=true;return{error};});
  try{
    await h.readyEntered.promise;abort.abort(new Error('owner-cancel'));assert.equal(h.stats().stops,1);assert.equal(h.stats().stopCalls,1);
    h.readyGate.reject(primary);await turn();assert.equal(settled,false,'run must join its first stop while hub exit is pending');assert.equal(h.stats().completedStops,0);
    h.exitGate.resolve();assert.equal((await outcome).error,primary);assert.equal(h.stats().stopCalls,1);assert.equal(h.stats().completedStops,1);assert.equal(h.stats().trackerCloses,1);
    assert.ok(!h.trace.includes('unexpected-exit'));
  }finally{await h.dispose();await outcome;}
});
test('cleanup rejection preserves the original ready error without an unhandled rejection',async()=>{
  const h=fixture({pendingReady:true,delayedExit:true,stopFailure:true}),abort=new AbortController(),primary=new Error('ready-original');
  const outcome:Promise<any>=h.subject.run(abort.signal).then((value:unknown)=>({value}),(error:unknown)=>({error}));
  try{
    await h.readyEntered.promise;abort.abort(new Error('owner-cancel'));assert.equal(h.stats().stops,1);
    h.exitGate.resolve();await turn();assert.equal(h.stats().completedStops,1);h.readyGate.reject(primary);
    assert.equal((await outcome).error,primary);assert.equal(h.stats().stopCalls,1);
  }finally{await h.dispose();await outcome;}
});
test('a signal after fulfilled Demo.run does not stop the caller-owned backend',async()=>{
  const h=fixture(),abort=new AbortController();try{
    assert.equal(await h.subject.run(abort.signal),h.stand);abort.abort();await turn();assert.equal(h.stats().stops,0);assert.equal(h.subject.stopping,false);
  }finally{await h.dispose();}
});
