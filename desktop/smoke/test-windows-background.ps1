# Execute the smoke's actual setup and pause/finally blocks with controlled native facts.
param([string]$Source=(Join-Path $PSScriptRoot 'windows-ui.ps1'))
$ErrorActionPreference='Stop'
$WarningPreference='SilentlyContinue'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'The UI smoke could not be parsed'}
$loops=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -eq 'cancel'},$true))
if($loops.Count -ne 1){throw 'Expected one paused-loader loop'}
$loop=$loops[0]
$shows=@($loop.Parent.Statements | Where-Object {$_.Extent.StartOffset -lt $loop.Extent.StartOffset -and $_.Extent.Text -match 'ShowWindowAsync\(\$window,\s*6\)'})
$tries=@($loop.Body.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($shows.Count -ne 1 -or $tries.Count -ne 1 -or -not $tries[0].Finally){throw 'The smoke setup/pause shape changed'}
$text=[IO.File]::ReadAllText($Source)
$setup=[scriptblock]::Create($text.Substring($shows[0].Extent.StartOffset,$loop.Extent.StartOffset-$shows[0].Extent.StartOffset))
$pause=[scriptblock]::Create($tries[0].Extent.Text)
Add-Type @'
using System;
public static class QuotumWindowProbe {
  public sealed class Reading { public uint Thread=7; }
  public sealed class DispatchReading { public uint Thread=7;public bool Paused,Resumed; }
  public sealed class PauseGuard : IDisposable {
    public bool Resumed;
    public void Dispose(){ResumeUi(new IntPtr(2));Resumed=true;}
  }
  public static DispatchReading LastDispatch;
  public static object LastPanelDispatch,LastUnresponsive;
  public static bool FailResume,FailScenario,FailSetup;
  public static int Clock,ForegroundUntil,IconicAt,Pauses,Resumes,Posts,PauseAt;
  public static bool Suspended,PausedForeground;
  public static string Race;
  public static void Reset(int foregroundUntil,int iconicAt,string race) {
    Clock=Pauses=Resumes=Posts=0;PauseAt=-1;Suspended=PausedForeground=false;
    FailResume=FailScenario=FailSetup=false;LastDispatch=null;
    ForegroundUntil=foregroundUntil;IconicAt=iconicAt;Race=race;
  }
  public static bool ShowWindowAsync(IntPtr window,int command) {
    if(window!=new IntPtr(1)||command!=6)throw new Exception("Unexpected minimize target");return true;
  }
  public static bool IsIconic(IntPtr window) { return Clock>=IconicAt; }
  public static bool Foreground(IntPtr window) { return Clock<ForegroundUntil; }
  public static IntPtr PauseUi(IntPtr window,int process) {
    if(window!=new IntPtr(1)||process!=99||Suspended)throw new Exception("Unexpected pause owner");
    Pauses++;PauseAt=Clock;PausedForeground=Foreground(window);Suspended=true;
    if(Race=="focus")ForegroundUntil=int.MaxValue;if(Race=="restore")IconicAt=int.MaxValue;
    return new IntPtr(2);
  }
  public static PauseGuard MainRequestThenPause(int process,string exe) {
    PauseUi(new IntPtr(1),process);LastDispatch=new DispatchReading{Paused=true};return new PauseGuard();
  }
  public static void ResumeUi(IntPtr thread) {
    if(thread!=new IntPtr(2)||!Suspended)throw new Exception("Unexpected resume");
    if(FailResume)throw new InvalidOperationException("controlled resume failure");
    Resumes++;Suspended=false;if(LastDispatch!=null)LastDispatch.Resumed=true;
  }
  public static Reading Snapshot(IntPtr window,int process) { return new Reading(); }
  public static IntPtr Tray(int process) { return new IntPtr(3); }
  public static bool OpenPanel(int process) {
    if(FailSetup)throw new InvalidOperationException("original setup failure");
    Posts++;if(Suspended && FailScenario)throw new InvalidOperationException("original scenario failure");return true;
  }
  public static bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l) { return true; }
  public static IntPtr Loading(int process) { return new IntPtr(4); }
  public static bool Responsive(IntPtr window,int process) { return true; }
  public static bool Rounded(IntPtr window) { return true; }
}
public static class QuotumEvidenceWriter {
  public static int Writes,Violations;
  public static bool FailWrites;
  public static void WriteAllText(string path,string body) {
    if(QuotumWindowProbe.Suspended){Violations++;throw new InvalidOperationException("filesystem write while paused");}
    Writes++;if(FailWrites)throw new System.IO.IOException("controlled evidence sink failure");
    System.IO.File.WriteAllText(path,body);
  }
}
'@
# Source actual functions and replace only their filesystem boundary. Both the
# old inline writer and the separated writer go through the same rejecting sink.
foreach($function in @($ast.FindAll({param($n)
  $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $n.Name -in @('Write-NativeJson','Enter-NativePause','Resume-NativePause','Save-Manifest','Save-Timeline','Save-Stage','Test-MainPanelHandoff')
},$true))){
  . ([scriptblock]::Create($function.Extent.Text.Replace('[IO.File]::WriteAllText(', '[QuotumEvidenceWriter]::WriteAllText(')))
}
function New-Item {
  param([string]$ItemType,[switch]$Force,[Parameter(Position=0)][string]$Path)
  if([QuotumWindowProbe]::Suspended){[QuotumEvidenceWriter]::Violations++;throw 'filesystem directory creation while paused'}
  Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Force:$Force -Path $Path
}
function Move-Item {
  param([string]$LiteralPath,[string]$Destination,[switch]$Force)
  if([QuotumWindowProbe]::Suspended){[QuotumEvidenceWriter]::Violations++;throw 'filesystem rename while paused'}
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('quotum-background-control-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
function Reset-EvidenceControl {
  $script:Diagnostics=$root
  $script:nativePauseDepth=0;$script:nativeResumeFailed=$false
  $script:manifest=[ordered]@{errors=@()}
  $script:timeline=New-Object 'System.Collections.Generic.List[object]'
  $script:timelineClock=[Diagnostics.Stopwatch]::StartNew()
  $script:requestSnapshots=0;$script:requestStages=@()
  [QuotumEvidenceWriter]::Writes=0;[QuotumEvidenceWriter]::Violations=0;[QuotumEvidenceWriter]::FailWrites=$false
}
function Get-Date { [datetime]::new(2026,1,1).AddMilliseconds([QuotumWindowProbe]::Clock) }
function Start-Sleep { param([int]$Milliseconds) [QuotumWindowProbe]::Clock+=$Milliseconds }
$cases=@(
  @{name='already-background';foreground=0;iconic=0;race='';error=$false;pauses=1;posts=1;at=0},
  @{name='minimized-still-foreground';foreground=200;iconic=0;race='';error=$false;pauses=1;posts=1;at=200},
  @{name='foreground-never-released';foreground=[int]::MaxValue;iconic=0;race='';error=$true;pauses=0;posts=0;at=-1},
  @{name='never-minimized';foreground=0;iconic=[int]::MaxValue;race='';error=$true;pauses=0;posts=0;at=-1},
  @{name='focus-returned-after-pause';foreground=0;iconic=0;race='focus';error=$true;pauses=1;posts=0;at=0},
  @{name='restored-after-pause';foreground=0;iconic=0;race='restore';error=$true;pauses=1;posts=0;at=0}
)
$failed=[Collections.Generic.List[string]]::new()
foreach($case in $cases){
  [QuotumWindowProbe]::Reset($case.foreground,$case.iconic,$case.race)
  Reset-EvidenceControl
  $window=[IntPtr]1;$process=[pscustomobject]@{Id=99};$cancel=$false
  $paused=$null;$result=@{};$caught=$false
  $pauseFailure=$null
  try {. $setup;. $pause} catch {$caught=$true}
  $ok=$caught -eq $case.error -and [QuotumWindowProbe]::Pauses -eq $case.pauses -and [QuotumWindowProbe]::Posts -eq $case.posts
  $ok=$ok -and [QuotumWindowProbe]::Resumes -eq $case.pauses -and -not [QuotumWindowProbe]::Suspended
  $ok=$ok -and [QuotumWindowProbe]::PauseAt -eq $case.at -and -not [QuotumWindowProbe]::PausedForeground
  $ok=$ok -and [QuotumEvidenceWriter]::Violations -eq 0
  if($case.pauses){
    $resume=@($timeline | Where-Object {$_.stage -eq 'ui-resume'})
    $ok=$ok -and $resume.Count -eq 1 -and $resume[0].resumed -eq $true
    $ok=$ok -and [QuotumEvidenceWriter]::Writes -gt 0
  }
  else {$ok=$ok -and [QuotumWindowProbe]::Clock -eq 5000}
  $status=if($ok){'PASS'}else{'FAIL'}
  Write-Output "$status $($case.name): caught=$caught clock=$([QuotumWindowProbe]::Clock) pauses=$([QuotumWindowProbe]::Pauses) posts=$([QuotumWindowProbe]::Posts) resumes=$([QuotumWindowProbe]::Resumes)"
  if(-not $ok){$failed.Add($case.name)}
}
# Stub only the extra native batch; execute its actual outer pause and resume.
function Test-StaleLoaderDismissal($Loader,$Clock,$UiThread) {
  if(-not [QuotumWindowProbe]::Suspended){throw 'Native control ran without the outer UI pause'}
  $script:batchCalls++
}
[QuotumWindowProbe]::Reset(0,0,'');Reset-EvidenceControl
$window=[IntPtr]1;$process=[pscustomobject]@{Id=99};$cancel=$false
$paused=$null;$pauseFailure=$null;$result=@{}
$isControl=$true;$batchCalls=0;$caught=$false
try {. $pause} catch {$caught=$true} finally {$isControl=$false}
$ok=-not $caught -and $batchCalls -eq 1 -and [QuotumWindowProbe]::Pauses -eq 1 -and [QuotumWindowProbe]::Resumes -eq 1 -and -not [QuotumWindowProbe]::Suspended -and $nativePauseDepth -eq 0 -and [QuotumEvidenceWriter]::Violations -eq 0
Write-Output "$(if($ok){'PASS'}else{'FAIL'}) stale-loader-control-resumes: caught=$caught batch=$batchCalls resumes=$([QuotumWindowProbe]::Resumes)"
if(-not $ok){$failed.Add('stale-loader-control-resumes')}
# Execute all three actual guarded pause blocks, including exceptions after the
# pause, a failed sink after resume, and native resume failure with a first cause.
$blocks=@(@{name='loader';body=$pause;resume='ui-resume'})
foreach($name in @('Test-QueuedPanelReopen','Test-MainPanelHandoff')){
  $function=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))[0]
  $guarded=@($function.FindAll({param($n)
    $n -is [Management.Automation.Language.TryStatementAst] -and
    @($n.Body.Statements | Where-Object {$_.Extent.Text -match '^\$paused\s*=.*(?:PauseUi|MainRequestThenPause)'}).Count -gt 0
  },$true))
  if($guarded.Count -eq 0 -and $name -eq 'Test-QueuedPanelReopen'){
    $guarded=@($function.FindAll({param($n)
      $n -is [Management.Automation.Language.TryStatementAst] -and $n.Finally -and $n.Finally.Extent.Text -match 'ResumeUi'
    },$true))
  }
  if($guarded.Count -ne 1){throw "Expected one actual pause guard in $name"}
  $guardText=$guarded[0].Extent.Text
  # The old queued check acquired the pause before try; include those exact
  # statements so this control rejects the old unguarded publication as well.
  if($name -eq 'Test-QueuedPanelReopen' -and $guardText -notmatch 'PauseUi'){
    $statements=@($function.Body.EndBlock.Statements)
    $acquire=@($statements | Where-Object {$_.Extent.Text -match '^\$paused\s*=.*PauseUi'})[0]
    $guardText=$text.Substring($acquire.Extent.StartOffset,$guarded[0].Extent.EndOffset-$acquire.Extent.StartOffset)
  }
  $blocks+=@{name=$name;body=[scriptblock]::Create($guardText);resume=$(if($name -eq 'Test-QueuedPanelReopen'){'queued-panel-resume'}else{'main-handoff-resume'})}
}
foreach($block in $blocks){
  foreach($mode in @('scenario-failure','writer-failure','resume-failure','scenario-and-resume-failure')){
    [QuotumWindowProbe]::Reset(0,0,'')
    Reset-EvidenceControl
    [QuotumWindowProbe]::FailScenario=$mode -in @('scenario-failure','scenario-and-resume-failure')
    [QuotumWindowProbe]::FailResume=$mode -in @('resume-failure','scenario-and-resume-failure')
    [QuotumEvidenceWriter]::FailWrites=$mode -eq 'writer-failure'
    $window=[IntPtr]1;$panel=[IntPtr]1;$Main=[IntPtr]1;$process=[pscustomobject]@{Id=99};$appPath='fixture.exe'
    $paused=$null;$pauseFailure=$null;$cancel=$false;$result=@{};$caught=$null
    try {. $block.body} catch {$caught=$_}
    $resume=@($timeline | Where-Object {$_.stage -eq $block.resume})
    $ok=[QuotumWindowProbe]::Pauses -eq 1 -and [QuotumEvidenceWriter]::Violations -eq 0
    $ok=$ok -and $resume.Count -eq 1
    if([QuotumWindowProbe]::FailResume){
      $ok=$ok -and $null -ne $caught -and [QuotumWindowProbe]::Suspended -and [QuotumWindowProbe]::Resumes -eq 0
      $ok=$ok -and $resume[0].resumed -eq $false -and [QuotumEvidenceWriter]::Writes -eq 0
      $ok=$ok -and $nativeResumeFailed -and $manifest.errors -contains 'native resume failed; evidence unavailable'
    }else{
      $ok=$ok -and -not [QuotumWindowProbe]::Suspended -and [QuotumWindowProbe]::Resumes -eq 1
      $ok=$ok -and $resume[0].resumed -eq $true -and [QuotumEvidenceWriter]::Writes -gt 0
    }
    if([QuotumWindowProbe]::FailScenario){$ok=$ok -and $caught.Exception.Message.Contains('original scenario failure')}
    elseif($mode -eq 'writer-failure'){$ok=$ok -and $null -eq $caught}
    elseif($mode -eq 'resume-failure'){$ok=$ok -and $caught.Exception.Message.Contains('controlled resume failure')}
    $status=if($ok){'PASS'}else{'FAIL'}
    Write-Output "$status $($block.name)/${mode}: pauses=$([QuotumWindowProbe]::Pauses) resumes=$([QuotumWindowProbe]::Resumes) writes=$([QuotumEvidenceWriter]::Writes) violations=$([QuotumEvidenceWriter]::Violations)"
    if(-not $ok){$failed.Add($block.name+'/'+$mode)}
  }
}
# A setup failure still propagates before any UI thread is paused.
[QuotumWindowProbe]::Reset(0,0,'')
Reset-EvidenceControl
[QuotumWindowProbe]::FailSetup=$true
$process=[pscustomobject]@{Id=99};$caught=$null
try {Test-MainPanelHandoff ([IntPtr]1)} catch {$caught=$_}
$ok=$null -ne $caught -and $caught.Exception.Message.Contains('original setup failure') -and [QuotumWindowProbe]::Pauses -eq 0
Write-Output "$(if($ok){'PASS'}else{'FAIL'}) handoff-setup: pauses=$([QuotumWindowProbe]::Pauses)"
if(-not $ok){$failed.Add('handoff-setup')}
# Buffer bounds and original timestamps belong to the actual Save-Stage too.
[QuotumWindowProbe]::Reset(0,0,'')
Reset-EvidenceControl
if(Get-Command Enter-NativePause -ErrorAction SilentlyContinue){
  $handle=Enter-NativePause { [QuotumWindowProbe]::PauseUi([IntPtr]1,99) }
}else{$handle=[QuotumWindowProbe]::PauseUi([IntPtr]1,99)}
try {
  Save-Stage 'timestamped-before-resume' ([IntPtr]1)
  $stamp=$timeline[0].utcTicks;$milliseconds=$timeline[0].ms
  for($index=0;$index -lt 1001;$index++){Save-Stage 'bounded-before-resume'}
  if($timeline.Count -ne 1000 -or [QuotumEvidenceWriter]::Writes -ne 0 -or [QuotumEvidenceWriter]::Violations -ne 0){$failed.Add('bounded-memory-before-resume')}
}finally{
  if(Get-Command Resume-NativePause -ErrorAction SilentlyContinue){$null=Resume-NativePause $handle {param($target) [QuotumWindowProbe]::ResumeUi($target)} $null}
  else{[QuotumWindowProbe]::ResumeUi($handle)}
}
# A full buffer must still flush its original records after resume.
Save-Stage 'bounded-resume' ([IntPtr]1) $true
$saved=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText((Join-Path $root 'timeline.json')))
if($saved.Count -ne 1000 -or $saved[0].utcTicks -ne $stamp -or $saved[0].ms -ne $milliseconds){$failed.Add('original-timestamps-after-resume')}
# Exercise the actual child selection and survivor cleanup with CIM's birth precision.
foreach($function in @($ast.FindAll({param($n)
  $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Invoke-Step','Stop-Owned')
},$true))){. ([scriptblock]::Create($function.Extent.Text))}
$selection=@($ast.FindAll({param($n)
  $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -eq 'info' -and $n.Condition.Extent.Text -eq '$tree'
},$true))
$survivor=@($ast.FindAll({param($n)
  $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -eq 'child' -and $n.Condition.Extent.Text -eq '$children'
},$true))
if($selection.Count -ne 1 -or $survivor.Count -ne 1){throw 'Expected the actual owned-child cleanup loops'}
$selectChildren=[scriptblock]::Create($selection[0].Extent.Text)
$statements=@($survivor[0].Parent.Statements);$index=[Array]::IndexOf($statements,$survivor[0])
$cleanupText=($statements[($index-1)..($index+2)] | ForEach-Object {$_.Extent.Text}) -join "`n"
if($cleanupText -notmatch '\$result.leftovers\s*=\s*\$leftovers' -or $cleanupText -notmatch 'Children survived the controller'){throw 'The survivor check changed shape'}
$cleanupChildren=[scriptblock]::Create($cleanupText)
Add-Type @'
public sealed class QuotumCleanupProcess : System.IDisposable {
  public int Id=99, Waits, Kills;
  public System.DateTime? Birth, PinnedBirth;
  public bool Held, Disposed, FailBirth, FailHandle;
  public System.DateTime? StartTime { get { if(FailBirth)throw new System.InvalidOperationException("unavailable birth");return Held ? PinnedBirth ?? Birth : Birth; } }
  public System.IntPtr Handle { get { if(FailHandle)throw new System.InvalidOperationException("unavailable handle");Held=true;return new System.IntPtr(1); } }
  public bool WaitForExit(int timeout) { if(!Held || Disposed || timeout!=10000)throw new System.InvalidOperationException("unowned wait");Waits++;return Kills>0; }
  public void Kill() { if(!Held || Disposed)throw new System.InvalidOperationException("unowned kill");Kills++; }
  public void Dispose() { Disposed=true;Held=false; }
}
'@
function Get-Process { [CmdletBinding()]param([int]$Id) if($Id -ne 99){throw 'Unexpected cleanup PID'};return $script:cleanupProcess }
$birth=[datetime]::SpecifyKind([datetime]::new(2026,1,1),[DateTimeKind]::Utc).AddTicks(1234560)
foreach($case in @('exact','submicrosecond','local-time','different-birth','changed-before-pin','missing-snapshot','missing-native','unavailable-birth','unavailable-handle','missing-process')){
  $candidate=[QuotumCleanupProcess]::new();$candidate.Birth=$birth
  $info=[pscustomobject]@{ProcessId=99;CreationDate=$birth}
  switch($case){
    'submicrosecond' {$candidate.Birth=$birth.AddTicks(7)}
    'local-time' {$candidate.Birth=$birth.AddTicks(7).ToLocalTime()}
    'different-birth' {$candidate.Birth=$birth.AddTicks(10)}
    'changed-before-pin' {$candidate.PinnedBirth=$birth.AddTicks(10)}
    'missing-snapshot' {$info.CreationDate=$null}
    'missing-native' {$candidate.Birth=$null}
    'unavailable-birth' {$candidate.FailBirth=$true}
    'unavailable-handle' {$candidate.FailHandle=$true}
  }
  $script:cleanupProcess=if($case -eq 'missing-process'){$null}else{$candidate}
  $script:children=@();$tree=@($info);$result=@{errors=@()}
  . $selectChildren
  $admitted=$case -in @('exact','submicrosecond','local-time')
  $ok=$children.Count -eq [int]$admitted
  if($admitted){$ok=$ok -and $children[0].Process -eq $candidate -and $candidate.Held -and -not $candidate.Disposed}
  elseif($case -ne 'missing-process'){$ok=$ok -and $candidate.Disposed -and -not $candidate.Held}
  $cleanupFailed=$false
  try {. $cleanupChildren} catch {$cleanupFailed=$true;$ok=$false}
  $ok=$ok -and $result.leftovers.Count -eq [int]$admitted -and $candidate.Kills -eq [int]$admitted -and $candidate.Waits -eq (2*[int]$admitted)
  if($admitted){$ok=$ok -and @($result.errors | Where-Object {$_ -like 'Children survived the controller:*'}).Count -eq 1}
  $status=if($ok){'PASS'}else{'FAIL'}
  Write-Output "$status cleanup/${case}: children=$($children.Count) leftovers=$($result.leftovers.Count) kills=$($candidate.Kills) cleanupFailed=$cleanupFailed"
  if(-not $ok){$failed.Add('cleanup/'+$case)}
  $candidate.Dispose()
}
Remove-Item -LiteralPath $root -Recurse -Force
if($failed.Count){throw "Background setup controls failed: $($failed -join ', ')"}
