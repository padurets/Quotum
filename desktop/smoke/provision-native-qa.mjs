/** Run by the administrator of a disposable runner/container, before normal native QA. */
import {execFileSync} from 'node:child_process';
import {writeFileSync,chmodSync} from 'node:fs';

if(!(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')&&!process.argv.includes('--disposable-container'))throw new Error('Provision only an explicitly disposable OS environment');
if(process.platform==='win32') {
  const shellEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'));
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',String.raw`
$ErrorActionPreference='Stop'
$dir=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Quotum'
[IO.Directory]::CreateDirectory($dir)|Out-Null
$file=Join-Path $dir 'native-qa.json'
$receipt=@{schemaVersion=1;id=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;home=[Environment]::GetFolderPath('UserProfile');localAppData=[Environment]::GetFolderPath('LocalApplicationData');ownerId='S-1-5-18';ownerHome=(Join-Path $env:WINDIR 'System32/config/systemprofile')}
[IO.File]::WriteAllText($file,($receipt|ConvertTo-Json -Compress))
foreach($path in @($dir,$file)){
  $acl=Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))}
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','Allow'))
  Set-Acl -LiteralPath $path -AclObject $acl
}`],{env:shellEnv,stdio:'inherit'});
} else {
  if(process.getuid()!==0)throw new Error('The disposable environment administrator must provision the receipt');
  const at=process.argv.indexOf('--user'),user=at<0?undefined:process.argv[at+1];
  if(!user)throw new Error('Pass the dedicated OS user');
  const line=execFileSync('getent',['passwd',user],{encoding:'utf8'}).trim().split(':');
  if(line[2]==='0'||!line[5]?.startsWith('/'))throw new Error('Expected a dedicated unprivileged account');
  const file='/etc/quotum-native-qa.json';
  writeFileSync(file,JSON.stringify({schemaVersion:1,id:line[2],home:line[5],ownerId:'0',ownerHome:'/root'}));chmodSync(file,0o644);
}
