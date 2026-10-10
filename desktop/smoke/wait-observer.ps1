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
  $observer=[pscustomobject]@{Process=$null;Output=$null;Errors=$null;Status='unavailable';Started=$false}
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

# Call only after the independent pause guard has resumed the UI.
function Stop-WaitObserver($Observer) {
  if(-not $Observer){return @{status='unavailable';stopped=$true;samples=@()}}
  $status=$Observer.Status;$samples=@();$stopped=$status -ne 'cleanup-unconfirmed'
  try {
    if($Observer.Process){
      $Observer.Process.StandardInput.Close()
      if(-not $Observer.Process.WaitForExit(2000)){$status='timeout'}
      elseif($Observer.Started -and $Observer.Process.ExitCode -eq 0){$status='complete'}
    }
  } catch {$status='unavailable'}
  finally {
    if($Observer.Process){
      try {if(-not $Observer.Process.HasExited){$Observer.Process.Kill();$stopped=$Observer.Process.WaitForExit(500)}} catch {$stopped=$false}
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
  return @{status=$status;stopped=$stopped;limitMs=5000;intervalMs=200;samples=$samples}
}
