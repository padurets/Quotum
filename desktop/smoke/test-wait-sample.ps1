$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'wait-observer.ps1')

# Scripted delivery and deadlines avoid timing a scheduler.
if(-not ('QuotumWaitSampleControl' -as [type])){
  Add-Type @'
using System;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
public sealed class QuotumWaitSampleControl {
  readonly string mode;
  public int Reads {get;private set;}
  public Task Done {get;}
  public QuotumWaitSampleControl(string mode){this.mode=mode;Done=mode=="closed"?Task.CompletedTask:new TaskCompletionSource<bool>().Task;}
  public int PublishedCount {
    get {
      Reads++;
      if(mode=="error")throw new InvalidOperationException("hidden-wait-sample-canary");
      if(mode=="cancel")throw new OperationCanceledException("hidden-wait-sample-canary");
      return mode=="buffered" || mode=="late" && Reads>=2 ? 1 : 0;
    }
  }
}
public sealed class QuotumWaitCaptureLockControl : IDisposable {
  readonly ManualResetEventSlim release=new ManualResetEventSlim();
  public ManualResetEventSlim Held {get;}=new ManualResetEventSlim();
  public Task Holder {get;}
  public bool TimedOut {get;private set;}
  public QuotumWaitCaptureLockControl(object capture){
    var lines=capture.GetType().GetField("lines",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(capture);
    Holder=Task.Run(()=>{lock(lines){Held.Set();TimedOut=!release.Wait(2000);}});
  }
  public void Dispose(){release.Set();if(!Holder.Wait(2000))throw new InvalidOperationException("capture lock holder did not exit");Held.Dispose();release.Dispose();}
}
'@
}
function Sample-Control([string]$Mode){
  [pscustomobject]@{Status='ready';Started=$true;Output=[QuotumWaitSampleControl]::new($Mode);HeldSampleWait=$null}
}
foreach($case in @('buffered','late','stuck','closed','error')){
  $observer=Sample-Control $case
  $remaining={if($observer.Output.Reads -ge 2){0}else{100}}.GetNewClosure()
  $receipt=Wait-WaitObserverSample $observer $remaining
  $expected=switch($case){'buffered'{'received'}'late'{'received'}'stuck'{'deadline'}'closed'{'output-closed'}'error'{'unavailable'}}
  if($receipt.status -ne $expected){throw "Unexpected sample wait status for $case"}
  if($case -eq 'late' -and $observer.Output.Reads -ne 2){throw 'A late publication was not observed'}
  if($case -eq 'stuck' -and $observer.Output.Reads -ne 2){throw 'A stuck observer escaped its existing deadline'}
  if((ConvertTo-Json $receipt) -match 'canary'){throw 'Sample wait exposed an exception'}
}
$observer=Sample-Control 'buffered'
$receipt=Wait-WaitObserverSample $observer {0}
if($receipt.status -ne 'deadline' -or $observer.Output.Reads){throw 'An expired deadline polled an available row'}
foreach($observer in @($null,[pscustomobject]@{Status='unavailable'})){
  $receipt=Wait-WaitObserverSample $observer {throw 'unavailable observer evaluated a deadline'}
  if($receipt.status -ne 'unavailable'){throw 'Unavailable observer changed its status'}
}
$observer=Sample-Control 'cancel';$cancelled=$false
try {$null=Wait-WaitObserverSample $observer {100}}
catch {if($_.Exception.GetBaseException() -isnot [OperationCanceledException]){throw};$cancelled=$true}
if(-not $cancelled){throw 'Sample wait hid cancellation'}

# Execute the actual opt-in branches. Default must not poll; loading uses its
# original clock even when Escape has a new, later deadline.
# Keep the branch in its caller's clock scope when it creates the closure.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-ui.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'UI smoke did not parse'}
$branches=@($ast.FindAll({param($node)
  $node -is [Management.Automation.Language.IfStatementAst] -and
  $node.Clauses[0].Item1.Extent.Text -in @('$AwaitHeldWaitSample','$AwaitHeldWaitSample -and -not $isControl') -and
  $node.Extent.Text.Contains('Wait-WaitObserverSample')
},$true))
if($branches.Count -ne 2){throw 'Both original paused scenarios must guard their opt-in wait'}
foreach($branch in $branches){
  $loading=$branch.Extent.Text.Contains('loadingClock')
  $condition=if($loading){'$AwaitHeldWaitSample -and -not $isControl'}else{'$AwaitHeldWaitSample'}
  if($branch.Clauses[0].Item1.Extent.Text -ne $condition){throw 'Paused scenario changed its observation guard'}
  $cases=@('default','expired','late','cancel')
  if($loading){$cases+='stale-control'}
  foreach($case in $cases){
    $observer=Sample-Control $(if($case -eq 'cancel'){'cancel'}else{'late'})
    $AwaitHeldWaitSample=$case -ne 'default'
    $isControl=$case -eq 'stale-control'
    $fresh=$case -in @('late','cancel')
    $loadingClock=[pscustomobject]@{ElapsedMilliseconds=$(if($loading -eq $fresh){0}else{3000})}
    $deadline=if($loading -ne $fresh){(Get-Date).AddSeconds(3)}else{(Get-Date).AddSeconds(-1)}
    $cancelled=$false
    try {. ([scriptblock]::Create($branch.Extent.Text))}
    catch {if($case -ne 'cancel' -or $_.Exception.GetBaseException() -isnot [OperationCanceledException]){throw};$cancelled=$true}
    if($case -eq 'cancel'){
      if(-not $cancelled -or $observer.HeldSampleWait.status -ne 'interrupted'){throw 'Caller hid its interrupted wait'}
    }elseif($case -eq 'late'){
      if($observer.Output.Reads -ne 2 -or $observer.HeldSampleWait.status -ne 'received'){throw 'Successful caller resumed before its late row'}
    }else{
      if($observer.Output.Reads){throw 'Default or expired caller polled the observer'}
      if($case -eq 'expired' -and $observer.HeldSampleWait.status -ne 'deadline'){throw 'Caller replaced its original deadline'}
      if($case -in @('default','stale-control') -and $observer.HeldSampleWait){throw 'Unobserved smoke case acquired an observation wait'}
    }
  }
}

# A row remains observable while another thread owns the capture's list lock.
$stream=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes("{}`n"))
$reader=[IO.StreamReader]::new($stream)
$capture=[QuotumWaitCapture]::new($reader);$held=$null
try {
  if(-not $capture.Done.Wait(2000) -or $capture.PublishedCount -ne 1){throw 'Controlled capture did not publish its row'}
  $held=[QuotumWaitCaptureLockControl]::new($capture)
  if(-not $held.Held.Wait(2000)){throw 'Controlled capture lock was not held'}
  $observer=[pscustomobject]@{Status='ready';Started=$true;Output=$capture}
  $receipt=Wait-WaitObserverSample $observer {100}
  if($receipt.status -ne 'received' -or $held.TimedOut){throw 'The paused wait took the capture lock'}
} finally {
  if($held){$held.Dispose()}
  $reader.Dispose();$stream.Dispose()
}
Write-Host 'Held sample controls passed; no app, window or provider client was started.'
