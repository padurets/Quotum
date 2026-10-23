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
import {idleProblems,chartProblems,measuredProblems,percentile,HISTORY_BYTES_PER_MEASUREMENT,IDLE_SCRIPT_MS_PER_SECOND} from '../budget.js';
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
type Fault='red'|'throw'|'cancel'|'browser-close'|'demo-stop'|'idle'|'measure'|'work'|'observed-work'|'private-work'|'panning'|'credits'|'money'|'fixed-activity'|'all-red'|'panning-throw'|'credits-throw'|'opening-metrics'|'idle-retention'|'idle-trace'|'suffix-throw'|'suffix-budget'|'suffix-cancel'|'suffix-cleanup'|'suffix-error-cleanup'|'suffix-returned-problems';
async function run(args:string[]=[],fault?:Fault,env:Record<string,string>={},ci=true,startedAt=Date.parse('2026-10-15T12:00:10Z')) {
  const calls:string[]=[],saved=new Map<string,unknown>(),diagnosticFiles=new Map<string,unknown>(),exits:number[]=[],statuses:string[]=[],logs:string[]=[];
  const listeners=new Map<string,()=>void>(),waits:number[]=[];let now=startedAt,phaseStart=now,metricReads=0,retentionReads=0;
  let terminal!:()=>void;const exited=new Promise<void>(resolve=>{terminal=resolve;});let cancellationStarted=false,suffixCalls=0;const suffixError=new Error('suffix-original');
  const mark=(name:string)=>{calls.push(name);};
  const red=(name:string)=>fault===name||fault==='all-red';
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
    if(expression.includes('.agent-hours-heatmap[data-calendar-ready='))return true;
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
    readonly id='fixture-id';
    begin(name:string){mark('phase:'+name);}save(name:string,value:unknown){saved.set(name,value);}
    finish(status:string){statuses.push(status);}
  }
  class Requests {count=0;bytes=0;byPath={};counting=false;}
  class Stop extends Error {}
  class ChromeLaunchError extends Error {}
  class IdleCpuDiagnostic {
    readonly binding={rememberInjected:(frame:number,source:string,label:string)=>{assert.equal(frame,1);assert.ok(source.length);assert.equal(label,'idle-probe');mark('idle-trace-injected');}};
    constructor(_cdp:unknown,_save:unknown,_client:unknown,owned:boolean,readonly mode:string,readonly signal?:AbortSignal){
      assert.equal(owned,true);assert.ok(['native-trace','native-profile','trace','profile'].includes(mode));
      if(mode.startsWith('native-')){assert.ok(signal);signal.throwIfAborted();mark('native-trace-created');}else mark('idle-trace-created');
    }
    async start(){mark('idle-trace-start');}
    async stop(window:{seconds:number}){assert.equal(window.seconds,120);assert.equal(metricReads,2);assert.equal(retentionReads,2);mark('idle-trace-stop');}
    async bindAndClose(){mark('idle-trace-bind');}
    traceReceipt(from:number,to:number,cellMs:number){assert.equal(to-from,120000);assert.equal(cellMs,300000);mark('idle-trace-receipt');return{status:fault==='idle-trace'?'insufficient-evidence':'complete'};}
    async close(){if(this.mode.startsWith('native-')){assert.equal(this.signal?.aborted,true);mark('native-trace-close');}else mark('idle-trace-close');}
  }
  const panning=async(_cdp?:unknown,_pace?:unknown,_output?:unknown,_reload?:unknown,trace?:()=>IdleCpuDiagnostic)=>{mark('panning');trace?.();if(fault==='panning-throw')throw Error('panning-original');
    if(fault==='cancel'){listeners.get('SIGTERM')!();await exited;throw Error('cancelled-panning');}
    return{problems:problems('panning'),reports:['quota','session','activity','budget','funds'].flatMap(initiator=>['24h','30d'].map(period=>({initiator,period,frames:[16],latency:[16]})))};
  };
  const context={exports:{},process:{argv:['node','index.ts',...(ci?['--ci']:[]),...args],env:{CI:'1',...env},pid:1,platform:'linux',
      on:(name:string,fn:()=>void)=>{listeners.set(name,fn);},exit:(code:number)=>{exits.push(code);terminal();}},
    Date:class extends Date {static now(){return now;}},console:{log:()=>{},error:(value:unknown)=>{logs.push(String(value));}},path,Buffer,RunOwner,Demo,Evidence,Requests,Stop,ChromeLaunchError,IdleCpuDiagnostic,
    safeEvidence,statSync:()=>({size:env.TEST_SUFFIX_BIG_BASELINE?1024*1024+1:Buffer.byteLength(JSON.stringify(safeEvidence(saved.get('result'))))}),
    readFileSync:()=>env.TEST_SUFFIX_BAD_BASELINE?'missing':JSON.stringify(safeEvidence(saved.get('result'))),
    mkdirSync:()=>{},writeFileSync:(file:string,body:string)=>diagnosticFiles.set(path.basename(file,'.json'),JSON.parse(body)),
    sourceIdentity:()=>env.QUOTUM_BENCH_HISTORY_SCROLL_CONTROL?{sourceHead:env.QUOTUM_BENCH_SOURCE_SHA??null,checkoutSha:'1'.repeat(40)}:{checkoutSha:'fixture'},
    execFileSync:()=>env.TEST_CONTROL_DIRTY??'',
    USAGE:'fixture usage',IDLE:{ci:120,full:300},SHOWN_MS:30_000,MEASURED:'fixture',HISTORY_BYTES_PER_MEASUREMENT,
    SETS:[set],fixtureTiming,panningSet:(value:unknown)=>value,people:()=>[{id:'ana'}],freePort:async()=>{mark('freePort');return 1234;},
    addressOf:()=>({base:'http://127.0.0.1:1234'}),prepare:async()=>{mark('prepare');},findChrome:()=>'/unused/chrome',
    seedPanningBudgets:()=>{mark('seed');},hear:async()=>({close:()=>{mark('stream-close');},reset:(window?:{from:number;to:number})=>{events.reset(window);for(let i=0;i<5;i++)events.push('event: ping\ndata: {}\n\n');},counts:()=>events.counts(),boardCounts:()=>events.boardCounts(),calendar:()=>events.calendar(),contacts:()=>events.contacts(),hints:()=>events.hints()}),
    launchChrome:async()=>{mark('launch');return browser;},openTab:async()=>{mark('openTab');return{cdp};},
    historyProxy:async(_upstream:string,scope:RunOwner)=>{
      mark('suffix-proxy');const close=scope.resource(async()=>{mark('suffix-close');if(fault==='suffix-cleanup'||fault==='suffix-error-cleanup')throw Error('suffix-close-red');});return{close};
    },
    browserHistoryTraffic:async(_browser:unknown,_proxy:unknown,_cookie:unknown,_board:unknown,_evidence:unknown,suffix:{pair:number;cohort:string})=>{
      assert.ok(saved.has('result')&&saved.has('history-traffic'),'baseline retained before suffix');suffixCalls++;mark(`suffix:${suffix.pair}:${suffix.cohort}`);
      if(fault==='suffix-throw'||fault==='suffix-error-cleanup')throw suffixError;
      if(fault==='suffix-cancel'){listeners.get('SIGTERM')!();await exited;}
      if(fault==='suffix-budget')throw suffixError;
      return{reports:[],invalidated:[],problems:fault==='suffix-returned-problems'?['returned-suffix-budget']:[]};
    },
    historyTraffic:async(...args:unknown[])=>{mark('history');if(args[6])mark('scroll-control');if(fault==='throw')throw new Stop('history-original');
      if(fault==='cancel'){listeners.get('SIGTERM')!();await exited;}
      return{reports:[{name:'history-marker'}],problems:red('red')?['history-red']:[]};},
    probeScript:()=>'',sleep:async(ms:number)=>{waits.push(ms);now+=Math.max(0,ms);},say:(value:string)=>{logs.push(value);},
    metrics:async()=>{const opening=metricReads++===0;
      if(opening&&fault==='opening-metrics')now=(saved.get('idle-plan') as {quotaBoundary:number}).quotaBoundary+1;
      mark(opening?'metrics-before':'metrics-after');return{Timestamp:now/1000,ScriptDuration:opening?0:red('idle')?2*IDLE_SCRIPT_MS_PER_SECOND*(ci?120:300)/1000:0,ThreadTime:opening?.4:.45};},
    cellOf,idleProblems,chartProblems,measuredProblems,percentile,idlePhaseProblems,idlePhaseScript,idleWindow,overviewCards,stillProblems,warmUntil,idleRetentionScript,idleRetentionProblems,
    delta,round,scriptPerSecond,tally,measure:async()=>{mark('measure');return{source:'fixture',from:now,to:now,
      ingestLatencies:[1],latencies:[red('measure')?Infinity:1],chartLatencies:[red('measure')?Infinity:1],historyBytes:1,
      reading:{...reading,renders:[{node:'card',region:'card:fixture',time:false,kind:null,count:1}]}};},
    work:async()=>{mark('work');return{reports:[],problems:problems('work')};},
    workObserved:async()=>{mark('observed-work');return{reports:[],setup:{},problems:problems('observed-work')};},
    workPrivate:async()=>{mark('private-work');return{reports:[],problems:problems('private-work')};},
    frequencyKeys:async()=>{mark('frequency');},panning,panningProblems:()=>[],
    creditPhase:async()=>{mark('credits');if(fault==='credits-throw')throw new Stop('credits-original');return{updates:[],problems:problems('credits')};},
    moneyPhase:async()=>{mark('money');return{problems:problems('money')};},
    fixedActivity:async()=>{mark('fixed-activity');return{reports:[],problems:problems('fixed-activity')};},
    clientIdentity:()=>env.QUOTUM_BENCH_HISTORY_SCROLL_CONTROL?{status:'available',sha256:'2'.repeat(64)}:{status:'unavailable'},
  };
  runInNewContext(code,context);
  const selected=(context as unknown as {selected:{main():Promise<void>;parseArgs(args:string[]):unknown}}).selected;
  let error:unknown;try{await selected.main();}catch(caught){error=caught;}
  if(cancellationStarted)await exited;
  return{calls,saved,diagnosticFiles,exits,statuses,logs,error,waits,fixtureStart:stand.start,parse:selected.parseArgs};
}
const tail=['measure','work','observed-work','private-work','frequency','panning','credits','money','fixed-activity'];
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
  assert.ok(result.saved.has('fixed-activity'));
  assert.ok((result.saved.get('result') as {selectedActivity:unknown}).selectedActivity);
  const idle=result.saved.get('idle') as {counterFrom:number;counterTo:number;performance:unknown};
  assert.deepEqual(safeEvidence(idle.performance),{before:{Timestamp:idle.counterFrom/1000,ScriptDuration:0,ThreadTime:.4},after:{Timestamp:idle.counterTo/1000,ScriptDuration:0,ThreadTime:.45},instrumentMs:0});
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
  for(const name of ['history','work','observed-work','private-work','panning','credits','money','fixed-activity'])assert.ok(problems.includes(name+'-red'));
  for(const message of ['script took ','never showed on their card','never showed on their chart'])assert.ok(problems.some(value=>value.includes(message)));
});
for(const fault of ['red','throw','cancel','browser-close','demo-stop'] as const)test('history cannot pass '+fault,async()=>{
  const result=await run(['--scope','history'],fault);assert.equal(result.error,undefined);
  assert.equal(result.exits.length,1);assert.notEqual(result.exits[0],0);assert.deepEqual(order(result.calls),['history']);
  assert.deepEqual(result.statuses,[fault==='cancel'?'cancelled':'failed']);
  for(const name of ['browser-close','demo-stop'])assert.equal(result.calls.filter(call=>call===name).length,1);
  if(fault==='throw')assert.ok(result.logs.includes('history-original'));
});
for(const fault of ['idle','measure','work','observed-work','private-work','panning','credits','money','fixed-activity'] as const)test('dashboard retains '+fault+' failure and the later tail',async()=>{
  const result=await run(['--scope','dashboard'],fault);assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);
  assert.deepEqual(order(result.calls),['openTab',...tail]);assert.deepEqual(result.statuses,['failed']);
  const problems=(result.saved.get('result') as {problems:string[]}).problems;
  assert.ok(fault==='idle'?problems.some(value=>value.startsWith('script took ')):
    fault==='measure'?problems.some(value=>value.includes('never showed on their card')):problems.includes(fault+'-red'));
});
test('retired aligned idle mode rejects before preparing or launching a browser',async()=>{
  const result=await run([],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'1'});
  assert.match(String(result.error),/Unknown or conflicting idle CPU diagnostic mode/);
  assert.deepEqual(result.calls,['freePort']);
});
const diagnostics={QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'profile',QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL:'1',QUOTUM_BENCH_DIAGNOSE_NATIVE:'1',QUOTUM_BENCH_REVERSAL_PROBE:'1'};
for(const scope of ['history','dashboard'])for(const [key,value] of Object.entries(diagnostics))if(scope!=='dashboard'||key!=='QUOTUM_BENCH_DIAGNOSE_IDLE_CPU')test('partial '+scope+' rejects '+key,async()=>{
  const result=await run(['--scope',scope],undefined,{[key]:value});
  assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);assert.deepEqual(result.exits,[]);
});
for(const mode of ['trace','profile'])test('idle '+mode+' dashboard shares the canonical idle window and retains its guards',async()=>{
  const canonical=await run(['--scope','dashboard']),diagnostic=await run(['--scope','dashboard'],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:mode});
  assert.equal(diagnostic.error,undefined);assert.deepEqual(diagnostic.exits,[0],JSON.stringify({logs:diagnostic.logs,calls:diagnostic.calls}));assert.deepEqual(diagnostic.statuses,['diagnostic']);
  assert.deepEqual(order(diagnostic.calls),['openTab']);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.saved.get('idle'))),JSON.parse(JSON.stringify(canonical.saved.get('idle'))));
  for(const name of ['idle-trace-injected','idle-trace-start','idle-trace-stop','idle-trace-bind','idle-trace-receipt','idle-trace-close','browser-close','demo-stop'])assert.equal(diagnostic.calls.filter(call=>call===name).length,1);
  for(const fault of ['idle','idle-retention','opening-metrics','idle-trace'] as const){
    const failed=await run(['--scope','dashboard'],fault,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:mode});
    assert.equal(failed.error,undefined);assert.deepEqual(failed.exits,[1]);assert.deepEqual(failed.statuses,['failed']);
    assert.ok(failed.calls.includes('idle-trace-stop'));assert.ok(failed.calls.includes('idle-trace-close'));
  }
  const history=await run(['--scope','history'],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:mode});assert.match(String(history.error),/scope/i);assert.deepEqual(history.calls,[]);
});
for(const mode of ['PANNING','IDLE','IDLE_TIMING','STARTUP_WAITS'])test('removed '+mode+' diagnostic cannot silently run the canonical gate',async()=>{
  const result=await run([],undefined,{['QUOTUM_BENCH_DIAGNOSE_'+mode]:'1'});
  assert.match(String(result.error),/Removed benchmark diagnostic mode/);assert.deepEqual(result.calls,[]);
});
for(const fault of ['panning-throw','credits-throw','cancel','browser-close','demo-stop'] as const)test('dashboard preserves its failure and cleanup: '+fault,async()=>{
  const result=await run(['--scope','dashboard'],fault);
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[fault==='credits-throw'?2:1]);
  assert.deepEqual(result.statuses,[fault==='cancel'?'cancelled':'failed']);
  for(const name of ['stream-close','browser-close','demo-stop'])assert.equal(result.calls.filter(call=>call===name).length,1);
  if(fault.endsWith('-throw'))assert.ok(result.logs.some(line=>line.includes(fault==='credits-throw'?'credits-original':'panning-original')));
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
  const control=workflow.split('  idle-cpu-control:\n')[1].split(/\n  [\w-]+:/)[0];
  assert.ok(control.includes('timeout-minutes: 15'));assert.ok(control.includes('--ci --scope dashboard'));
});


for(const mode of ['native-trace','native-profile'])for(const scope of ['all','dashboard'])test(mode+' '+scope+' keeps every original dashboard phase and owned cleanup',async()=>{
  const result=await run(['--scope',scope],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:mode});
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[0]);assert.deepEqual(result.statuses,['diagnostic']);
  for(const name of tail)assert.equal(result.calls.filter(call=>call===name).length,1);
  assert.ok(result.calls.indexOf('native-trace-created')>result.calls.indexOf('frequency'));
  assert.equal(result.calls.filter(call=>call==='native-trace-close').length,1);
});
for(const fault of ['panning','panning-throw','cancel'] as const)test('native-trace preserves original '+fault,async()=>{
  const result=await run(['--scope','dashboard'],fault,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:'native-trace'});
  assert.equal(result.error,undefined);assert.deepEqual(result.exits,[1]);assert.deepEqual(result.statuses,[fault==='cancel'?'cancelled':'failed']);
  assert.equal(result.calls.filter(call=>call==='native-trace-close').length,1);
  if(fault==='panning')assert.ok((result.saved.get('result') as {problems:string[]}).problems.includes('panning-red'));
  if(fault==='panning-throw')assert.ok(result.logs.some(line=>line.includes('panning-original')));
});
for(const mode of ['native-trace','native-profile'])test('history still rejects '+mode+' before preparation',async()=>{
  const result=await run(['--scope','history'],undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:mode});assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);
});
for(const mode of ['native-trace','native-profile','trace','profile'])test(mode+' refuses attached, non-CI and conflicting diagnostic runs before preparation',async()=>{
  const cases:[string[],Record<string,string>,boolean][]=[
    [['--scope','dashboard','--cdp','http://example.test'],{},true],
    [['--scope','dashboard'],{},false],
    [[],{QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL:'1'},true],
    [[],{QUOTUM_BENCH_DIAGNOSE_NATIVE:'1'},true],
    [[],{QUOTUM_BENCH_REVERSAL_PROBE:'1'},true],
  ];
  for(const [args,env,ci] of cases){
    const result=await run(args,undefined,{QUOTUM_BENCH_DIAGNOSE_IDLE_CPU:mode,...env},ci);
    assert.match(String(result.error),/conflicting/i);assert.ok(!result.calls.includes('prepare'));
  }
});

test('the pinned history scroll control is diagnostic and fails before startup on invalid provenance or modes',async()=>{
  const env={QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:'1',QUOTUM_BENCH_SOURCE_SHA:'1'.repeat(40),QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:'2'.repeat(64)};
  const ok=await run(['--scope','history'],undefined,env);
  assert.equal(ok.error,undefined);assert.deepEqual(ok.exits,[0]);assert.deepEqual(ok.statuses,['diagnostic']);
  assert.ok(ok.calls.includes('scroll-control'));assert.ok(!ok.calls.includes('openTab'));assert.ok(!ok.calls.includes('panning'));
  assert.equal((ok.saved.get('result') as {status:string}).status,'observations-completed');
  assert.equal((ok.saved.get('scroll-control-disposition') as {status:string}).status,'noC3Observed');
  const provenance=safeEvidence(ok.saved.get('history-scroll-source')) as {sha:string;checkoutHash:string;clientHash:string;expectedClientHash:string};
  assert.equal(provenance.sha,env.QUOTUM_BENCH_SOURCE_SHA);assert.equal(provenance.checkoutHash,env.QUOTUM_BENCH_SOURCE_SHA);
  assert.equal(provenance.clientHash,env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256);assert.equal(provenance.expectedClientHash,env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256);
  for(const fault of ['red','throw','browser-close','demo-stop'] as const){
    const failed=await run(['--scope','history'],fault,env);assert.equal(failed.exits.length,1);assert.notEqual(failed.exits[0],0);assert.deepEqual(failed.statuses,['failed']);
    assert.equal((failed.saved.get('scroll-control-disposition') as {status:string}).status,'inconclusive');
  }
  for(const patch of [{QUOTUM_BENCH_SOURCE_SHA:''},{QUOTUM_BENCH_SOURCE_SHA:'3'.repeat(40)},{QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:'3'.repeat(64)},{TEST_CONTROL_DIRTY:' M tracked.ts'}] as Record<string,string>[]){
    const bad=await run(['--scope','history'],undefined,{...env,...patch});assert.match(String(bad.error),/mismatch/);assert.ok(!bad.calls.includes('prepare'));
  }
  for(const [args,patch,ci] of [[[],{},true],[['--scope','dashboard'],{},true],[['--scope','history'],{},false],
    [['--scope','history','--cdp','http://fixture'],{},true],[['--scope','history'],{QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:'2'},true],
    [['--scope','history'],{QUOTUM_BENCH_DIAGNOSE_NATIVE:'1'},true],[['--scope','history'],{QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL:'1'},true]] as [string[],Record<string,string>,boolean][]){
    const bad=await run(args,undefined,{...env,...patch},ci);assert.match(String(bad.error),/conflicting/);assert.ok(!bad.calls.includes('prepare'));
  }
});

test('manual native tracing uses only the existing dashboard job and rejects mismatched evidence',()=>{
  const workflow=readFileSync(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const job=(name:string)=>workflow.split('  '+name+':\n')[1].split(/\n  [\w-]+:/)[0];
  const selected=(name:string,inputs:object,event='workflow_dispatch',ref='refs/heads/task')=>{
    const expression=job(name).match(/if: \$\{\{ (.+) \}\}/)![1];
    return Boolean(runInNewContext(expression,{inputs,github:{event_name:event,ref},always:()=>true,startsWith:(value:string,prefix:string)=>value.startsWith(prefix)}));
  };
  for(const native_trace of [false,true])for(const native_profile of [false,true]){
    const inputs={diagnostic_ref:'1'.repeat(40),native_trace,native_profile};
    assert.equal(selected('bench-dashboard',inputs),native_trace||native_profile);
    assert.equal(selected('idle-cpu-control',inputs),!native_trace&&!native_profile);
    assert.equal(selected('bench-history',inputs),false);
    assert.equal(selected('bench',inputs),false);
  }
  assert.equal(selected('bench-dashboard',{},'pull_request'),true);
  assert.equal(selected('bench-dashboard',{},'workflow_call','refs/tags/v1.0.0'),false);
  for(const conflicting of [{},{trace_only:true},{native_trace:true},{native_profile:true},{caption_control:true}]){
    const inputs={diagnostic_ref:'1'.repeat(40),native_postmortem_control:true,...conflicting};
    assert.equal(selected('native-postmortem-control',inputs),true);
    for(const job of ['bench-dashboard','bench-history','idle-cpu-control','bench'])assert.equal(selected(job,inputs),false);
  }
  assert.equal(selected('native-postmortem-control',{},'pull_request'),false);
  const scroll={diagnostic_ref:'1'.repeat(40),history_scroll_control:true};
  assert.equal(selected('bench-history',scroll),true);
  for(const name of ['bench-dashboard','idle-cpu-control','native-postmortem-control','bench','hub','dev-tooling'])assert.equal(selected(name,scroll),false);
  assert.equal(job('bench-history').match(/timeout-minutes: (\d+)/)![1],'20');
  const scrollGuard=job('bench-history').match(/run: node -e '([^']+)'/)![1];
  assert.doesNotThrow(()=>runInNewContext(scrollGuard,{process:{env:{CONFLICTING_MODE:'false'}}}));
  assert.throws(()=>runInNewContext(scrollGuard,{process:{env:{CONFLICTING_MODE:'true'}}}),/Choose only/);
  assert.equal(selected('bench-history',{}),true);
  assert.equal(selected('bench',{}),true);
  assert.equal(selected('dev-tooling',{}),true);
  const ordinaryGuard=job('dev-tooling').match(/run: node -e '([^']+)'/)![1];
  assert.doesNotThrow(()=>runInNewContext(ordinaryGuard,{process:{env:{HAS_DIAGNOSTIC_MODE:'false'}}}));
  assert.throws(()=>runInNewContext(ordinaryGuard,{process:{env:{HAS_DIAGNOSTIC_MODE:'true'}}}),/require diagnostic_ref/);
  const nativeGuard=job('native-postmortem-control').match(/run: node -e '([^']+)'/)![1];
  assert.doesNotThrow(()=>runInNewContext(nativeGuard,{process:{env:{}}}));
  for(const key of ['TRACE','PROFILE','NATIVE_TRACE','NATIVE_PROFILE','CAPTION','HISTORY_SCROLL'])assert.throws(()=>runInNewContext(nativeGuard,{process:{env:{[key]:'true'}}}),/Choose only/);
  const script=job('bench-dashboard').split("          node --import tsx --input-type=module <<'JS'\n")[1].split('\n          JS')[0]
    .replace(/^\s*import .+;\n/gm,'');
  const source='1'.repeat(40),hash='2'.repeat(64);
  const verify=(env:Record<string,string|undefined>={},head=source,client:object={status:'available',sha256:hash})=>runInNewContext(script,{
    process:{env:{QUOTUM_BENCH_SOURCE_SHA:source,EXPECTED_CLIENT_SHA256:hash,NATIVE_TRACE:'true',...env}},
    execFileSync:()=>head,clientIdentity:()=>client,console:{log(){}},
  });
  assert.doesNotThrow(()=>verify());
  assert.doesNotThrow(()=>verify({NATIVE_TRACE:'false',NATIVE_PROFILE:'true'}));
  for(const env of [{TRACE_ONLY:'true'},{ORIGINAL_TIMING:'true'},{NATIVE_PROFILE:'true'},{NATIVE_TRACE:'false'},{QUOTUM_BENCH_SOURCE_SHA:'bad'},{EXPECTED_CLIENT_SHA256:'bad'}])assert.throws(()=>verify(env),/diagnostic mode|mismatch/);
  assert.throws(()=>verify({},'3'.repeat(40)),/mismatch/);
  assert.throws(()=>verify({},source,{status:'unavailable'}),/mismatch/);
  assert.throws(()=>verify({},source,{status:'available',sha256:'3'.repeat(64)}),/mismatch/);
});

const suffixEnv={QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:'1',QUOTUM_BENCH_SOURCE_SHA:'1'.repeat(40),QUOTUM_BENCH_EXPECTED_CLIENT_SHA256:'2'.repeat(64),QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX:'1',QUOTUM_BENCH_DIAGNOSTICS_DIR:'/owned/diagnostics'};
test('the fixed suffix follows the retained complete baseline and keeps its result separate',async()=>{
  const out=await run(['--scope','history'],undefined,suffixEnv);
  assert.equal(out.error,undefined);assert.deepEqual(out.exits,[0]);assert.deepEqual(out.statuses,['diagnostic']);
  assert.deepEqual(out.calls.filter(name=>name.startsWith('suffix:')),Array.from({length:12},(_,i)=>[`suffix:${i+1}:history`,`suffix:${i+1}:activity`]).flat());
  const original=out.saved.get('result') as {historyTraffic:{reports:unknown[]};problems:string[]};
  assert.deepEqual(original.problems,[]);assert.equal(original.historyTraffic.reports.length,1);
  assert.deepEqual(safeEvidence(out.saved.get('history-suffix-result')),{mode:'diagnostic',status:'observations-completed',completed:24,expected:24,canonicalPass:false});
  assert.equal((out.saved.get('scroll-control-disposition') as {status:string}).status,'noC3Observed');
  assert.equal(out.calls.filter(name=>name==='suffix-close').length,1);
  assert.ok(out.calls.indexOf('phase:history-suffix')>out.calls.indexOf('history'));
  assert.ok(!out.calls.includes('openTab'));
});
test('a failed or unretained original history result cannot start the suffix',async()=>{
  for(const fault of ['red','throw'] as const){
    const out=await run(['--scope','history'],fault,suffixEnv);
    assert.notEqual(out.exits[0],0);assert.ok(!out.calls.includes('suffix-proxy'));
    if(fault==='red')assert.deepEqual((out.saved.get('result') as {problems:string[]}).problems,['history-red']);
  }
  for(const extra of [{TEST_SUFFIX_BAD_BASELINE:'1'},{TEST_SUFFIX_BIG_BASELINE:'1'}] as Record<string,string>[]){
    const out=await run(['--scope','history'],undefined,{...suffixEnv,...extra});
    assert.notEqual(out.exits[0],0);assert.ok(!out.calls.includes('suffix-proxy'));assert.ok(out.logs.some(line=>line.includes('baseline was not retained')));
  }
});
test('the suffix stops on thrown or returned first failure and preserves the primary error through cleanup',async()=>{
  for(const fault of ['suffix-throw','suffix-budget','suffix-returned-problems','suffix-error-cleanup'] as const){
    const out=await run(['--scope','history'],fault,suffixEnv);
    assert.notEqual(out.exits[0],0);assert.deepEqual(out.calls.filter(name=>name.startsWith('suffix:')),['suffix:1:history']);
    assert.equal(out.calls.filter(name=>name==='suffix-close').length,1);
    assert.equal((out.saved.get('history-suffix-result') as {completed:number}).completed,0);
    assert.equal((out.saved.get('scroll-control-disposition') as {status:string}).status,'inconclusive');
    assert.ok(out.logs.some(line=>line.includes(fault==='suffix-returned-problems'?'History suffix exceeded':'suffix-original')));
    assert.ok(!out.logs.some(line=>line.includes('suffix-close-red')),'cleanup must not replace primary failure');
  }
});
test('suffix cleanup failure and cancellation cannot advertise noC3Observed',async()=>{
  for(const fault of ['suffix-cleanup','browser-close','suffix-cancel'] as const){
    const out=await run(['--scope','history'],fault,suffixEnv);
    assert.notEqual(out.exits[0],0);assert.notEqual((out.saved.get('scroll-control-disposition') as {status:string}).status,'noC3Observed');
    assert.notEqual((out.saved.get('history-suffix-result') as {status?:string}|undefined)?.status,'noC3Observed');
    assert.equal(out.calls.filter(name=>name==='suffix-close').length,1);
    if(fault==='suffix-cancel')assert.deepEqual(out.calls.filter(name=>name.startsWith('suffix:')),['suffix:1:history']);
  }
});
test('the suffix requires its exact internal opt-in and does not alter legacy or Beta callers',async()=>{
  const {QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX:_,...legacy}=suffixEnv;
  const ordinary=await run(['--scope','history'],undefined,legacy);
  assert.deepEqual(ordinary.exits,[0]);assert.ok(!ordinary.calls.includes('suffix-proxy'));
  for(const patch of [{QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:''},{QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX:'2'},{QUOTUM_BENCH_DIAGNOSTICS_DIR:''},{QUOTUM_C3_CHROME:'beta'}] as Record<string,string>[]){
    const out=await run(['--scope','history'],undefined,{...suffixEnv,...patch});
    assert.match(String(out.error),/history suffix/);assert.ok(!out.calls.includes('prepare'));
  }
});
test('the internal suffix environment exists only on the direct history control route',()=>{
  const workflow=readFileSync(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const job=(name:string)=>workflow.split('  '+name+':\n')[1].split(/\n  [\w-]+:/)[0];
  const expression=job('bench-history').match(/QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX: \$\{\{ (.+) \}\}/)![1];
  for(const history_scroll_control of [false,true])for(const compositor_guard_control of [false,true]){
    assert.equal(runInNewContext(expression,{inputs:{history_scroll_control,compositor_guard_control}}),history_scroll_control&&!compositor_guard_control?'1':'');
  }
  assert.equal(workflow.match(/QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX:/g)?.length,1);
  assert.ok(!job('startup-io-control').includes('QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX'));
});
