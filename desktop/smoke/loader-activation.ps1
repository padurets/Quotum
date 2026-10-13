# Optional native policy-model diagnostics; original app smoke remains independent.
param([string]$Diagnostics,[string]$Policy,[string]$Scenario,[string]$Output)
$ErrorActionPreference='Stop'
if($Policy){
  if(-not $IsWindows){throw 'Native Windows runtime unavailable'}
  Add-Type -Path (Join-Path $PSScriptRoot 'loader-activation.cs')
  $reading=[QuotumLoaderActivationControl]::Run($Policy,$Scenario)
  [IO.File]::WriteAllText($Output,(ConvertTo-Json -InputObject $reading -Depth 7))
  if(-not $reading.qualified -or -not $reading.passed){exit 1}
  exit 0
}
if(-not $Diagnostics){throw 'Diagnostics directory is required'}
$Diagnostics=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Diagnostics)
$Diagnostics=Join-Path $Diagnostics ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Diagnostics | Out-Null
. (Join-Path $PSScriptRoot 'qualify-loader-activation.ps1')
$manifest=[ordered]@{schemaVersion=1;scope='native-policy-model';status='running';productionAcceptance=$false;sha=$null;run=$env:GITHUB_RUN_ID;attempt=$env:GITHUB_RUN_ATTEMPT;platform='windows';runtimeExecuted=$false;source=@();branchHash=$null;files=@();truncated=$false;errors=@()}
$identityCleanupUnconfirmed=$false
function Save-ActivationManifest {
  [IO.File]::WriteAllText((Join-Path $Diagnostics 'manifest.json.tmp'),(ConvertTo-Json -InputObject $manifest -Depth 7))
  Move-Item -LiteralPath (Join-Path $Diagnostics 'manifest.json.tmp') -Destination (Join-Path $Diagnostics 'manifest.json') -Force
}
# This deliberately recognizes a narrow source shape, not arbitrary Rust syntax.
function Test-ActivationVisibilityGuard([string]$Branch) {
  $head="        WM_ACTIVATE if w & 0xffff == WA_INACTIVE as usize => {`n"
  $tail="            0`n        }`n"
  if(-not $Branch.StartsWith($head,[StringComparison]::Ordinal) -or -not $Branch.EndsWith($tail,[StringComparison]::Ordinal)){return $false}
  # Comments or literals could make source-looking text a false match.
  if($Branch -match '//|/\*|\*/|["'']'){return $false}
  $depth=0
  foreach($character in $Branch.ToCharArray()){
    if($character -eq '{'){$depth++}elseif($character -eq '}'){$depth--;if($depth -lt 0){return $false}}
  }
  if($depth -ne 0 -or [regex]::Matches($Branch,'panel\.visible\.get\(\)').Count -ne 1){return $false}
  $direct=[regex]::Matches($Branch,'(?m)^            if panel\.visible\.get\(\) \{$')
  if($direct.Count -eq 1){return $true}
  $prefix=(@(
    '        WM_ACTIVATE if w & 0xffff == WA_INACTIVE as usize => {'
    '            let _phase = panel.probe.then(|| Phase::new(hwnd, 13));'
    '            let visible = panel.visible.get();'
    '            let mut activation = panel.request_probe.activation(panel.request.get(), hwnd, w, l, visible);'
    '            if visible {'
  ) -join "`n")+"`n"
  if(-not $Branch.StartsWith($prefix,[StringComparison]::Ordinal)){return $false}
  # The immutable alias must reach that condition without a shadow or assignment.
  # Any additional use is unsupported, even when it might be harmless Rust.
  return -not [regex]::IsMatch($Branch.Substring($prefix.Length),'\bvisible\b')
}

function Source-ActivationManifest {
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName='git';$start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-C',$PSScriptRoot,'rev-parse','HEAD')){$start.ArgumentList.Add($argument)}
  $git=[Diagnostics.Process]::Start($start)
  try {
    $output=$git.StandardOutput.ReadToEndAsync();$errorOutput=$git.StandardError.ReadToEndAsync()
    if($git.WaitForExit(1000) -and $git.ExitCode -eq 0 -and $output.Wait(500) -and $output.Result.Trim() -match '^[0-9a-f]{40}$'){$manifest.sha=$output.Result.Trim()}
    else{$manifest.errors+=@('source-commit-unavailable')}
  }finally{
    try {
      if(-not $git.get_HasExited()){$git.Kill();$null=$git.WaitForExit(500)}
      if(-not $git.get_HasExited()){$script:identityCleanupUnconfirmed=$true}
    }catch{$script:identityCleanupUnconfirmed=$true}
    $git.Dispose()
  }
  $repository=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  foreach($name in @('desktop/smoke/loader-activation.cs','desktop/smoke/loader-activation.ps1','desktop/smoke/qualify-loader-activation.ps1','desktop/smoke/test-window-probe.ps1','desktop/src/host/windows_loading.rs')){
    $path=Join-Path $repository $name
    $manifest.source+=@{name=$name;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $path).Length}
  }
  $body=[IO.File]::ReadAllText((Join-Path $repository 'desktop/src/host/windows_loading.rs')).Replace("`r`n","`n")
  $branch=[regex]::Match($body,'(?s)        WM_ACTIVATE if w & 0xffff == WA_INACTIVE as usize => \{.*?(?=        _ => unsafe \{ DefWindowProcW)')
  if($branch.Success -and (Test-ActivationVisibilityGuard $branch.Value) -and $branch.Value.Contains('panel.dismiss(true)')){
    $manifest.branchHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($branch.Value))).ToLowerInvariant()
  }else{$manifest.errors+=@('production-branch-unavailable')}
}
try {Source-ActivationManifest} catch {$manifest.errors+=@('source-binding-unavailable')}
Save-ActivationManifest
$results=New-Object 'System.Collections.Generic.List[object]'
$cleanupUnconfirmed=$identityCleanupUnconfirmed
foreach($case in @(@('baseline','stale'),@('guard','stale'),@('guard','blur'),@('guard','escape'),@('guard','handoff'))){
  if($cleanupUnconfirmed){break}
  $name=$case[0]+'-'+$case[1];$file=Join-Path $Diagnostics ($name+'.json')
  $worker=$null;$reading=$null
  $cleanup=[ordered]@{pid=0;started=$false;exited=$false;killed=$false;killReturned=$false;exitCode=$null;error=$null}
  try {
    if(-not $IsWindows){$cleanup.exited=$true;$cleanup.error='native-Windows-runtime-unavailable'}
    else {
      $start=[Diagnostics.ProcessStartInfo]::new()
      $start.FileName=(Get-Process -Id $PID).Path;$start.UseShellExecute=$false
      foreach($argument in @('-NoProfile','-File',$PSCommandPath,'-Policy',$case[0],'-Scenario',$case[1],'-Output',$file)){$start.ArgumentList.Add($argument)}
      $worker=[Diagnostics.Process]::Start($start);$cleanup.started=$true;$cleanup.pid=$worker.Id;$manifest.runtimeExecuted=$true
      $cleanup.exited=$worker.WaitForExit(10000)
      if($cleanup.exited){$cleanup.exitCode=$worker.ExitCode}else{$cleanup.error='native-control-deadline'}
    }
  } catch {$cleanup.error='native-control-unavailable'}
  finally {
    if($worker){
      try {
        if(-not $worker.get_HasExited()){$cleanup.killed=$true;$worker.Kill();$cleanup.killReturned=$true;$cleanup.exited=$worker.WaitForExit(500)}
        $cleanup.exited=$worker.get_HasExited()
        if($cleanup.exited){$cleanup.exitCode=$worker.ExitCode}
      }catch{$cleanup.error='worker-cleanup-unconfirmed';$cleanup.exited=$false}
      $worker.Dispose()
    }
    if($cleanup.started -and -not $cleanup.exited){$cleanupUnconfirmed=$true}
    [IO.File]::WriteAllText(($file+'.worker.json'),(ConvertTo-Json -InputObject $cleanup -Depth 4))
  }
  if(Test-Path -LiteralPath $file){
    try {
      if((Get-Item -LiteralPath $file).Length -gt 262144){$manifest.truncated=$true;$manifest.errors+=@('native-receipt-over-limit')}
      else{$reading=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($file))}
    }catch{$manifest.errors+=@('native-receipt-malformed')}
  }
  $qualified=Test-LoaderActivationEvidence $reading $cleanup $case[0] $case[1]
  $results.Add(@{policy=$case[0];scenario=$case[1];qualification=$qualified})
  if($reading -and $reading.overflow -ne 0){$manifest.truncated=$true}
  if($cleanupUnconfirmed){break}
}
foreach($source in $manifest.source){
  try {
    $repository=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    if((Get-FileHash -LiteralPath (Join-Path $repository $source.name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256){$manifest.errors+=@('source-changed-during-native-control')}
  }catch{$manifest.errors+=@('source-readback-unavailable')}
}
$manifest.status=if($cleanupUnconfirmed){'cleanup-unconfirmed'}else{'complete'}
$status=if($cleanupUnconfirmed){'cleanup-unconfirmed'}elseif($manifest.errors.Count -or $manifest.truncated -or $results.Count -ne 5){'insufficient'}elseif(@($results|Where-Object {$_.qualification.status -eq 'policy-failed'}).Count){'policy-failed'}elseif(@($results|Where-Object {$_.qualification.status -ne 'qualified'}).Count){'unavailable'}else{'qualified'}
$outcomes=@{scope='native-policy-model';status=$status;productionAcceptance=$false;nativeScheduleQualified=($status -eq 'qualified');cases=$results.ToArray()}
[IO.File]::WriteAllText((Join-Path $Diagnostics 'outcomes.json'),(ConvertTo-Json -InputObject $outcomes -Depth 8))
$manifest.files=@(Get-ChildItem -LiteralPath $Diagnostics -Filter '*.json' | Where-Object {$_.Name -ne 'manifest.json'} | ForEach-Object {@{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
Save-ActivationManifest
Write-Host "Native activation policy-model diagnostics: $status; productionAcceptance=false"
if($cleanupUnconfirmed){throw 'Native activation worker cleanup unconfirmed'}
