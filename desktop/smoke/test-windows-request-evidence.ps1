param([string]$Report)
$ErrorActionPreference='Stop'
if(-not ('QuotumWindowProbe' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'window-probe.cs')}
$controls=New-Object 'System.Collections.Generic.List[object]'
# These typed numeric fixtures exercise the actual qualifier, without native calls.
function New-RequestHeader([long]$Callbacks=1,[long]$Epoch=3) {
  $h=[QuotumWindowProbe+RequestHeader]::new()
  $h.Window=400;$h.Birth=10000;$h.Process=2646;$h.Thread=21;$h.Owned=$true;$h.Class='QuotumTray';$h.Status='qualified'
  $h.SequenceBefore=2;$h.SequenceAfter=2;$h.Schema=1;$h.Lifetime=1;$h.Epoch=$Epoch
  $h.Source=1;$h.Event=2;$h.SourceWindow=400;$h.Kind=1;$h.OwnerThread=21;$h.Callbacks=$Callbacks
  return $h
}
function New-RequestFrame {
  $f=[QuotumWindowProbe+RequestFrame]::new();$f.BeforeCleanup=$true
  $f.Before=New-RequestHeader;$f.After=New-RequestHeader
  $f.Rows=[QuotumWindowProbe+RequestRecord[]]::new(15)
  for($lane=0;$lane -lt 15;$lane++){
    $r=[QuotumWindowProbe+RequestRecord]::new();$r.Lane=$lane;$r.Values=[long[]]::new(10);$f.Rows[$lane]=$r
  }
  $f.Rows[0].Sequence=2;$f.Rows[0].Epoch=2;$f.Rows[0].Values=[long[]]@(100,1,21,2,0,1,0,0,0,0)
  $f.Rows[1].Sequence=2;$f.Rows[1].Epoch=3;$f.Rows[1].Values=[long[]]@(100,0,44,2,0,1,0,0,0,0)
  return $f
}
function Test-Receipt([string]$Name,[scriptblock]$Arrange,[scriptblock]$Assert) {
  $frame=New-RequestFrame;$baseline=New-RequestHeader 0 1
  & $Arrange $frame $baseline
  $e=[QuotumWindowProbe]::QualifyRequests($frame,$baseline,2646,10000)
  & $Assert $e
  if($e.OriginalPostedInputAccepted -or $e.FreshWorkerAtFailedDeadline -or $e.ProductionAcceptance -or $e.CausalPass -or $e.VisibilityProved -or $e.WholePipelineQualified -or $e.Scope -ne 'last-natural-owner-snapshot' -or $e.InputAttribution -ne 'unknown-last-natural-baseline'){throw "Scope was widened: $Name"}
  $controls.Add([ordered]@{name=$Name;status=$e.Status;link=$e.LinkStatus;callbackAccepted=$e.CallbackAccepted;passed=$true})
}
$accepted={param($e) if($e.Status -ne 'qualified' -or $e.LinkStatus -ne 'qualified' -or -not $e.CallbackAccepted -or $e.Request -ne 100){throw 'Actual accepted revision lost its unique numeric binding'}}
$unknown={param($e) if($e.CallbackAccepted -or $e.LinkStatus -eq 'qualified'){throw 'Incomplete or ambiguous evidence accepted the callback'}}
Test-Receipt 'accepted-partial-pipeline' {} {param($e) & $accepted $e;if($null -eq [QuotumWindowProbe]::ForRequest($e,1) -or $null -ne [QuotumWindowProbe]::ForRequest($e,2) -or $e.Frame.Rows[2].Status -ne 'unknown-milestone'){throw 'An absent build marker became observed'}}
Test-Receipt 'accepted-hide-revision' {param($f,$b)$f.Rows[0].Values[3]=3;$f.Rows[0].Values[5]=0} {param($e)& $accepted $e;if($e.WantedCompact){throw 'Hide was reinterpreted as show'}}
Test-Receipt 'callback-entered-before-acceptance' {param($f,$b)$f.Rows[0].Values[0]=0;$f.Rows[0].Values[3]=1;$f.Rows[0].Values[5]=0} {param($e)& $unknown $e;if(-not $e.CallbackObserved -or $e.LinkStatus -ne 'observed-not-accepted'){throw 'Callback entry was relabelled as policy acceptance'}}
Test-Receipt 'cross-request-worker' {param($f,$b)$f.Rows[1].Values[0]=99} {param($e)& $accepted $e;if($null -ne [QuotumWindowProbe]::ForRequest($e,1) -or $e.Frame.Rows[1].Status -ne 'other-request'){throw 'Another revision was joined into the accepted request'}}
Test-Receipt 'wrong-pid' {param($f,$b)$f.Before.Process=777;$f.After.Process=777} $unknown
Test-Receipt 'wrong-process-birth' {param($f,$b)$f.Before.Birth=999;$f.After.Birth=999} $unknown
Test-Receipt 'foreign-hwnd' {param($f,$b)$f.Before.Owned=$false;$f.After.Owned=$false} $unknown
Test-Receipt 'foreign-source-hwnd' {param($f,$b)$f.Before.SourceWindow=777;$f.After.SourceWindow=777} $unknown
Test-Receipt 'wrong-class' {param($f,$b)$f.Before.Class='';$f.After.Class=''} $unknown
Test-Receipt 'wrong-owner-thread' {param($f,$b)$f.Before.OwnerThread=44;$f.After.OwnerThread=44} $unknown
Test-Receipt 'unavailable-with-complete-numbers' {param($f,$b)$f.Before.Status='unavailable';$f.After.Status='unavailable'} $unknown
Test-Receipt 'missing-schema' {param($f,$b)$f.Before.Schema=0;$f.After.Schema=0} $unknown
Test-Receipt 'wrong-snapshot-source-flag' {param($f,$b)$f.Before.Source=2;$f.After.Source=2} $unknown
Test-Receipt 'odd-native-publication' {param($f,$b)$f.Before.SequenceBefore=3;$f.Before.SequenceAfter=3;$f.After.SequenceBefore=3;$f.After.SequenceAfter=3} $unknown
Test-Receipt 'publication-changed-during-read' {param($f,$b)$f.After.SequenceBefore=4;$f.After.SequenceAfter=4} $unknown
Test-Receipt 'epoch-changed-during-read' {param($f,$b)$f.After.Epoch=4} $unknown
Test-Receipt 'lifetime-changed' {param($f,$b)$f.After.Lifetime=2} $unknown
foreach($flag in @(1,2,4,8,16,32)){
  Test-Receipt ('publisher-error-'+$flag) {param($f,$b)$f.Before.Errors=$flag;$f.After.Errors=$flag} $unknown
}
Test-Receipt 'odd-memory-record' {param($f,$b)$f.Rows[1].Sequence=1} $unknown
Test-Receipt 'future-record-epoch' {param($f,$b)$f.Rows[1].Epoch=4} $unknown
Test-Receipt 'missing-record' {param($f,$b)$f.Rows[1]=$null} $unknown
Test-Receipt 'missing-numeric-field' {param($f,$b)$f.Rows[1].Values=[long[]]::new(9)} $unknown
Test-Receipt 'absent-sequence-with-present-values' {param($f,$b)$f.Rows[1].Sequence=0} $unknown
Test-Receipt 'two-callbacks-after-input-baseline' {param($f,$b)$f.Before.Callbacks=2;$f.After.Callbacks=2;$f.Rows[0].Values[1]=2} $unknown
Test-Receipt 'no-new-callback-in-stale-snapshot' {param($f,$b)$b.Callbacks=1} $unknown
Test-Receipt 'different-acceptance-thread' {param($f,$b)$f.Rows[0].Values[2]=44} $unknown
Test-Receipt 'different-callback-ordinal' {param($f,$b)$f.Rows[0].Values[1]=2} $unknown
Test-Receipt 'missing-accepted-revision' {param($f,$b)$f.Rows[0].Values[0]=0} $unknown
Test-Receipt 'cleanup-reading' {param($f,$b)$f.BeforeCleanup=$false} $unknown
function Add-Inactive([object]$f,[long]$Flags=19) {
  $f.Before.Epoch=4;$f.After.Epoch=4;$f.Before.Activations=1;$f.After.Activations=1
  $f.Before.Kind=2;$f.After.Kind=2;$f.Before.SourceWindow=500;$f.After.SourceWindow=500;$f.Before.Event=5;$f.After.Event=5
  $f.Rows[7].Sequence=2;$f.Rows[7].Epoch=4;$f.Rows[7].Values=[long[]]@(100,1,21,2,500,0,400,0,0,$Flags)
}
Test-Receipt 'inactive-foreground-unobserved' {param($f,$b)Add-Inactive $f} $accepted
Test-Receipt 'inactive-fabricated-foreground-observation' {param($f,$b)Add-Inactive $f 23} $unknown
Test-Receipt 'inactive-wrong-wparam' {param($f,$b)Add-Inactive $f;$f.Rows[7].Values[5]=1} $unknown
Test-Receipt 'inactive-source-hwnd-mismatch' {param($f,$b)Add-Inactive $f;$f.Before.SourceWindow=600;$f.After.SourceWindow=600} $unknown
Test-Receipt 'missing-inactive-row' {param($f,$b)$f.Before.Activations=1;$f.After.Activations=1} $unknown
Test-Receipt 'omitted-activations-since-input' {
  param($f,$b)$f.Before.Epoch=10;$f.After.Epoch=10;$f.Before.Activations=10;$f.After.Activations=10
  for($ordinal=3;$ordinal -le 10;$ordinal++){$slot=7+($ordinal-1)%8;$f.Rows[$slot].Sequence=2;$f.Rows[$slot].Epoch=$ordinal;$f.Rows[$slot].Values=[long[]]@(100,$ordinal,21,3,500,0,400,0,0,19)}
} $unknown
Test-Receipt 'future-input-baseline' {param($f,$b)$b.Epoch=4} $unknown
Test-Receipt 'counter-overflow' {param($f,$b)$f.Before.Callbacks=[long]::MaxValue;$f.After.Callbacks=[long]::MaxValue} $unknown
# Extract only the production smoke's pure batch qualifier; do not start an app.
$parseErrors=$null
$uiAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-ui.ps1'),[ref]$null,[ref]$parseErrors)
if($parseErrors.Count){throw 'Windows UI script syntax failed'}
$qualifier=@($uiAst.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-LoaderBatchState'},$true))
if($qualifier.Count -ne 1){throw 'Native batch qualifier unavailable'}
Invoke-Expression $qualifier[0].Extent.Text
function Test-Batch([string]$Name,[scriptblock]$Arrange,[string]$Expected) {
  $f=New-RequestFrame;$b=New-RequestHeader 1 1
  $f.Before.Callbacks=3;$f.After.Callbacks=3;$f.Before.SequenceBefore=4;$f.Before.SequenceAfter=4;$f.After.SequenceBefore=4;$f.After.SequenceAfter=4
  $f.Rows[0].Values=[long[]]@(102,3,21,2,0,1,0,0,0,0)
  $f.Rows[6].Sequence=2;$f.Rows[6].Epoch=3;$f.Rows[6].Values=[long[]]@(102,0,21,6,500,0,0,0,0,0)
  & $Arrange $f $b
  $e=[QuotumWindowProbe]::QualifyRequests($f,$b,2646,10000)
  $state=Get-LoaderBatchState $e $b 100 500
  if($state -ne $Expected){throw "Batch state mismatch: $Name ($state)"}
  if($e.OriginalPostedInputAccepted -or $e.FreshWorkerAtFailedDeadline -or $e.ProductionAcceptance -or $e.CausalPass){throw "Batch widened original evidence: $Name"}
  $controls.Add(@{name='batch-'+$Name;status=$e.Status;link=$e.LinkStatus;batch=$state;passed=$true})
}
Test-Batch 'latest-show-with-two-callbacks' {} 'new-show'
Test-Batch 'old-hide-is-only-a-marker' {param($f,$b)$f.Rows[6].Values[0]=100;$f.Rows[6].Values[3]=8} 'old-hide'
Test-Batch 'old-show-is-pending' {param($f,$b)$f.Rows[6].Values[0]=100} 'pending'
Test-Batch 'only-one-callback' {param($f,$b)$f.Before.Callbacks=2;$f.After.Callbacks=2;$f.Rows[0].Values[1]=2} 'unknown'
Test-Batch 'extra-callback' {param($f,$b)$f.Before.Callbacks=4;$f.After.Callbacks=4;$f.Rows[0].Values[1]=4} 'unknown'
Test-Batch 'another-request' {param($f,$b)$f.Rows[0].Values[0]=103} 'unknown'
Test-Batch 'another-loader' {param($f,$b)$f.Rows[6].Values[4]=501} 'unknown'
Test-Batch 'another-thread' {param($f,$b)$f.Rows[6].Values[2]=44} 'unknown'
Test-Batch 'another-lifetime' {param($f,$b)$b.Lifetime=2} 'unknown'
Test-Batch 'another-process-birth' {param($f,$b)$b.Birth=999} 'unknown'
Test-Batch 'unchanged-publication' {param($f,$b)$b.SequenceBefore=4;$b.SequenceAfter=4} 'unknown'
Test-Batch 'unchanged-memory-epoch' {param($f,$b)$b.Epoch=3} 'unknown'
Test-Batch 'partial-snapshot' {param($f,$b)$f.Rows[6].Values=[long[]]::new(9)} 'unknown'
Test-Batch 'extra-blur-decision' {param($f,$b)Add-Inactive $f} 'unknown'
Test-Batch 'prior-blur-is-outside-batch' {param($f,$b)Add-Inactive $f;$b.Activations=1} 'new-show'
Test-Batch 'omitted-activation' {
  param($f,$b)$f.Before.Epoch=10;$f.After.Epoch=10;$f.Before.Activations=9;$f.After.Activations=9
  for($ordinal=2;$ordinal -le 9;$ordinal++){$slot=7+($ordinal-1)%8;$f.Rows[$slot].Sequence=2;$f.Rows[$slot].Epoch=$ordinal;$f.Rows[$slot].Values=[long[]]@(100,$ordinal,21,3,500,0,400,0,0,0)}
} 'unknown'
if($Report){[IO.File]::WriteAllText($Report,(ConvertTo-Json -InputObject ([ordered]@{schemaVersion=1;scope='fabricated numeric qualifier controls';nativeExecuted=$false;count=$controls.Count;controls=$controls.ToArray()}) -Depth 6))}
Write-Host "Windows request qualifier: $($controls.Count) synthetic controls passed"
