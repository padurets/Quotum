import childProcess from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {release} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SecretError} from '../secrets/crypto.js';
import {managedRegistry} from '../secrets/windows.js';
import {registryStages} from './registryDiagnostics.js';

// A temporary hosted control: this command is not the canonical -File invocation.
const command="& { param($p) [Console]::Error.WriteLine('QKE1 0'); [Console]::Error.Flush(); & $p }";
const nativeSpawn=childProcess.spawnSync,script=fileURLToPath(new URL('../secrets/windows.ps1',import.meta.url));
function metadata(file:string) {try {const s=statSync(file);return s.isFile()?{bytes:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs}:null;}catch{return null;}}
type Metadata=ReturnType<typeof metadata>;
function retrospective(file:string,before:Metadata) {
  try {const start=metadata(file);if(!start||start.bytes>8*1024*1024)return {sha256:null,metadataStable:false};
    const sha256=createHash('sha256').update(readFileSync(file)).digest('hex'),end=metadata(file);
    return {sha256,metadataStable:before!==null&&JSON.stringify(before)===JSON.stringify(start)&&JSON.stringify(start)===JSON.stringify(end)};
  }catch{return {sha256:null,metadataStable:false};}
}
const safeFailure=(value:unknown)=>typeof value==='string'&&['ETIMEDOUT','ENOENT','EACCES','ENOBUFS'].includes(value)?value:value===undefined?null:'other';
async function main() {
  const env=process.env,requested=env.QUOTUM_KEY_ENTRY_SOURCE_SHA??'',root=env.SystemRoot??env.SYSTEMROOT;
  if(process.platform!=='win32'||process.arch!=='x64'||env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    env.RUNNER_OS!=='Windows'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.QUOTUM_KEY_ENTRY_DIAGNOSTIC!=='1'||
    env.QUOTUM_KEY_ENTRY_TRACE_ONLY!=='0'||env.QUOTUM_KEY_ENTRY_ORIGINAL_TIMING!=='0'||!/^[a-f0-9]{40}$/.test(requested)||
    !root||!path.isAbsolute(root)||!env.RUNNER_TEMP||!path.isAbsolute(env.RUNNER_TEMP))throw Error('Diagnostic guard rejected');
  const actual=childProcess.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000,maxBuffer:256,stdio:['ignore','pipe','ignore']}).trim();
  if(actual!==requested)throw Error('Diagnostic source rejected');
  const expectedExecutable=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const files={helper:script,adapter:fileURLToPath(new URL('../secrets/windows.ts',import.meta.url)),
    stages:fileURLToPath(new URL('./registryDiagnostics.ts',import.meta.url)),control:fileURLToPath(import.meta.url),executable:expectedExecutable};
  const before:Partial<Record<keyof typeof files,Metadata>>={};
  let calls=0,nativeCalled=false,reading:object|null=null,entryCount:number|null=null,outcome='other';
  childProcess.spawnSync=((...args:Parameters<typeof nativeSpawn>)=>{
    calls++;const [executable,argv,options]=args;
    if(calls!==1||typeof executable!=='string'||path.normalize(executable).toLowerCase()!==path.normalize(expectedExecutable).toLowerCase()||
      !Array.isArray(argv)||argv.join('\0')!==['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script].join('\0')||
      !options||!Buffer.isBuffer(options.input)||options.input.length!==84||options.timeout!==10000||options.maxBuffer!==4096||options.windowsHide!==true||
      !Array.isArray(options.stdio)||options.stdio.join(',')!=='pipe,pipe,pipe'||options.env!==undefined)throw Error('Helper invocation rejected');
    for(const key of Object.keys(files) as (keyof typeof files)[])before[key]=metadata(files[key]);
    args[1]=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command,"'"+script.replaceAll("'","''")+"'"];
    args[2]={...options,env:{...env,QUOTUM_TEST_KEY_STAGES:'1'}};
    const started=performance.now();nativeCalled=true;const result=nativeSpawn(...args),output=result.stdout,stderr=result.stderr;
    const header=Buffer.isBuffer(output)&&output.length>=5&&output.subarray(0,4).equals(Buffer.from('QKR1'));
    entryCount=Buffer.isBuffer(stderr)&&stderr.length<=4096?stderr.toString('utf8').split(/\r?\n/).filter(line=>line==='QKE1 0').length:null;
    reading={ms:performance.now()-started,pid:Number.isSafeInteger(result.pid)&&result.pid>0?result.pid:null,status:result.status,
      signal:result.signal===null?null:['SIGTERM','SIGKILL','SIGABRT','SIGINT','SIGBREAK'].includes(result.signal)?result.signal:'other',
      failure:safeFailure((result.error as NodeJS.ErrnoException|undefined)?.code),outputBytes:Buffer.isBuffer(output)?output.length:0,
      header,helperStatus:header&&output[4]<=3?output[4]:null,stderrKind:Buffer.isBuffer(stderr)?'buffer':stderr===null?'null':'other',
      stderrBytes:Buffer.isBuffer(stderr)?stderr.length:null,entryCount,entryQualified:entryCount===1,stages:registryStages(stderr)};
    return result;
  }) as typeof nativeSpawn;
  const id=randomUUID();syncBuiltinESMExports();
  try {managedRegistry(id,true);outcome='returned';}
  catch(error) {outcome=error instanceof SecretError&&['secret_key_storage_unavailable','secret_key_storage_invalid','secret_key_storage_missing'].includes(error.code)?error.code:'other';}
  finally {childProcess.spawnSync=nativeSpawn;syncBuiltinESMExports();}
  const directory=path.join(env.RUNNER_TEMP,'quotum-windows-key-entry');
  const numericId=(value:string|undefined)=>value&&/^[1-9][0-9]{0,14}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
  const sealed=JSON.stringify({schema:1,requestedSource:requested,actualSource:actual,
    runId:numericId(env.GITHUB_RUN_ID),runAttempt:numericId(env.GITHUB_RUN_ATTEMPT),calls,nativeCalled,outcome,reading,
    inputBytes:84,timeoutMs:10000,productionAcceptance:false,causalPass:false,clientIdentityChecked:false})+'\n';
  // Seal in memory first. Failed persistence must still clean only this attempt's namespace.
  let outcomeSaved=false,cleanupSaved=false,identitySaved=false,cleanupStatus:number|null=null,cleanupFailure:string|null=null;
  try {mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'outcome.json'),sealed,{flag:'wx'});outcomeSaved=true;}
  catch {} finally {
    if(nativeCalled) {try {const r=nativeSpawn(path.join(root,'System32','reg.exe'),['delete','HKCU\\Software\\Quotum\\HubKeys\\v1\\'+id,'/f','/reg:64'],
      {timeout:10000,maxBuffer:4096,windowsHide:true,stdio:'ignore'});cleanupStatus=r.status;cleanupFailure=safeFailure((r.error as NodeJS.ErrnoException|undefined)?.code);
    }catch {cleanupFailure='other';}}
  }
  const cleanup={attempted:nativeCalled,status:cleanupStatus,failure:cleanupFailure,
    deletionCommandSucceeded:cleanupStatus===0&&cleanupFailure===null,absenceVerified:false,vmDiscardRequired:true};
  try {writeFileSync(path.join(directory,'cleanup.json'),JSON.stringify(cleanup)+'\n',{flag:'wx'});cleanupSaved=true;}catch {}
  const hashes=Object.fromEntries((Object.keys(files) as (keyof typeof files)[]).map(key=>[key,retrospective(files[key],before[key]??null)]));
  const identityComplete=Object.values(hashes).every(value=>value.sha256!==null&&value.metadataStable),osRelease=release();
  const identity={schema:1,hashTiming:'after-outcome-and-cleanup',hashes,identityComplete,
    executableLocation:'System32/WindowsPowerShell/v1.0/powershell.exe',executableLocationChecked:nativeCalled,executableVersion:null,
    osRelease:/^[0-9.]+$/.test(osRelease)?osRelease:null,nodeVersion:process.version,arch:process.arch,retrospectiveOnly:true};
  try {writeFileSync(path.join(directory,'identity.json'),JSON.stringify(identity)+'\n',{flag:'wx'});identitySaved=true;}catch {}
  if(!outcomeSaved)console.log(sealed.trim());
  console.log(JSON.stringify({outcomeSaved,cleanupSaved,identitySaved,cleanup,identityComplete}));
  if(calls!==1||!reading||entryCount!==1||outcome!=='returned'||cleanupStatus!==0||cleanupFailure!==null||!identityComplete||!outcomeSaved||!cleanupSaved||!identitySaved)process.exitCode=1;
}
main().catch(()=>{console.error('Key entry diagnostic unavailable');process.exitCode=1;});
