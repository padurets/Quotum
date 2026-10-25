import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const HERE=path.dirname(fileURLToPath(import.meta.url)),SIZE=16*1024**2,U64=(1n<<64n)-1n;
const MAPS=new Set('alive birth bound_ns capture_closed cohort config_invalid count entries exec_birth exec_count exec_inode exec_missing exec_ns exit_ns extra_admission files_omitted files_printed first_term_ns identity_lost key_count last_file missing parent parent_ticks root seen term_sender window_closed_ns'.split(' '));
const BAD_MAPS=new Set('config_invalid extra_admission identity_lost missing'.split(' '));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const uint=s=>typeof s==='string'&&/^(?:0|[1-9]\d{0,19})$/.test(s)&&BigInt(s)<=U64;
const signed=s=>uint(s)||typeof s==='string'&&/^-[1-9]\d{0,9}$/.test(s)&&BigInt(s)>=-2147483648n;
const positive=s=>uint(s)&&BigInt(s)>0n;
const small=s=>uint(s)&&Number.isSafeInteger(Number(s));
const requireValue=(value,code)=>{if(!value)throw Object.assign(new Error(code),{controlReason:code});};
export const deviceNumbers=dev=>{const d=BigInt(dev);return{major:String(((d>>8n)&0xfffn)|((d>>32n)&~0xfffn)),minor:String((d&0xffn)|((d>>12n)&0xffffff00n))};};
export const fileIdentity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),uid:String(s.uid)});
const exactKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===keys.slice().sort().join(',');
const sameFile=(a,b)=>exactKeys(a,Object.keys(b))&&Object.keys(a).every(k=>a[k]===b[k]);
const bornMatches=(ns,ticks)=>uint(ns)&&uint(ticks)&&BigInt(ns)/10000000n===BigInt(ticks);

export const controllerExitCode=report=>report.status!=='observed'?2:report.benchmark?.signal?1:Number.isInteger(report.benchmark?.exit)&&report.benchmark.exit>=0&&report.benchmark.exit<=255?report.benchmark.exit:1;
export const isolatedCI=(env,repository)=>env.CI==='true'&&env.GITHUB_ACTIONS==='true'&&path.isAbsolute(repository)&&path.isAbsolute(env.GITHUB_WORKSPACE??'')&&env.GITHUB_WORKSPACE===repository&&['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'].every(k=>typeof env[k]==='string'&&/^\d{1,24}$/.test(env[k]));
export function forwardBenchmark(child,output=process){child.stdout?.pipe(output.stdout,{end:false});child.stderr?.pipe(output.stderr,{end:false});}
const numericTuple=text=>{text=text.trim();if(text.startsWith('(')||text.endsWith(')')){if(!/^\([^()]*\)$/.test(text))return null;text=text.slice(1,-1);}if(/[()]/.test(text))return null;const values=text.split(/\s*,\s*/);return values.every(signed)?values:null;};

/** Classify a capped prefix. The isolated tracer can also retain redacted tool errors. */
export function diagnosticClassifier({toolMessages=false}={}){
  let bytes=0,scanned=0,tail='',toolText='',sealed;
  const kinds=new Set(),locations=[];
  const patterns=[['permission',/EPERM|EACCES|permission denied|operation not permitted|must be root/i],['BTF',/\bBTF\b/i],['layout',/no member named|unknown struct|unknown type|invalid field|incomplete definition/i],['syntax',/syntax ?error|unexpected token|parse error|unknown identifier|semantic error/i],['attach',/failed to attach|cannot attach|error attaching|no probes to attach|no matching probes|probe[^\n]*not found/i],['verifier',/verifier|verification failed|invalid mem access/i],['resource',/no space left|cannot allocate|ENOMEM|out of memory|too many open files|resource temporarily/i],['lost-events',/lost[^\n]*(?:event|sample)|dropped[^\n]*events/i]];
  return{add(chunk){
    if(sealed)return;bytes+=chunk.length;const part=chunk.subarray(0,Math.max(0,16384-scanned));scanned+=part.length;
    if(toolMessages)toolText+=part.toString('utf8');
    const text=tail+part.toString('utf8');for(const[k,p]of patterns)if(p.test(text))kinds.add(k);
    for(const match of text.matchAll(/(?:^|\n)(?:[^:\n]*\/)?(startupWaitOwner\.bt|stdin):(\d{1,4}):(\d{1,4})(?=[:\s-]|$)/g)){
      const line=Number(match[2]),column=Number(match[3]),source=match[1]==='stdin'?'stdin':'bpf-script';
      if(line>0&&line<=1000&&column>0&&column<=1000&&locations.length<8&&!locations.some(r=>r.source===source&&r.line===line&&r.column===column))locations.push({source,line,column});
    }
    tail=text.slice(-4096);
  },finish(){if(!sealed){sealed={categories:[...kinds].length?[...kinds]:bytes?['other']:[],locations,bytes,scannedBytes:scanned,discardedBytes:bytes,unscannedBytes:bytes-scanned,capBytes:16384,limited:bytes>16384};
    if(toolMessages){
      const rows=toolText.split(/\r?\n/);if(bytes>16384)rows.pop();
      sealed.toolMessages=rows.filter(v=>v.trim()).slice(0,8).map(v=>v.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/https?:\/\/\S+/gi,'[url]').replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>:]*/g,'[path]').replace(/\b(?:0x)?[a-f0-9]{8,128}\b/gi,'[address]').replace(/\b[A-Za-z0-9_-]*(?:token|secret|cookie|password|credential)[A-Za-z0-9_-]*(?:\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+))?/gi,'[redacted]').replace(/[\x00-\x1f\x7f]/g,'?').slice(0,256));
      sealed.toolMessagesLimited=bytes>16384||rows.filter(v=>v.trim()).length>8||rows.some(v=>v.length>256);
    }
    tail='';toolText='';}return sealed;}};
}

/** Accept only fixed numeric markers and named numeric maps; no raw line is retained. */
export function traceProtocol(){
  const state={markers:[],maps:[],invalid:0,omitted:0,ended:false};
  const add=line=>{
    line=line.trim();if(!line)return;
    if(state.markers.length+state.maps.length>=1536){state.omitted++;return;}
    const a=line.split(/\s+/),kind=a.shift();let r;
    if(kind==='QFW_TICK'||kind==='QFW_END'||kind==='QFW_WINDOW_CLOSED'){
      if(a.length===1&&positive(a[0]))r={kind,ns:a[0]};
    }else if(kind==='QFW_BIND'){
      if(a.length===6&&a.every(uint)&&['1','2'].includes(a[0])&&small(a[1])&&positive(a[1])&&positive(a[2])&&small(a[3])&&positive(a[3])&&small(a[4])&&positive(a[5]))r={kind,cohort:Number(a[0]),pid:Number(a[1]),birthNs:a[2],parent:Number(a[3]),uid:Number(a[4]),ns:a[5]};
    }else if(kind==='QFW_TERM'){
      if(a.length===8&&a.every((v,i)=>(i===7?signed:uint)(v))&&['1','2'].includes(a[0])&&[1,4,6].every(i=>small(a[i]))&&[1,2,3,4,5].every(i=>positive(a[i])))r={kind,cohort:Number(a[0]),pid:Number(a[1]),birthNs:a[2],ns:a[3],senderPid:Number(a[4]),senderBirthNs:a[5],senderUid:Number(a[6]),result:Number(a[7])};
    }else if(kind==='QFW_EXIT'){
      if(a.length===4&&a.every(uint)&&['1','2'].includes(a[0])&&small(a[1])&&positive(a[1])&&positive(a[2])&&positive(a[3]))r={kind,cohort:Number(a[0]),pid:Number(a[1]),birthNs:a[2],ns:a[3]};
    }else if(kind==='QFW_FILE'){
      if(a.length===10&&a.every(uint)&&['1','2'].includes(a[0])&&['1','2'].includes(a[1])&&small(a[2])&&positive(a[2])&&positive(a[3])&&positive(a[9])&&BigInt(a[7])<=BigInt(a[8])&&(a[1]==='1'||a[7]===a[8]))r={kind,cohort:Number(a[0]),origin:Number(a[1]),pid:Number(a[2]),birthNs:a[3],major:a[4],minor:a[5],inode:a[6],firstIndex:a[7],lastIndex:a[8],ns:a[9]};
    }else{
      const m=/^@([a-z_]{1,32})(?:\[([^\]]+)\])?:\s*(\([^)]*\)|-?\d+)$/.exec(line);
      if(m&&MAPS.has(m[1])){
        const keys=m[2]?numericTuple(m[2]):[],values=numericTuple(m[3]);
        if(keys&&values&&keys.length<=7&&values.length<=7){state.maps.push({name:m[1],keys,values,filemapContextOnly:true,physicalWaitProof:false});return;}
      }
    }
    if(!r){state.invalid++;return;}state.markers.push(r);if(kind==='QFW_END')state.ended=true;
  };
  return{state,add};
}

/** Called after reap: cross-CPU delivery order cannot establish logical END order. */
export function traceComplete(state){
  const ends=state.markers.filter(r=>r.kind==='QFW_END');
  return !state.invalid&&!state.omitted&&ends.length===1&&state.markers.every(r=>BigInt(r.ns)<=BigInt(ends[0].ns));
}

/** Both owned-file read-pages-ready and fault-entry contexts must occur; neither proves a wait. */
export function fixtureProof(trace,json,row,meta,parent,uid){
  const bind=trace.markers.filter(r=>r.kind==='QFW_BIND'&&r.cohort===1),dev=deviceNumbers(meta.dev);
  if(bind.length!==1||!exactKeys(json,'status pid birth group session owner fdmeta mainReads threadReads mappedTouches offsets pageBytes fdPosition coldstats'.split(' '))||json.status!=='fixture-read-complete'||!row)return false;
  const b=bind[0],fields=['dev','ino','size','mtimeNs','ctimeNs','uid'];
  if(b.pid!==row.pid||b.parent!==parent||b.uid!==uid||!bornMatches(b.birthNs,row.birth)||json.pid!==row.pid||json.birth!==row.birth||json.group!==row.pid||json.session!==row.pid||json.owner!==uid||row.parent!==parent||row.group!==row.pid||row.session!==row.pid||row.uids.some(v=>v!==uid))return false;
  if(!json.fdmeta||fields.some(k=>typeof json.fdmeta[k]!=='string'||json.fdmeta[k]!==meta[k])||Object.keys(json.fdmeta).length!==6||json.mainReads!==16||json.threadReads!==16||json.mappedTouches!==16||json.offsets!==16||json.pageBytes!==4096||json.fdPosition!=='0'||!exactKeys(json.coldstats,['adviceCalls','mincoreCalls','residentPages','pages'])||json.coldstats?.adviceCalls!==1||json.coldstats?.mincoreCalls!==1||json.coldstats?.residentPages!==0||json.coldstats?.pages!==4096)return false;
  return !trace.invalid&&!trace.omitted&&[1,2].every(origin=>trace.markers.some(r=>r.kind==='QFW_FILE'&&r.cohort===1&&r.origin===origin&&r.pid===b.pid&&r.birthNs===b.birthNs&&r.major===dev.major&&r.minor===dev.minor&&r.inode===meta.ino&&BigInt(r.firstIndex)<4096n&&BigInt(r.lastIndex)<4096n));
}
export function fixtureTermProof(trace,row,bracket,sender){
  const binds=trace.markers.filter(r=>r.kind==='QFW_BIND'&&r.cohort===1),terms=trace.markers.filter(r=>r.kind==='QFW_TERM'&&r.cohort===1),exits=trace.markers.filter(r=>r.kind==='QFW_EXIT'&&r.cohort===1);
  return binds.length===1&&terms.length===1&&exits.length===1&&[terms[0],exits[0]].every(r=>r.pid===row.pid&&r.birthNs===binds[0].birthNs)&&sender&&terms[0].senderPid===sender.pid&&bornMatches(terms[0].senderBirthNs,sender.birth)&&terms[0].senderUid===sender.uid&&terms[0].result===0&&BigInt(terms[0].ns)>=BigInt(bracket.beforeNs)&&BigInt(terms[0].ns)<=BigInt(bracket.afterNs)&&BigInt(exits[0].ns)>=BigInt(terms[0].ns);
}

/** A released observer cannot cancel the original benchmark merely for missing evidence. */
export async function observeFilemapPhase(report,observe,release){
  const retain=error=>{report.observationIssue??=error?.controlReason??'observation-unavailable';};
  let state;
  try{await observe();}catch(error){retain(error);}
  finally{try{state=await release();}catch(error){retain(error);}}
  const released=state?.released===true&&state.reaped===true&&state.pipesClosed===true&&Array.isArray(state.residual)&&state.residual.length===0;
  if(!released)report.observationResourceIssue??='observation-resource-unreleased';
  return released;
}
export function filemapWindowReady(state,protocol){
  requireValue(!state.bad&&!protocol.invalid&&!protocol.omitted,'trace-capture');
  if(protocol.markers.some(r=>r.kind==='QFW_WINDOW_CLOSED'))return true;
  requireValue(!state.reaped,'trace-capture');return false;
}

export async function runControl(repository,directory){
  requireValue(path.isAbsolute(repository)&&path.isAbsolute(directory),'arguments');requireValue(isolatedCI(process.env,repository),'isolated-ci');fs.mkdirSync(directory,{mode:0o700});
  const report={kind:'startup-filemap-input-control',status:'unknown',canonicalPass:false,C1RepairProven:false,primary:null,observationIssue:null,observationResourceIssue:null,filemapContextOnly:true,physicalWaitProven:false,durationProven:false,absenceProven:false,sourceBefore:null,sourceAfter:null,fixture:null,fixtureQualified:false,benchmark:{started:false},trace:null,cleanup:[],limits:['Initial owned-main window; entries after browser ready are not automatically startup cost.','Origin1 reports inclusive requested range at the successful get-pages point, not all pages physically read/acquired. Origin2 is fault-entry before cache lookup. Neither context certifies a stalled read, blocking, duration or absence.','Signal bracket proves generation by the owned sender, not delivery. Filemap context and fixture qualification are not a C1 reproduction or repair.','Software deadlines require OS/event-loop progress; external20m job allowance is unchanged.']};
  const cancel=new AbortController(),leases=[];let fd,ownDirectory,trace,fixture,bench,proto=traceProtocol(),fixtureJSON,traceUntil=0,benchReady=null;
  const until=performance.now()+20*60_000,uid=process.getuid?.();
  const abort=()=>{report.primary??='controller-cancelled';cancel.abort();};for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,abort);
  const mod=name=>import(pathToFileURL(path.join(repository,'hub/bench',name)).href);
  let browserProcess,processIdentity,deadline;const signalHelpers=[];
  const poll=async(test,end,code)=>{for(;;){cancel.signal.throwIfAborted();if(test())return;if(performance.now()>=end)throw Object.assign(new Error(code),{controlReason:code});await sleep(10,undefined,{signal:cancel.signal});}};
  const current=async(pid,signal)=>{
    const text=await fs.promises.readFile('/proc/'+pid+'/stat',{encoding:'utf8',signal}),status=await fs.promises.readFile('/proc/'+pid+'/status',{encoding:'utf8',signal});
    const row=processIdentity(pid,text),u=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    return text.startsWith(pid+' (')&&row&&u?{...row,uids:u.slice(1).map(Number)}:null;
  };
  const boundedCurrent=(pid,signal)=>deadline(100,s=>current(pid,s),signal).catch(()=>null);
  const owned=(child,kind)=>{
    const owner=browserProcess(child,true),state={kind,pid:child.pid??null,exit:null,signal:null,reaped:false,pipesClosed:false,stdoutBytes:0,stderrBytes:0,bad:false,records:[]};let partial='';const diagnostic=kind==='trace'?diagnosticClassifier({toolMessages:true}):null;
    const closed=new Promise(resolve=>{child.once('error',()=>{state.bad=true;if(!child.pid){state.reaped=true;resolve();}});child.once('exit',(code,signal)=>{state.exit=code;state.signal=signal;state.reaped=true;if(kind==='bench'&&code!==0&&!cancel.signal.aborted&&!state.controllerTerm)report.primary='benchmark-failed';});child.once('close',()=>{state.pipesClosed=true;if(diagnostic)state.diagnostic=diagnostic.finish();resolve();});});
    const lines=value=>{
      partial+=value.toString('utf8');const maximum=kind==='bench'?65536:4096;
      if(partial.length>maximum&&!partial.includes('\n')){partial='';state.bad=kind!=='bench';return;}
      for(;;){const at=partial.indexOf('\n');if(at<0)break;const line=partial.slice(0,at);partial=partial.slice(at+1);
        if(line.length>maximum){if(kind!=='bench')state.bad=true;continue;}
        if(kind==='trace')proto.add(line);
        if(kind==='fixture')try{state.records.push(JSON.parse(line));if(state.records.length!==1)state.bad=true;else if(kind==='fixture')fixtureJSON=state.records[0];}catch{state.bad=true;}
        if(kind==='bench'&&line.startsWith('bench: Chrome ready '))try{const b=JSON.parse(line.slice('bench: Chrome ready '.length));if(Number.isSafeInteger(b.pid)&&b.pid>0&&[b.readyMs,b.portMs].every(v=>Number.isFinite(v)&&v>=0))benchReady={receiptHrtimeNs:String(process.hrtime.bigint()),pid:b.pid,readyMs:b.readyMs,portMs:b.portMs};}catch{}
      }
    };
    child.stdout?.on('data',v=>{state.stdoutBytes+=v.length;if(kind==='trace'&&state.stdoutBytes>65536||kind!=='bench'&&kind!=='trace'&&state.stdoutBytes>4096)state.bad=true;else if(kind!=='bench')lines(v);});
    child.stderr?.on('data',v=>{state.stderrBytes+=v.length;diagnostic?.add(v);if(kind==='trace'&&state.stderrBytes>0||kind==='fixture'&&state.stderrBytes>16384)state.bad=true;if(kind==='bench')lines(v);});
    if(kind==='bench')forwardBenchmark(child);
    child.stdin?.on('error',()=>{state.bad=true;});const lease={child,owner,state,closed,diagnostic,root:null,stopping:null};leases.push(lease);return lease;
  };
  const anchor=async lease=>{
    const rows=await deadline(500,s=>lease.owner.observe(s),cancel.signal),r=rows.find(r=>r.pid===lease.child.pid),n=r&&await boundedCurrent(r.pid,cancel.signal);
    requireValue(n&&n.birth===r.birth&&n.parent===process.pid&&n.group===n.pid&&n.session===n.pid&&n.uids.every(v=>lease.state.kind==='trace'?[0,uid].includes(v):v===uid),'owned-anchor');lease.root=n;return n;
  };
  const rootSignal=async(lease,signal,cleanup)=>{
    const rows=await deadline(150,s=>lease.owner.observe(s),cleanup).catch(()=>[]),targets=[];
    for(const row of rows){const n=await boundedCurrent(row.pid,cleanup);cleanup.throwIfAborted();if(n&&n.birth===row.birth&&n.uids.every(v=>[0,uid].includes(v))){const target=n.group===lease.child.pid&&n.session===lease.child.pid?-lease.child.pid:n.pid;if(!targets.includes(target))targets.push(target);}}
    if(!targets.length)return;lease.state[signal==='SIGKILL'?'killRequested':'termRequested']=true;
    const code='for(const id of process.argv.slice(1))try{process.kill(Number(id),'+JSON.stringify(signal)+')}catch(e){if(e.code!=="ESRCH")process.exitCode=1}';
    cleanup.throwIfAborted();const killer=spawn('/usr/bin/sudo',['-n','--',process.execPath,'-e',code,'--',...targets.map(String)],{stdio:'ignore',env:{LANG:'C',PATH:'/usr/bin:/bin'}});
    const record={pid:killer.pid??null,reaped:false,pipesClosed:false,exit:null,signal:null};
    const joined=new Promise(resolve=>{killer.once('error',()=>{if(!killer.pid)record.reaped=true;resolve();});killer.once('exit',(code,signal)=>{record.reaped=true;record.exit=code;record.signal=signal;});killer.once('close',()=>{record.pipesClosed=true;resolve();});});
    signalHelpers.push({child:killer,record,joined});
    await deadline(200,()=>joined,cleanup).catch(()=>{try{killer.kill('SIGKILL');}catch{}});
    if(!record.reaped)await deadline(100,()=>joined,cleanup).catch(()=>{});
    if(!record.reaped)try{killer.kill('SIGKILL');}catch{}killer.unref();
    requireValue(record.reaped&&record.pipesClosed&&record.exit===0,'root-signal-unreaped');
  };
  const readBrowserArtifact=(bind,parent)=>{
    try{
      const root=path.join(directory,'benchmark-first'),dirs=fs.readdirSync(root).filter(n=>/^[a-f0-9-]{36}$/.test(n));if(dirs.length!==1)return false;
      const file=path.join(root,dirs[0],'browser.json');if(fs.statSync(file).size>1024**2)return false;
      const bytes=fs.readFileSync(file),b=JSON.parse(bytes),numeric=v=>Number.isFinite(v)&&v>=0?v:null;
      report.browserArtifact={file:path.relative(directory,file),bytes:bytes.length,sha256:sha(bytes),pid:Number.isSafeInteger(b.pid)?b.pid:null,readyMs:numeric(b.readyMs),portMs:numeric(b.portMs),elapsedMs:numeric(b.elapsedMs),startupSpansPreserved:!!b.startupSpans,identityBound:false,sourceBound:false};
      if(!bind)return false;
      const manifestFile=path.join(root,dirs[0],'manifest.json');if(fs.statSync(manifestFile).size>1024**2)return false;
      const manifestBytes=fs.readFileSync(manifestFile),m=JSON.parse(manifestBytes),id=m.identity,pin=m.files?.find(r=>r.name==='browser.json');
      const sourceFile=path.join(root,dirs[0],'history-scroll-source.json');if(fs.statSync(sourceFile).size>4096)return false;
      const sourceBytes=fs.readFileSync(sourceFile),source=JSON.parse(sourceBytes),sourcePin=m.files?.find(r=>r.name==='history-scroll-source.json');
      if(id?.sha!==report.sourceBefore.source.checkoutSha||id?.tree!==report.sourceBefore.tree||id?.dirty!==false||id?.client?.sha256!==report.sourceBefore.client.sha256||id?.client?.bytes!==report.sourceBefore.client.bytes||id?.client?.name!==report.sourceBefore.client.name||pin?.truncated!==false||pin?.bytes!==bytes.length||pin?.sha256!==sha(bytes)||sourcePin?.truncated!==false||sourcePin?.bytes!==sourceBytes.length||sourcePin?.sha256!==sha(sourceBytes)||source.sha!==id.sha||source.checkoutHash!==id.sha||source.clientHash!==id.client.sha256||source.expectedClientHash!==id.client.sha256)return false;
      const cleanupFile=path.join(root,dirs[0],'cleanup.json');if(fs.statSync(cleanupFile).size>1024**2)return false;
      const cleanupBytes=fs.readFileSync(cleanupFile),cleanup=JSON.parse(cleanupBytes),cleanupPin=m.files?.find(r=>r.name==='cleanup.json'),closed=cleanup.browser?.cleanup??b.cleanup;
      if(!['diagnostic','failed','cancelled'].includes(m.status)||bench.state.exit===0&&m.status!=='diagnostic'||cleanupPin?.truncated!==false||cleanupPin?.bytes!==cleanupBytes.length||cleanupPin?.sha256!==sha(cleanupBytes)||!Array.isArray(cleanup.failures)||cleanup.failures.length||closed?.status!=='closed'||closed.reaped!==true||closed.pipesClosed!==true)return false;
      report.browserArtifact.sourceBound=true;report.browserArtifact.manifest={bytes:manifestBytes.length,sha256:sha(manifestBytes),status:m.status};report.browserArtifact.sourceReceipt={bytes:sourceBytes.length,sha256:sha(sourceBytes)};report.browserArtifact.cleanup={bytes:cleanupBytes.length,sha256:sha(cleanupBytes),status:'closed',reaped:true,pipesClosed:true};
      const rows=[...(Array.isArray(b.processes)?b.processes:[]),...(Array.isArray(b.startupSamples?.samples)?b.startupSamples.samples:[])];
      const r=rows.find(r=>r.pid===bind.pid&&r.parent===parent&&r.group===bind.pid&&r.session===bind.pid&&bornMatches(bind.birthNs,r.birth));
      if(b.pid!==bind.pid||b.ownedGroup!==true||!r)return false;
      report.browserArtifact.identityBound=true;report.browserArtifact.identity={pid:r.pid,birth:r.birth,parent:r.parent,group:r.group,session:r.session};return true;
    }catch{return false;}
  };
  const stop=lease=>lease.stopping??=(async()=>{
    try{
      if(lease.state.kind==='trace')await deadline(1000,async s=>{
        if(lease.state.naturalRequested){
          await deadline(500,()=>lease.closed,s).catch(()=>{});
          if(!lease.state.reaped||!lease.state.pipesClosed){await rootSignal(lease,'SIGKILL',s);await deadline(200,()=>lease.closed,s).catch(()=>{});}
        }else{
          await rootSignal(lease,'SIGTERM',s);await deadline(150,()=>lease.closed,s).catch(()=>{});
          if(!lease.state.reaped||!lease.state.pipesClosed){await rootSignal(lease,'SIGKILL',s);await deadline(200,()=>lease.closed,s).catch(()=>{});}
        }
      });
      else{
        if(lease.state.kind==='bench'&&lease.state.reaped===false&&lease.root){const n=await boundedCurrent(lease.root.pid);if(n?.birth===lease.root.birth&&n.uids.every(v=>v===uid))try{lease.state.controllerTerm=true;lease.child.kill('SIGTERM');}catch{}await deadline(25000,()=>lease.closed).catch(()=>{});}
        await lease.owner.close();
      }
    }catch{lease.state.bad=true;}
    const remaining=await deadline(150,s=>lease.owner.observe(s)).catch(()=>null);
    lease.state.residual=remaining?.map(r=>({pid:r.pid,birth:r.birth,state:r.state}))??null;
    if(lease.diagnostic)lease.state.diagnostic=lease.diagnostic.finish();
    lease.child.stdin?.destroy();lease.child.stdout?.destroy();lease.child.stderr?.destroy();lease.child.unref();
    lease.state.released=lease.state.reaped&&lease.state.pipesClosed&&remaining?.length===0;report.cleanup.push({...lease.state,records:undefined});
  })();
  try{
    requireValue(process.platform==='linux'&&process.arch==='x64'&&Number.isSafeInteger(uid),'unsupported');
    const [{browserProcess:bp,processIdentity:pi},{deadline:dl},{sourceIdentity},{clientIdentity}]=await Promise.all([mod('browserProcess.ts'),mod('deadline.ts'),mod('idleCpuDiagnostic.ts'),mod('evidence.ts')]);browserProcess=bp;processIdentity=pi;deadline=dl;
    const pinSource=()=>{const source=sourceIdentity(process.env,()=>execFileSync('git',['-C',repository,'rev-parse','--verify','HEAD'],{encoding:'utf8',timeout:1000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}).trim()),client=clientIdentity(path.join(repository,'hub/dist/client/assets')),tree=execFileSync('git',['-C',repository,'rev-parse','HEAD^{tree}'],{encoding:'utf8',timeout:1000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}).trim();requireValue(/^[a-f0-9]{40}$/.test(process.env.QUOTUM_BENCH_SOURCE_SHA??'')&&source.sourceHead===source.checkoutSha&&execFileSync('git',['-C',repository,'status','--porcelain'],{encoding:'utf8',timeout:1000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}).trim()===''&&/^[a-f0-9]{64}$/.test(process.env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256??'')&&client.status==='available'&&client.sha256===process.env.QUOTUM_BENCH_EXPECTED_CLIENT_SHA256,'source');return{source,tree,client};};
    requireValue(['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'].every(k=>process.env[k]===undefined||/^\d{1,24}$/.test(process.env[k])),'event-identity');
    report.sourceBefore=pinSource();requireValue(execFileSync('/usr/bin/getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000,maxBuffer:1024}).trim()==='100','user-hz');
    requireValue(!['QUOTUM_BENCH_DIAGNOSE_IDLE_CPU','QUOTUM_BENCH_CAPTION_CONTROL','QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL','QUOTUM_BENCH_DIAGNOSE_NATIVE','QUOTUM_BENCH_REVERSAL_PROBE','QUOTUM_C3_CHROME'].some(k=>process.env[k]),'conflicting-mode');
    const script=path.join(HERE,'startupWaitOwner.bt'),reader=path.join(HERE,'startupWaitFixture.py');report.privateSourcePins=Object.fromEntries([script,reader,fileURLToPath(import.meta.url)].map(p=>[path.basename(String(p)),sha(fs.readFileSync(p))]));
    ownDirectory=fs.mkdtempSync('/var/tmp/quotum-folio-');fs.chmodSync(ownDirectory,0o700);requireValue(fs.statSync(ownDirectory,{bigint:true}).dev===fs.statSync('/',{bigint:true}).dev&&fs.statfsSync(ownDirectory,{bigint:true}).type!==0x01021994n,'fixture-filesystem');
    const file=path.join(ownDirectory,'owned.bin'),write=fs.openSync(file,'wx',0o600);try{const block=Buffer.alloc(1024**2,0x5a);for(let n=0;n<16;n++){let offset=0;while(offset<block.length){const written=fs.writeSync(write,block,offset,block.length-offset,n*block.length+offset);requireValue(written>0,'fixture-write');offset+=written;}}fs.fsyncSync(write);}finally{fs.closeSync(write);}fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd,{bigint:true}),meta=fileIdentity(stat),dev=deviceNumbers(meta.dev);requireValue(stat.isFile()&&stat.nlink===1n&&meta.size===String(SIZE)&&meta.uid===String(uid),'fixture-file');report.file=meta;
    const env={...process.env,QUOTUM_BENCH_HISTORY_SCROLL_CONTROL:'1',QUOTUM_BENCH_DIAGNOSTICS_DIR:path.join(directory,'benchmark-first')};delete env.QUOTUM_BENCH_HISTORY_SCROLL_SUFFIX;
    bench=owned(spawn('/bin/bash',['-c','IFS= read -r gate; [ "$gate" = start ] && exec "$@"','quotum-owned-bench',process.execPath,'--import','tsx',path.join(repository,'hub/bench/index.ts'),'--ci','--scope','history'],{cwd:path.join(repository,'hub'),detached:true,stdio:['pipe','pipe','pipe'],env}),'bench');
    const e=await anchor(bench),p=await boundedCurrent(process.pid,cancel.signal);requireValue(p&&p.uids.every(v=>v===uid),'controller-identity');report.controller={pid:p.pid,birth:p.birth,uid};report.benchmark.identity=e;
    fixture=owned(spawn('/usr/bin/python3',['-B',reader,JSON.stringify(meta)],{detached:true,stdio:['pipe','pipe','pipe',fd],env:{LANG:'C',PATH:'/usr/bin:/bin'}}),'fixture');const f=await anchor(fixture);report.fixtureIdentity=f;
    const args=[script,String(p.pid),String(e.pid),String(uid),p.birth,e.birth,'100',dev.major,dev.minor,meta.ino,String(f.pid),f.birth];
    trace=owned(spawn('/usr/bin/sudo',['-n','--','/bin/sh','-c','IFS= read -r gate; [ "$gate" = trace ] || exit 2; exec /usr/bin/timeout --foreground --signal=TERM --kill-after=0.2s 240s /usr/bin/bpftrace -q -B line "$@"','quotum-owned-tracer',...args],{detached:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C',PATH:'/usr/bin:/bin'}}),'trace');
    await anchor(trace);traceUntil=performance.now()+240000;trace.child.stdin.end('trace\n');
    await poll(()=>{requireValue(!trace.state.bad&&!proto.state.invalid&&!proto.state.omitted&&!trace.state.reaped,'trace-setup');return proto.state.markers.some(r=>r.kind==='QFW_TICK');},traceUntil,'trace-tick-timeout');
    cancel.signal.throwIfAborted();fixture.child.stdin.write('start\n');
    await poll(()=>{requireValue(!trace.state.bad&&!fixture.state.bad&&!trace.state.reaped&&!fixture.state.reaped,'fixture-capture');return fixtureProof(proto.state,fixtureJSON,f,meta,p.pid,uid);},traceUntil,'fixture-not-qualified');
    requireValue(sameFile(meta,fileIdentity(fs.fstatSync(fd,{bigint:true}))),'fixture-file-changed');report.fixture=fixtureJSON;
    const fresh=await boundedCurrent(f.pid,cancel.signal);requireValue(fresh?.birth===f.birth&&fresh.parent===p.pid&&fresh.group===f.pid&&fresh.session===f.pid&&fresh.uids.every(v=>v===uid),'fixture-identity-changed');
    const bracket={beforeNs:String(process.hrtime.bigint()),afterNs:null};const sent=fixture.child.kill('SIGTERM');bracket.afterNs=String(process.hrtime.bigint());report.fixtureTermBracket=bracket;requireValue(sent,'fixture-term');
    await poll(()=>fixture.state.reaped&&fixture.state.pipesClosed&&fixtureTermProof(proto.state,f,bracket,{pid:p.pid,birth:p.birth,uid}),traceUntil,'fixture-term-unconfirmed');requireValue(fixture.state.signal==='SIGTERM','fixture-exit');await stop(fixture);requireValue(fixture.state.released,'fixture-residual');report.fixtureQualified=true;
    const eNow=await boundedCurrent(e.pid,cancel.signal);requireValue(eNow?.birth===e.birth&&eNow.parent===p.pid&&eNow.group===e.pid&&eNow.session===e.pid&&eNow.uids.every(v=>v===uid),'bench-gate-identity');cancel.signal.throwIfAborted();bench.child.stdin.end('start\n');report.benchmark.started=true;

    const observerReleased=await observeFilemapPhase(report,async()=>{
      await poll(()=>{if(filemapWindowReady(trace.state,proto.state))return true;if(bench.state.reaped&&!proto.state.markers.some(r=>r.kind==='QFW_BIND'&&r.cohort===2))throw Object.assign(new Error('bench-before-bind'),{controlReason:'bench-before-bind'});return false;},Math.min(until,traceUntil),'trace-window-incomplete');
      const windows=proto.state.markers.filter(r=>r.kind==='QFW_WINDOW_CLOSED'),bindings=proto.state.markers.filter(r=>r.kind==='QFW_BIND'&&r.cohort===2);
      requireValue(windows.length===1&&bindings.length===1&&BigInt(windows[0].ns)-BigInt(bindings[0].ns)>=21000000000n,'trace-window');
      trace.state.naturalRequested=true;await stop(trace);
      requireValue(trace.state.released&&traceComplete(proto.state)&&!trace.state.bad&&!trace.state.killRequested&&trace.state.exit===0&&trace.state.signal===null,'trace-release');
    },async()=>{await stop(trace);return trace.state;});
    report.benchmark.observerReleaseConfirmed=observerReleased;
    if(!observerReleased){report.benchmark.cancelRequestedByObservationResource=!bench.state.reaped;throw Object.assign(new Error('observation-resource-unreleased'),{controlReason:'observation-resource-unreleased'});}
    report.benchmark.continuedAfterObservationIssue=!!report.observationIssue&&!cancel.signal.aborted&&!bench.state.reaped;
    await poll(()=>bench.state.reaped&&bench.state.pipesClosed,until,'controller-deadline');
    report.benchmark.exit=bench.state.exit;report.benchmark.signal=bench.state.signal;report.primary??=report.observationIssue??(bench.state.exit===0?'benchmark-completed':'benchmark-failed');report.benchmark.readyLine=benchReady;
    const c2=proto.state.markers.filter(r=>r.kind==='QFW_BIND'&&r.cohort===2);requireValue(c2.length===1&&c2[0].parent===e.pid&&c2[0].uid===uid,'browser-binding');
    requireValue(readBrowserArtifact(c2[0],e.pid),'browser-artifact-binding');
    requireValue(!proto.state.maps.some(m=>BAD_MAPS.has(m.name)&&m.values.some(v=>BigInt(v)!==0n)),'trace-numeric-flags');report.status=report.observationIssue?'unknown':'observed';
    report.sourceAfter=pinSource();requireValue(JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter),'source-changed');
    requireValue(Object.entries(report.privateSourcePins).every(([name,hash])=>sha(fs.readFileSync(path.join(HERE,name)))===hash),'private-source-changed');
  }catch(error){report.observationIssue??=error?.controlReason??(cancel.signal.aborted?'controller-cancelled':'unavailable');report.primary??=report.observationIssue;report.status='unknown';}
  finally{
    if(deadline)await Promise.all(leases.map(stop));
    for(const helper of signalHelpers){if(!helper.record.reaped)try{helper.child.kill('SIGKILL');}catch{}helper.child.unref();}
    report.signalHelpers=signalHelpers.map(h=>({...h.record,released:h.record.reaped&&h.record.pipesClosed}));
    report.benchmark={...report.benchmark,...(bench?{exit:bench.state.exit,signal:bench.state.signal}:{}),readyLine:benchReady};report.trace={...proto.state,outputBytes:trace?.state.stdoutBytes??0,diagnosticBytes:trace?.state.stderrBytes??0,countsAreLowerBounds:true};
    if(!traceComplete(proto.state)||signalHelpers.some(h=>!h.record.reaped||!h.record.pipesClosed)||leases.some(l=>!l.state.released||l.state.bad)||proto.state.invalid||proto.state.omitted||trace?.state.stderrBytes)report.status='unknown';
    if(!report.browserArtifact)readBrowserArtifact();
    if(fd!==undefined)try{fs.closeSync(fd);}catch{report.status='unknown';}if(ownDirectory)try{fs.rmSync(ownDirectory,{recursive:true});}catch{report.status='unknown';}
    try{fs.writeFileSync(path.join(directory,'control-first.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});}finally{for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.removeListener(s,abort);}
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const args=process.argv.slice(2);requireValue(args.length===2,'arguments');const r=await runControl(...args);console.log(JSON.stringify({kind:r.kind,status:r.status,canonicalPass:false,C1RepairProven:false,fixtureQualified:r.fixtureQualified,benchmarkExit:r.benchmark.exit??null}));process.exitCode=controllerExitCode(r);}
  catch{console.log(JSON.stringify({kind:'startup-filemap-input-control',status:'unknown',reason:'controller-unavailable',canonicalPass:false,C1RepairProven:false}));process.exitCode=2;}
}
