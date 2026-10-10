$ErrorActionPreference='Stop'
if(-not ('QuotumWindowProbe' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'window-probe.cs')}
. (Join-Path $PSScriptRoot 'wait-observer.ps1')
$root=Join-Path $env:TEMP ('quotum-wait-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
try {
  foreach($mode in @('native','stuck')){
    $ready=Join-Path $root ($mode+'.ready');$delivered=Join-Path $root ($mode+'.delivered')
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=(Get-Process -Id $PID).Path;$start.UseShellExecute=$false
    foreach($argument in @('-NoProfile','-File',(Join-Path $PSScriptRoot 'test-window-probe.ps1'),'-Mode','wait-chain','-Ready',$ready,'-Delivered',$delivered)){$start.ArgumentList.Add($argument)}
    $receiver=[Diagnostics.Process]::Start($start);$null=$receiver.Handle
    $observer=$null;$paused=[IntPtr]::Zero;$evidence=$null
    try {
      $until=(Get-Date).AddSeconds(10)
      while((-not (Test-Path $ready) -or -not (Test-Path $delivered)) -and -not $receiver.HasExited -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 20}
      if(-not (Test-Path $delivered)){throw 'Wait-chain receiver did not start'}
      $window=[IntPtr]([long]([IO.File]::ReadAllText($ready)))
      $waiter=[uint32]([IO.File]::ReadAllText($delivered))
      $ui=[QuotumWindowProbe]::Snapshot($window,$receiver.Id)
      if($mode -eq 'native'){$observer=Start-WaitObserver $receiver}
      else {
        $worker=Join-Path $root 'stuck.ps1'
        [IO.File]::WriteAllText($worker,@'
param([int]$Owner,[long]$Birth)
[Console]::Out.WriteLine('ready');[Console]::Out.Flush()
$null=[Console]::In.ReadLine()
[Console]::Out.WriteLine('{"at":1,"end":2,"readings":[]}');[Console]::Out.Flush()
Start-Sleep -Seconds 60
'@)
        $observer=Start-WaitObserver $receiver $worker
      }
      if($observer.Status -ne 'ready'){throw 'Wait observer did not become ready'}
      try {
        $paused=[QuotumWindowProbe]::PauseUi($window,$receiver.Id)
        $from=[DateTime]::UtcNow.Ticks
        $foreign=[uint32]([Diagnostics.Process]::GetCurrentProcess().Threads[0].Id)
        Watch-OwnedThreads $observer @($waiter,$foreign)
        $until=(Get-Date).AddSeconds(2)
        while(-not $observer.Output.Snapshot().Length -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 10}
        if(-not $observer.Output.Snapshot().Length){throw 'Observer produced no sample during the controlled pause'}
        throw 'controlled failure while UI is paused'
      } catch {if($_.Exception.Message -ne 'controlled failure while UI is paused'){throw}}
      finally {
        $to=[DateTime]::UtcNow.Ticks
        if($paused -ne [IntPtr]::Zero){[QuotumWindowProbe]::ResumeUi($paused);$paused=[IntPtr]::Zero}
      }
      if(-not [QuotumWindowProbe]::Responsive($window)){throw 'Observer prevented UI resume'}
      [void][QuotumWindowProbe]::PostMessage($window,0x8006,[IntPtr]::Zero,[IntPtr]::Zero)
      $stopClock=[Diagnostics.Stopwatch]::StartNew()
      $evidence=Stop-WaitObserver $observer
      if(-not $evidence.stopped -or $stopClock.ElapsedMilliseconds -gt 3500){throw 'Observer cleanup was not bounded'}
      if($mode -eq 'stuck'){
        if($evidence.status -ne 'timeout' -or $evidence.samples.Count -ne 1){throw 'Hung observer lost its flushed evidence'}
      } else {
        if($evidence.status -ne 'complete'){throw 'Native wait-chain evidence unavailable'}
        $during=@($evidence.samples | Where-Object {$_.at -ge $from -and $_.end -le $to})
        $chains=@($during | ForEach-Object {$_.readings} | Where-Object {$_.thread -eq $waiter} | ForEach-Object {$_.chain})
        $found=@($chains | Where-Object {
          @($_.nodes | Where-Object {$_.type -eq 3}).Count -gt 0 -and
          @($_.nodes | Where-Object {$_.type -eq 8 -and $_.thread -eq $ui.Thread -and $_.process -eq $receiver.Id}).Count -gt 0
        })
        if(-not $found.Count){throw 'No original paused-owner dependency was captured'}
        $rejected=@($during | ForEach-Object {$_.readings} | Where-Object {$_.chain.status -eq 'foreign-thread' -and $_.thread -eq 0})
        if(-not $rejected.Count){throw 'Foreign thread was not refused'}
        if((ConvertTo-Json -InputObject $evidence -Depth 9) -match 'canary|ObjectName|Local\\'){throw 'Wait-chain evidence leaked a private lock name'}
      }
      $until=(Get-Date).AddSeconds(2)
      while([IO.File]::ReadAllText($delivered) -ne 'released' -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 20}
      if([IO.File]::ReadAllText($delivered) -ne 'released'){throw 'Resumed owner did not release the real mutex'}
      if($mode -eq 'native'){
        # A post-resume query cannot reconstruct the dependency that just disappeared.
        $observer=Start-WaitObserver $receiver
        if($observer.Status -ne 'ready'){throw 'Post-resume control did not start'}
        Watch-OwnedThreads $observer @($waiter)
        $until=(Get-Date).AddSeconds(2)
        while(-not $observer.Output.Snapshot().Length -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 10}
        $after=Stop-WaitObserver $observer
        if($after.status -ne 'complete' -or -not $after.samples.Count -or -not $after.stopped){throw 'Post-resume control unavailable'}
        $owners=@($after.samples | ForEach-Object {$_.readings} | ForEach-Object {$_.chain.nodes} | Where-Object {$_.type -eq 8 -and $_.thread -eq $ui.Thread})
        if($owners.Count){throw 'Released mutex unexpectedly retains its earlier owner'}
      }
      Write-Host (ConvertTo-Json -Compress -InputObject @{case=$mode;status=$evidence.status;samples=$evidence.samples.Count;resumed=$true})
    } catch {
      if($evidence){Write-Host (ConvertTo-Json -InputObject $evidence -Depth 9)}
      throw
    } finally {
      if($paused -ne [IntPtr]::Zero){[QuotumWindowProbe]::ResumeUi($paused)}
      if($observer -and $observer.Process){$null=Stop-WaitObserver $observer}
      if(-not $receiver.HasExited){$receiver.Kill();if(-not $receiver.WaitForExit(5000)){throw 'Receiver cleanup failed'}}
      $receiver.Dispose()
    }
  }
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
