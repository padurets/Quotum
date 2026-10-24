import {spawn,type ChildProcess} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {deadline} from './deadline.js';

export type ProcessIdentity = {pid: number; parent: number; group: number; session: number; birth: string; state: string;
  minorFaults: number | null; majorFaults: number | null; userTicks: number | null; systemTicks: number | null; blockIoTicks: number | null};
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Reuse the ownership read for counters; names and arbitrary fields never leave this parser. */
export function processIdentity(pid: number, stat: string): ProcessIdentity | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fields.length <= 19 || !/^[RSDZTtXxKWPI]$/.test(fields[0]) || ![1,2,3,19].every(i => /^\d+$/.test(fields[i]))) return null;
  const counter = (i: number) => /^\d+$/.test(fields[i] ?? '') && Number.isSafeInteger(Number(fields[i])) ? Number(fields[i]) : null;
  return {pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), birth: fields[19],
    minorFaults: counter(7), majorFaults: counter(9), userTicks: counter(11), systemTicks: counter(12), blockIoTicks: counter(39)};
}

export type KernelProbe = {status:'observed'|'unknown'|'skipped';reason:string;pid:number;birth:string|null;helperPid:number|null;
  wait:{kind:string;name:string|null};identityStates:{before:{state:string|null};after:{state:string|null}};syscall:number|null;fd:{kind:string};syscallStable:boolean|null;identityStable:boolean|null;beforeTermination:boolean|null;outputBytes:number;diagnosticBytes:number;
  reaped:boolean;pipesClosed:boolean;released:boolean;fromMs:number;toMs:number};

/** One postfailure child isolates proc reads; no kernel operation runs in the owner's libuv pool. */
export async function kernelProbe(root:ProcessIdentity|undefined,endsAt:number,signal:AbortSignal):Promise<KernelProbe> {
  const fromMs=performance.now(),uid=process.getuid?.();
  const base:KernelProbe={status:'skipped',reason:'guard',pid:root?.pid??0,birth:root?.birth??null,helperPid:null,wait:{kind:'unavailable',name:null},identityStates:{before:{state:null},after:{state:null}},syscall:null,fd:{kind:'unavailable'},syscallStable:null,identityStable:null,beforeTermination:null,outputBytes:0,diagnosticBytes:0,reaped:true,pipesClosed:true,released:true,fromMs,toMs:fromMs};
  if(process.platform!=='linux'||process.arch!=='x64'||uid===undefined||signal.aborted||!root||root.parent!==process.pid||root.group!==root.pid||root.session!==root.pid||endsAt-performance.now()<=300)return base;
  const source=String.raw`
const fs=require('node:fs');
const parse=(id,stat)=>{const head=/^(\d+) \(/.exec(stat),end=stat.lastIndexOf(')');if(!head||head[1]!==String(id)||end<head[0].length)return null;const f=stat.slice(end+2).trim().split(/\s+/);if(f.length<=19||!/^[RSDZTtXxKWPI]$/.test(f[0])||![1,2,3,19].every(i=>/^\d+$/.test(f[i]))||![1,2,3].every(i=>Number.isSafeInteger(Number(f[i]))))return null;return{state:f[0],parent:Number(f[1]),group:Number(f[2]),session:Number(f[3]),birth:f[19]};};
const expected=JSON.parse(process.argv[1]),[pid,birth,parent,group,session,uid]=expected;
const out={pid,birth,wait:'unavailable',waitSymbol:null,stateBefore:null,stateAfter:null,syscall:null,fdKind:'unavailable',syscallStable:null,identityStable:false,reason:'identity'};
const read=(file,cap)=>{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);try{const b=Buffer.alloc(cap+1),n=fs.readSync(fd,b,0,b.length,0);if(n>cap)throw 0;return b.toString('utf8',0,n);}finally{fs.closeSync(fd);}};
const same=()=>{const row=parse(pid,read('/proc/'+pid+'/stat',4096)),u=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(read('/proc/'+pid+'/status',16384));return row&&row.birth===birth&&row.parent===parent&&row.group===group&&row.session===session&&u&&u.slice(1).every(x=>Number(x)===uid)&&process.getuid()===uid&&process.ppid===parent?row:null;};
const kind=s=>/^(?:__)?futex_wait(?:_queue(?:_me)?)?$/.test(s)?'futex':/^(?:ep_poll|do_epoll_wait|poll_schedule_timeout|do_poll|do_select)$/.test(s)?'poll':/^(?:hrtimer_nanosleep|do_nanosleep)$/.test(s)?'timer':/^(?:pipe_read|pipe_write)$/.test(s)?'pipe':s==='do_wait'?'child':/^(?:io_schedule|folio_wait_bit_common)$/.test(s)?'io':!s||s==='0'?'unavailable':'unknown';
let before;try{
 if(Number.isSafeInteger(pid)&&pid>0&&/^\d+$/.test(birth)&&parent>0&&group===pid&&session===pid&&Number.isSafeInteger(uid)&&(before=same())){out.stateBefore=before.state;
  try{const symbol=read('/proc/'+pid+'/wchan',128).trim();out.wait=kind(symbol);if(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(symbol)&&!/^[A-Fa-f0-9]+$/.test(symbol))out.waitSymbol=symbol;}catch{}
  let call;try{call=read('/proc/'+pid+'/syscall',1024).trim();const fields=call.split(/\s+/);if(/^\d+$/.test(fields[0])&&Number(fields[0])<=1024){out.syscall=Number(fields[0]);if([0,1,17,18,74,75].includes(out.syscall)&&/^0x[\da-f]+$|^\d+$/.test(fields[1])){const fd=Number(fields[1]);if(Number.isSafeInteger(fd)&&fd>=0&&fd<=1048576){const s=fs.statSync('/proc/'+pid+'/fd/'+fd);out.fdKind=s.isFile()?'regular':s.isFIFO()?'pipe':s.isSocket()?'socket':s.isDirectory()?'directory':s.isCharacterDevice()||s.isBlockDevice()?'device':'other';}}}out.syscallStable=read('/proc/'+pid+'/syscall',1024).trim()===call;if(!out.syscallStable)out.fdKind='unavailable';}catch{out.fdKind='unavailable';}
  const after=same();if(after){out.identityStable=true;out.stateAfter=after.state;out.reason=out.wait!=='unknown'&&out.wait!=='unavailable'||out.syscall!==null?'sampled':'unavailable';}else{out.wait='unavailable';out.syscall=null;out.fdKind='unavailable';out.syscallStable=null;}
 }
}catch{}
if(!out.identityStable){out.waitSymbol=null;out.stateBefore=null;out.stateAfter=null;out.wait='unavailable';out.syscall=null;out.fdKind='unavailable';out.syscallStable=null;}
process.stdout.write(JSON.stringify(out)+'\n');`;
  if(signal.aborted||endsAt-performance.now()<=300)return {...base,toMs:performance.now()};
  const until=Math.min(fromMs+200,endsAt-100);let child:ChildProcess;
  try{child=spawn(process.execPath,['-e',source,JSON.stringify([root.pid,root.birth,root.parent,root.group,root.session,uid])],{stdio:['ignore','pipe','pipe'],env:{LANG:'C'}});}catch{return {...base,status:'unknown',reason:'spawn',toMs:performance.now()};}
  return await new Promise<KernelProbe>(resolve=>{
    let done=false,reaped=false,pipesClosed=false,exit:number|null=null,reason='running',outputBytes=0,diagnosticBytes=0,timer:ReturnType<typeof setTimeout>|undefined;
    const chunks:Buffer[]=[];
    const kill=()=>{if(!reaped&&child.pid)try{child.kill('SIGKILL');}catch{}};
    const finish=()=>{
      if(done)return;done=true;if(timer)clearTimeout(timer);signal.removeEventListener('abort',cancel);
      child.stdout?.removeAllListeners('data');child.stderr?.removeAllListeners('data');child.stdout?.destroy();child.stderr?.destroy();child.unref();
      const result={...base,status:'unknown' as KernelProbe['status'],reason,helperPid:child.pid??null,outputBytes,diagnosticBytes,reaped,pipesClosed,released:reaped&&pipesClosed,toMs:performance.now()};
      if(reason==='closed'&&exit===0&&diagnosticBytes===0&&outputBytes<=4096)try{
        const v=JSON.parse(Buffer.concat(chunks).toString('utf8')),waits=['futex','poll','timer','pipe','child','io','unknown','unavailable'],fds=['regular','pipe','socket','directory','device','other','unavailable'];
        if(v.pid===root.pid&&v.birth===root.birth&&(v.waitSymbol===null||typeof v.waitSymbol==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v.waitSymbol)&&!/^[A-Fa-f0-9]+$/.test(v.waitSymbol))&&[v.stateBefore,v.stateAfter].every(state=>state===null||typeof state==='string'&&/^[RSDZTtXxKWPI]$/.test(state))&&(!v.identityStable||v.stateBefore!==null&&v.stateAfter!==null)&&waits.includes(v.wait)&&fds.includes(v.fdKind)&&(v.syscall===null||Number.isSafeInteger(v.syscall)&&v.syscall>=0&&v.syscall<=1024)&&(v.syscallStable===null||typeof v.syscallStable==='boolean')&&typeof v.identityStable==='boolean'&&v.identityStable===(v.reason!=='identity')&&['sampled','identity','unavailable'].includes(v.reason))Object.assign(result,{status:v.reason==='sampled'?'observed':'unknown',reason:v.reason,wait:{kind:v.identityStable?v.wait:'unavailable',name:v.identityStable?v.waitSymbol:null},identityStates:{before:{state:v.identityStable?v.stateBefore:null},after:{state:v.identityStable?v.stateAfter:null}},syscall:v.identityStable?v.syscall:null,fd:{kind:v.identityStable?v.fdKind:'unavailable'},syscallStable:v.identityStable?v.syscallStable:null,identityStable:v.identityStable});else result.reason='malformed';
      }catch{result.reason='malformed';}
      resolve(result);
    };
    const stop=(why:string)=>{reason=why;kill();if(timer)clearTimeout(timer);const left=until-performance.now();if(left<=0)finish();else timer=setTimeout(finish,left);};
    const cancel=()=>stop('aborted');
    child.once('error',()=>{reason='spawn';if(child.pid===undefined)reaped=true;});child.once('exit',code=>{exit=code;reaped=true;});child.once('close',()=>{pipesClosed=true;if(reason==='running')reason='closed';finish();});
    child.stdout?.on('data',(b:Buffer)=>{outputBytes+=b.length;if(outputBytes+diagnosticBytes<=4096)chunks.push(b);else stop('output-cap');});
    child.stderr?.on('data',(b:Buffer)=>{diagnosticBytes+=b.length;if(outputBytes+diagnosticBytes>4096)stop('output-cap');});
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();else if(performance.now()>=until)stop('late-spawn');else timer=setTimeout(()=>stop('timeout'),Math.max(0,until-performance.now()-40));
  });
}

const identity = async (pid: number, signal?: AbortSignal) => {
  const stat = await readFile(`/proc/${pid}/stat`, {encoding: 'utf8', signal}).catch(() => '');
  signal?.throwIfAborted();
  return processIdentity(pid, stat);
};

/** Only numeric identities are read. No command lines, process-name matching, or foreign signals. */
async function processes(signal?: AbortSignal): Promise<ProcessIdentity[]> {
  signal?.throwIfAborted();
  const entries = await readdir('/proc');
  signal?.throwIfAborted();
  const result: ProcessIdentity[] = [];
  // Limit concurrent reads on a shared machine.
  for (let from = 0; from < entries.length; from += 64) {
    signal?.throwIfAborted();
    const batch = await Promise.all(entries.slice(from, from + 64).filter(value => /^\d+$/.test(value)).map(value => identity(Number(value), signal)));
    signal?.throwIfAborted();
    result.push(...batch.filter((value): value is ProcessIdentity => value !== null));
  }
  return result;
}

export type ProcessCleanup = {status: 'closed' | 'residual'; term: boolean; kill: boolean; reaped: boolean; pipesClosed: boolean; elapsedMs: number; reason?: string;rootWait?:KernelProbe};

/** A detached group is signalled only while an observed member still anchors its identity. */
export function browserProcess(child: ChildProcess, group: boolean) {
  const known = new Map<number, string>();
  let lastRoot:ProcessIdentity|undefined;
  let exited = false, pipesClosed = false, released = false;
  child.once('exit', () => {exited = true;});
  child.once('close', () => {pipesClosed = true;});
  const live = () => !exited && child.exitCode === null && child.signalCode === null;
  const observe = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!child.pid || !group || process.platform !== 'linux') return [];
    const all=await processes(signal);
    signal?.throwIfAborted();
    const current = all.filter(value=>value.group===child.pid&&value.session===child.pid);
    const anchored = current.some(value => (value.pid === child.pid && live()) || known.get(value.pid) === value.birth);
    if (anchored && !released) for (const value of current) known.set(value.pid, value.birth);
    if(anchored&&live())lastRoot=current.find(value=>value.pid===child.pid)??lastRoot;
    if (!current.length && !live()) released = true;
    // Escaping the group never grants signal authority, but cannot count as a clean exit.
    const owned=new Set(all.filter(value=>known.get(value.pid)===value.birth).map(value=>value.pid));
    for(let depth=0;depth<16;depth++) {
      const descendants=all.filter(value=>owned.has(value.parent)&&!owned.has(value.pid));
      if(!descendants.length)break;
      for(const value of descendants){known.set(value.pid,value.birth);owned.add(value.pid);}
    }
    return all.filter(value=>owned.has(value.pid));
  };
  let closing: Promise<ProcessCleanup> | undefined;
  return {observe, close: (captureRootWait=false) => closing ??= (async () => {
    const started = performance.now();
    let probe:Promise<KernelProbe>|undefined,finished=false,beforeTermination:boolean|null=null;
    const result: ProcessCleanup = {status: 'residual', term: false, kill: false, reaped: false, pipesClosed: false, elapsedMs: 0};
    try {
      // Bound the wait for identity reads and forbid signals after cancellation.
      await deadline(7_000, async signal => {
        if(captureRootWait)probe=kernelProbe(lastRoot,started+7000,signal).then(value=>{if(!finished)result.rootWait=value;return value;});
        while (performance.now() - started < 7_000) {
          const current = await observe(signal);
          signal.throwIfAborted();
          const workers = current.filter(value => value.state !== 'Z' && value.state !== 'X');
          let portableGroupExists = false;
          if (group && process.platform !== 'linux' && child.pid && !released) {
            try {process.kill(-child.pid, 0); portableGroupExists = true;}
            catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') released = true; else throw error;}
          }
          if ((!child.pid || !live()) && !workers.length && !portableGroupExists && pipesClosed) {result.status = 'closed'; break;}
          const canSignal = group && process.platform === 'linux'
            ? !released && workers.some(value => value.group===child.pid&&value.session===child.pid&&known.get(value.pid) === value.birth)
            : live();
          if (canSignal && (!result.term || (!result.kill && performance.now() - started >= 5_000))) {
            if(!result.term&&beforeTermination===null)beforeTermination=result.rootWait?.identityStable===true;
            const signal = result.term ? 'SIGKILL' : 'SIGTERM';
            try {
              if (group) process.kill(-child.pid!, signal); else child.kill(signal);
              if (signal === 'SIGTERM') result.term = true; else result.kill = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {result.reason = 'signal failed'; break;}
              released = true;
            }
          }
          await wait(25);
        }
        // Collect only after the original TERM/reap loop; this adds no pre-TERM await.
        if(probe)await probe;
      });
      if (result.status !== 'closed') result.reason ??= 'owned exit, group identity or pipe closure unconfirmed';
    } catch {result.reason = 'process identity unavailable';}
    finally {
      finished=true;
      if(probe&&!result.rootWait)result.rootWait={status:'unknown',reason:'pending',pid:lastRoot?.pid??0,birth:lastRoot?.birth??null,helperPid:null,wait:{kind:'unavailable',name:null},identityStates:{before:{state:null},after:{state:null}},syscall:null,fd:{kind:'unavailable'},syscallStable:null,identityStable:null,beforeTermination:null,outputBytes:0,diagnosticBytes:0,reaped:false,pipesClosed:false,released:false,fromMs:started,toMs:performance.now()};
      if(result.rootWait)result.rootWait={...result.rootWait,beforeTermination};
      if(result.rootWait&&!result.rootWait.released){result.status='residual';result.reason='kernel probe cleanup unconfirmed';}
      result.reaped = !child.pid || !live(); result.pipesClosed = pipesClosed;
      result.elapsedMs = Math.round(performance.now() - started);
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    return result;
  })()};
}
