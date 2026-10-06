import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Writable} from 'node:stream';
import {Store} from '../store/store.js';
import {managedRegistry, reserveManagedId} from '../secrets/windows.js';
import {readInputs, startSecrets} from '../secrets/index.js';
import {SecretKey} from '../secrets/crypto.js';

const windows={skip:process.platform!=='win32'};
function cleanup(id:string) {
  const executable=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
  // Only this fixture's random namespace is disposable; never enumerate another instance.
  spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',"Remove-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Quotum\\HubKeys\\v1\\"+id+"' -Recurse -Force -ErrorAction SilentlyContinue"],{stdio:'ignore',timeout:10_000,windowsHide:true});
}
test('Windows registry bootstrap is private, durable and never replaces a missing established store',windows,t=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-registry-')),data=path.join(root,'data');mkdirSync(data);
  const store=new Store(path.join(data,'hub.sqlite')),id=reserveManagedId(store.db);
  t.after(()=>{cleanup(id);store.close();rmSync(root,{recursive:true,force:true});});
  const first=readInputs({},data,false),report=startSecrets(store.db,first);
  assert.equal(report.outcome,'created');assert.ok(first.current);assert.equal(reserveManagedId(store.db),id);
  assert.equal(startSecrets(store.db,readInputs({},data,false)).current,report.current);
  assert.equal(managedRegistry(id,false).fingerprint,report.current);
  cleanup(id);
  const lost=startSecrets(store.db,readInputs({},data,false));assert.equal(lost.reason,'secret_key_storage_missing');
  assert.throws(()=>managedRegistry(id,false),/secret_key_storage_missing/);
  assert.equal(startSecrets(store.db,readInputs({QUOTUM_SECRET_DIR:data},data,false)).reason,'secret_key_storage_unavailable');
});

test('concurrent Windows helpers share one native mutex and one published key',windows,async t=>{
  const id=randomUUID();t.after(()=>cleanup(id));
  const module=new URL('../secrets/windows.ts',import.meta.url).href;
  const run=()=>new Promise<string>((resolve,reject)=>{
    const script="import {managedRegistry} from "+JSON.stringify(module)+";console.log(managedRegistry('"+id+"',true).fingerprint);";
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    let result='';child.stdout.on('data',bytes=>result+=String(bytes));
    child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve(result.trim()):reject(new Error('Registry fixture failed')));
  });
  const values=await Promise.all([run(),run()]);assert.match(values[0],/^[a-f0-9]{16}$/);assert.equal(values[0],values[1]);
  assert.equal(managedRegistry(id,false).fingerprint,values[0]);
});

async function until(check:()=>boolean) {
  const deadline=Date.now()+15_000;
  while(!check()) {
    assert.ok(Date.now()<deadline,'Native helper did not reach its bounded barrier');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
function frame(id:string,byte:number) {
  const candidate=Buffer.alloc(32,byte).toString('base64url'),input=Buffer.alloc(84);
  input.write('QKI1');input.write(id,4);input[40]=1;input.write(candidate,41);
  return {input,fingerprint:SecretKey.parse(Buffer.from(candidate)).fingerprint};
}
function sendFrame(pipe:Writable,input:Buffer) {
  return new Promise<void>((resolve,reject)=>{
    pipe.once('error',reject);pipe.end(input,()=>{input.fill(0);resolve();});
  });
}

// Instrument a disposable copy of the actual helper, without giving production a test switch.
function pausedScript(root:string,name:string,point:'write'|'flush'|'wait'|'reader') {
  let script=readFileSync(new URL('../secrets/windows.ps1',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const ready=path.join(root,name+'-ready'),gate=path.join(root,name+'-gate'),acquired=path.join(root,name+'-acquired');
  const compiled=path.join(root,name+'-compiled'),start=path.join(root,name+'-start'),finished=path.join(root,name+'-finished'),status=path.join(root,name+'-status'),diagnostic=path.join(root,name+'-diagnostic');
  const before=point==='flush'?'if(RegFlushKey(leaf)!=0)throw new Exception();':point==='write'?'if(RegSetValueEx(leaf,"CurrentKey",0,3,candidate,43)!=0)':'var waited=WaitForSingleObject(mutex,8000);';
  assert.equal(script.split(before).length,2);
  const barrier='File.WriteAllText('+JSON.stringify(ready)+',"ready");'+(point!=='reader'?'while(!File.Exists('+JSON.stringify(gate)+')){if(watch.ElapsedMilliseconds>=8500)throw new Exception();System.Threading.Thread.Sleep(10);}':'');
  script=script.replace(before,barrier+before);
  assert.equal(script.split('held=true;').length,2);script=script.replace('held=true;','held=true;File.WriteAllText('+JSON.stringify(acquired)+',waited.ToString());');
  assert.equal(script.split('output.Write(header,0,header.Length);').length,2);
  script=script.replace('output.Write(header,0,header.Length);','File.WriteAllText('+JSON.stringify(status)+',status.ToString());output.Write(header,0,header.Length);');
  const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  script=script.replace("  Add-Type -TypeDefinition @'","  $stage = 'compile'\n  Add-Type -TypeDefinition @'");
  assert.equal(script.split('[QuotumManagedKey]::Run()').length,2);
  script=script.replace('[QuotumManagedKey]::Run()', "$stage = 'compiled'; [IO.File]::WriteAllText("+literal(compiled)+",'ready'); $wait = [Diagnostics.Stopwatch]::StartNew(); while (-not [IO.File]::Exists("+literal(start)+")) { if ($wait.ElapsedMilliseconds -ge 15000) { throw }; Start-Sleep -Milliseconds 10 }; $stage = 'run'; [QuotumManagedKey]::Run(); [IO.File]::WriteAllText("+literal(finished)+",'done')");
  const caught='} catch {\n  try { $out';assert.equal(script.split(caught).length,2);
  script=script.replace(caught,"} catch {\n  $safe = @{stage=$stage; type=$_.Exception.GetType().Name; line=$_.InvocationInfo.ScriptLineNumber; codes=@([regex]::Matches($_.Exception.Message,'\\bCS[0-9]{4}\\b') | ForEach-Object { $_.Value })} | ConvertTo-Json -Compress\n  [IO.File]::WriteAllText("+literal(diagnostic)+",$safe)\n  try { $out");
  const file=path.join(root,name+'.ps1');writeFileSync(file,script);return {file,ready,gate,acquired,compiled,start,finished,status,diagnostic};
}

test('a Windows registry writer survives its launcher and abandoned mutexes are recovered',{...windows,timeout:120_000},async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-registry-lifetime-'));
  const executable=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=(script:string)=>['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script];
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const death of ['parent','parent-before-acquire','helper-before-write','helper-after-write'] as const) {
    const orphan=death.startsWith('parent'),reverse=death==='parent-before-acquire';
    const id=randomUUID(),a=pausedScript(root,death+'-writer',reverse?'wait':death==='helper-after-write'?'flush':'write'),b=pausedScript(root,death+'-reader','reader');
    const first=frame(id,17),second=frame(id,29);
    for(const script of [a.file,b.file]) {
      const parser="$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('"+script.replaceAll("'","''")+"',[ref]$tokens,[ref]$errors) | Out-Null; ConvertTo-Json -Compress -InputObject @($errors | ForEach-Object { @{id=$_.ErrorId; line=$_.Extent.StartLineNumber} })";
      const parsed=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',parser],{encoding:'utf8',timeout:10_000,windowsHide:true});
      assert.equal(parsed.status,0);assert.equal(parsed.stdout.trim(),'[]');
    }
    // A .NET launcher keeps the console without Node's per-parent child job, so its death leaves a real orphan.
    const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
    const parentScript=`$ErrorActionPreference = 'Stop'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = ${literal(executable)}
$info.Arguments = ${literal('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+a.file+'"')}
$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = [System.Diagnostics.Process]::Start($info)
$pidBytes = [Text.Encoding]::ASCII.GetBytes($child.Id.ToString() + [char]10)
$pidOutput = [Console]::OpenStandardOutput()
$pidOutput.Write($pidBytes,0,$pidBytes.Length)
$pidOutput.Flush()
$inputStream = [Console]::OpenStandardInput()
$frame = New-Object byte[] 84
$count = 0
while ($count -lt 84) { $n = $inputStream.Read($frame,$count,84-$count); if ($n -eq 0) { throw }; $count += $n }
$child.StandardInput.BaseStream.Write($frame,0,84)
$child.StandardInput.BaseStream.Flush()
[Array]::Clear($frame,0,84)
$child.StandardInput.Close()
$output = $child.StandardOutput.ReadToEndAsync()
$errors = $child.StandardError.ReadToEndAsync()
$child.WaitForExit()
`;
    const parentFile=path.join(root,death+'-parent.ps1');writeFileSync(parentFile,parentScript);
    const parent=spawn(executable,args(parentFile),{stdio:['pipe','pipe','ignore'],windowsHide:true});
    let helperPid:number|undefined,pidText='';parent.stdout!.on('data',bytes=>{pidText+=String(bytes);const found=pidText.match(/^\s*(\d+)[\r\n]+$/);if(found)helperPid=Number(found[1]);});
    let reader:ReturnType<typeof spawn>|undefined;
    try {
      await sendFrame(parent.stdin!,first.input);
      reader=spawn(executable,args(b.file),{stdio:['pipe','pipe','ignore'],windowsHide:true});
      let output=Buffer.alloc(0);reader.stdout!.on('data',bytes=>{output=Buffer.concat([output,bytes]);});
      const result=new Promise<number|null>((resolve,reject)=>{reader!.on('error',reject);reader!.on('close',resolve);});
      await sendFrame(reader.stdin!,second.input);
      // Compile both helpers before starting either production deadline.
      await until(()=>!!helperPid&&existsSync(a.compiled)&&existsSync(b.compiled)||existsSync(a.diagnostic)||existsSync(b.diagnostic)||reader!.exitCode!==null||parent.exitCode!==null);
      assert.equal(!!helperPid&&existsSync(a.compiled)&&existsSync(b.compiled),true);
      writeFileSync(a.start,'continue');await until(()=>existsSync(a.ready));
      if(orphan) {parent.kill();await until(()=>parent.exitCode!==null||parent.signalCode!==null);process.kill(helperPid!,0);}
      writeFileSync(b.start,'continue');
      await until(()=>existsSync(b.ready));
      if(!reverse) {
        assert.equal(existsSync(b.acquired),false);
        if(!orphan)process.kill(helperPid!);else writeFileSync(a.gate,'continue');
      }
      await until(()=>reader!.exitCode!==null||reader!.signalCode!==null);
      assert.equal(await result,0);assert.equal(output.length,48);assert.equal(output.subarray(0,5).equals(Buffer.from([81,75,82,49,0])),true);
      const fingerprint=SecretKey.parse(output.subarray(5)).fingerprint;output.fill(0);
      assert.equal(readFileSync(b.acquired,'utf8'),!orphan?'128':'0');
      assert.equal(fingerprint,death==='helper-before-write'||reverse?second.fingerprint:first.fingerprint);
      if(reverse)writeFileSync(a.gate,'continue');
      if(orphan) {await until(()=>existsSync(a.finished));assert.equal(readFileSync(a.status,'utf8'),'0');}
      assert.equal(managedRegistry(id,false).fingerprint,fingerprint);
    } catch(error) {
      const snapshot=(script:ReturnType<typeof pausedScript>)=>({compiled:existsSync(script.compiled),ready:existsSync(script.ready),acquired:existsSync(script.acquired),finished:existsSync(script.finished),status:existsSync(script.status)?readFileSync(script.status,'utf8'):null,diagnostic:existsSync(script.diagnostic)?JSON.parse(readFileSync(script.diagnostic,'utf8')):null});
      t.diagnostic(JSON.stringify({death,a:snapshot(a),b:snapshot(b),parentExit:parent.exitCode,readerExit:reader?.exitCode,helperPidReceived:!!helperPid,pidBytes:Buffer.byteLength(pidText)}));throw error;
    } finally {
      if(reader?.exitCode===null)reader.kill();
      if(helperPid) {try{process.kill(helperPid);}catch{}}
      if(parent.exitCode===null)parent.kill();
      await until(()=>!reader||reader.exitCode!==null||reader.signalCode!==null);
      await until(()=>parent.exitCode!==null||parent.signalCode!==null);
      if(helperPid)await until(()=>{try{process.kill(helperPid!,0);return false;}catch{return true;}});
      cleanup(id);
    }
  }
  const invalidId=randomUUID();
  try {
    managedRegistry(invalidId,true);
    const registry='Registry::HKEY_CURRENT_USER\\Software\\Quotum\\HubKeys\\v1\\'+invalidId;
    const altered=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',"Set-ItemProperty -LiteralPath '"+registry+"' -Name CurrentKey -Value ([byte[]](1,2,3));"],{stdio:'ignore',timeout:10_000,windowsHide:true});
    assert.equal(altered.status,0);assert.throws(()=>managedRegistry(invalidId,true),/secret_key_storage_invalid/);
    const unchanged=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Convert]::ToBase64String((Get-ItemPropertyValue -LiteralPath '"+registry+"' -Name CurrentKey))"],{encoding:'utf8',timeout:10_000,windowsHide:true});
    assert.equal(unchanged.status,0);assert.equal(unchanged.stdout.trim(),'AQID');
  } finally {cleanup(invalidId);}
});
