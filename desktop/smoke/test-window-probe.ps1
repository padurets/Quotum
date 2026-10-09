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
  foreach($case in @('accepted','rejected','late','unresponsive')){
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
      $caught=$false
      try {
        $guard=[QuotumWindowProbe]::MainRequestThenPause($receiver.Id,'fixture.exe')
        if($case -ne 'accepted'){throw 'A rejected or timed-out dispatch paused the receiver'}
        if([QuotumWindowProbe]::Responsive($window)){throw 'Paused receiver remained responsive'}
        $snapshot=[QuotumWindowProbe]::Snapshot($window,$receiver.Id)
        if(-not $snapshot.Owned -or $snapshot.Rounded){throw 'Owned square receiver was misclassified'}
        if([QuotumWindowProbe]::Snapshot($window,$PID).Owned){throw 'Foreign receiver was classified as owned'}
        # An exception immediately after acquiring the pause must still resume it.
        throw 'controlled exception after pause'
      } catch {if($case -eq 'accepted' -and $_.Exception.Message -ne 'controlled exception after pause'){throw};$caught=$true} finally {if($guard){$guard.Dispose()}}
      $reading=[QuotumWindowProbe]::LastDispatch
      if(-not $caught -or $reading.ElapsedMs -gt 3500){throw "Unbounded dispatch: $case"}
      $expected=switch($case){accepted {'accepted'} rejected {'rejected'} late {'unknown'} unresponsive {'not-sent'}}
      if($reading.Acceptance -ne $expected -or $reading.Paused -ne ($case -eq 'accepted')){throw "Incorrect acceptance/pause: $case"}
      if($case -eq 'accepted' -and (-not $guard.Resumed -or -not [QuotumWindowProbe]::Responsive($window))){throw 'Exception did not resume the owned UI'}
      if($case -eq 'late'){
        $until=(Get-Date).AddSeconds(4)
        while(-not (Test-Path $delivered) -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 20}
        if(-not (Test-Path $delivered) -or [IO.File]::ReadAllText($delivered) -ne 'valid'){throw 'Timed-out receiver lost its marshalled payload'}
      }
      Write-Host ($reading | ConvertTo-Json -Compress)
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
