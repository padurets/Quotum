import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {RunOwner} from '../runOwner.js';
import {safeEvidence} from '../evidence.js';
import {EventCounts} from '../stream.js';
import {cellOf} from '../../server/domain/history.js';
import {idleProblems,chartProblems,measuredProblems,percentile,HISTORY_BYTES_PER_MEASUREMENT} from '../budget.js';
import {DOT_STILL_AFTER,fixtureTiming,idlePhaseProblems,idlePhaseScript,idleWindow,overviewCards,stillProblems,warmUntil} from '../still.js';
import {delta,round,scriptPerSecond,tally} from '../report.js';
import {idleRetentionScript,idleRetentionProblems} from '../idleRetention.js';

// Execute the actual caller and parser, not a second implementation of its phase branches.
// Leaf phases and browser IO are stand-ins; these tests prove routing/failure propagation only.
const file=ts.createSourceFile('index.ts',readFileSync(new URL('../index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declarations=['parseArgs','main'].map(name=>{
  const found=file.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
  assert.equal(found.length,1);return found[0].getText(file);
});
const code=ts.transpileModule(declarations.join('\n')+'\nglobalThis.selected={main,parseArgs};',{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
type Fault='red'|'throw'|'cancel'|'browser-close'|'demo-stop'|'idle'|'measure'|'work'|'private-work'|'panning'|'credits'|'money'|'all-red'|'panning-throw'|'credits-throw'|'opening-metrics'|'idle-retention'|'idle-trace-cancel'|'idle-trace-throw'|'idle-binding'|'idle-profile-incomplete'|'idle-profile-close'|'retirement-binding-mismatch'|'retirement-debugger-active'|'retirement-probe-missing';
async function run(args:string[]=[],fault?:Fault,env:Record<string,string>={},ci=true,startedAt=Date.parse('2026-10-15T12:00:10Z')) {
  const calls:string[]=[],saved=new Map<string,unknown>(),diagnosticFiles=new Map<string,unknown>(),exits:number[]=[],statuses:string[]=[],logs:string[]=[];
  const listeners=new Map<string,()=>void>(),waits:number[]=[];let now=startedAt,phaseStart=now,metricReads=0,retentionReads=0;
  let terminal!:()=>void;const exited=new Promise<void>(resolve=>{terminal=resolve;});
  const mark=(name:string)=>{calls.push(name);};
  const red=(name:string)=>fault===name||fault==='all-red'||name==='idle'&&['idle-trace-throw','idle-binding'].includes(fault??'');
  const problems=(name:string)=>red(name)?[name+'-red']:[];
  const reading={commits:0,instrumentMs:0,renders:[],mutations:[]};
  const events=new EventCounts(()=>now);for(let i=0;i<5;i++)events.push('event: ping\ndata: {}\n\n');
  const source={id:'fixture',successAt:now-600_000,staleAfterMs:3_600_000,windows:[]};
  const overview={sources:[source],forecast:{},board:{id:'board'}};
  const person={personalBoard:'board',cookie:'session=fixture',get:async()=>overview};
  const set={id:'all',scene:'still'},stand={set,start:now,people:new Map([['ana',person]])};
  const browser={owned:true,endpoint:'fixture',launchReport:()=>({mode:'owned'}),close:async()=>{
    mark('browser-close');if(fault==='browser-close')throw Error('browser-close-red');
  }};
  const cdp={send:async()=>({}),evaluate:async(expression:string)=>{
    if(expression.includes(".card:not(.is-loading)"))return 1;
    if(expression==='__quotumBench.read()')return reading;
    if(expression==='window.__quotumIdleRetention()'){
      mark('retention-'+(++retentionReads));
      const R=(saved.get('idle-plan') as {quotaBoundary:number}).quotaBoundary,periodMs=86_400_000,second=R-periodMs-1;
      const retired=retentionReads===2&&fault!=='idle-retention';
      return {at:now,evaluatedAt:now,identity:'board/live',generation:1,revision:1,proofEpoch:1,scopeKey:'quota',selection:{mode:'live',periodMs},settled:true,retirementAt:R+(retired?300000:0),
        quota:{from:stand.start-periodMs,cut:stand.start,cursor:'same',rows:[{sourceId:'fixture',windowId:'weekly',count:retired?2:3,first:retired?second:second-300000,second:retired?second+300000:second,third:retired?null:second+300000,last:second+300000}]}};
    }
    if(expression.includes('window.__quotumIdlePhase='))phaseStart=now;
    if(expression.includes('const p=__quotumIdlePhase.read()')){
      const start=Math.floor(phaseStart/300_000),end=Math.floor(now/300_000);
      return{from:phaseStart,to:now,monotonicFrom:phaseStart,monotonicTo:now,cellMs:300_000,
        starts:Array(5).fill(start),ends:Array(5).fill(end),transitions:Array(5).fill(end-start)};
    }
  }};
  class Demo {
    constructor(options:{start:number}){stand.start=options.start;}
    dir='/unused';async run(){mark('demo');return stand;}async settled(){}
    async stop(){mark('demo-stop');if(fault==='demo-stop')throw Error('demo-stop-red');}
  }
  class Evidence {
    begin(name:string){mark('phase:'+name);}save(name:string,value:unknown){saved.set(name,value);}
    finish(status:string){statuses.push(status);}
  }
  class Requests {count=0;bytes=0;byPath={};counting=false;}
  class IdleCpuDiagnostic {
    binding={rememberInjected:(_context:number,source:string,role:string)=>{assert.match(source,/quotum\.locale/);assert.equal(role,'idle-probe');mark('idle-cpu-probe');}};
    constructor(_target:unknown,_save:unknown,_client:unknown,owned:boolean,collection:string){assert.equal(owned,true);assert.equal(collection,'profile');}
    async start(){mark('idle-cpu-start');if(fault==='idle-trace-cancel'){listeners.get('SIGTERM')!();await exited;throw Error('cancelled-idle-profile');}}
    async stop(window:{seconds:number}){mark('idle-cpu-stop');assert.equal(window.seconds,120);if(fault==='idle-trace-throw')throw Error('idle-profile-stop-original');}
    async bindAndClose(){mark('idle-cpu-binding');if(fault==='idle-binding')throw Error('idle-binding-original');}
    traceReceipt(){mark('idle-cpu-receipt');return{status:fault==='idle-profile-incomplete'?'insufficient-evidence':'complete'};}
    async close(){mark('idle-cpu-close');if(fault==='idle-profile-close')throw Error('idle-profile-close-original');}
  }
  class Stop extends Error {}
  class ChromeLaunchError extends Error {}
  const panning=async()=>{mark('panning');if(fault==='panning-throw')throw Error('panning-original');
    if(fault==='cancel'){listeners.get('SIGTERM')!();await exited;throw Error('cancelled-panning');}
    return{problems:problems('panning'),reports:['quota','session','activity','budget','funds'].flatMap(initiator=>['24h','30d'].map(period=>({initiator,period,frames:[16],latency:[16],
      ...(['cpu','trace'].includes(env.QUOTUM_BENCH_DIAGNOSE_PANNING)?{timeline:{status:'complete',count:1,omitted:0,entries:[{id:1,at:now,kind:'frame',canary:'private-timeline-canary'}]}}:{})})))};
  };
  const context={exports:{},process:{argv:['node','index.ts',...(ci?['--ci']:[]),...args],env:{CI:'1',...env},pid:1,platform:'linux',
      on:(name:string,fn:()=>void)=>{listeners.set(name,fn);},exit:(code:number)=>{exits.push(code);terminal();}},
    Date:class extends Date {static now(){return now;}},console:{log:()=>{},error:(value:unknown)=>{logs.push(String(value));}},path,Buffer,RunOwner,Demo,Evidence,Requests,IdleCpuDiagnostic,Stop,ChromeLaunchError,
    mkdirSync:()=>{},writeFileSync:(file:string,body:string)=>diagnosticFiles.set(path.basename(file,'.json'),JSON.parse(body)),sourceIdentity:()=>({checkoutSha:'fixture'}),
    USAGE:'fixture usage',IDLE:{ci:120,full:300},SHOWN_MS:30_000,MEASURED:'fixture',HISTORY_BYTES_PER_MEASUREMENT,
    SETS:[set],fixtureTiming,panningSet:(value:unknown)=>value,people:()=>[{id:'ana'}],freePort:async()=>{mark('freePort');return 1234;},
    addressOf:()=>({base:'http://127.0.0.1:1234'}),prepare:async()=>{mark('prepare');},findChrome:()=>'/unused/chrome',
    seedPanningBudgets:()=>{mark('seed');},hear:async()=>({close:()=>{mark('stream-close');},reset:(window?:{from:number;to:number})=>{events.reset(window);for(let i=0;i<5;i++)events.push('event: ping\ndata: {}\n\n');},counts:()=>events.counts(),boardCounts:()=>events.boardCounts(),calendar:()=>events.calendar(),contacts:()=>events.contacts(),hints:()=>events.hints()}),
    launchChrome:async()=>{mark('launch');return browser;},openTab:async()=>{mark('openTab');return{cdp};},
    historyTraffic:async()=>{mark('history');if(fault==='throw')throw new Stop('history-original');
      if(fault==='cancel'){listeners.get('SIGTERM')!();await exited;}
      return{reports:[{name:'history-marker'}],problems:red('red')?['history-red']:[]};},
    probeScript:()=>'',sleep:async(ms:number)=>{waits.push(ms);now+=Math.max(0,ms);},say:(value:string)=>{logs.push(value);},
    metrics:async()=>{const opening=metricReads++===0;
      if(opening&&fault==='opening-metrics')now=(saved.get('idle-plan') as {quotaBoundary:number}).quotaBoundary+1;
      mark(opening?'metrics-before':'metrics-after');return{Timestamp:now/1000,ScriptDuration:!opening&&red('idle')?0.1:0};},
    cellOf,idleProblems,chartProblems,measuredProblems,percentile,idlePhaseProblems,idlePhaseScript,idleWindow,overviewCards,stillProblems,warmUntil,idleRetentionScript,idleRetentionProblems,
    delta,round,scriptPerSecond,tally,measure:async()=>{mark('measure');return{source:'fixture',from:now,to:now,
      ingestLatencies:[1],latencies:[red('measure')?Infinity:1],chartLatencies:[red('measure')?Infinity:1],historyBytes:1,
      reading:{...reading,renders:[{node:'card',region:'card:fixture',time:false,kind:null,count:1}]}};},
    work:async()=>{mark('work');return{reports:[],problems:problems('work')};},
    workPrivate:async()=>{mark('private-work');return{reports:[],problems:problems('private-work')};},
    frequencyKeys:async()=>{mark('frequency');},panning,
    creditPhase:async()=>{mark('credits');if(fault==='credits-throw')throw new Stop('credits-original');return{updates:[],problems:problems('credits')};},
    moneyPhase:async()=>{mark('money');return{problems:problems('money')};},
    profilePanning:async(target:unknown,actualBrowser:unknown,_evidence:unknown,original:(target:unknown)=>Promise<unknown>)=>{
      assert.equal(actualBrowser,browser);mark('profile-start');try{return await original(target);}finally{mark('profile-stop');}
    },
    profileControls:async()=>{mark('profile-controls');},
    tracePanning:async(target:unknown,actualBrowser:unknown,_evidence:unknown,original:(target:unknown)=>Promise<unknown>=panning)=>{
      assert.equal(actualBrowser,browser);mark('trace-start');try{return await original(target);}finally{mark('trace-stop');}
    },
    traceControls:async()=>{mark('trace-controls');},
    clientIdentity:()=>({status:'unavailable'}),
    ScriptBinding:class {
      constructor(_target:unknown,_client:unknown,readonly save:(name:string,value:unknown)=>void){}
      rememberInjected(interval:number){mark('idle-probe-'+interval);}
      async afterFamily(){mark('idle-binding');if(fault==='idle-binding')throw Error('idle-binding-original');
        this.save('source-family-1',{status:fault==='retirement-binding-mismatch'?'mismatch':'complete',debuggerDisabled:fault!=='retirement-debugger-active',injected:{status:fault==='retirement-probe-missing'?'unavailable':'complete'}});
      }
      close(){mark('idle-binding-close');}
    },
    retirementReadScript:'passive retirement snapshot',retirementProfile:async(_target:unknown,_browser:unknown,planned:{from:number;to:number;quotaBoundary:number})=>{
      mark('retirement-profile');assert.ok(planned.from<=now);now=planned.quotaBoundary+5000;
      return{status:fault==='idle-profile-incomplete'?'insufficient-evidence':'complete'};
    },
    traceIdle:async(_target:unknown,actualBrowser:unknown,read:()=>Promise<unknown>)=>{
      assert.equal(actualBrowser,browser);mark('idle-trace');
      if(fault==='idle-trace-cancel'){listeners.get('SIGTERM')!();await exited;throw Error('cancelled-idle-trace');}
      const value=await read();if(fault==='idle-trace-throw')throw Error('idle-trace-original');return value;
    },
  };
  runInNewContext(code,context);
  const selected=(context as unknown as {selected:{main():Promise<void>;parseArgs(args:string[]):unknown}}).selected;
  let error:unknown;try{await selected.main();}catch(caught){error=caught;}
  return{calls,saved,diagnosticFiles,exits,statuses,logs,error,waits,fixtureStart:stand.start,parse:selected.parseArgs};
}
const tail=['measure','work','private-work','frequency','panning','credits','money'];
const order=(calls:string[])=>calls.filter(call=>call==='history'||call==='openTab'||tail.includes(call));
test('actual main passes the aligned fixture anchor and keeps the legacy warm wait',async()=>{
  const cell=300_000,minute=60_000,base=Date.parse('2026-10-15T12:00:10Z');
  for(let phase=0;phase<5;phase++){
    const at=base+phase*minute,result=await run(['--scope','dashboard'],undefined,{},true,at);
    assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);
    assert.equal(result.fixtureStart,Math.floor((at+50_000)/cell)*cell-50_000);
    assert.equal(result.waits[0],Math.floor(at/minute)*minute+DOT_STILL_AFTER-at);
    assert.deepEqual(result.saved.get('fixture-timing'),{start:result.fixtureStart,warmAt:Math.floor(at/minute)*minute+DOT_STILL_AFTER});
  }
});
test('actual main rejects quota retirement before the opening CPU counter even without DOM work',async()=>{
  const result=await run(['--scope','dashboard'],'opening-metrics');
  const idle=result.saved.get('idle') as {phase:{from:number;to:number};planned:{quotaBoundary:number};counterFrom:number;renders:unknown[];mutations:unknown[];phaseProblems:string[]};
  assert.ok(idle.phase.from<idle.planned.quotaBoundary&&idle.planned.quotaBoundary<idle.phase.to);
  assert.deepEqual(idle.renders,[]);assert.deepEqual(idle.mutations,[]);
  assert.equal(idle.counterFrom,idle.planned.quotaBoundary+1);
  assert.ok(idle.phaseProblems.includes('idle counters did not include regular quota retirement'));
  assert.deepEqual(result.exits,[1]);
});
for(const args of [[],['--scope','all'],['--scope','dashboard']])test('actual main preserves the shared full tail '+args.join(' '),async()=>{
  const result=await run(args);assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);
  assert.deepEqual(order(result.calls),[...(args.includes('dashboard')?[]:['history']),'openTab',...tail]);
  assert.deepEqual(result.statuses,['passed']);assert.ok(result.saved.has('result'));
  const mode=args.includes('dashboard')?'dashboard':'all';
  assert.deepEqual(safeEvidence(result.saved.get('scope')),{mode});
  assert.equal((safeEvidence(result.saved.get('result')) as {mode:string}).mode,mode);
  assert.ok(result.calls.indexOf('phase:idle')<result.calls.indexOf('measure'));
  assert.equal((result.saved.get('panning') as {reports:unknown[]}).reports.length,10);
});
test('history-only runs its matrix and closes all owners without opening the dashboard',async()=>{
  const result=await run(['--scope','history']);assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);
  assert.deepEqual(order(result.calls),['history']);assert.ok(result.saved.has('history-traffic'));
  assert.ok(!result.saved.has('idle'));assert.deepEqual(result.statuses,['passed']);
  assert.deepEqual(safeEvidence(result.saved.get('scope')),{mode:'history'});
  assert.equal((safeEvidence(result.saved.get('result')) as {mode:string}).mode,'history');
  for(const name of ['stream-close','browser-close','demo-stop'])assert.equal(result.calls.filter(call=>call===name).length,1);
});
test('the default full run retains history budget failures through the complete dashboard tail',async()=>{
  const result=await run([],'red');assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  assert.deepEqual(order(result.calls),['history','openTab',...tail]);assert.deepEqual(result.statuses,['failed']);
  assert.ok((result.saved.get('result') as {problems:string[]}).problems.includes('history-red'));
});
test('dashboard rejects an idle interval without actual quota retirement',async()=>{
  const result=await run(['--scope','dashboard'],'idle-retention');
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  const idle=result.saved.get('idle') as {phaseProblems:string[]};
  assert.ok(idle.phaseProblems.some(problem=>problem.includes('prefix did not retire')));
  assert.deepEqual(order(result.calls),['openTab',...tail],'a coverage failure still runs the remaining budgets');
});
test('both actual quota snapshots are inside the original performance counters',async()=>{
  const result=await run(['--scope','dashboard']);
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);
  const positions=['metrics-before','retention-1','retention-2','metrics-after'].map(name=>result.calls.indexOf(name));
  assert.ok(positions.every((position,i)=>position>=0&&(!i||position>positions[i-1])));
});
test('the actual full caller retains simultaneous history and every dashboard budget failure',async()=>{
  const result=await run([],'all-red');assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  assert.deepEqual(order(result.calls),['history','openTab',...tail]);assert.deepEqual(result.statuses,['failed']);
  const problems=(result.saved.get('result') as {problems:string[]}).problems;
  for(const name of ['history','work','private-work','panning','credits','money'])assert.ok(problems.includes(name+'-red'));
  for(const message of ['script took ','never showed on their card','never showed on their chart'])assert.ok(problems.some(value=>value.includes(message)));
});
for(const fault of ['red','throw','cancel','browser-close','demo-stop'] as const)test('history cannot pass '+fault,async()=>{
  const result=await run(['--scope','history'],fault);assert.equal(result.error,undefined);
  assert.equal(result.exits.length,1);assert.notEqual(result.exits[0],0);assert.deepEqual(order(result.calls),['history']);
  assert.deepEqual(result.statuses,[fault==='cancel'?'cancelled':'failed']);
  for(const name of ['browser-close','demo-stop'])assert.equal(result.calls.filter(call=>call===name).length,1);
  if(fault==='throw')assert.ok(result.logs.includes('history-original'));
});
for(const fault of ['idle','measure','work','private-work','panning','credits','money'] as const)test('dashboard retains '+fault+' failure and the later tail',async()=>{
  const result=await run(['--scope','dashboard'],fault);assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  assert.deepEqual(order(result.calls),['openTab',...tail]);assert.deepEqual(result.statuses,['failed']);
  const problems=(result.saved.get('result') as {problems:string[]}).problems;
  assert.ok(fault==='idle'?problems.some(value=>value.startsWith('script took ')):
    fault==='measure'?problems.some(value=>value.includes('never showed on their card')):problems.includes(fault+'-red'));
});
const diagnostics={QUOTUM_BENCH_DIAGNOSE_PANNING:'cpu',QUOTUM_BENCH_DIAGNOSE_IDLE:'double',QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'profile',
  QUOTUM_BENCH_DIAGNOSE_IDLE_TIMING:'1',QUOTUM_BENCH_DIAGNOSE_STARTUP:'1',QUOTUM_BENCH_DIAGNOSE_STARTUP_WAITS:'1',
  QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL:'1',QUOTUM_BENCH_DIAGNOSE_NATIVE:'1',QUOTUM_BENCH_REVERSAL_PROBE:'1'};
for(const scope of ['history','dashboard'])for(const [key,value] of Object.entries(diagnostics).filter(([key])=>scope!=='dashboard'||!['QUOTUM_BENCH_DIAGNOSE_PANNING','QUOTUM_BENCH_DIAGNOSE_IDLE_TIMING','QUOTUM_BENCH_DIAGNOSE_IDLE_CPU'].includes(key)))test('partial '+scope+' rejects '+key,async()=>{
  const result=await run(['--scope',scope],undefined,{[key]:value});
  assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);assert.deepEqual(result.exits,[]);
});
for(const scope of ['all','dashboard'])for(const fault of [undefined,'idle','opening-metrics','idle-trace-cancel','idle-trace-throw','idle-binding','browser-close','demo-stop'] as const)test('idle timing '+scope+' preserves '+String(fault),async()=>{
  const result=await run(['--scope',scope],fault,{QUOTUM_BENCH_DIAGNOSE_IDLE_TIMING:'1'});
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[fault?1:0]);
  assert.deepEqual(result.statuses,[fault==='idle-trace-cancel'?'cancelled':fault?'failed':'diagnostic']);
  assert.equal(result.calls.includes('history'),scope==='all');assert.ok(result.calls.includes('idle-trace'));
  assert.ok(tail.every(name=>!result.calls.includes(name)));
  assert.equal(result.calls.includes('idle-binding'),!['idle-trace-cancel','idle-trace-throw'].includes(fault??''));
  if(fault!=='idle-trace-cancel'){
    const idle=result.saved.get('idle') as {from:number;to:number;scriptMsPerSecond:number;phaseProblems:string[]};
    assert.equal(idle.to-idle.from,120_000);assert.equal(idle.scriptMsPerSecond>.3,['idle','idle-trace-throw','idle-binding'].includes(fault??''));
    assert.equal(idle.phaseProblems.length>0,fault==='opening-metrics');
    assert.equal((result.saved.get('idle-timing-result') as {problems:unknown[]}).problems.length>0,['idle','opening-metrics','idle-trace-throw','idle-binding'].includes(fault??''));
  }
  for(const name of ['stream-close','browser-close','demo-stop','idle-binding-close'])assert.equal(result.calls.filter(call=>call===name).length,1);
});
for(const [mode,next] of [['timing','idle-cpu'],['cpu','browser-startup']])test('idle '+mode+' workflow uses the required dashboard prefix and unchanged deadline',()=>{
  const workflow=readFileSync(new URL('../../../.github/workflows/bench-diagnostics.yml',import.meta.url),'utf8').split('  idle-'+mode+':\n')[1].split('\n  '+next+':')[0];
  assert.ok(workflow.includes('npm run bench -- --ci --scope dashboard'));assert.ok(workflow.includes('timeout-minutes: 20'));assert.ok(!workflow.includes('continue-on-error:'));
});
for(const scope of ['all','dashboard'])for(const fault of [undefined,'idle','opening-metrics','idle-trace-cancel','idle-trace-throw','idle-binding','idle-profile-incomplete','idle-profile-close','browser-close','demo-stop'] as const)test('idle CPU profile '+scope+' preserves '+String(fault),async()=>{
  const result=await run(['--scope',scope],fault,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'profile'});
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[fault?1:0]);
  assert.deepEqual(result.statuses,[fault==='idle-trace-cancel'?'cancelled':fault?'failed':'diagnostic']);
  assert.equal(result.calls.includes('history'),scope==='all');assert.ok(result.calls.includes('idle-cpu-start'));assert.ok(result.calls.includes('idle-cpu-probe'));
  assert.ok(tail.every(name=>!result.calls.includes(name)));
  if(fault!=='idle-trace-cancel'){
    const idle=result.saved.get('idle') as {from:number;to:number;scriptMsPerSecond:number;phaseProblems:string[]};
    assert.equal(idle.to-idle.from,120_000);assert.equal(idle.scriptMsPerSecond>.3,['idle','idle-trace-throw','idle-binding'].includes(fault??''));
    assert.equal(idle.phaseProblems.length>0,fault==='opening-metrics');
    const original=result.diagnosticFiles.get('idle-cpu-result') as {original:{problems:string[]}};
    assert.equal(original.original.problems.length>0,['idle','opening-metrics','idle-trace-throw','idle-binding'].includes(fault??''));
    assert.ok(result.calls.includes('idle-cpu-stop'));
    assert.equal(result.calls.includes('idle-cpu-binding'),fault!=='idle-trace-throw');
    assert.equal(result.calls.includes('idle-cpu-receipt'),!['idle-trace-throw','idle-binding'].includes(fault??''));
    if(fault==='idle-trace-throw'||fault==='idle-binding')assert.ok(result.logs.some(line=>line.includes(fault==='idle-trace-throw'?'idle-profile-stop-original':'idle-binding-original')));
  }
  if(fault==='idle-profile-close')assert.equal((result.diagnosticFiles.get('idle-cpu-cleanup') as {status:string}).status,'insufficient-evidence');
  for(const name of ['stream-close','browser-close','demo-stop','idle-cpu-close'])assert.equal(result.calls.filter(call=>call===name).length,1);
});
for(const [key,value] of Object.entries(diagnostics).filter(([key])=>key!=='QUOTUM_BENCH_DIAGNOSE_IDLE_CPU'))test('dashboard idle CPU profile rejects mixed '+key,async()=>{
  const result=await run(['--scope','dashboard'],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'profile',[key]:value});
  assert.match(String(result.error),/scope|panning diagnostics/i);assert.deepEqual(result.calls,[]);
});
for(const fault of [undefined,'idle','opening-metrics','idle-retention','idle-binding','idle-profile-incomplete','retirement-binding-mismatch','retirement-debugger-active','retirement-probe-missing'] as const)test('short retirement keeps original counters and rejects '+String(fault),async()=>{
  const result=await run(['--scope','dashboard'],fault,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'retirement'});
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[fault?1:0]);
  const idle=result.saved.get('idle') as {from:number;to:number;actualSeconds:number;scriptMsPerSecond:number;phaseProblems:string[]};
  assert.equal(idle.to-idle.from,120_000);
  if(fault==='opening-metrics')assert.ok(idle.actualSeconds<120&&idle.phaseProblems.length>0);else assert.equal(idle.actualSeconds,120);
  assert.equal(idle.scriptMsPerSecond>.3,['idle','idle-binding'].includes(fault??''));
  assert.ok(result.calls.indexOf('metrics-before')<result.calls.indexOf('retirement-profile'));
  assert.ok(result.calls.indexOf('retirement-profile')<result.calls.indexOf('metrics-after'));
  assert.ok(result.calls.indexOf('metrics-after')<result.calls.indexOf('idle-binding'));
  assert.ok(result.waits.some(wait=>wait>0&&wait<120_000),'waits through the unchanged remainder after the capture');
  assert.ok(!result.calls.includes('idle-cpu-start'));assert.ok(!result.calls.includes('history'));assert.ok(tail.every(name=>!result.calls.includes(name)));
  const original=result.diagnosticFiles.get('idle-cpu-result') as {status:string;problems:string[];original:{seconds:number}};
  assert.equal(original.original.seconds,120);assert.equal(original.problems.length>0,!!fault);
  if(fault==='idle-binding')assert.equal(original.status,'insufficient-evidence');
  assert.equal(result.calls.filter(name=>name==='idle-binding-close').length,1);
});
for(const [key,value] of Object.entries(diagnostics).filter(([key])=>key!=='QUOTUM_BENCH_DIAGNOSE_IDLE_CPU'))test('retirement rejects mixed '+key,async()=>{
  const result=await run(['--scope','dashboard'],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'retirement',[key]:value});
  assert.match(String(result.error),/scope|panning diagnostics/i);assert.deepEqual(result.calls,[]);
});
for(const args of [[],['--scope','history'],['--scope','dashboard','--cdp','http://127.0.0.1:9222']])test('retirement requires an owned dashboard CI scope '+JSON.stringify(args),async()=>{
  const result=await run(args,undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'retirement'});assert.match(String(result.error),/scope|idle CPU/i);assert.deepEqual(result.calls,[]);
});
for(const [args,ci,value] of [[['--scope','dashboard','--cdp','http://127.0.0.1:9222'],true,'profile'],[['--scope','dashboard'],false,'profile'],[['--scope','dashboard'],true,'1'],[['--scope','dashboard'],true,'trace'],[['--scope','dashboard'],true,'unknown']] as const)test('dashboard idle CPU profile rejects '+JSON.stringify({args,ci,value}),async()=>{
  const result=await run([...args],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:value},ci);
  assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);
});
for(const [key,value] of Object.entries(diagnostics).filter(([key])=>key!=='QUOTUM_BENCH_DIAGNOSE_IDLE_TIMING'))test('dashboard idle timing rejects mixed '+key,async()=>{
  const result=await run(['--scope','dashboard'],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_TIMING:'1',[key]:value});
  assert.match(String(result.error),/scope|panning diagnostics/i);assert.deepEqual(result.calls,[]);
});
for(const [args,ci,value] of [[['--scope','dashboard','--cdp','http://127.0.0.1:9222'],true,'1'],[['--scope','dashboard'],false,'1'],[['--scope','dashboard'],true,'2']] as const)test('dashboard idle timing rejects '+JSON.stringify({args,ci,value}),async()=>{
  const result=await run([...args],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_TIMING:value},ci);
  assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);
});
const modes=['cpu','trace'] as const;
for(const mode of modes)for(const scope of mode==='cpu'?['all','dashboard']:['dashboard'])test('actual '+mode+' '+scope+' preserves its original prefix and complete tail',async()=>{
  const result=await run(['--scope',scope],undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode}),wrapper=mode==='cpu'?'profile':'trace';assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);
  const selected=result.calls.filter(call=>call==='history'||call==='openTab'||call==='phase:idle'||tail.includes(call)||call.startsWith(wrapper+'-'));
  assert.deepEqual(selected,[...(scope==='all'?['history']:[]),'openTab','phase:idle','measure','work','private-work','frequency',wrapper+'-start','panning',wrapper+'-stop','credits','money',wrapper+'-controls']);
  assert.deepEqual(result.statuses,['diagnostic']);assert.deepEqual(safeEvidence(result.saved.get('scope')),{mode:scope});
  const value=result.saved.get('result') as {mode:string;panning:{initiator:string;period:string;timeline:{count:number;omitted:number;storedEntries:number;entries?:unknown}}[]};
  assert.equal(value.mode,scope);assert.deepEqual(value.panning.map(row=>row.initiator+'/'+row.period),['quota','session','activity','budget','funds'].flatMap(owner=>['24h','30d'].map(period=>owner+'/'+period)));
  for(const row of value.panning){assert.equal(row.timeline.count,1);assert.equal(row.timeline.omitted,0);assert.equal(row.timeline.storedEntries,1);assert.ok(!('entries' in row.timeline));}
  assert.doesNotMatch(JSON.stringify(result.saved.get('panning')),/private-timeline-canary/);
  assert.ok(result.saved.has('credits'));assert.ok(result.saved.has('money'));assert.ok(result.saved.has('diagnostic-panning-result'));
});
for(const mode of modes)test('dashboard '+mode+' retains simultaneous prefix and later failures without passing a diagnostic control',async()=>{
  const result=await run(['--scope','dashboard'],'all-red',{QUOTUM_BENCH_DIAGNOSE_PANNING:mode});assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  assert.deepEqual(order(result.calls),['openTab',...tail]);assert.deepEqual(result.statuses,['failed']);
  const problems=(result.saved.get('result') as {problems:string[]}).problems;
  for(const name of ['work','private-work','panning','credits','money'])assert.ok(problems.includes(name+'-red'));
  for(const message of ['script took ','never showed on their card','never showed on their chart'])assert.ok(problems.some(value=>value.includes(message)));
  assert.ok(result.calls.indexOf((mode==='cpu'?'profile':'trace')+'-controls')>result.calls.indexOf('money'));assert.ok(result.saved.has('diagnostic-panning-result'));
});
for(const mode of modes)for(const fault of ['panning-throw','credits-throw'] as const)test('dashboard '+mode+' preserves '+fault+' and closes every owner',async()=>{
  const result=await run(['--scope','dashboard'],fault,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode}),wrapper=mode==='cpu'?'profile':'trace';assert.equal(result.error,undefined);assert.deepEqual(result.exits,[fault==='credits-throw'?2:1]);
  assert.deepEqual(result.statuses,['failed']);assert.ok(result.logs.some(line=>line.includes(fault==='credits-throw'?'credits-original':'panning-original')));
  assert.ok(!result.saved.has('result'));assert.ok(!result.calls.includes('money'));assert.ok(!result.calls.includes(wrapper+'-controls'));
  assert.equal(result.saved.has('panning'),fault==='credits-throw');assert.ok(result.calls.includes(wrapper+'-stop'));
  for(const name of ['stream-close','browser-close','demo-stop'])assert.equal(result.calls.filter(call=>call===name).length,1);
});
for(const mode of modes)for(const fault of ['cancel','browser-close','demo-stop'] as const)test('dashboard '+mode+' cannot pass '+fault,async()=>{
  const result=await run(['--scope','dashboard'],fault,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode});assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  assert.deepEqual(result.statuses,[fault==='cancel'?'cancelled':'failed']);assert.equal(result.saved.has('result'),fault!=='cancel');
  for(const name of ['stream-close','browser-close','demo-stop'])assert.equal(result.calls.filter(call=>call===name).length,1);
});
for(const args of [[],['--scope','all']])test('legacy trace '+args.join(' ')+' keeps its diagnostic-only short prefix',async()=>{
  const result=await run(args,undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:'trace'});assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);
  assert.deepEqual(result.calls.filter(call=>call==='history'||call==='openTab'||call==='phase:idle'||tail.includes(call)||call.startsWith('trace-')),['openTab','trace-start','panning','trace-stop','trace-controls']);
  assert.deepEqual(result.statuses,['diagnostic']);assert.ok(!result.saved.has('result'));
  assert.equal((result.saved.get('diagnostic-panning-result') as {reports:unknown[]}).reports.length,10);
});
for(const mode of ['pairs','unknown'])test('dashboard still rejects panning '+mode,async()=>{
  const result=await run(['--scope','dashboard'],undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode});
  assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);
});
test('history still rejects trace before preparation',async()=>{
  const result=await run(['--scope','history'],undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:'trace'});assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);
});
for(const mode of modes)for(const scope of mode==='cpu'?['all','dashboard']:['dashboard'])for(const [key,value] of Object.entries(diagnostics).filter(([key])=>key!=='QUOTUM_BENCH_DIAGNOSE_PANNING'))test(mode+' '+scope+' rejects mixed '+key+' before preparation',async()=>{
  const result=await run(['--scope',scope],undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode,[key]:value});assert.match(String(result.error),/panning diagnostics/i);assert.deepEqual(result.calls,[]);
});
for(const mode of modes)for(const scope of mode==='cpu'?['all','dashboard']:['dashboard'])test(mode+' '+scope+' rejects an attached browser before preparation',async()=>{
  const result=await run(['--scope',scope,'--cdp','http://127.0.0.1:9222'],undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode});assert.match(String(result.error),/owned browser/);assert.deepEqual(result.calls,[]);
});
for(const mode of modes)test('dashboard '+mode+' requires the original CI idle duration',async()=>{
  const result=await run(['--scope','dashboard'],undefined,{QUOTUM_BENCH_DIAGNOSE_PANNING:mode},false);assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);
});
test('actual parser rejects unknown, missing and repeated scope',async()=>{
  const {parse}=await run(['--scope','history']);
  for(const args of [['--scope','other'],['--scope'],['--scope','history','--scope','history']])assert.throws(()=>parse(args));
});

/** Execute the workflow's shell assertion, including every unsuccessful dependency result. */
test('the existing bench check requires success from both independent scopes',{skip:process.platform==='win32'},()=>{
  const workflow=readFileSync(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const block=workflow.split('  bench:\n')[1].split('\n  bench-history:')[0];
  assert.ok(block.includes('always()'));assert.ok(block.includes('needs: [bench-history, bench-dashboard]'));
  assert.ok(!block.includes('continue-on-error:'));
  const script=block.split('        run: |\n')[1].split('\n').map(line=>line.slice(10)).join('\n');
  for(const history of ['success','failure','skipped','cancelled',''])for(const dashboard of ['success','failure','skipped','cancelled','']){
    const result=spawnSync('bash',['-eu','-c',script],{env:{...process.env,HISTORY_RESULT:history,DASHBOARD_RESULT:dashboard},encoding:'utf8'});
    assert.ifError(result.error);assert.equal(result.status===0,history==='success'&&dashboard==='success',JSON.stringify({history,dashboard}));
  }
  for(const [name,scope] of [['bench-history','history'],['bench-dashboard','dashboard']]){
    const job=workflow.split('  '+name+':\n')[1].split(/\n  [\w-]+:/)[0];
    assert.ok(job.includes('timeout-minutes: 20'));assert.ok(job.includes('--ci --scope '+scope));
    assert.ok(!job.includes('continue-on-error:'));
    assert.ok(!job.includes('\n    needs:'),'benchmark producers run independently');
  }
  const diagnostics=readFileSync(new URL('../../../.github/workflows/bench-diagnostics.yml',import.meta.url),'utf8').split('  panning-trace:\n')[1];
  assert.ok(diagnostics.includes('timeout-minutes: 20'));assert.ok(!diagnostics.includes('continue-on-error:'));
  const native=diagnostics.split('      - run: |\n')[1].split('\n        env:')[0].split('\n').map(line=>line.slice(10)).join('\n');
  assert.ok(native.endsWith('npm run bench -- --ci "$@"'));
  const choose=native.slice(0,native.indexOf('QUOTUM_CHROME='));
  for(const mode of ['cpu','trace','pairs','']){
    const result=spawnSync('bash',['-eu','-c',choose+'printf \'%s\\n\' \"$@\"'],{env:{...process.env,QUOTUM_BENCH_DIAGNOSE_PANNING:mode},encoding:'utf8'});
    assert.ifError(result.error);assert.equal(result.status,0);assert.equal(result.stdout,['cpu','trace'].includes(mode)?'--scope\ndashboard\n':'\n');
  }
});
