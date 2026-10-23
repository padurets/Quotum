import {spawn} from 'node:child_process';
import {access, readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {browserProcess, processIdentity, type ProcessIdentity} from './browserProcess.js';
import {deadline} from './deadline.js';

export type NativeCandidate = {pid:number;cpuTime:number};
export type NativeScope = {root:number;live():boolean;observe(signal:AbortSignal):Promise<ProcessIdentity[]>;
  resource?(close:()=>Promise<void>):()=>Promise<void>};
const MAX_OUTPUT = 64 * 1024;
const wait = (ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

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
  let reading=false, current:typeof threads[number]|undefined, omitted=0;
  for(const raw of text.split('\n')) {
    const line=raw.replace(/\x1b\[[0-9;]*m/g,'');
    if(line.startsWith('(lldb) thread backtrace ')){reading=true;continue;}
    if(line.startsWith('(lldb) process detach'))reading=false;
    if(!reading)continue;
    const thread=/^\s*\*?\s*quotum-thread=(\d+) tid=(0x[\da-f]+|\d+)\s*$/i.exec(line);
    if(thread){
      current=undefined;
      if(threads.length===32){omitted++;continue;}
      const index=Number(thread[1]),tid=Number(thread[2]);
      if(Number.isSafeInteger(index)&&Number.isSafeInteger(tid)&&tid>0){current={index,tid,frames:[]};threads.push(current);}
      continue;
    }
    const frame=/^\s*\*?\s*quotum-frame=(\d+) function=(.*)$/.exec(line);
    if(frame&&current){
      if(current.frames.length===16){omitted++;continue;}
      const index=Number(frame[1]);
      if(Number.isSafeInteger(index))current.frames.push({index,kind:frameKind(frame[2]),symbol:!!frame[2]});
    }
  }
  return {threads,omitted};
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
  const report={status:'unavailable',kind:'owned-renderer-after-failure',reason:'largest-cumulative-renderer-cpu',
    fromMs,toMs:null as number|null,intervened:false,released:false,reaped:false,pipesClosed:false,
    candidateCount:0,omittedCandidates:0,pid:0,birth:'',stdoutBytes:0,stderrBytes:0,outputLimited:false,
    exit:null as number|null,cleanup:{term:false,kill:false,killExit:null as number|null},
    threads:[] as ReturnType<typeof nativeFrames>['threads'],omitted:0};
  try {
    if(process.platform!=='linux'||!scope.live()||!scope.resource)return report;
    signal.throwIfAborted();
    const executable=await (async()=>{for(const file of ['/usr/share/swift/usr/bin/lldb','/usr/bin/lldb'])try{await access(file,constants.X_OK);return file;}catch{}return null;})();
    if(!executable)return report;
    const first=await scope.observe(signal),root=first.find(row=>row.pid===scope.root);
    const owned=candidates.filter(row=>Number.isSafeInteger(row.pid)&&Number.isFinite(row.cpuTime)&&row.cpuTime>=0)
      .filter(row=>first.some(value=>value.pid===row.pid&&value.group===scope.root&&value.session===scope.root))
      .sort((a,b)=>b.cpuTime-a.cpuTime||a.pid-b.pid);
    report.candidateCount=owned.length;report.omittedCandidates=Math.max(0,owned.length-1);
    const selected=first.find(row=>row.pid===owned[0]?.pid);
    if(!root||!selected||selected.pid===scope.root)return report;
    const second=await scope.observe(signal),now=await current(selected.pid,signal);
    if(!scope.live()||!second.some(row=>row.pid===root.pid&&row.birth===root.birth)
      ||!second.some(row=>row.pid===selected.pid&&row.birth===selected.birth&&row.group===scope.root&&row.session===scope.root)
      ||!now||now.birth!==selected.birth||now.group!==scope.root||now.session!==scope.root
      ||!['R','S'].includes(now.state)||now.tracer!==0||now.uid!==process.getuid?.())return report;
    signal.throwIfAborted();
    report.pid=now.pid;report.birth=now.birth;
    const format='quotum-thread=${thread.index} tid=${thread.id}\\n';
    const settings=['target.load-script-from-symbol-file false','target.load-cwd-lldbinit false',
      'symbols.enable-external-lookup false','use-color false',`thread-format "${format}"`,
      `thread-stop-format "${format}"`,'frame-format "quotum-frame=${frame.index} function=${function.name-without-args}\\n"'];
    const args=['-c','IFS= read -r gate && [ "$gate" = capture ] && exec /usr/bin/timeout "$@"','native-postmortem',
      '--foreground','--signal=TERM','--kill-after=0.2s','2s',executable,'--no-lldbinit','--batch',
      ...settings.flatMap(value=>['-O','settings set '+value]),'--attach-pid',String(now.pid),
      '-o','thread backtrace all -c 16','-o','process detach'];
    const environment={...process.env,DEBUGINFOD_URLS:''};
    const child=process.getuid?.()===0?spawn('/bin/sh',args,{detached:true,stdio:['pipe','pipe','pipe'],env:environment})
      :spawn('/usr/bin/sudo',['-n','--','/bin/sh',...args],{detached:true,stdio:['pipe','pipe','pipe'],env:environment});
    const helperOwner=browserProcess(child,true);
    report.intervened=child.pid!==undefined;
    const chunks:Buffer[]=[];
    let failed=false;
    const terminate=()=>{if(child.exitCode===null&&child.signalCode===null)try{report.cleanup.term=child.kill('SIGTERM');}catch{}};
    const closed=new Promise<void>(resolve=>{
      child.once('error',()=>{failed=true;});
      child.once('exit',code=>{report.exit=code;report.reaped=true;});
      child.once('close',()=>{report.pipesClosed=true;resolve();});
    });
    child.stdout.on('data',(value:Buffer)=>{
      const room=Math.max(0,MAX_OUTPUT-report.stdoutBytes);report.stdoutBytes+=value.length;
      if(room)chunks.push(value.subarray(0,room));
      if(report.stdoutBytes>MAX_OUTPUT){report.outputLimited=true;void stop();}
    });
    child.stderr.on('data',(value:Buffer)=>{report.stderrBytes+=value.length;});
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
      await deadline(2400,()=>closed,signal);
    }
    catch { /* The bounded release below owns cancellation and escalation. */ }
    finally {
      signal.removeEventListener('abort',cancel);
      await release();
    }
    const parsed=nativeFrames(Buffer.concat(chunks).toString('utf8'));
    report.threads=parsed.threads;report.omitted=parsed.omitted;
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
      &&report.threads.some(row=>row.frames.length)?'observed':'incomplete';
  } catch {report.status=report.intervened?'incomplete':'unavailable';}
  finally {report.toMs=performance.now();}
  return report;
}
