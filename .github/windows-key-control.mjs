import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha = b => createHash('sha256').update(b).digest('hex');
const need = (ok, reason) => {if (!ok) throw new Error(reason);};
const literal = s => "'" + s.replaceAll("'", "''") + "'";
const read = (p, cap) => {const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=cap,'file-bound');return fs.readFileSync(p);};
export function numericStages(stderr) {
  if (!Buffer.isBuffer(stderr)||stderr.length>4096) return [];
  const found=[];for(const line of stderr.toString('utf8').split(/\r?\n/)){const m=/^QKS1 ([1-9]|10|11) (0|[1-9][0-9]{0,5})$/.exec(line);if(m&&found.length<16)found.push({stage:+m[1],ms:+m[2]});}return found;
}
export function variants(source, dll) {
  const matches=[...source.matchAll(/  Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@ -ErrorAction Stop \| Out-Null/g)];
  const run='  [QuotumManagedKey]::Run()',suffix="'@ -ErrorAction Stop | Out-Null";
  need(matches.length===1&&source.split(run).length===2,'source-shape');
  const block=matches[0][0],loading='  Add-Type -LiteralPath '+literal(dll)+' -ErrorAction Stop | Out-Null';
  const load=source.replace(block,()=>loading),build=source.replace(block,()=>block.slice(0,-suffix.length)+"'@ -OutputAssembly "+literal(dll)+' -OutputType Library -ErrorAction Stop | Out-Null').replace(run,'  [void]0');
  need(load.replace(loading,()=>block)===source,'variant-boundary');return {compile:source,load,build,csharpSha256:sha(matches[0][1])};
}
function call(exe,args,input) {
  const began=performance.now(),r=spawnSync(exe,args,{input,timeout:10000,maxBuffer:4096,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,QUOTUM_TEST_KEY_STAGES:'1'}});
  const info={ms:performance.now()-began,pid:r.pid||null,status:r.status,signal:['SIGTERM','SIGKILL','SIGABRT','SIGINT','SIGBREAK'].includes(r.signal)?r.signal:r.signal===null?null:'other',failure:r.error?(['ETIMEDOUT','ENOENT','EACCES','ENOBUFS'].includes(r.error.code)?r.error.code:'other'):null,stdoutBytes:r.stdout?.length??0,stderrBytes:r.stderr?.length??0,stages:numericStages(r.stderr)};
  r.stderr?.fill(0);return {info,output:r.stdout,normal:!r.error&&r.signal===null&&Number.isInteger(r.status),noProducer:!r.pid};
}
export function main() {
  const mode=process.argv[2],artifact=path.resolve(process.argv[3]??'.');
  const report={schemaVersion:1,mode:['build','compile','load'].includes(mode)?mode:'invalid',status:'insufficient',primary:'unknown',cleanup:'unknown'};
  let work=null,id=null,input=null,output=null,quiescent=true,exe;
  try {
    need(['build','compile','load'].includes(mode)&&process.platform==='win32'&&process.arch==='x64','platform-or-mode');
    const head=process.env.CONTROL_SOURCE_SHA;need(/^[a-f0-9]{40}$/.test(head??''),'source-commit');
    const actual=execFileSync('git',['rev-parse','--verify','HEAD'],{encoding:'utf8',timeout:1000,maxBuffer:128,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();
    need(/^[a-f0-9]{40}$/.test(actual),'source-head');report.actualSourceSha=actual;need(actual===head,'source-head');
    const bytes=read('hub/server/secrets/windows.ps1',65536),source=bytes.toString('utf8');
    need(sha(source.replaceAll('\r\n','\n'))==='f27579f6fe859e01dbc1279950de40b28a6d10e8d7cd226169be4c2e56cc34b1','source-version');
    const pins={source:sha(bytes),launcher:sha(read('hub/server/secrets/windows.ts',16384)),control:sha(read(fileURLToPath(import.meta.url),32768))};
    const system=process.env.SystemRoot??process.env.SYSTEMROOT;need(system&&path.isAbsolute(system),'system-root');
    exe=fs.realpathSync(path.join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'));
    const binaries={powershell:exe,compiler:path.join(system,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),runtime:path.join(system,'Microsoft.NET/Framework64/v4.0.30319/mscorlib.dll')};
    let manifest,dll=path.join(artifact,'managed-key.dll');
    if(mode!=='build') {
      const raw=read(path.join(artifact,'manifest.json'),16384);need(sha(raw)===process.env.CONTROL_MANIFEST_SHA,'manifest-pin');manifest=JSON.parse(raw);
      need(manifest.schemaVersion===1&&manifest.head===head&&Object.keys(pins).every(k=>manifest.pins[k]===pins[k]),'source-pins');
      const binary=read(dll,1048576);need(binary.length===manifest.dllBytes&&sha(binary)===manifest.dllSha256,'dll-pin');
      need(JSON.stringify(fs.readdirSync(artifact).sort())===JSON.stringify(['managed-key.dll','manifest.json']),'artifact-members');
    }
    work=fs.mkdtempSync(path.join(os.tmpdir(),'quotum-key-control-'));
    if(mode==='build')dll=path.join(work,'managed-key.dll');
    const v=variants(source,dll);report.pins={...pins,csharp:v.csharpSha256,variant:sha(v[mode])};
    if(manifest)need(manifest.csharpSha256===v.csharpSha256,'literal-pin');
    const script=path.join(work,'helper.ps1');fs.writeFileSync(script,v[mode],{flag:'wx'});
    if(mode!=='build'){id=randomUUID();input=Buffer.alloc(84);const candidate=Buffer.from(Buffer.alloc(32,17).toString('base64url'));input.write('QKI1');input.write(id,4);input[40]=1;candidate.copy(input,41);candidate.fill(0);}
    quiescent=false;const attempt=call(exe,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],input);
    report.attempt=attempt.info;output=attempt.output;quiescent=attempt.normal||attempt.noProducer;
    need(attempt.normal&&attempt.info.status===0,'helper-failed');
    const expected=mode==='build'?[1,2]:Array.from({length:11},(_,i)=>i+1);
    need(JSON.stringify(attempt.info.stages.map(x=>x.stage))===JSON.stringify(expected),'stage-inventory');
    need(Buffer.isBuffer(output)&&(mode==='build'?output.length===0:output.length===48&&output.subarray(0,5).equals(Buffer.from([81,75,82,49,0]))&&output.subarray(5).equals(input.subarray(41))),'output-abi');
    // Target hashes are read after the only timed arm, never as compiler warmup.
    const target={};for(const [key,file] of Object.entries(binaries))target[key]=sha(read(file,32*1048576));
    report.target=target;report.targetKind='WindowsPowerShell5.1-NetFx4-x64';
    if(manifest)need(JSON.stringify(target)===JSON.stringify(manifest.target),'compiler-target');
    if(mode==='build') {
      const binary=read(dll,1048576);manifest={schemaVersion:1,head,pins,csharpSha256:v.csharpSha256,target,dllBytes:binary.length,dllSha256:sha(binary)};
      fs.mkdirSync(artifact);fs.writeFileSync(path.join(artifact,'managed-key.dll'),binary,{flag:'wx'});
      const raw=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(artifact,'manifest.json'),raw,{flag:'wx'});report.manifestSha256=sha(raw);
      if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'manifest='+sha(raw)+'\n');
    } else report.manifestSha256=process.env.CONTROL_MANIFEST_SHA;
    report.primary='observed-success';
  } catch(error) {report.reason=['platform-or-mode','source-commit','source-head','source-version','source-shape','variant-boundary','system-root','file-bound','manifest-pin','source-pins','dll-pin','artifact-members','literal-pin','helper-failed','stage-inventory','output-abi','compiler-target'].includes(error.message)?error.message:'control-failed';}
  finally {
    input?.fill(0);output?.fill(0);
    if(quiescent) {
      try {
        if(id){const key='Registry::HKEY_CURRENT_USER\\Software\\Quotum\\HubKeys\\v1\\'+id;const c=call(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; if(Test-Path -LiteralPath "+literal(key)+'){Remove-Item -LiteralPath '+literal(key)+" -Recurse -Force}; if(Test-Path -LiteralPath "+literal(key)+'){exit 1}']);report.cleanupAttempt=c.info;c.output?.fill(0);need(c.normal&&c.info.status===0,'cleanup');}
        if(work)fs.rmSync(work,{recursive:true,force:true});report.cleanup='complete';
      } catch {report.cleanup='unknown';}
    }
    report.ownedWorkRetained=!!work&&report.cleanup!=='complete';report.status=report.primary==='observed-success'&&report.cleanup==='complete'?'complete-observation':'insufficient';
    console.log(JSON.stringify(report));if(report.status!=='complete-observation')process.exitCode=1;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
