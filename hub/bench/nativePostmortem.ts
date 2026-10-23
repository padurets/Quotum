import {spawn} from 'node:child_process';
import {access, readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {browserProcess, processIdentity, type ProcessIdentity} from './browserProcess.js';
import {deadline} from './deadline.js';

export type NativeCandidate = {pid:number;cpuTime:number;birth?:string};
export type NativeScope = {root:number;live():boolean;observe(signal:AbortSignal):Promise<ProcessIdentity[]>;
  resource?(close:()=>Promise<void>):()=>Promise<void>};
const MAX_OUTPUT = 64 * 1024;

/** Use the fixed system debugger only; never search client-controlled paths. */
export async function nativeDebugger(){
  try{await access('/usr/bin/gdb',constants.X_OK);return '/usr/bin/gdb';}catch{return null;}
}

/** Function classes, never native arguments, addresses, paths or arbitrary symbols. */
function frameKind(name:string) {
  return /\bcc::CompletionEvent::Wait\b/.test(name)?'completion-event'
    : /\bcc::LayerTreeHost::WaitForProtectedSequenceCompletion\b/.test(name)?'protected-sequence'
    : /\bcc::ProxyMain::BeginMainFrame\b/.test(name)?'begin-main-frame'
    : /\bbase::WaitableEvent::(?:TimedWait|Wait)/.test(name)?'waitable-event'
    : /\bfutex\b|__futex_/.test(name)?'futex'
    : /\bpthread_cond_(?:timed)?wait\b/.test(name)?'condition'
    : /\b(?:epoll_wait|poll|select)\b/.test(name)?'poll'
    : /\bcontent::RendererMain\b/.test(name)?'renderer-main':'other';
}

export function nativeFrames(text:string) {
  const threads:{index:number;tid:number;frames:{index:number;kind:string;symbol:boolean}[]}[]=[];
  let reading=false,started=false,ended=false,current:typeof threads[number]|undefined,omitted=0,partial=false;
  for(const raw of text.split('\n')){
    const line=raw.replace(/\x1b\[[0-9;]*m/g,'');
    if(line==='QGDB_BT_BEGIN'){if(started||ended)partial=true;started=true;reading=true;continue;}
    if(line==='QGDB_BT_DONE'){if(!reading)partial=true;ended=true;reading=false;continue;}
    if(!reading)continue;
    if(/Backtrace stopped:|Cannot access memory|Unable to read|No stack\.|Error while/i.test(line))partial=true;
    const thread=/^Thread (\d+) \(.*\bLWP (\d+)\)/.exec(line);
    if(thread){
      current=undefined;
      const index=Number(thread[1]),tid=Number(thread[2]);
      if(threads.length===32){omitted++;partial=true;continue;}
      if(!Number.isSafeInteger(index)||!Number.isSafeInteger(tid)||tid<=0||threads.some(t=>t.index===index||t.tid===tid)){partial=true;continue;}
      current={index,tid,frames:[]};threads.push(current);continue;
    }
    if(/^Thread /.test(line))partial=true;
    const frame=/^#(\d+)\s+(.*)$/.exec(line);
    if(frame){
      if(!current){partial=true;continue;}
      if(current.frames.length===16){omitted++;partial=true;continue;}
      const index=Number(frame[1]);
      if(index!==current.frames.length){partial=true;continue;}
      current.frames.push({index,kind:frameKind(frame[2]),symbol:!/^\s*(?:0x[\da-f]+\s+in\s+)?\?\?/i.test(frame[2])});
      continue;
    }
    if(line.trim()&&!/^\s*(?:at |from |\(More stack frames follow\.\.\.\)$)/.test(line))partial=true;
  }
  partial ||= !started||!ended||reading||!threads.length||threads.some(thread=>!thread.frames.length);
  return {threads,omitted,partial};
}

/** Fixed debugger markers identify boundaries without returning native text. */
export function nativeProgress(text:string){
  const markers=text.match(/^QGDB_(?:SETTINGS|ATTACH|ATTACHED|BT_BEGIN|BT_DONE|DETACHED)$/gm)??[];
  return {ordered:markers.join(',')==='QGDB_SETTINGS,QGDB_ATTACH,QGDB_ATTACHED,QGDB_BT_BEGIN,QGDB_BT_DONE,QGDB_DETACHED',settingsCommandSeen:/^QGDB_SETTINGS$/m.test(text),attachCommandSeen:/^QGDB_ATTACH$/m.test(text),
    stopAcknowledged:/^QGDB_ATTACHED$/m.test(text),backtraceCommandSeen:/^QGDB_BT_BEGIN$/m.test(text),
    detachCommandSeen:/^QGDB_BT_DONE$/m.test(text),detachAcknowledged:/^QGDB_DETACHED$/m.test(text)};
}

type NativeMainFrame = {index:number;status:'file-location';buildId:string;fileOffset:number}
  | {index:number;status:'unknown';reason:string};
type NativeMainLocations = {status:'observed'|'unavailable';tid:number;frames:NativeMainFrame[]};

/** Module-relative file positions supplement names; they never qualify a symbol. */
export function nativeMainLocations(text:string,pid:number,frameCount:number):NativeMainLocations {
  const unavailable:NativeMainLocations={status:'unavailable',tid:pid,frames:[]};
  const lines=text.split('\n'),records=lines.filter(line=>line.startsWith('QGDB_MAIN '));
  const begin=lines.indexOf('QGDB_BT_DONE'),end=lines.indexOf('QGDB_DETACHED');
  if(records.length!==1||begin<0||end<=begin||lines.indexOf(records[0])<=begin||lines.indexOf(records[0])>=end)return unavailable;
  try{
    const value=JSON.parse(records[0].slice('QGDB_MAIN '.length));
    if(!value||value.tid!==pid||!Number.isSafeInteger(pid)||pid<=0||!Array.isArray(value.frames))return unavailable;
    if(value.status==='unavailable'&&value.frames.length===0)return unavailable;
    if(value.status!=='observed'||!Number.isInteger(frameCount)||frameCount<1||frameCount>16||value.frames.length!==frameCount)return unavailable;
    const reasons=['anonymous-executable','non-executable','unmapped','identity-unavailable','ambiguous','deleted',
      'offset-outside-file','frame-unavailable','mapping-changed','unsupported'];
    const frames:NativeMainFrame[]=[];
    for(const [index,frame] of value.frames.entries()){
      if(!frame||frame.index!==index)return unavailable;
      if(frame.status==='file-location'&&typeof frame.buildId==='string'&&/^(?:[a-f0-9]{2}){4,64}$/.test(frame.buildId)
        &&Number.isSafeInteger(frame.fileOffset)&&frame.fileOffset>=0){
        frames.push({index,status:'file-location',buildId:frame.buildId,fileOffset:frame.fileOffset});
      }else if(frame.status==='unknown'&&reasons.includes(frame.reason))frames.push({index,status:'unknown',reason:frame.reason});
      else return unavailable;
    }
    return {status:'observed',tid:pid,frames};
  }catch{return unavailable;}
}

const current = async(pid:number,signal?:AbortSignal)=>{
  const [stat,status]=await Promise.all([
    readFile(`/proc/${pid}/stat`,{encoding:'utf8',signal}),
    readFile(`/proc/${pid}/status`,{encoding:'utf8',signal}),
  ]);
  const identity=processIdentity(pid,stat),traced=/^TracerPid:\s+(\d+)/m.exec(status),uid=/^Uid:\s+(\d+)/m.exec(status);
  return identity&&traced&&uid?{...identity,tracer:Number(traced[1]),uid:Number(uid[1])}:null;
};

/** Only a failed owned browser grants this authority; the selected renderer is not a page binding. */
export async function nativePostmortem(scope:NativeScope,candidates:NativeCandidate[],signal:AbortSignal) {
  const fromMs=performance.now();
  const report={status:'unavailable',kind:'owned-renderer-after-failure',reason:'largest-cumulative-renderer-cpu',executable:'unavailable',
    fromMs,toMs:null as number|null,intervened:false,released:false,reaped:false,pipesClosed:false,
    candidateCount:0,omittedCandidates:0,pid:0,birth:'',outputBytes:0,diagnosticBytes:0,outputLimited:false,
    progress:nativeProgress(''),
    sampling:{reads:0,firstTrace:null as {fromMs:number;toMs:number;tracerId:number}|null,
      firstStop:null as {fromMs:number;toMs:number;state:string}|null},
    helperSample:null as {fromMs:number;toMs:number;processes:ProcessIdentity[];omitted:number}|null,
    exit:null as number|null,cleanup:{term:false,kill:false,killExit:null as number|null},
    partial:false,
    threads:[] as ReturnType<typeof nativeFrames>['threads'],omitted:0,
    mainLocations:{status:'unavailable',tid:0,frames:[]} as NativeMainLocations};
  try {
    if(process.platform!=='linux'||!scope.live()||!scope.resource)return report;
    signal.throwIfAborted();
    const executable=await nativeDebugger();
    if(!executable)return report;
    report.executable=executable.slice(executable.lastIndexOf('/')+1);
    const first=await scope.observe(signal),root=first.find(row=>row.pid===scope.root);
    const owned=candidates.filter(row=>Number.isSafeInteger(row.pid)&&Number.isFinite(row.cpuTime)&&row.cpuTime>=0)
      .filter(row=>first.some(value=>value.pid===row.pid&&value.group===scope.root&&value.session===scope.root))
      .sort((a,b)=>b.cpuTime-a.cpuTime||a.pid-b.pid);
    report.candidateCount=owned.length;report.omittedCandidates=Math.max(0,owned.length-1);
    const selected=first.find(row=>row.pid===owned[0]?.pid);
    if(!root||!selected||selected.pid===scope.root
      ||owned[0].birth!==undefined&&owned[0].birth!==selected.birth)return report;
    const second=await scope.observe(signal),now=await current(selected.pid,signal);
    if(!scope.live()||!second.some(row=>row.pid===root.pid&&row.birth===root.birth)
      ||!second.some(row=>row.pid===selected.pid&&row.birth===selected.birth&&row.group===scope.root&&row.session===scope.root)
      ||!now||now.birth!==selected.birth||now.group!==scope.root||now.session!==scope.root
      ||!['R','S'].includes(now.state)||now.tracer!==0||now.uid!==process.getuid?.())return report;
    signal.throwIfAborted();
    report.pid=now.pid;report.birth=now.birth;
    const locations=await readFile(new URL('./nativeMainLocations.py',import.meta.url),{encoding:'utf8',signal});
    if(locations.split('EXPECTED_PID = 0').length!==2)throw new Error('native location source unavailable');
    const mainCommand='python exec('+JSON.stringify(locations.replace('EXPECTED_PID = 0','EXPECTED_PID = '+now.pid))+')';
    const settings=['set auto-load off','set debuginfod enabled off','set print frame-arguments none',
      'set print entry-values no','set print frame-info location','set libthread-db-search-path $sdir',
      'echo QGDB_SETTINGS\\n','echo QGDB_ATTACH\\n'];
    const args=['-c','IFS= read -r gate && [ "$gate" = capture ] && exec /usr/bin/timeout "$@"','native-postmortem',
      '--foreground','--signal=TERM','--kill-after=0.2s','2s',executable,'-nx','-batch',
      ...settings.flatMap(value=>['-iex',value]),'--pid',String(now.pid),
      '-ex','echo QGDB_ATTACHED\\n','-ex','echo QGDB_BT_BEGIN\\n',
      '-ex','thread apply all -c bt 16','-ex','echo QGDB_BT_DONE\\n',
      '-ex',mainCommand,
      '-ex','detach','-ex','echo QGDB_DETACHED\\n'];
    const environment={...process.env,DEBUGINFOD_URLS:''};
    const child=process.getuid?.()===0?spawn('/bin/sh',args,{detached:true,stdio:['pipe','pipe','pipe'],env:environment})
      :spawn('/usr/bin/sudo',['-n','--','/bin/sh',...args],{detached:true,stdio:['pipe','pipe','pipe'],env:environment});
    const helperOwner=browserProcess(child,true);
    report.intervened=child.pid!==undefined;
    const chunks:Buffer[]=[],diagnostics:Buffer[]=[];let retainedBytes=0;
    let failed=false;
    const terminate=()=>{if(child.exitCode===null&&child.signalCode===null)try{report.cleanup.term=child.kill('SIGTERM');}catch{}};
    const closed=new Promise<void>(resolve=>{
      child.once('error',()=>{failed=true;});
      child.once('exit',code=>{report.exit=code;report.reaped=true;});
      child.once('close',()=>{report.pipesClosed=true;resolve();});
    });
    child.stdout.on('data',(value:Buffer)=>{
      const room=Math.max(0,MAX_OUTPUT-retainedBytes);report.outputBytes+=value.length;retainedBytes+=Math.min(room,value.length);
      if(room)chunks.push(value.subarray(0,room));
      if(report.outputBytes+report.diagnosticBytes>MAX_OUTPUT){report.outputLimited=true;void stop();}
    });
    child.stderr.on('data',(value:Buffer)=>{
      const room=Math.max(0,MAX_OUTPUT-retainedBytes);report.diagnosticBytes+=value.length;retainedBytes+=Math.min(room,value.length);
      if(room)diagnostics.push(value.subarray(0,room));
      if(report.outputBytes+report.diagnosticBytes>MAX_OUTPUT){report.outputLimited=true;void stop();}
    });
    child.stdin.on('error',()=>{failed=true;});
    let stopping:Promise<void>|undefined;
    const stop=()=>stopping??=deadline(1000,async cleanup=>{
      // Retain the tracing backend while its parent is alive; killing a frontend
      // first can orphan a server that still has the renderer stopped.
      await deadline(150,pending=>helperOwner.observe(pending),cleanup).catch(()=>[]);
      terminate();
      await deadline(150,()=>closed).catch(()=>{});
      {
        const owned=await deadline(150,pending=>helperOwner.observe(pending),cleanup).catch(()=>[]);
        const workers=owned.filter(value=>!['Z','X'].includes(value.state));
        // sudo may own a root debugger. Recheck identities before asking it to
        // kill only our helper group and any observed escaping descendants.
        const targets:string[]=[];
        for(const row of workers){
          const now=await deadline(50,pending=>current(row.pid,pending),cleanup).catch(()=>null);
          cleanup.throwIfAborted();
          if(!now||now.birth!==row.birth)continue;
          const group=now.group===child.pid&&now.session===child.pid;
          const target=String(group?-child.pid!:now.pid);
          if(!targets.includes(target))targets.push(target);
        }
        if(targets.length){
          cleanup.throwIfAborted();
          // Use Node's syscall wrapper: external kill versions disagree about
          // parsing a negative group ID, even after an option delimiter.
          const args=['-e','for(const id of process.argv.slice(1))try{process.kill(Number(id),"SIGKILL")}catch(error){if(error.code!=="ESRCH")process.exitCode=1}',
            '--',...targets];
          const killer=process.getuid?.()===0?spawn(process.execPath,args,{stdio:'ignore'})
            :spawn('/usr/bin/sudo',['-n','--',process.execPath,...args],{stdio:'ignore'});
          const killed=new Promise<void>(resolve=>{killer.once('error',()=>resolve());killer.once('close',()=>resolve());});
          await deadline(200,()=>killed,cleanup).catch(()=>{try{killer.kill('SIGKILL');}catch{}killer.unref();});
          report.cleanup.kill=true;report.cleanup.killExit=killer.exitCode;
        }
        await deadline(200,()=>closed).catch(()=>{});
      }
    }).catch(()=>{}).finally(()=>{
      if(!report.pipesClosed){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}
    });
    const cancel=()=>{void stop();};
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    const release=scope.resource(stop);
    try {
      // No debugger starts until the detached helper's identity is retained.
      const anchored=await deadline(200,pending=>helperOwner.observe(pending),signal);
      if(!anchored.some(row=>row.pid===child.pid&&row.group===child.pid&&row.session===child.pid))throw new Error('helper identity unavailable');
      const attach=await current(now.pid,signal);
      if(!scope.live()||!attach||attach.birth!==now.birth||attach.group!==scope.root||attach.session!==scope.root
        ||!['R','S'].includes(attach.state)||attach.tracer!==0||attach.uid!==process.getuid?.())throw new Error('renderer identity changed');
      signal.throwIfAborted();
      child.stdin.end('capture\n');
      await deadline(2400,async pending=>{
        void (async()=>{
          await wait(1000,undefined,{signal:pending});
          const fromMs=performance.now(),rows=await deadline(150,signal=>helperOwner.observe(signal),pending);
          pending.throwIfAborted();
          report.helperSample={fromMs,toMs:performance.now(),processes:rows.slice(0,16),omitted:Math.max(0,rows.length-16)};
        })().catch(()=>{});
        // These bracketed points cannot establish continuous tracing or absence
        // between reads. The existing helper wait owns their cancellation.
        void (async()=>{
          while(!pending.aborted){
            const fromMs=performance.now(),row=await current(now.pid,pending),toMs=performance.now();
            pending.throwIfAborted();
            if(!row||row.birth!==now.birth)return;
            report.sampling.reads++;
            if(row.tracer&&!report.sampling.firstTrace)report.sampling.firstTrace={fromMs,toMs,tracerId:row.tracer};
            if(['T','t'].includes(row.state)&&!report.sampling.firstStop)report.sampling.firstStop={fromMs,toMs,state:row.state};
            await wait(25,undefined,{signal:pending});
          }
        })().catch(()=>{});
        await closed;
      },signal);
    }
    catch { /* The bounded release below owns cancellation and escalation. */ }
    finally {
      signal.removeEventListener('abort',cancel);
      await release();
    }
    const transcript=Buffer.concat(chunks).toString('utf8');
    report.progress=nativeProgress(transcript);
    const parsed=nativeFrames(transcript);
    parsed.partial ||= Buffer.concat(diagnostics).toString('utf8').trim().length>0;
    report.threads=parsed.threads;report.omitted=parsed.omitted;report.partial=parsed.partial;
    report.mainLocations=nativeMainLocations(transcript,now.pid,parsed.threads.find(thread=>thread.tid===now.pid)?.frames.length??0);
    // A debugger frontend can exit before its native tracing backend detaches.
    await deadline(200,async pending=>{
      for(;;){
        const after=await current(now.pid,pending);
        if(!after||after.birth!==now.birth)return;
        if(after.tracer===0&&!['T','t'].includes(after.state)){report.released=true;return;}
        await wait(10);
      }
    }).catch(()=>{});
    report.status=!failed&&report.exit===0&&!report.outputLimited&&report.released&&report.reaped&&report.pipesClosed
      &&!report.partial&&Object.values(report.progress).every(Boolean)&&report.threads.some(row=>row.frames.length)?'observed':'incomplete';
  } catch {report.status=report.intervened?'incomplete':'unavailable';}
  finally {report.toMs=performance.now();}
  return report;
}
