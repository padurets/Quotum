import {createReadStream} from 'node:fs';
import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
const ELF='/opt/google/chrome/chrome';
const tuple=s=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]));
async function binding(file,read=true){
 const resolved=await realpath(file),before=await stat(resolved,{bigint:true});
 if(!before.isFile()||before.size<=0n||before.size>1024n**3n)throw new Error('runtime-file-unavailable');
 const hash=createHash('sha256');let bytes=0,magic;
 if(read)for await(const block of createReadStream(resolved,{highWaterMark:65536})){magic??=block.subarray(0,4).toString('hex');bytes+=block.length;hash.update(block);}
 const after=await stat(resolved,{bigint:true});
 if(read&&bytes!==Number(before.size)||JSON.stringify(tuple(before))!==JSON.stringify(tuple(after)))throw new Error('runtime-file-changed');
 return {invocation:file,file:resolved,identity:tuple(after),...(read?{sha256:hash.digest('hex'),magic}:{}),status:read?'hash-bound':'hash-pending'};
}
export async function bindRuntime(launcher){
 if(process.platform!=='linux'||process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('hosted-runtime-required');
 const files=[];
 for(const file of [launcher,ELF,'/usr/bin/cat','/usr/bin/python3','/usr/bin/timeout','/usr/bin/sudo'])files.push(await binding(file,file!==ELF));
 const text=await readFile(files[0].file,'utf8');
 // This recognizes the expected source line; actual execution is checked separately.
 if(files[1].file!==ELF||files[0].file!=='/opt/google/chrome/google-chrome'||!/^exec -a "\$0" "\$HERE\/chrome" "\$@"\s*$/m.test(text))throw new Error('launcher-exec-unqualified');
 return {status:'metadata-bound-elf-hash-pending',kernel:os.release(),node:process.version,files,source:'actual-hosted-files',coldSnapshotProof:false};
}
export async function unchangedRuntime(bound){
 for(const file of bound.files)if(await realpath(file.invocation)!==file.file||JSON.stringify(tuple(await stat(file.file,{bigint:true})))!==JSON.stringify(file.identity))return false;
 return true;
}
export async function finalizeRuntime(bound){
 try{
  if(!await unchangedRuntime(bound))return {status:'unavailable'};
  const expected=bound.files[1],actual=await binding(expected.invocation);
  const unchanged=actual.file===expected.file&&JSON.stringify(actual.identity)===JSON.stringify(expected.identity)&&await unchangedRuntime(bound);
  return unchanged&&actual.magic==='7f454c46'?{status:'retrospectively-bound',sha:actual.sha256,unchanged:true}:{status:'unavailable'};
 }catch{return {status:'unavailable'};}
}
export async function executedRuntime(report,bound){
 try{
  const pid=report.pid,owner=report.processes?.find(row=>row.pid===pid);
  if(!owner)return {status:'unavailable'};
  const birth=async()=>{const text=await readFile(`/proc/${pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/)[19];};
  if(await birth()!==String(owner.birth))return {status:'unavailable'};
  const elf=bound.files.find(file=>file.file===ELF),actual=await realpath(`/proc/${pid}/exe`);
  const matched=actual===ELF&&JSON.stringify(tuple(await stat(`/proc/${pid}/exe`,{bigint:true})))===JSON.stringify(elf.identity)&&await birth()===String(owner.birth);
  return {status:matched?'matched':'unavailable'};
 }catch{return {status:'unavailable'};}
}
