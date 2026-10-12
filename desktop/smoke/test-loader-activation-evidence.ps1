# Fabricated receipt unit tests. This does not start a native window or the app.
param([string]$Qualifier=(Join-Path $PSScriptRoot 'qualify-loader-activation.ps1'),[string]$Report)
$ErrorActionPreference='Stop'
. $Qualifier
function Evidence-Row([int]$Number,[string]$Kind,[long]$Window=200,[uint32]$Thread=12,[uint32]$CurrentThread=12,[long]$Foreground=200,[uint32]$Message=0,[int]$W=0,[long]$L=0,[int]$Started=0,[int]$Returned=0){
  @{N=$Number;Kind=$Kind;Window=$Window;Thread=$Thread;CurrentThread=$CurrentThread;Process=101;Owned=$true;UtcTicks=10000+$Number;MonotonicTicks=1000+$Number;Foreground=$Foreground;Message=$Message;W=$W;L=$L;GateStarted=$Started;GateReturned=$Returned;Visible=$true;NativeVisible=$true;Wanted=$true;Ready=0;Cancellations=0}
}
function New-Case([string]$Policy,[string]$Scenario){
  $rows=@((Evidence-Row 1 'created' 100 11 11 100),(Evidence-Row 2 'created'),(Evidence-Row 3 'initial-main-observed' 100 11 21 100),(Evidence-Row 4 'transition-main-loader' 200 12 21))
  if($Scenario -eq 'stale'){
    $rows+=@((Evidence-Row 5 'gate-entered' 200 12 12 200 0 0 0 1),(Evidence-Row 6 'transition-loader-main' 100 11 21 100 0 0 0 1),(Evidence-Row 7 'transition-main-loader-again' 200 12 21 200 0 0 0 1),(Evidence-Row 8 'gate-returned' 200 12 12 200 0 0 0 1 1),(Evidence-Row 9 'native-message' 200 12 12 200 6 0 100 1 1),(Evidence-Row 10 'stale-inactive' 200 12 12 200 6 0 100 1 1))
    $rows+=@(Evidence-Row 11 $(if($Policy -eq 'guard'){'stale-ignored'}else{'cancel'}))
  }elseif($Scenario -eq 'blur'){
    $rows+=@((Evidence-Row 5 'native-message' 200 12 12 100 6 0 100),(Evidence-Row 6 'cancel'))
  }elseif($Scenario -eq 'escape'){
    $rows+=@((Evidence-Row 5 'escape-input' 200 12 21),(Evidence-Row 6 'native-message' 200 12 12 200 0x100 27),(Evidence-Row 7 'cancel'))
  }elseif($Scenario -eq 'handoff'){
    $rows+=@((Evidence-Row 5 'ready-target'),(Evidence-Row 6 'native-message' 200 12 12 100 6 0 100),(Evidence-Row 7 'handoff'))
    foreach($row in $rows | Where-Object {$_.N -ge 5}){$row.Ready=100}
  }
  $cancelled=if($Policy -eq 'baseline' -or $Scenario -in @('blur','escape')){1}else{0}
  $open=$Policy -eq 'guard' -and $Scenario -eq 'stale'
  $final=Evidence-Row ($rows.Count+1) 'final-snapshot' 200 12 21 $(if($open){200}else{100})
  $final.Cancellations=$cancelled;$final.Wanted=$open -or $Scenario -eq 'handoff';$final.Visible=$open;$final.NativeVisible=$open
  if($Scenario -eq 'handoff'){$final.Ready=100}
  $rows+=@($final)
  @{scope='native-policy-model';nativeRuntimeExecuted=$true;policy=$Policy;scenario=$Scenario;status='qualified';qualified=$true;passed=$true;overflow=0;gateExpired=0;transitions=$(if($Scenario -eq 'stale'){3}elseif($Scenario -eq 'escape'){1}else{2});gateStarted=$(if($Scenario -eq 'stale'){1}else{0});gateReturned=$(if($Scenario -eq 'stale'){1}else{0});linkedStaleObserved=$(if($Scenario -eq 'stale'){1}else{0});staleIgnored=$(if($Policy -eq 'guard' -and $Scenario -eq 'stale'){1}else{0});cancelled=$cancelled;receipts=$rows}
}
$worker=@{pid=101;started=$true;exited=$true;killed=$false;exitCode=0}
$results=New-Object 'System.Collections.Generic.List[object]'
function Check([string]$Name,$Reading,[string]$Policy,[string]$Scenario,[string]$Expected,$Cleanup=$worker){
  $qualified=Test-LoaderActivationEvidence $Reading $Cleanup $Policy $Scenario
  $matched=$qualified.status -eq $Expected -and $qualified.productionAcceptance -eq $false
  $results.Add(@{name=$Name;expected=$Expected;actual=$qualified.status;matched=$matched;productionAcceptance=$qualified.productionAcceptance})
}
foreach($case in @(@('baseline','stale'),@('guard','stale'),@('guard','blur'),@('guard','escape'),@('guard','handoff'))){
  $policy=$case[0];$scenario=$case[1];$name=$policy+'-'+$scenario
  Check ($name+'-original-state') (New-Case $policy $scenario) $policy $scenario 'qualified'
  $reading=New-Case $policy $scenario;$reading.cancelled++
  $cleanup=Evidence-Row ($reading.receipts.Count+1) 'native-message' 200 12 12 0 6
  $cleanup.Cancellations=$reading.receipts[-1].Cancellations;$cleanup.NativeVisible=$false
  $reading.receipts+=@($cleanup)
  $cleanup=Evidence-Row ($reading.receipts.Count+1) 'cancel' 200 12 12 0
  $cleanup.Cancellations=$reading.cancelled;$cleanup.Visible=$false;$cleanup.NativeVisible=$false;$cleanup.Wanted=$false
  $reading.receipts+=@($cleanup)
  Check ($name+'-aggregate-includes-cleanup') $reading $policy $scenario 'qualified'
  $reading=New-Case $policy $scenario;$reading.receipts[-1].Cancellations=1-$reading.receipts[-1].Cancellations
  Check ($name+'-wrong-final-cancellation-count') $reading $policy $scenario 'policy-failed'
}
$reading=New-Case 'guard' 'stale';$reading.cancelled=1;$reading.receipts=@($reading.receipts|Where-Object {$_.Kind -notin @('native-message','stale-inactive','stale-ignored')});$reading.linkedStaleObserved=0
Check 'unobserved-stale-remains-insufficient' $reading 'guard' 'stale' 'insufficient'
$reading=New-Case 'guard' 'stale';$reading.receipts[-1].Visible=$false;$reading.receipts[-1].NativeVisible=$false
Check 'hidden-final-state' $reading 'guard' 'stale' 'policy-failed'
$reading=New-Case 'guard' 'stale';$reading.receipts[-1].Wanted=$false
Check 'cancelled-final-intent' $reading 'guard' 'stale' 'policy-failed'
$reading=New-Case 'guard' 'stale';$reading.receipts=@($reading.receipts|Where-Object {$_.Kind -ne 'final-snapshot'})
Check 'missing-final-snapshot' $reading 'guard' 'stale' 'insufficient'
$reading=New-Case 'guard' 'stale';$reading.receipts+=@($reading.receipts[-1].Clone())
Check 'duplicate-final-snapshot' $reading 'guard' 'stale' 'insufficient'
$reading=New-Case 'guard' 'stale';$reading.receipts[-1].Remove('Cancellations')
Check 'missing-final-counter' $reading 'guard' 'stale' 'policy-failed'
$reading=New-Case 'guard' 'stale';$reading.receipts[-1].Cancellations='unavailable'
Check 'malformed-final-counter' $reading 'guard' 'stale' 'policy-failed'
$reading=New-Case 'guard' 'stale';$reading.receipts[-1].Process=999
Check 'foreign-final-window' $reading 'guard' 'stale' 'insufficient'
$reading=New-Case 'guard' 'stale';$reading.overflow=1
Check 'omitted-receipts' $reading 'guard' 'stale' 'insufficient'
Check 'missing-native-reading' $null 'guard' 'stale' 'unavailable'
Check 'worker-cleanup-unconfirmed' (New-Case 'guard' 'stale') 'guard' 'stale' 'cleanup-unconfirmed' @{pid=101;started=$true;exited=$false;killed=$false}
$failures=@($results.ToArray()|Where-Object {-not $_.matched})
$outcome=@{scope='qualification-unit-test';nativeExecuted=$false;productionAcceptance=$false;cases=$results.ToArray();count=$results.Count;failed=$failures.Count}
if($Report){[IO.File]::WriteAllText($Report,(ConvertTo-Json -InputObject $outcome -Depth 6))}
if($failures.Count){$failures|ForEach-Object {Write-Host "$($_.name): expected $($_.expected), got $($_.actual)"};throw "Loader activation evidence unit tests failed: $($failures.Count)"}
Write-Host "$($results.Count) fabricated loader evidence unit controls passed; nativeExecuted=false"
