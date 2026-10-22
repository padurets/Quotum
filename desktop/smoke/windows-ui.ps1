# Ordinary startup, including the window-state and single-instance plugins that --smoke skips.
# Every run starts from a fresh profile of WebView2, as the first start on a machine does:
# the one there is set aside and put back at the end.
# -Diagnostics <dir> keeps bounded stage readings and owned process identities, passed or not.
param([Parameter(Mandatory=$true)][string]$App, [string]$Report, [string]$Diagnostics, [switch]$StaleDismissalControl)
$ErrorActionPreference = 'Stop'
if($StaleDismissalControl -and -not $Diagnostics){throw 'Paused UI observations require Diagnostics'}
# Relative to PowerShell's location: .NET would take them relative to the process's.
if ($Report) { $Report = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Report) }
if ($Diagnostics) { $Diagnostics = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Diagnostics) }
$appPath = (Resolve-Path -LiteralPath $App).Path
$work = Join-Path $env:TEMP ('quotum-ui-' + [guid]::NewGuid().ToString('N'))
$stateFile = Join-Path $env:APPDATA 'com.padurets.quotum/.window-state.json'
$savedState = if (Test-Path -LiteralPath $stateFile) { [IO.File]::ReadAllBytes($stateFile) } else { $null }
$environment = @{}
$names = @('QUOTUM_APP_DATA_DIR', 'QUOTUM_STATE_DIR', 'QUOTUM_CONFIG', 'QUOTUM_RESETS', 'QUOTUM_WINDOW_PROBE')
foreach ($name in $names) { $environment[$name] = [Environment]::GetEnvironmentVariable($name) }
$webviewRoot = Join-Path $env:LOCALAPPDATA 'com.padurets.quotum'
$webview = Join-Path $webviewRoot 'EBWebView'
$aside = Join-Path $webviewRoot ('EBWebView.quotum-ui-' + [guid]::NewGuid().ToString('N'))
# unknown: not touched; absent: there was none; moved: set aside to $aside.
$profileState = 'unknown'
$process = $null
$second = $null
$failed = $false
# Each cycle closes the window and asks a second launch for it again. Times are in
# milliseconds from the WM_CLOSE of the cycle, except firstWindowMs (from the app's start),
# searchMs (how long finding the browser process took, before the close) and openHandoffMs
# (from the second launch while the window is minimized).
$result = [ordered]@{passed=$false; firstWindowMs=$null; windows=@(); cycles=@(); panels=@(); errors=@()}
# The browser process of WebView2 of each cycle's window, and when that window was closed.
$browsers = @{}
$closedAt = @{}

if (-not ('QuotumWindowProbe' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'window-probe.cs')
}
# Installed and portable smoke can share one PowerShell process and its static types.
[QuotumWindowProbe]::ResetDispatch()

$sourceSha=$null
if($Diagnostics){
  try {
    $revision=& git -C $PSScriptRoot rev-parse HEAD 2>$null
    if($LASTEXITCODE -eq 0 -and $revision -match '^[a-f0-9]{40}$'){$sourceSha=$revision}
  } catch { # Source identity may be unavailable outside a checkout or without Git.
  }
}
$manifest=[ordered]@{schemaVersion=1;status='running';sha=$sourceSha;run=$env:GITHUB_RUN_ID;attempt=$env:GITHUB_RUN_ATTEMPT;platform='windows';packageHash=(Get-FileHash -LiteralPath $appPath -Algorithm SHA256).Hash;files=@();errors=@()}
$loaderDismissalEvidence=$null
# Capture native facts in memory while any owned UI thread is paused.
$nativePauseDepth=0
$nativeResumeFailed=$false
function Write-NativeJson([string]$Name,$Value,[int]$Depth) {
  New-Item -ItemType Directory -Force $Diagnostics | Out-Null
  $temporary=Join-Path $Diagnostics ($Name+'.tmp')
  [IO.File]::WriteAllText($temporary,(ConvertTo-Json -InputObject $Value -Depth $Depth))
  Move-Item -LiteralPath $temporary -Destination (Join-Path $Diagnostics $Name) -Force
}
function Enter-NativePause([scriptblock]$Acquire) {
  $script:nativePauseDepth++
  try { & $Acquire } catch {
    $script:nativePauseDepth--
    # MainRequestThenPause also owns a guard before returning it to PowerShell.
    $dispatch=[QuotumWindowProbe]::LastDispatch
    if($dispatch -and $dispatch.Paused -and -not $dispatch.Resumed){
      $script:nativeResumeFailed=$true
      $manifest.errors=@('native resume failed; evidence unavailable')
    }
    throw
  }
}
function Resume-NativePause($Target,[scriptblock]$Resume,$Failure) {
  try { & $Resume $Target;return $true } catch {
    $script:nativeResumeFailed=$true
    $manifest.errors=@('native resume failed; evidence unavailable')
    if($null -eq $Failure){throw}
    return $false
  } finally { $script:nativePauseDepth-- }
}
function Save-Manifest {
  if(-not $Diagnostics -or $nativePauseDepth -or $nativeResumeFailed){return}
  try { Write-NativeJson 'manifest.json' $manifest 5 }
  catch {Write-Warning 'Native evidence manifest unavailable'}
}
Save-Manifest
$timelineClock=[Diagnostics.Stopwatch]::StartNew()
$timeline=New-Object 'System.Collections.Generic.List[object]'
$requestSnapshots=0
$requestStages=@('panel-visibility-deadline','panel-visible','main-accepted-paused','main-handoff-loader','main-handoff-unresponsive-before-resume','main-handoff-before-resume','paused-ui-loader','paused-ui-unresponsive-before-resume','ui-before-resume','failed')
function Save-Timeline {
  if(-not $Diagnostics -or $nativePauseDepth -or $nativeResumeFailed){return}
  try { Write-NativeJson 'timeline.json' $timeline.ToArray() 10 }
  catch {$manifest.errors=@('native stage evidence unavailable')}
}
function Save-Stage([string]$Stage,[IntPtr]$Window=[IntPtr]::Zero,[Nullable[bool]]$Resumed=$null) {
  try {
    if($timeline.Count -ge 1000){$manifest.errors=@('timeline truncated');Save-Manifest;Save-Timeline;return}
    $reading=[QuotumWindowProbe]::LastDispatch
    # Copy mutable dispatch fields now; a later resume must not rewrite earlier stages.
    $dispatch=if($reading){[ordered]@{Stage=$reading.Stage;Acceptance=$reading.Acceptance;Window=$reading.Window;ElapsedMs=$reading.ElapsedMs;Process=$reading.Process;Thread=$reading.Thread;Paused=$reading.Paused;ResumeAttempted=$reading.ResumeAttempted;Resumed=$reading.Resumed}}else{$null}
    $panelReading=[QuotumWindowProbe]::LastPanelDispatch
    $panelDispatch=if($panelReading){[ordered]@{Window=$panelReading.Window;Process=$panelReading.Process;Thread=$panelReading.Thread;Owned=$panelReading.Owned;Posted=$panelReading.Posted;ForegroundWindow=$panelReading.ForegroundWindow;ForegroundProcess=$panelReading.ForegroundProcess;ForegroundThread=$panelReading.ForegroundThread;FromUtcTicks=$panelReading.FromUtcTicks;ToUtcTicks=$panelReading.ToUtcTicks}}else{$null}
    $entry=[ordered]@{stage=$Stage;ms=$timelineClock.Elapsed.TotalMilliseconds;utcTicks=[DateTime]::UtcNow.Ticks;dispatch=$dispatch;panelDispatch=$panelDispatch;unresponsive=[QuotumWindowProbe]::LastUnresponsive}
    if($Diagnostics -and ($requestStages -contains $Stage)){
      if($requestSnapshots -lt 32){
        $script:requestSnapshots++
        $entry.requestEvidence=if($process){[QuotumWindowProbe]::Requests($process.Id,$true)}else{$null}
      }else{$entry.requestEvidence=@{status='unavailable-truncated';scope='last-natural-owner-snapshot';originalPostedInputAccepted=$false;freshWorkerAtFailedDeadline=$false}}
    }
    if($null -ne $Resumed){$entry.resumed=$Resumed}
    if($process){$entry.window=[QuotumWindowProbe]::Snapshot($Window,$process.Id)}
    $timeline.Add($entry)
    Save-Timeline
  } catch {
    # A warning sink may block too; failure evidence stays bounded in memory.
    $manifest.errors=@('native stage evidence unavailable')
  }
}
Save-Stage 'initial'

# This batch owns exactly two posted tray callbacks and the old loader's close.
# The existing single-callback qualifier stays unchanged; it cannot qualify +2.
function Get-LoaderBatchState($Evidence,$Baseline,[long]$Request,[long]$Loader) {
  if(-not $Evidence -or $Evidence.Status -ne 'qualified'){return 'unknown'}
  $h=$Evidence.Frame.After;$a=$Evidence.Frame.Rows[0];$r=$Evidence.Frame.Rows[6]
  if($h.Window -ne $Baseline.Window -or $h.Thread -ne $Baseline.Thread -or $h.Birth -ne $Baseline.Birth -or
    $h.Lifetime -ne $Baseline.Lifetime -or $h.Callbacks -ne $Baseline.Callbacks+2 -or
    $h.Activations -lt $Baseline.Activations -or $h.Activations-$Baseline.Activations -gt 8 -or
    $h.Epoch -le $Baseline.Epoch -or $h.SequenceBefore -le $Baseline.SequenceBefore -or
    $a.Sequence -eq 0 -or $a.Values[0] -ne $Request+2 -or $a.Values[1] -ne $h.Callbacks -or
    $a.Values[2] -ne $h.Thread -or $a.Values[3] -ne 2 -or $a.Values[5] -ne 1){return 'unknown'}
  # Any additional blur decision makes this schedule insufficient, not a policy failure.
  foreach($row in $Evidence.Frame.Rows[7..14]){
    if($row.Sequence -gt 0 -and $row.Values[1] -gt $Baseline.Activations -and ($row.Values[9] -band 16)){return 'unknown'}
  }
  if($r.Sequence -eq 0 -or $r.Values[2] -ne $h.Thread -or $r.Values[4] -ne $Loader){return 'unknown'}
  if($r.Values[0] -eq $Request+2 -and $r.Values[3] -in @(6,7)){return 'new-show'}
  if($r.Values[0] -eq $Request -and $r.Values[3] -in @(8,9)){return 'old-hide'}
  return 'pending'
}
function Test-StaleLoaderDismissal([IntPtr]$Loader,$Clock,[uint32]$UiThread) {
  $c=[ordered]@{scope='native-stale-dismissal-control';status='insufficient';outcome='unknown';posted=@();before=$null;after=$null;surface=$null;sampleFromMs=$null;sampleEndMs=$null;outsideSample=$null;responseEndMs=$null;trayResumed=$false;elapsedMs=$null;pipelinePassed=$false;productionAcceptance=$false;freshWorkerAtFailedDeadline=$false}
  $script:loaderDismissalEvidence=$c
  try {
    do {
      $a=[QuotumWindowProbe]::Requests($process.Id,$true)
      $surface=[QuotumWindowProbe]::Snapshot($Loader,$process.Id)
      if($a.Status -eq 'qualified' -and $a.LinkStatus -eq 'qualified' -and $a.CallbackAccepted -and $a.WantedCompact -and
        $a.Frame.Rows[6].Values[0] -eq $a.Request -and $a.Frame.Rows[6].Values[3] -in @(6,7) -and
        $surface.Owned -and $surface.Visible -and $surface.Foreground -and $surface.Rounded -and $surface.LoadingPhase -eq 1){break}
      Start-Sleep -Milliseconds 10
    }while($Clock.ElapsedMilliseconds -lt 3000)
    if($Clock.ElapsedMilliseconds -ge 3000){throw 'Stale dismissal control: initial loader unqualified'}
    $tray=[IntPtr]$a.Frame.After.Window
    if($surface.Thread -ne $a.Frame.After.Thread -or $surface.Thread -eq $UiThread){throw 'Stale dismissal control: native threads unqualified'}
    $paused=$null;$pauseFailure=$null
    try {
      $paused=Enter-NativePause { [QuotumWindowProbe]::PauseUi($tray,$process.Id,$surface.Thread) }
      $a=[QuotumWindowProbe]::Requests($process.Id,$true)
      $surface=[QuotumWindowProbe]::Snapshot($Loader,$process.Id)
      if($Clock.ElapsedMilliseconds -ge 3000 -or $a.Status -ne 'qualified' -or $a.LinkStatus -ne 'qualified' -or
        -not $a.CallbackAccepted -or -not $a.WantedCompact -or $surface.LoadingPhase -ne 1 -or
        -not $surface.Owned -or -not $surface.Visible -or -not $surface.Foreground -or
        $a.Frame.Rows[6].Values[0] -ne $a.Request -or $a.Frame.Rows[6].Values[3] -notin @(6,7)){
        throw 'Stale dismissal control: tray paused outside idle loader'
      }
      $c.before=$a;$baseline=$a.Frame.After;$request=$a.Request
      foreach($name in @('toggle-close','toggle-open')){
        $posted=[QuotumWindowProbe]::PostMessage($tray,0x8002,[IntPtr]::Zero,[IntPtr]0x10400)
        $c.posted+=@{kind=$name;posted=$posted;ms=$Clock.ElapsedMilliseconds}
        if(-not $posted){throw 'Stale dismissal control: tray batch not posted'}
      }
      $posted=[QuotumWindowProbe]::PostMessage($Loader,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
      $c.posted+=@{kind='close-old-loader';posted=$posted;ms=$Clock.ElapsedMilliseconds}
      if(-not $posted){throw 'Stale dismissal control: loader close not posted'}
    }catch{$pauseFailure=$_;throw}finally{
      if($paused){$c.trayResumed=Resume-NativePause $paused {param($target) [QuotumWindowProbe]::ResumeUi($target)} $pauseFailure}
    }
    if(-not $c.trayResumed -or $c.posted.Count -ne 3 -or $c.posted[-1].ms -ge 3000){throw 'Stale dismissal control: batch exceeded the original deadline'}
    $state='unknown'
    do {
      if($Clock.ElapsedMilliseconds -ge 3000){break}
      $from=$Clock.ElapsedMilliseconds
      $after=[QuotumWindowProbe]::Requests($process.Id,$true)
      $surface=[QuotumWindowProbe]::Snapshot($Loader,$process.Id)
      $end=$Clock.ElapsedMilliseconds
      if($end -ge 3000){$c.outsideSample=@{fromMs=$from;endMs=$end;evidence=$after;surface=$surface};break}
      $c.after=$after;$c.surface=$surface;$c.sampleFromMs=$from;$c.sampleEndMs=$end
      $state=Get-LoaderBatchState $after $baseline $request $Loader.ToInt64()
      if($state -eq 'new-show' -and $surface.Owned -and $surface.Thread -eq $baseline.Thread -and $surface.Visible -and $surface.Foreground -and
        $surface.Rounded -and $surface.LoadingPhase -eq 1){
        $responsive=[QuotumWindowProbe]::Responsive($Loader,$process.Id);$c.responseEndMs=$Clock.ElapsedMilliseconds
        if($responsive -and $c.responseEndMs -lt 3000){$c.status='qualified';$c.outcome='preserved-accepted-request';return}
      }
      Start-Sleep -Milliseconds 10
    }while($Clock.ElapsedMilliseconds -lt 3000)
    if($state -eq 'old-hide' -and $c.surface.Owned -and $c.surface.Thread -eq $baseline.Thread -and $c.surface.LoadingPhase -eq 1 -and -not $c.surface.Visible){
      # This is the last complete reading before the unchanged deadline, not a
      # direct observation of the global toggle or a claim that B can never show.
      $c.status='qualified';$c.outcome='accepted-loader-unobserved'
      throw 'Stale dismissal control: new loader not observed within 3s'
    }
    throw 'Stale dismissal control: native schedule insufficient'
  }finally{
    $c.elapsedMs=$Clock.ElapsedMilliseconds
    $result.staleDismissal=@{status=$c.status;outcome=$c.outcome;elapsedMs=$c.elapsedMs;trayResumed=$c.trayResumed}
  }
}

function Wait-Window {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    if ($process.HasExited) { throw "App exited before showing a window: $($process.ExitCode)" }
    $window = [QuotumWindowProbe]::Find($process.Id)
    if ($window -ne [IntPtr]::Zero -and [QuotumWindowProbe]::Responsive($window,$process.Id)) { return $window }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw 'Ordinary startup did not show a responsive window within 20 seconds'
}

# The newest browser process of WebView2 among $Candidates that the app started itself
# (each window's web view starts one as its child), other than those of earlier cycles.
# Its parent first: that needs no CIM, and only the app's children are asked their start.
function Select-Browser($Candidates, [int]$Parent, [datetime]$Since, [int[]]$Skip) {
  @($Candidates | Where-Object { $_.Parent.Id -eq $Parent -and $_.StartTime -ge $Since -and $Skip -notcontains $_.Id } |
    Sort-Object StartTime -Descending)[0]
}

# How long the browser process of a cycle's window outlived its WM_CLOSE, or, while it
# runs, how long it has so far. Read after the close, not between the window and its close.
function Update-Browser([int]$Cycle) {
  $browser = $browsers[$Cycle]
  if (-not $browser -or -not $closedAt.ContainsKey($Cycle)) { return }
  $entry = $result.cycles[$Cycle]
  if ($browser.HasExited) {
    $entry.browserExitMs = [int]($browser.ExitTime - $closedAt[$Cycle]).TotalMilliseconds
    $entry.Remove('aliveAtMs')
  } else {
    $entry.aliveAtMs = [int]((Get-Date) - $closedAt[$Cycle]).TotalMilliseconds
  }
}

# How many lines of the app's log have $Text. The app appends to it meanwhile.
function Measure-Logged([string]$Text) {
  $path = "$work/app/logs/hub.log"
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $reader = [IO.StreamReader]::new([IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
  try { return @($reader.ReadToEnd() -split "`n" | Where-Object { $_.Contains($Text) }).Count } finally { $reader.Dispose() }
}

# Runs one step of the cleanup: its failure goes into the report and fails the run, and
# the steps after it still run.
function Invoke-Step([string]$Name, [scriptblock]$Body) {
  try { & $Body } catch { $result.errors += "${Name}: $($_.Exception.Message)" }
}

# Ends a process of the run; one that still runs 10 seconds later is a failure.
function Stop-Owned($Owned, [string]$Description) {
  $why = 'no error'
  try { $Owned.Kill() } catch { $why = $_.Exception.Message }
  if (-not $Owned.WaitForExit(10000)) { throw "$Description still runs after Kill ($why)" }
}

# Completion of an old close must not overwrite a newer tray-open request.
# Check with another WebView present and with the compact panel as the only one.
function Test-QueuedPanelReopen([IntPtr]$Except) {
  if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot open panel for queued-close check'}
  $deadline=(Get-Date).AddSeconds(15)
  do {$panel=[QuotumWindowProbe]::FindOther($process.Id,$Except);if($panel -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while((Get-Date) -lt $deadline)
  if($process.HasExited){throw "Controller exited during queued reopen: $($process.ExitCode)"}
  if($panel -eq [IntPtr]::Zero){throw 'No panel for queued-close check'}
  $paused=$null;$pauseFailure=$null
  try {
    $paused=Enter-NativePause { [QuotumWindowProbe]::PauseUi($panel,$process.Id) }
    Save-Stage 'queued-panel-paused' $panel
    [void][QuotumWindowProbe]::PostMessage($panel,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
    if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot toggle queued panel closed'}
    Start-Sleep -Milliseconds 100
    if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot request panel reopen'}
    Start-Sleep -Milliseconds 100
  } catch {$pauseFailure=$_;throw} finally {
    $resumed=$false
    try {
      if($paused){$resumed=Resume-NativePause $paused {param($target) [QuotumWindowProbe]::ResumeUi($target)} $pauseFailure}
    } finally {Save-Stage 'queued-panel-resume' $panel $resumed}
  }
  $deadline=(Get-Date).AddSeconds(15)
  Start-Sleep -Seconds 2
  do {$panel=[QuotumWindowProbe]::FindOther($process.Id,$Except);if($panel -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while((Get-Date) -lt $deadline)
  if($process.HasExited){throw "Controller exited during queued reopen: $($process.ExitCode)"}
  if($panel -eq [IntPtr]::Zero){throw 'Old CloseRequested lost the latest panel open'}
  Start-Sleep -Seconds 1
  if(-not [QuotumWindowProbe]::IsWindowVisible($panel)){throw 'The reopened panel disappeared after old callbacks'}
  [QuotumWindowProbe]::Escape($panel,$process.Id)
  $deadline=(Get-Date).AddSeconds(5)
  while([QuotumWindowProbe]::IsWindowVisible($panel) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
  if([QuotumWindowProbe]::IsWindowVisible($panel)){throw 'Cannot close the current panel after queued reopen'}
}

function Test-MainPanelHandoff([IntPtr]$Main) {
  if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot open panel before main handoff'}
  $deadline=(Get-Date).AddSeconds(15)
  do {$old=[QuotumWindowProbe]::FindOther($process.Id,$Main);if($old -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while((Get-Date) -lt $deadline)
  if($old -eq [IntPtr]::Zero){throw 'No initial panel before main handoff'}
  $paused=$null;$pauseFailure=$null
  try {
    $paused=Enter-NativePause { [QuotumWindowProbe]::MainRequestThenPause($process.Id,$appPath) }
    Save-Stage 'main-accepted-paused' $Main
    if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot supersede the pending main request'}
    $deadline=(Get-Date).AddSeconds(3)
    do {$loader=[QuotumWindowProbe]::Loading($process.Id);if($loader -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 10}while((Get-Date) -lt $deadline)
    Save-Stage 'main-handoff-loader' $loader
    if($loader -eq [IntPtr]::Zero){throw 'Main handoff: loader missing within 3s'}
    if(-not [QuotumWindowProbe]::Responsive($loader,$process.Id)){Save-Stage 'main-handoff-unresponsive-before-resume';throw 'Main handoff: loader unresponsive'}
  } catch {$pauseFailure=$_;throw} finally {
    $resumed=$false
    try {if($Diagnostics){Save-Stage 'main-handoff-before-resume'}} finally {
      try {
        if($paused){$resumed=Resume-NativePause $paused {param($target) $target.Dispose()} $pauseFailure}
      } finally {
        Save-Stage 'main-handoff-resume' $Main $(if($paused){$resumed}else{$null})
      }
    }
  }
  Start-Sleep -Seconds 2
  $deadline=(Get-Date).AddSeconds(15)
  do {$panel=[QuotumWindowProbe]::FindOther($process.Id,$Main);if($panel -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while((Get-Date) -lt $deadline)
  if($process.HasExited){throw "Old main request crashed the controller: $($process.ExitCode)"}
  Save-Stage 'main-handoff-panel' $panel
  if($panel -eq [IntPtr]::Zero){throw 'Main handoff: panel missing within 15s'}
  if(-not [QuotumWindowProbe]::Rounded($panel)){throw 'Main handoff: panel shape wrong'}
  if(-not [QuotumWindowProbe]::Responsive($panel,$process.Id)){throw 'Main handoff: panel unresponsive'}
  Start-Sleep -Seconds 1
  Save-Stage 'main-handoff-focus' $panel
  if(-not [QuotumWindowProbe]::Foreground($panel)){throw 'Main handoff: panel lost foreground'}
  if([QuotumWindowProbe]::Loading($process.Id) -ne [IntPtr]::Zero){throw 'Main handoff: loader not retired'}
  [QuotumWindowProbe]::Escape($panel,$process.Id)
  $deadline=(Get-Date).AddSeconds(5)
  while([QuotumWindowProbe]::IsWindowVisible($panel) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
  if([QuotumWindowProbe]::IsWindowVisible($panel)){throw 'Cannot close panel after main handoff'}
  if($Main -eq [IntPtr]::Zero){
    $deadline=(Get-Date).AddSeconds(10)
    do {
      $browsersLeft=@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"|Where-Object {$_.ParentProcessId -eq $process.Id})
      if(-not $browsersLeft.Count){break};Start-Sleep -Milliseconds 100
    }while((Get-Date) -lt $deadline)
    # CIM may have sampled a browser before it exited. Trust only an already
    # held process with the same birth; live and unknown roots remain failures.
    $recheckStartedUtc = [datetime]::UtcNow.ToString('o')
    $browserChecks = @()
    $confirmedExited = 0
    foreach ($info in @($browsersLeft | Select-Object -First 16)) {
      $known = @($browsers.Values | Where-Object { $_.Id -eq $info.ProcessId })
      $entry = [ordered]@{pid=[int]$info.ProcessId; birthBound=0; hasExited=-1}
      if ($known.Count -eq 1) {
        try {
          # CIM birth times have microsecond precision; compare UTC at that precision.
          $heldBirth = $known[0].StartTime.ToUniversalTime()
          $snapshotBirth = $info.CreationDate.ToUniversalTime()
          $entry.heldBirthUtc = $heldBirth.ToString('o')
          $entry.snapshotBirthUtc = $snapshotBirth.ToString('o')
          if ($heldBirth.ToString('yyyyMMddHHmmssffffff') -eq $snapshotBirth.ToString('yyyyMMddHHmmssffffff')) {
            $entry.birthBound = 1
            $entry.hasExited = [int]$known[0].HasExited
            if ($entry.hasExited) {
              $entry.exitUtc = $known[0].ExitTime.ToUniversalTime().ToString('o')
              $confirmedExited++
            }
          }
        } catch { $entry.hasExited = -1 }
      }
      $browserChecks += $entry
    }
    $remainingBrowserCount = $browsersLeft.Count - $confirmedExited
    $remainingWindow = [QuotumWindowProbe]::Find($process.Id)
    $result.mainPanelHandoffRelease = [ordered]@{startedUtc=$recheckStartedUtc; endedUtc=[datetime]::UtcNow.ToString('o'); snapshotBrowserCount=$browsersLeft.Count; remainingBrowserCount=$remainingBrowserCount; visibleWindow=$remainingWindow.ToInt64(); browserChecks=$browserChecks; omittedBrowserChecks=[Math]::Max(0, $browsersLeft.Count - 16)}
    if($remainingBrowserCount -or $remainingWindow -ne [IntPtr]::Zero){throw 'Cancelled main creation retained a window or WebView'}
  }
}

try {
  if (Get-Process quotum-desktop -ErrorAction SilentlyContinue) { throw 'Another Quotum instance is already running' }
  $left = @(Get-ChildItem -LiteralPath $webviewRoot -Filter 'EBWebView.quotum-ui-*' -Directory -ErrorAction SilentlyContinue)
  if ($left.Count) { throw "A profile of WebView2 set aside by an interrupted run is left: $($left.FullName -join ', '). Put it back as $webview by hand, after removing a fresh one there." }
  New-Item -ItemType Directory -Force "$work/app", "$work/state", (Split-Path $stateFile) | Out-Null
  $env:QUOTUM_APP_DATA_DIR = "$work/app"
  $env:QUOTUM_STATE_DIR = "$work/state"
  $env:QUOTUM_CONFIG = "$work/config.toml"
  $env:QUOTUM_RESETS = 'off'
  $env:QUOTUM_WINDOW_PROBE = $(if($Diagnostics){'1'}else{$null})
  # No accounts or clients, and no changes to the runner's start-at-login entry.
  [IO.File]::WriteAllText("$work/app/app.json", '{"autostartDefaulted":true}')
  [IO.File]::WriteAllText($env:QUOTUM_CONFIG, "sessions = false`n[providers.claude]`nenabled = false`n[providers.codex]`nenabled = false`n[providers.antigravity]`nenabled = false`n")
  # A window saved on a larger display must fit the current monitor on restoration.
  [IO.File]::WriteAllText($stateFile, '{"main":{"width":6000,"height":4000,"x":0,"y":0,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}')
  # The first search is about ten times slower than the next ones: made here, it does not
  # delay the first close, which races with the web view setting up.
  $me = Get-Process -Id $PID
  $null = Select-Browser @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue) 0 ([datetime]::MinValue) @()
  $null = Select-Browser @($me) $me.Parent.Id ([datetime]::MinValue) @()
  if (Test-Path -LiteralPath $webview) {
    try { [IO.Directory]::Move($webview, $aside) }
    catch { throw "Could not set the profile of WebView2 aside, a process of WebView2 may hold it: $webview ($($_.Exception.Message))" }
    $profileState = 'moved'
  } else {
    $profileState = 'absent'
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $appPath -PassThru
  $null = $process.Handle
  if($Diagnostics){[QuotumWindowProbe]::ObserveRequests($process)}
  $since = $process.StartTime
  $window = Wait-Window
  $result.firstWindowMs = $clock.ElapsedMilliseconds
  $seen = [Collections.Generic.List[int]]::new()
  for ($cycle = 0; $cycle -lt 3; $cycle++) {
    $bounds = [QuotumWindowProbe]::Bounds($window)
    if ($bounds[0] -lt $bounds[4] -or $bounds[1] -lt $bounds[5] -or $bounds[2] -gt $bounds[6] -or $bounds[3] -gt $bounds[7]) {
      throw "Window exceeds the monitor work area: $bounds"
    }
    $result.windows += ,$bounds
    $entry = [ordered]@{}
    $result.cycles += $entry
    $search = [Diagnostics.Stopwatch]::StartNew()
    try {
      $browser = Select-Browser @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue) $process.Id $since $seen.ToArray()
      if ($browser) {
        # Kept open, so that its exit time can be read after it ends.
        $null = $browser.Handle
        $browsers[$cycle] = $browser
        $seen.Add($browser.Id)
        $entry.browserPid = $browser.Id
      }
    } catch { $entry.browserError = $_.Exception.Message }
    $entry.searchMs = $search.ElapsedMilliseconds
    if (-not [QuotumWindowProbe]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close the window' }
    $closed = $clock.ElapsedMilliseconds
    $closedAt[$cycle] = Get-Date
    if ($cycle -gt 0) { Update-Browser ($cycle - 1) }
    $deadline = (Get-Date).AddSeconds(10)
    while ([QuotumWindowProbe]::Find($process.Id) -ne [IntPtr]::Zero -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ($process.HasExited -or [QuotumWindowProbe]::Find($process.Id) -ne [IntPtr]::Zero) { throw 'Closing the window did not leave a live controller without its window' }
    $entry.goneMs = $clock.ElapsedMilliseconds - $closed
    $second = Start-Process -FilePath $appPath -PassThru
    $entry.secondStartMs = $clock.ElapsedMilliseconds - $closed
    $null = $second.Handle
    if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw 'The second instance did not hand off to the first' }
    $entry.secondExitMs = $clock.ElapsedMilliseconds - $closed
    $window = Wait-Window
    $entry.windowMs = $clock.ElapsedMilliseconds - $closed
    if ($browsers[$cycle]) { $entry.browserAliveAtWindow = -not $browsers[$cycle].HasExited }
  }
  Update-Browser ($cycle - 1)
  # A second launch while the window is minimized brings that very window back: the app
  # finds it alive, as a closing one is not, and restores it.
  $null = [QuotumWindowProbe]::ShowWindowAsync($window, 7) # SW_SHOWMINNOACTIVE
  $deadline = (Get-Date).AddSeconds(5)
  while (-not [QuotumWindowProbe]::IsIconic($window) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if (-not [QuotumWindowProbe]::IsIconic($window)) { throw 'Could not minimize the window' }
  $found = Measure-Logged 'app: found the window main'
  $asked = $clock.ElapsedMilliseconds
  $second = Start-Process -FilePath $appPath -PassThru
  $null = $second.Handle
  if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw 'The second instance did not hand off to the first while its window was minimized' }
  $deadline = (Get-Date).AddSeconds(10)
  while (((Measure-Logged 'app: found the window main') -le $found -or [QuotumWindowProbe]::IsIconic($window)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if ((Measure-Logged 'app: found the window main') -le $found) { throw 'A second launch while the window was minimized did not find it alive' }
  if ([QuotumWindowProbe]::IsIconic($window)) { throw 'A second launch while the window was minimized did not restore it' }
  if ((Wait-Window) -ne $window) { throw 'A second launch while the window was minimized did not show that window' }
  $result.openHandoffMs = $clock.ElapsedMilliseconds - $asked
  # WebView2 may send focus changes before its hidden panel is shown. A logged
  # creation is not enough: it must stay visible and leave the main window intact.
  for ($cycle = 0; $cycle -lt 3; $cycle++) {
    $before = [QuotumWindowProbe]::Bounds($window)
    if (-not [QuotumWindowProbe]::OpenPanel($process.Id)) { throw 'Could not activate the tray panel' }
    $deadline = (Get-Date).AddSeconds(15)
    $panel = [IntPtr]::Zero
    do {
      $panel = [QuotumWindowProbe]::FindOther($process.Id, $window)
      if ($panel -ne [IntPtr]::Zero -and [QuotumWindowProbe]::Responsive($panel,$process.Id)) { break }
      Start-Sleep -Milliseconds 50
    } while ((Get-Date) -lt $deadline)
    if ($panel -eq [IntPtr]::Zero) {
      Save-Stage 'panel-visibility-deadline' $window
      if($Diagnostics){Save-Stage 'panel-loader-after-deadline' ([QuotumWindowProbe]::Loading($process.Id))}
      throw 'The tray panel did not become visible'
    }
    Save-Stage 'panel-visible' $panel
    Start-Sleep -Seconds 1
    if (-not [QuotumWindowProbe]::IsWindowVisible($panel) -or -not [QuotumWindowProbe]::Responsive($panel,$process.Id)) { throw 'The tray panel disappeared after creation' }
    $bounds = [QuotumWindowProbe]::Bounds($panel)
    if ($bounds[0] -lt $bounds[4] -or $bounds[1] -lt $bounds[5] -or $bounds[2] -gt $bounds[6] -or $bounds[3] -gt $bounds[7]) { throw "Panel exceeds its monitor work area: $bounds" }
    $result.panels += ,$bounds
    if ($cycle -eq 0) {
      $second = Start-Process -FilePath $appPath -PassThru
      $null = $second.Handle
      if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw 'Could not activate the main window beside the panel' }
    } elseif ($cycle -eq 1) {
      [QuotumWindowProbe]::Escape($panel, $process.Id)
    } elseif (-not [QuotumWindowProbe]::OpenPanel($process.Id)) { throw 'Could not toggle the panel through the tray' }
    $deadline = (Get-Date).AddSeconds(5)
    while ([QuotumWindowProbe]::IsWindowVisible($panel) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if ([QuotumWindowProbe]::IsWindowVisible($panel)) { throw 'The panel did not close after dismissal, main-window activation or a repeated tray click' }
    if (-not [QuotumWindowProbe]::IsWindowVisible($window) -or ($before -join ',') -ne ([QuotumWindowProbe]::Bounds($window) -join ',')) { throw 'The panel changed the main window geometry' }
  }
  Test-QueuedPanelReopen $window
  Test-MainPanelHandoff $window
  [void][QuotumWindowProbe]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  $deadline=(Get-Date).AddSeconds(5)
  while([QuotumWindowProbe]::IsWindowVisible($window) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
  if($process.HasExited -or [QuotumWindowProbe]::IsWindowVisible($window)){throw 'Could not close main before the last-WebView check'}
  Test-QueuedPanelReopen ([IntPtr]::Zero)
  Test-MainPanelHandoff ([IntPtr]::Zero)
  $result.queuedPanelReopen=$true
  $result.queuedPanelReopenWithoutMain=$true
  $result.mainPanelHandoff=$true
  $second=Start-Process -FilePath $appPath -PassThru
  $null=$second.Handle
  if(-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0){throw 'Could not reopen main after the last-WebView check'}
  $window=Wait-Window
  # A blocked WebView/UI thread must not stop the tray's native loading surface.
  # Only this test process's already-verified UI thread is paused, always resumed.
  # A minimized window can still own foreground. This scenario needs both
  # background conditions before pausing the UI.
  [void][QuotumWindowProbe]::ShowWindowAsync($window,6)
  $deadline=(Get-Date).AddSeconds(5)
  while((-not [QuotumWindowProbe]::IsIconic($window) -or [QuotumWindowProbe]::Foreground($window)) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
  if(-not [QuotumWindowProbe]::IsIconic($window) -or [QuotumWindowProbe]::Foreground($window)){throw 'Could not put the test UI thread in the background'}
  $loadingCases=@($false,$true)
  if($StaleDismissalControl){$loadingCases+=$false}
  $loadingIndex=0
  foreach($cancel in $loadingCases) {
    $isControl=$StaleDismissalControl -and $loadingIndex -eq 2
    $loadingIndex++
    $paused=$null;$pauseFailure=$null
    try {
      $paused=Enter-NativePause { [QuotumWindowProbe]::PauseUi($window,$process.Id) }
      if(-not [QuotumWindowProbe]::IsIconic($window) -or [QuotumWindowProbe]::Foreground($window)){throw 'The test window left the background while pausing its UI thread'}
      $ui=[QuotumWindowProbe]::Snapshot($window,$process.Id)
      Save-Stage 'ui-paused' $window
      $loadingClock=[Diagnostics.Stopwatch]::StartNew()
      if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot ask for the loading panel'}
      $loader=[IntPtr]::Zero
      do {$loader=[QuotumWindowProbe]::Loading($process.Id);if($loader -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 10}while($loadingClock.ElapsedMilliseconds -lt 3000)
      Save-Stage 'paused-ui-loader' $loader
      if($loader -eq [IntPtr]::Zero){throw 'Paused UI: loader missing within 3s'}
      if(-not [QuotumWindowProbe]::Responsive($loader,$process.Id)){Save-Stage 'paused-ui-unresponsive-before-resume';throw 'Paused UI: loader unresponsive'}
      if(-not [QuotumWindowProbe]::Rounded($loader)){throw 'Native loader has square corners'}
      if($isControl){$result.staleLoaderMs=$loadingClock.ElapsedMilliseconds;Test-StaleLoaderDismissal $loader $loadingClock $ui.Thread}
      else{$result.loadingMs=$loadingClock.ElapsedMilliseconds}
      if($cancel){
        [void][QuotumWindowProbe]::PostMessage($loader,0x100,[IntPtr]27,[IntPtr]::Zero)
        $deadline=(Get-Date).AddSeconds(3)
        while([QuotumWindowProbe]::IsWindowVisible($loader) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 10}
        if([QuotumWindowProbe]::IsWindowVisible($loader)){throw 'Escape could not cancel native loading'}
      }
    } catch {$pauseFailure=$_;throw} finally {
      $resumed=$false
      try {if($Diagnostics){Save-Stage 'ui-before-resume'}} finally {
        try {
          if($paused){$resumed=Resume-NativePause $paused {param($target) [QuotumWindowProbe]::ResumeUi($target)} $pauseFailure}
        } finally {
          Save-Stage 'ui-resume' $window $resumed
        }
      }
    }
    if($cancel){
      Start-Sleep -Seconds 1
      if([QuotumWindowProbe]::FindOther($process.Id,$window) -ne [IntPtr]::Zero){throw 'Cancelled loading opened a panel later'}
    } else {
      $deadline=(Get-Date).AddSeconds(15)
      do {$panel=[QuotumWindowProbe]::FindOther($process.Id,$window);if($panel -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while((Get-Date) -lt $deadline)
      Save-Stage 'paused-ui-panel' $panel
      if($panel -eq [IntPtr]::Zero){throw 'Paused UI: panel missing within 15s'}
      if(-not [QuotumWindowProbe]::Rounded($panel)){throw 'Paused UI: panel shape wrong'}
      # ShowWindow and hiding the loader are separate native messages. Observe
      # the completed handoff, not the brief interval where both are visible.
      $deadline=(Get-Date).AddSeconds(2)
      while([QuotumWindowProbe]::Loading($process.Id) -ne [IntPtr]::Zero -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 10}
      if([QuotumWindowProbe]::Loading($process.Id) -ne [IntPtr]::Zero){throw 'Loader stayed over the ready panel'}
      if(-not [QuotumWindowProbe]::IsWindowVisible($panel) -or -not [QuotumWindowProbe]::Responsive($panel,$process.Id)){throw 'The panel disappeared during handoff'}
      [void][QuotumWindowProbe]::PostMessage($panel,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
      $deadline=(Get-Date).AddSeconds(5)
      while([QuotumWindowProbe]::IsWindowVisible($panel) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
      if([QuotumWindowProbe]::IsWindowVisible($panel)){throw 'Could not dismiss the loaded panel'}
    }
  }
  $result.passed = $true
} catch {
  Save-Stage 'failed'
  $result.error = $_.Exception.Message
  $failed = $true
  throw
} finally {
  # Every step on its own: none may take the report, the diagnostics or the restoration of
  # the runner's files with it.
  $listed = @(Invoke-Step 'listing processes' {
    Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate
  })
  # Before anything is ended: an ending app takes its web view's processes with it.
  for ($cycle = 0; $cycle -lt $result.cycles.Count; $cycle++) {
    Invoke-Step "the browser process of cycle $cycle" { Update-Browser $cycle }
  }
  # The app's children are those started after it (a pid of an older process may be reused).
  $tree = @()
  $children = @()
  if ($process -and -not $process.HasExited) {
    Invoke-Step 'finding the children' {
      $parents = @([pscustomobject]@{ProcessId=$process.Id; CreationDate=$process.StartTime})
      for ($depth = 0; $depth -lt 5 -and $parents.Count; $depth++) {
        $next = @()
        foreach ($parent in $parents) {
          $next += @($listed | Where-Object { $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate })
        }
        $script:tree += $next
        $parents = $next
      }
    }
    foreach ($info in $tree) {
      Invoke-Step "holding child $($info.ProcessId)" {
        $owned = Get-Process -Id $info.ProcessId -ErrorAction SilentlyContinue
        if ($owned) {
          $keepChild = $false
          try {
            $handle = $owned.Handle
            if ($null -eq $handle -or $handle -eq [IntPtr]::Zero) { throw 'Cannot hold a child process' }
            # Check the pinned process at CIM's UTC microsecond precision.
            if ($info.CreationDate -and $owned.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -eq $info.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) {
              $script:children += [pscustomobject]@{Process=$owned; Info=$info}
              $keepChild = $true
            }
          } finally { if (-not $keepChild) { $owned.Dispose() } }
        }
      }
    }
  }
  if (Test-Path -LiteralPath $work) {
    Invoke-Step 'writing processes.json' {
      $mine = @($process.Id) + @($tree | ForEach-Object ProcessId)
      $kept = @($listed | Where-Object { $mine -contains $_.ProcessId } |
        ForEach-Object { [ordered]@{ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$(if ($_.CreationDate) { $_.CreationDate.ToString('o') })} })
      [IO.File]::WriteAllText("$work/processes.json", (ConvertTo-Json -InputObject $kept -Depth 3))
    }
  }
  if ($process -and -not $process.HasExited) {
    Invoke-Step 'ending the app' { Stop-Owned $process "the app ($($process.Id))" }
  }
  if ($second -and -not $second.HasExited -and -not $second.WaitForExit(10000)) {
    Invoke-Step 'ending the second launch' { Stop-Owned $second "the second launch ($($second.Id))" }
  }
  $leftovers = @()
  foreach ($child in $children) {
    if (-not $child.Process.WaitForExit(10000)) {
      $description = "owned child $($child.Info.ProcessId)"
      $leftovers += [ordered]@{pid=$child.Info.ProcessId}
      Invoke-Step 'ending a child' { Stop-Owned $child.Process $description }
    }
  }
  $result.leftovers = $leftovers
  if ($leftovers.Count) { $result.errors += "Children survived the controller: $(($leftovers | ForEach-Object { $_.pid }) -join ', ')" }
  # The fresh profile goes and the one set aside comes back. If the fresh one cannot go, the
  # one set aside stays where it is: both are named.
  if ($profileState -ne 'unknown') {
    $before = $result.errors.Count
    Invoke-Step 'putting the profile of WebView2 back' {
      $deadline = (Get-Date).AddSeconds(10)
      while (Test-Path -LiteralPath $webview) {
        try { Remove-Item -LiteralPath $webview -Recurse -Force }
        catch {
          if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; continue }
          $kept = if ($profileState -eq 'moved') { "; the previous one stays at $aside" } else { '' }
          throw "the fresh profile $webview could not be removed ($($_.Exception.Message))$kept"
        }
      }
      if ($profileState -eq 'moved') {
        try { [IO.Directory]::Move($aside, $webview) }
        catch { throw "the previous profile $aside could not be put back as $webview ($($_.Exception.Message))" }
      }
    }
    # Seen even when the run failed for another reason, which the error is about.
    if ($result.errors.Count -gt $before) { Write-Warning "The profile of WebView2 is not back in place: $($result.errors[-1])" }
  }
  Invoke-Step 'restoring the window state' {
    if ($null -ne $savedState) { [IO.File]::WriteAllBytes($stateFile, $savedState) }
    else { Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue }
  }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $environment[$name]) }
  if ($result.errors.Count) { $result.passed = $false }
  $json = ConvertTo-Json -InputObject $result -Depth 6
  Write-Host $json
  if ($Report) { Invoke-Step 'writing the report' { [IO.File]::WriteAllText($Report, $json) } }
  if ($Diagnostics) {
    Invoke-Step 'keeping the diagnostics' {
      New-Item -ItemType Directory -Force $Diagnostics | Out-Null
      # Artifact strings are fixed stage labels; exceptions and private paths remain local.
      $safe=[ordered]@{passed=$result.passed;firstWindowMs=$result.firstWindowMs;windows=$result.windows;cycles=$result.cycles;panels=$result.panels;errorCount=$result.errors.Count;failed=$failed;leftovers=$result.leftovers}
      [IO.File]::WriteAllText((Join-Path $Diagnostics 'report.json'), (ConvertTo-Json -InputObject $safe -Depth 6))
      Copy-Item -LiteralPath "$work/processes.json" -Destination $Diagnostics -ErrorAction SilentlyContinue
      if($loaderDismissalEvidence -and -not $nativePauseDepth -and -not $nativeResumeFailed){
        $loaderDismissalEvidence.pipelinePassed=$result.passed
        Write-NativeJson 'stale-dismissal-control.json' $loaderDismissalEvidence 10
      }
      $manifest.requestProbeScope='last-natural-owner-snapshot'
      $manifest.requestProbeOriginalPostedInputAccepted=$false
      $manifest.requestProbeFreshWorkerAtFailedDeadline=$false
      $manifest.requestProbeSources=@()
      $sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
      foreach($relative in @('desktop/src/main.rs','desktop/src/host/tauri.rs','desktop/src/host/tauri_window.rs','desktop/src/host/windows_loading.rs','desktop/src/host/windows_request.rs','desktop/src/tray.rs','desktop/smoke/window-probe.cs','desktop/smoke/windows-ui.ps1')){
        $sourcePath=Join-Path $sourceRoot $relative
        if(Test-Path -LiteralPath $sourcePath){$item=Get-Item -LiteralPath $sourcePath;$manifest.requestProbeSources+=@{path=$relative;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash}}
      }
      $manifest.status=if($result.passed){'passed'}else{'failed'}
      $manifest.files=@(Get-ChildItem -LiteralPath $Diagnostics -Filter '*.json' | Where-Object {$_.Name -ne 'manifest.json'} | ForEach-Object {
        [ordered]@{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
      })
      Save-Manifest
      Write-Host "Diagnostics kept in $Diagnostics"
    }
  }
  if ($result.passed) { Invoke-Step 'removing the work folder' { Remove-Item -Recurse -Force $work } }
  else { Write-Host "Diagnostics: $work" }
  # A failure of the run itself is already on its way; this one is of the cleanup alone.
  if (-not $failed -and $result.errors.Count) { throw ($result.errors -join '; ') }
}
