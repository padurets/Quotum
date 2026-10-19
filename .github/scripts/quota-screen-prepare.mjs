import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const [root, output] = process.argv.slice(2);
if (!root || !output || path.resolve(root) === path.resolve(output)) throw Error('Separate source and output roots required');
const hash = text => createHash('sha256').update(text).digest('hex');
const pinned = {
  'hub/bench/index.ts': 'e4232edf51c209e9fe5c1e450f62e438d0f1271436d4fd8e83bbb0d618c740b7',
  'hub/bench/stream.ts': 'fde25574f5a8623c3367ab70bb0819415a0b21aabc2a403cc508a37a1997ed77',
  'hub/ui/lib/period.ts': '7c4b6cc0aa9301d2de015130711c297f23183e31b45d6118cb6e0d0ce1adb93a',
};
const source = Object.fromEntries(Object.entries(pinned).map(([name, sha]) => {
  const text = readFileSync(path.join(root, name), 'utf8');
  if (hash(text) !== sha) throw Error('Source pin mismatch: ' + name);
  return [name, text];
}));
const once = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error('Non-unique source boundary: ' + before.slice(0, 90));
  return text.replace(before, after);
};
let stream = source['hub/bench/stream.ts'];
stream = once(stream, '  close(): void;', '  close(): void;\n  drain(): Promise<void>;');
stream = once(stream, '  void (async () => {', '  const reading = (async () => {');
stream = once(stream, '    close: () => stop.abort(),', '    close: () => stop.abort(),\n    drain: () => reading,');

let period = source['hub/ui/lib/period.ts'];
period = once(period, "        for(const [scope,entry] of previousTapes){\n          if(scope==='quota'){", "        for(const [scope,entry] of previousTapes){\n          if(scope==='quota' && (globalThis as typeof globalThis & {__quotumQuotaPathOmit?:boolean}).__quotumQuotaPathOmit===true)continue;\n          if(scope==='quota'){");

let entry = source['hub/bench/index.ts'];
entry = once(entry, "from './stream.js';", "from './.quota-path-stream.js';");
entry = once(entry, "import {ObservedWork} from './observed.js';", "import {ObservedWork} from './observed.js';\nimport {deadline} from './deadline.js';");
entry = once(entry, '  const evidence = new Evidence();', '  let evidence = new Evidence();');
entry = once(entry, '  const owner = new RunOwner(evidence);', '  let owner = new RunOwner(evidence);');
entry = once(entry, '  let cancelled = false;', '  let cancelled = false;\n  let evidenceFinalized=false;');
entry = once(entry, "    evidence.begin('cleanup');", "    if(!evidenceFinalized)evidence.begin('cleanup');");
entry = once(entry, "    evidence.finish(cancelled ?", "    if(!evidenceFinalized)evidence.finish(cancelled ?");
entry = once(entry, '    heard?.close();', '    heard?.close();\n    try {await deadline(5100, () => heard?.drain() ?? Promise.resolve());} catch {code=1;owner.failures.push(\'stream drain unconfirmed\');}\n    pair.status=\'incomplete\';savePair();');
entry = once(entry, '  const seconds = options.ci ? IDLE.ci : IDLE.full;', `  const pairId = Number(process.env.QUOTUM_SCREEN_PAIR);
  const coin = Number(process.env.QUOTUM_SCREEN_COIN);
  if (!options.ci || options.scope!=='dashboard' || options.cdp || !['0','1'].includes(process.env.QUOTUM_SCREEN_PAIR??'') || !['0','1'].includes(process.env.QUOTUM_SCREEN_COIN??'')
    || [panDiagnostic,idleDiagnostic,idleCpuMode,idleTimingDiagnostic,startupWaitDiagnostic,poolDiagnostic,process.env.QUOTUM_BENCH_DIAGNOSE_NATIVE,process.env.QUOTUM_BENCH_REVERSAL_PROBE].some(Boolean)
    || !process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR) throw new Stop('Exclusive owned dashboard screen inputs required');
  const order = pairId===coin ? [false,true] : [true,false];
  let pairWriteFailed=false;
  const pair:{mode:string;status:string;pair:number;coin:number;order:boolean[];arms:unknown[];demoStopped:boolean;failure?:{kind:string}} = {mode:'diagnostic',status:'planned',pair:pairId,coin,order,arms:[],demoStopped:false};
  const savePair = () => {
    try {
      const text=JSON.stringify(pair);
      if(Buffer.byteLength(text)>64*1024)throw new Stop('Pair receipt exceeds cap');
      writeFileSync(path.join(process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR!,'pair.json'),text,{mode:0o600});
    } catch {pairWriteFailed=true;}
  };
  savePair();
  if(pairWriteFailed)throw new Stop('Initial pair receipt unavailable');
  const seconds = options.ci ? IDLE.ci : IDLE.full;`);
entry = once(entry, '    heard = await hear(address.base, ana.cookie, board);', `    for (let slot=0;slot<2;slot++) {
    if(cancelled||finishing){await finish(1);return;}
    if(slot){evidence=new Evidence();owner=new RunOwner(evidence);browser=undefined;tab=undefined;heard=undefined;evidenceFinalized=false;}
    const omitted=order[slot];
    evidence.save('fixture-timing',timing);
    evidence.save('screen-assignment',{mode:'diagnostic',pair:pairId,coin,slot,omitted});
    pair.status='running';savePair();if(pairWriteFailed)throw new Stop('Pair receipt unavailable');
    heard = await hear(address.base, ana.cookie, board);`);
entry = once(entry, '    const idleBinding = idleTimingDiagnostic || shortIdleProfile ? new ScriptBinding(', '    const idleBinding = true ? new ScriptBinding(');
const historyStart=entry.indexOf("    if(options.scope==='history'){");
const historyEnd=entry.indexOf('    tab = await openTab(browser);',historyStart);
if(historyStart<0||historyEnd<historyStart)throw Error('History-only boundary unavailable');
entry=entry.slice(0,historyStart)+entry.slice(historyEnd);
entry = once(entry, '      }else evidence.save(name,value);', "      }else {if(name==='source-family-1')boundaryBinding=value as typeof boundaryBinding;evidence.save(name,value);}");
entry = once(entry, "    if(shortIdleProfile || idleRoutingDiagnostic)idleBinding?.rememberInjected(1,bootstrapSource,'idle-probe');", "    idleBinding?.rememberInjected(1,bootstrapSource,'idle-probe');");
entry = once(entry, '    heard.reset({from,to});', `    if(cancelled||finishing){await finish(1);return;}
    const activationSource=\`(() => {
      const state=window.__quotumIdleRetention(),at=Date.now();
      if(!state?.settled||!state.quota||state.selection.mode!=='live'||!Number.isFinite(state.retirementAt)||!(at<state.retirementAt&&at<\${planned.quotaBoundary})||Object.hasOwn(globalThis,'__quotumQuotaPathOmit'))throw Error('Screen activation basis unavailable');
      Object.defineProperty(globalThis,'__quotumQuotaPathOmit',{value:\${omitted},writable:false,configurable:false});
      const descriptor=Object.getOwnPropertyDescriptor(globalThis,'__quotumQuotaPathOmit');
      return {at,omitted:descriptor.value,writable:descriptor.writable,configurable:descriptor.configurable,settled:state.settled,retirementAt:state.retirementAt,rows:state.quota.rows.length};
    })()\`;
    const activation=await cdp.evaluate<{at:number;omitted:boolean;writable:boolean;configurable:boolean;settled:boolean;retirementAt:number;rows:number}>(activationSource);
    idleBinding!.rememberInjected(2,activationSource,'idle-probe');
    evidence.save('screen-activation',activation);
    heard.reset({from,to});`);
entry = once(entry, 'scriptMsPerSecond,counterFrom,counterTo,retentionBefore};', 'scriptMsPerSecond,counterFrom,counterTo,retentionBefore,retentionAfter};');
const tailStart = '    const {idle, phaseProblems, actualSeconds, events, boardEvents, deviceContacts, deviceHints, reading, phase, before, after, scriptMsPerSecond,retentionBefore} = await observedIdle();';
const start = entry.indexOf(tailStart), end = entry.indexOf('  } catch (error) {\n    if (finishing) return;', start);
if(start<0||end<start||entry.indexOf(tailStart,start+1)>=0)throw Error('Idle terminal boundary unavailable');
entry=entry.slice(0,start)+`    const {idle,phaseProblems,actualSeconds,scriptMsPerSecond,counterFrom,counterTo,retentionBefore,retentionAfter}=await observedIdle();
    const originalProblems=[...phaseProblems,...idleProblems(idle)];
    const retentionProblems=idleRetentionProblems(retentionBefore,retentionAfter,counterFrom,counterTo,planned.quotaBoundary);
    const otherPhaseProblems=phaseProblems.filter(problem=>!retentionProblems.includes(problem));
    const period=retentionBefore?.selection.periodMs??NaN;
    const due=retentionBefore?.quota?.rows.filter(row=>row.second!==null&&counterFrom<row.second+1+period&&row.second+1+period<counterTo)??[];
    const expectedOmission=omitted&&due.length>0&&retentionProblems.length===due.length&&retentionProblems.every(problem=>problem.startsWith('idle quota prefix did not retire: '))
      &&due.every(row=>{const after=retentionAfter?.quota?.rows.find(next=>next.sourceId===row.sourceId&&next.windowId===row.windowId);return after?.count===row.count&&after.first===row.first&&after.second===row.second&&after.last===row.last;});
    await idleBinding!.afterFamily([1,2]);
    const bindingComplete=boundaryBinding?.status==='complete'&&boundaryBinding.debuggerDisabled===true&&boundaryBinding.injected?.status==='complete';
    const valid=Number.isFinite(scriptMsPerSecond)&&actualSeconds>0&&bindingComplete&&otherPhaseProblems.length===0&&idleObservationProblems(idle).length===0
      &&activation.omitted===omitted&&activation.writable===false&&activation.configurable===false&&activation.settled&&activation.at<=counterFrom
      &&(omitted?expectedOmission:retentionProblems.length===0&&due.length>0);
    const arm={mode:'diagnostic',id:evidence.id,pair:pairId,coin,slot,omitted,valid,bindingComplete,expectedOmission,due:due.length,rows:retentionBefore?.quota?.rows.length,
      seconds:actualSeconds,scriptMsPerSecond,originalProblems:originalProblems.map(reason=>({reason})),otherPhaseProblems:otherPhaseProblems.map(reason=>({reason})),retentionProblems:retentionProblems.map(reason=>({reason})),cleanupComplete:false};
    evidence.save('screen-result',arm);
    heard.close();
    evidence.begin('cleanup');
    try{await deadline(5100,()=>heard!.drain());}catch{owner.failures.push('stream drain unconfirmed');}
    try{await owner.close();}catch{/* Retain the original arm before failing cleanup. */}
    if(cancelled||finishing){await finish(1);return;}
    const launch=browser.launchReport?.() as {cleanup?:{status?:string;reaped?:boolean;pipesClosed?:boolean}}|undefined;
    arm.cleanupComplete=owner.failures.length===0&&launch?.cleanup?.status==='closed'&&launch.cleanup.reaped===true&&launch.cleanup.pipesClosed===true;
    evidence.save('screen-result',arm);
    evidence.finish(originalProblems.length||!valid||!arm.cleanupComplete?'failed':'diagnostic',{browser:launch,failures:owner.failures,streamDrained:!owner.failures.includes('stream drain unconfirmed')});
    evidenceFinalized=true;
    pair.arms.push(arm);savePair();
    if(!valid||!arm.cleanupComplete||pairWriteFailed){await finish(1);return;}
    }
    if(cancelled||finishing){await finish(1);return;}
    await demo.stop();pair.demoStopped=true;
    if(cancelled||finishing){await finish(1);return;}
    pair.status='complete';savePair();process.exit(pairWriteFailed?1:0);
`+entry.slice(end);

const finishStart=entry.indexOf('  const finish = (code: number): Promise<void> =>');
const finishEnd=entry.indexOf('  const set = panningSet(SETS[0]);',finishStart);
if(finishStart<0||finishEnd<finishStart)throw Error('Finish boundary unavailable');
entry=entry.slice(0,finishStart)+`  const finish = (code:number):Promise<void> => finishing ??= (async()=>{
    const currentOwner=owner,currentEvidence=evidence,currentHeard=heard,currentBrowser=browser,finalized=evidenceFinalized;
    currentHeard?.close();
    if(!finalized)currentEvidence.begin('cleanup');
    pair.status='incomplete';savePair();
    const closed=await Promise.allSettled([deadline(5100,()=>currentHeard?.drain()??Promise.resolve()),currentOwner.close()]);
    if(closed[0].status==='rejected'){code=1;currentOwner.failures.push('stream drain unconfirmed');}
    if(closed[1].status==='rejected')code=1;
    try{await demo.stop();pair.demoStopped=true;}catch{code=1;}
    savePair();if(pairWriteFailed)code=1;
    if(!finalized)currentEvidence.finish(cancelled?'cancelled':'failed',{browser:currentBrowser?.launchReport?.(),failures:currentOwner.failures});
    process.exit(code);
  })();
`+entry.slice(finishEnd);
entry=once(entry,"    evidence.save('failure', {status: 'failed', kind: error instanceof Stop ? 'fixture' : 'runtime'});", "    if(!evidenceFinalized)evidence.save('failure', {status: 'failed', kind: error instanceof Stop ? 'fixture' : 'runtime'});\n    pair.failure={kind:error instanceof Stop?'fixture':'runtime'};savePair();");
entry=once(entry,"    if(error instanceof ChromeLaunchError)evidence.save('browser',error.report);", "    if(!evidenceFinalized&&error instanceof ChromeLaunchError)evidence.save('browser',error.report);");

const outputs={
  'hub/bench/.quota-path-screen.ts':entry,
  'hub/bench/.quota-path-stream.ts':stream,
  'hub/ui/lib/period.ts':period,
};
for(const [name,text] of Object.entries(outputs)){
  mkdirSync(path.dirname(path.join(output,name)),{recursive:true});
  writeFileSync(path.join(output,name),text,{flag:'wx'});
}
writeFileSync(path.join(output,'source-pins.json'),JSON.stringify({inputs:pinned,outputs:Object.fromEntries(Object.entries(outputs).map(([name,text])=>[name,{bytes:Buffer.byteLength(text),sha256:hash(text)}]))},null,2),{flag:'wx'});
console.log(JSON.stringify({status:'prepared',files:Object.keys(outputs)}));
