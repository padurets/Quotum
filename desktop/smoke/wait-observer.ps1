# Start outside the paused interval. A failed observer never changes a smoke assertion.
if(-not ('QuotumWaitCapture' -as [type])){
  Add-Type @'
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
public sealed class QuotumWaitCapture {
  readonly List<string> lines=new List<string>();
  int length;
  public bool Overflow {get;private set;}
  public Task Done {get;private set;}
  public QuotumWaitCapture(StreamReader reader) {
    Done=Task.Run(async()=>{
      string line;
      while((line=await reader.ReadLineAsync())!=null)lock(lines){
        if(length+line.Length<=131072 && lines.Count<26){lines.Add(line);length+=line.Length;}
        else Overflow=true;
      }
    });
  }
  public string[] Snapshot(){lock(lines)return lines.ToArray();}
}
'@
}
function Start-WaitObserver($Owner,[string]$Worker=(Join-Path $PSScriptRoot 'windows-waitchain.ps1')) {
  $observer=[pscustomobject]@{Process=$null;Output=$null;Errors=$null;Status='unavailable';Started=$false;StopReceipt=$null}
  try {
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=(Get-Process -Id $PID).Path;$start.UseShellExecute=$false
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    foreach($argument in @('-NoProfile','-File',$Worker,'-Owner',[string]$Owner.Id,'-Birth',[string]$Owner.StartTime.ToUniversalTime().Ticks)){$start.ArgumentList.Add($argument)}
    $observer.Process=[Diagnostics.Process]::Start($start)
    $observer.Errors=$observer.Process.StandardError.ReadToEndAsync()
    $ready=$observer.Process.StandardOutput.ReadLineAsync()
    if($ready.Wait(2000) -and $ready.Result -eq 'ready'){
      $observer.Output=[QuotumWaitCapture]::new($observer.Process.StandardOutput);$observer.Status='ready'
    } else {$observer.Status='startup-timeout'}
  } catch {$observer.Status='unavailable'}
  if($observer.Status -ne 'ready'){
    $ended=Stop-WaitObserver $observer
    $observer.Process=$null
    if(-not $ended.stopped){$observer.Status='cleanup-unconfirmed'}
  }
  return $observer
}

function Watch-OwnedThreads($Observer,[uint32[]]$Threads) {
  if(-not $Observer -or $Observer.Status -ne 'ready'){return}
  try {
    $ids=@($Threads | Where-Object {$_ -gt 0} | Select-Object -Unique)
    if(-not $ids.Count -or $ids.Count -gt 2){$Observer.Status='invalid-threads';return}
    $Observer.Process.StandardInput.WriteLine(($ids -join ','));$Observer.Process.StandardInput.Flush()
    $Observer.Started=$true
  } catch {$Observer.Status='unavailable'}
}

function Set-WaitCleanupFailure($Cleanup,$Failure) {
  $cause=$Failure.Exception.GetBaseException()
  $Cleanup.failure=$Cleanup.stage
  $Cleanup.errorKind=if($cause -is [ComponentModel.Win32Exception]){'win32'}elseif($cause -is [InvalidOperationException]){'invalid-operation'}else{'other'}
  $Cleanup.errorCode=if($cause -is [ComponentModel.Win32Exception]){$cause.NativeErrorCode}else{$null}
}

# Call only after the independent pause guard has resumed the UI.
function Stop-WaitObserver($Observer) {
  if(-not $Observer){return @{status='unavailable';stopped=$true;samples=@()}}
  # Startup failure already closes the worker. Keep that receipt when the paused
  # scenario records its outcome later, after the process handle has been disposed.
  $saved=$Observer.PSObject.Properties['StopReceipt']
  if(-not $Observer.Process -and $saved -and $saved.Value){return $saved.Value}
  $status=$Observer.Status;$samples=@();$stopped=$status -ne 'cleanup-unconfirmed'
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $cleanup=@{stage='inactive';inputClosed=$false;waited=$null;beforeKill=$null;killAttempted=$false;killReturned=$false;afterKill=$null;exited=$null;failure=$null;errorKind=$null;errorCode=$null;elapsedMs=0}
  try {
    if($Observer.Process){
      $cleanup.stage='close-input';$Observer.Process.StandardInput.Close();$cleanup.inputClosed=$true
      $cleanup.stage='wait';$cleanup.waited=$Observer.Process.WaitForExit(2000)
      if(-not $cleanup.waited){$status='timeout'}
      elseif($Observer.Started -and $Observer.Process.ExitCode -eq 0){$status='complete'}
    }
  } catch {$status='unavailable';Set-WaitCleanupFailure $cleanup $_}
  finally {
    if($Observer.Process){
      # Calling the getter preserves failures that PowerShell property access would hide.
      try {
        $cleanup.stage='before-kill';$cleanup.beforeKill=$Observer.Process.get_HasExited()
        if($cleanup.beforeKill -eq $false){
          $cleanup.stage='kill';$cleanup.killAttempted=$true;$Observer.Process.Kill();$cleanup.killReturned=$true
          $cleanup.stage='wait-after-kill';$cleanup.afterKill=$Observer.Process.WaitForExit(500)
        }
      } catch {Set-WaitCleanupFailure $cleanup $_}
      # A worker can exit between HasExited and Kill. Confirm its state on the same handle.
      try {$cleanup.stage='confirm-exit';$cleanup.exited=$Observer.Process.get_HasExited();$stopped=$cleanup.exited -eq $true}
      catch {$stopped=$false;if(-not $cleanup.failure){Set-WaitCleanupFailure $cleanup $_}}
      $cleanup.stage='output'
      # Preserve already-flushed samples even if a later native query hung.
      try {
        if($Observer.Output){
          $done=$Observer.Output.Done.Wait(500)
          $samples=@($Observer.Output.Snapshot() | ForEach-Object {ConvertFrom-Json -InputObject $_})
          if($Observer.Output.Overflow){$status='output-truncated'}
          elseif(-not $done -and $status -eq 'complete'){$status='output-unavailable'}
        } elseif($status -eq 'complete'){$status='output-unavailable'}
      } catch {$status='output-unavailable'}
      $Observer.Process.Dispose();$Observer.Process=$null
    }
  }
  $cleanup.stage='finished';$cleanup.elapsedMs=$clock.ElapsedMilliseconds
  $receipt=@{status=$status;stopped=$stopped;limitMs=5000;intervalMs=200;samples=$samples;cleanup=$cleanup}
  Add-Member -InputObject $Observer -MemberType NoteProperty -Name StopReceipt -Value $receipt -Force
  return $receipt
}
