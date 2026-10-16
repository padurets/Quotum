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
type Fault='red'|'throw'|'cancel'|'browser-close'|'demo-stop'|'idle'|'measure'|'work'|'private-work'|'panning'|'credits'|'money'|'all-red'|'panning-throw'|'credits-throw'|'opening-metrics';
async function run(args:string[]=[],fault?:Fault,env:Record<string,string>={},ci=true,startedAt=Date.parse('2026-10-15T12:00:10Z')) {
  const calls:string[]=[],saved=new Map<string,unknown>(),exits:number[]=[],statuses:string[]=[],logs:string[]=[];
  const listeners=new Map<string,()=>void>(),waits:number[]=[];let now=startedAt,phaseStart=now,metricReads=0;
  let terminal!:()=>void;const exited=new Promise<void>(resolve=>{terminal=resolve;});
  const mark=(name:string)=>{calls.push(name);};
  const red=(name:string)=>fault===name||fault==='all-red';
  const problems=(name:string)=>red(name)?[name+'-red']:[];
  const reading={commits:0,instrumentMs:0,renders:[],mutations:[]};
  const events=new EventCounts();for(let i=0;i<5;i++)events.push('event: ping\ndata: {}\n\n');
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
  class Stop extends Error {}
  class ChromeLaunchError extends Error {}
  const panning=async()=>{mark('panning');if(fault==='panning-throw')throw Error('panning-original');
    if(fault==='cancel'){listeners.get('SIGTERM')!();await exited;throw Error('cancelled-panning');}
    return{problems:problems('panning'),reports:['quota','session','activity','budget','funds'].flatMap(initiator=>['24h','30d'].map(period=>({initiator,period,frames:[16],latency:[16],
      ...(['cpu','trace'].includes(env.QUOTUM_BENCH_DIAGNOSE_PANNING)?{timeline:{status:'complete',count:1,omitted:0,entries:[{id:1,at:now,kind:'frame',canary:'private-timeline-canary'}]}}:{})})))};
  };
  const context={exports:{},process:{argv:['node','index.ts',...(ci?['--ci']:[]),...args],env:{CI:'1',...env},pid:1,platform:'linux',
      on:(name:string,fn:()=>void)=>{listeners.set(name,fn);},exit:(code:number)=>{exits.push(code);terminal();}},
    Date:class extends Date {static now(){return now;}},console:{log:()=>{},error:(value:unknown)=>{logs.push(String(value));}},path,Buffer,RunOwner,Demo,Evidence,Requests,Stop,ChromeLaunchError,
    USAGE:'fixture usage',IDLE:{ci:120,full:300},SHOWN_MS:30_000,MEASURED:'fixture',HISTORY_BYTES_PER_MEASUREMENT,
    SETS:[set],fixtureTiming,panningSet:(value:unknown)=>value,people:()=>[{id:'ana'}],freePort:async()=>{mark('freePort');return 1234;},
    addressOf:()=>({base:'http://127.0.0.1:1234'}),prepare:async()=>{mark('prepare');},findChrome:()=>'/unused/chrome',
    seedPanningBudgets:()=>{mark('seed');},hear:async()=>({close:()=>{mark('stream-close');},reset:()=>{},counts:()=>events.counts(),boardCounts:()=>events.boardCounts(),contacts:()=>events.contacts(),hints:()=>events.hints()}),
    launchChrome:async()=>{mark('launch');return browser;},openTab:async()=>{mark('openTab');return{cdp};},
    historyTraffic:async()=>{mark('history');if(fault==='throw')throw new Stop('history-original');
      if(fault==='cancel'){listeners.get('SIGTERM')!();await exited;}
      return{reports:[{name:'history-marker'}],problems:red('red')?['history-red']:[]};},
    probeScript:()=>'',sleep:async(ms:number)=>{waits.push(ms);now+=Math.max(0,ms);},say:(value:string)=>{logs.push(value);},
    metrics:async()=>{const opening=metricReads++===0;
      if(opening&&fault==='opening-metrics')now=(saved.get('idle-plan') as {quotaBoundary:number}).quotaBoundary+1;
      return{Timestamp:now/1000,ScriptDuration:!opening&&red('idle')?0.1:0};},
    cellOf,idleProblems,chartProblems,measuredProblems,percentile,idlePhaseProblems,idlePhaseScript,idleWindow,overviewCards,stillProblems,warmUntil,
    delta,round,scriptPerSecond,tally,measure:async()=>{mark('measure');return{source:'fixture',from:now,to:now,
      latencies:[red('measure')?Infinity:1],chartLatencies:[red('measure')?Infinity:1],historyBytes:1,
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
  };
  runInNewContext(code,context);
  const selected=(context as unknown as {selected:{main():Promise<void>;parseArgs(args:string[]):unknown}}).selected;
  let error:unknown;try{await selected.main();}catch(caught){error=caught;}
  return{calls,saved,exits,statuses,logs,error,waits,fixtureStart:stand.start,parse:selected.parseArgs};
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
for(const scope of ['history','dashboard'])for(const [key,value] of Object.entries(diagnostics).filter(([key])=>scope!=='dashboard'||key!=='QUOTUM_BENCH_DIAGNOSE_PANNING'))test('partial '+scope+' rejects '+key,async()=>{
  const result=await run(['--scope',scope],undefined,{[key]:value});
  assert.match(String(result.error),/scope/i);assert.deepEqual(result.calls,[]);assert.deepEqual(result.exits,[]);
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
