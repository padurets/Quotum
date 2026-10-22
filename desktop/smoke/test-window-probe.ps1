param([string]$Mode,[string]$Ready,[string]$Delivered)
$ErrorActionPreference='Stop'
if($Mode){
  Add-Type -Path (Join-Path $PSScriptRoot 'window-receiver.cs')
  [QuotumTestReceiver]::Run($Mode,$Ready,$Delivered)
  exit
}
Add-Type -Path (Join-Path $PSScriptRoot 'window-probe.cs')
$root=Join-Path $env:TEMP ('quotum-probe-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
try {
  foreach($case in @('accepted','rejected','late','unresponsive','tray')){
    $ready=Join-Path $root ($case+'.ready');$delivered=Join-Path $root ($case+'.delivered')
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=(Get-Process -Id $PID).Path;$start.UseShellExecute=$false
    foreach($argument in @('-NoProfile','-File',$PSCommandPath,'-Mode',$case,'-Ready',$ready,'-Delivered',$delivered)){$start.ArgumentList.Add($argument)}
    $receiver=[Diagnostics.Process]::Start($start);$null=$receiver.Handle
    $guard=$null
    try {
      $until=(Get-Date).AddSeconds(10)
      while(-not (Test-Path $ready) -and -not $receiver.HasExited -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 20}
      if(-not (Test-Path $ready)){throw 'Native receiver did not start'}
      $window=[IntPtr]([long]([IO.File]::ReadAllText($ready)))
      if($case -eq 'tray'){
        if(-not [QuotumWindowProbe]::OpenPanel($receiver.Id)){throw 'Owned tray callback was not posted'}
        $posted=[QuotumWindowProbe]::LastPanelDispatch
        if(-not $posted.Owned -or -not $posted.Posted -or $posted.Window -ne $window.ToInt64() -or $posted.Process -ne $receiver.Id -or -not $posted.Thread -or $posted.FromUtcTicks -gt $posted.ToUtcTicks){throw 'Tray dispatch lost its original target or queue receipt'}
        $until=(Get-Date).AddSeconds(2)
        while(-not (Test-Path $delivered) -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 20}
        if(-not (Test-Path $delivered) -or [IO.File]::ReadAllText($delivered) -ne 'valid'){throw 'Tray callback payload changed'}
        if([QuotumWindowProbe]::OpenPanel(0)){throw 'Missing tray callback was posted'}
        $missing=[QuotumWindowProbe]::LastPanelDispatch
        if($missing.Posted -or $missing.Owned -or $missing.Window -ne 0 -or -not $posted.Posted){throw 'Missing tray lost its failure or rewrote the earlier receipt'}
        [QuotumWindowProbe]::ResetDispatch()
        if($null -ne [QuotumWindowProbe]::LastPanelDispatch){throw 'Tray receipt leaked into another smoke run'}
        continue
      }
      $caught=$false
      try {
        $guard=[QuotumWindowProbe]::MainRequestThenPause($receiver.Id,'fixture.exe')
        if($case -ne 'accepted'){throw 'A rejected or timed-out dispatch paused the receiver'}
        if([QuotumWindowProbe]::Responsive($window,$receiver.Id)){throw 'Paused receiver remained responsive'}
        $snapshot=[QuotumWindowProbe]::Snapshot($window,$receiver.Id)
        if(-not $snapshot.Owned -or $snapshot.Rounded -or $snapshot.LoadingPhase -ne 0x145){throw 'Owned square receiver or phase was misclassified'}
        $unresponsive=[QuotumWindowProbe]::LastUnresponsive
        if(-not $unresponsive.Owned -or $unresponsive.LoadingPhase -ne 0x145 -or $unresponsive.Window -ne $window.ToInt64() -or $unresponsive.FromUtcTicks -gt $unresponsive.ToUtcTicks){throw 'Failed response lost its owned phase before resume'}
        $foreign=[QuotumWindowProbe]::Snapshot($window,$PID)
        if($foreign.Owned -or $null -ne $foreign.LoadingPhase){throw 'Foreign receiver was classified as owned'}
        # An exception immediately after acquiring the pause must still resume it.
        throw 'controlled exception after pause'
      } catch {if($case -eq 'accepted' -and $_.Exception.Message -ne 'controlled exception after pause'){throw};$caught=$true} finally {if($guard){$guard.Dispose()}}
      $reading=[QuotumWindowProbe]::LastDispatch
      if($case -ne 'accepted' -and $null -ne [QuotumWindowProbe]::Snapshot($window,$receiver.Id).LoadingPhase){throw 'Malformed phase was accepted'}
      if(-not $caught -or $reading.ElapsedMs -gt 3500){throw "Unbounded dispatch: $case"}
      $expected=switch($case){accepted {'accepted'} rejected {'rejected'} late {'unknown'} unresponsive {'not-sent'}}
      if($reading.Acceptance -ne $expected -or $reading.Paused -ne ($case -eq 'accepted')){throw "Incorrect acceptance/pause: $case"}
      if($case -eq 'accepted' -and (-not $guard.Resumed -or -not [QuotumWindowProbe]::Responsive($window,$receiver.Id))){throw 'Exception did not resume the owned UI'}
      if($reading.ResumeAttempted -ne ($case -eq 'accepted') -or $reading.Resumed -ne ($case -eq 'accepted')){throw 'Resume evidence disagrees with the actual native thread'}
      if($case -eq 'late'){
        $until=(Get-Date).AddSeconds(4)
        while(-not (Test-Path $delivered) -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 20}
        if(-not (Test-Path $delivered) -or [IO.File]::ReadAllText($delivered) -ne 'valid'){throw 'Timed-out receiver lost its marshalled payload'}
      }
      Write-Host ($reading | ConvertTo-Json -Compress)
      [QuotumWindowProbe]::ResetDispatch()
      if($null -ne [QuotumWindowProbe]::LastDispatch -or $null -ne [QuotumWindowProbe]::LastUnresponsive -or $null -ne [QuotumWindowProbe]::LastPanelDispatch){throw 'A new smoke run inherited the previous dispatch or failure'}
    } finally {
      if($guard){$guard.Dispose()}
      if(-not $receiver.HasExited){$receiver.Kill();if(-not $receiver.WaitForExit(5000)){throw 'Receiver cleanup failed'}}
      $receiver.Dispose()
    }
  }
  $failed=$false
  try {[QuotumWindowProbe]::MainRequestThenPause(0,'fixture.exe') | Out-Null} catch {$failed=$true}
  if(-not $failed -or [QuotumWindowProbe]::LastDispatch.Acceptance -ne 'not-sent'){throw 'Missing target was accepted'}
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
# The controlled probe has the native probe's type name, so keep it in a child.
& (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $PSScriptRoot 'test-windows-background.ps1')
if($LASTEXITCODE){throw 'Background setup controls failed'}
& (Join-Path $PSScriptRoot 'test-windows-request-evidence.ps1')
