/** Normal native QA may reconcile shared consent: require a protected OS-account receipt. */
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function validateBoundary(actual,receipt) {
  const normalize=value=>actual.localAppData===undefined?value:value.replaceAll('\\','/').toLowerCase();
  const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&normalize(a)===normalize(b);
  if(receipt?.schemaVersion!==1||!actual?.id||!receipt.ownerId||actual.id!==receipt.id||actual.id===receipt.ownerId
    ||!equal(actual.home,receipt.home)||equal(actual.home,receipt.ownerHome)
    ||actual.localAppData!==undefined&&!equal(actual.localAppData,receipt.localAppData)) throw new Error('Native QA requires a disposable OS account with its own canonical profile');
  return actual;
}
export function launchChecked(actual,receipt,spawn) {validateBoundary(actual,receipt);return spawn();}

export function checkedBoundary() {
  if(process.platform==='win32') {
    // pwsh callers can export their v7 module paths to Windows PowerShell 5.
    // Let the OS shell construct its own compatible built-in module path.
    const shellEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'));
    const script=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$file=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Quotum/native-qa.json'
foreach($part in @($file,(Split-Path $file))) {
  $item=Get-Item -LiteralPath $part
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe QA receipt'}
  $acl=Get-Acl -LiteralPath $part
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'Untrusted QA receipt owner'}
  foreach($ace in $acl.Access){
    $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($ace.AccessControlType -eq 'Allow' -and ([int]$ace.FileSystemRights -band 0x500D0156) -ne 0 -and $sid -notin @('S-1-5-18','S-1-5-32-544')){throw 'Writable QA receipt'}
  }
}
if((Get-Item -LiteralPath $file).Length -gt 4096){throw 'Invalid QA receipt'}
$actual=@{id=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;home=[Environment]::GetFolderPath('UserProfile');localAppData=[Environment]::GetFolderPath('LocalApplicationData')}
@{actual=$actual;receipt=(Get-Content -LiteralPath $file -Raw|ConvertFrom-Json)}|ConvertTo-Json -Depth 10 -Compress`;
    const {actual,receipt}=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:shellEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    return validateBoundary(actual,receipt);
  }
  const file='/etc/quotum-native-qa.json';
  for(const ancestor of [file,'/etc','/']) {
    const meta=lstatSync(ancestor);
    if(meta.isSymbolicLink()||meta.uid!==0||(meta.mode&0o022)!==0)throw new Error('Untrusted native QA receipt');
  }
  const meta=lstatSync(file);
  if(!meta.isFile()||meta.nlink!==1||meta.size>4096)throw new Error('Invalid native QA receipt');
  const user=os.userInfo(),home=lstatSync(user.homedir);
  if(!home.isDirectory()||home.isSymbolicLink()||home.uid!==user.uid||realpathSync(user.homedir)!==user.homedir)throw new Error('Untrusted disposable profile');
  return validateBoundary({id:String(user.uid),home:user.homedir},JSON.parse(readFileSync(file,'utf8')));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{checkedBoundary();}catch{console.error('Native QA refused: provision a disposable OS account and its protected account receipt.');process.exitCode=1;}
}
