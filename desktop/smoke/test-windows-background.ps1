# Execute the smoke's actual setup and pause/finally blocks with controlled native facts.
param([string]$Source=(Join-Path $PSScriptRoot 'windows-ui.ps1'))
$ErrorActionPreference='Stop'
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
  public static int Clock,ForegroundUntil,IconicAt,Pauses,Resumes,Posts,PauseAt;
  public static bool Suspended,PausedForeground;
  public static string Race;
  public static void Reset(int foregroundUntil,int iconicAt,string race) {
    Clock=Pauses=Resumes=Posts=0;PauseAt=-1;Suspended=PausedForeground=false;
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
  public static void ResumeUi(IntPtr thread) {
    if(thread!=new IntPtr(2)||!Suspended)throw new Exception("Unexpected resume");Resumes++;Suspended=false;
  }
  public static Reading Snapshot(IntPtr window,int process) { return new Reading(); }
  public static IntPtr Tray(int process) { return new IntPtr(3); }
  public static bool OpenPanel(int process) { Posts++;return true; }
  public static IntPtr Loading(int process) { return new IntPtr(4); }
  public static bool Responsive(IntPtr window,int process) { return true; }
  public static bool Rounded(IntPtr window) { return true; }
}
'@
function Get-Date { [datetime]::new(2026,1,1).AddMilliseconds([QuotumWindowProbe]::Clock) }
function Start-Sleep { param([int]$Milliseconds) [QuotumWindowProbe]::Clock+=$Milliseconds }
function Watch-OwnedThreads { param($Observer,$Threads) }
function Save-Stage { param($Stage,$Window,$Resumed) if($Stage -eq 'ui-resume'){$script:resumeRecorded=$Resumed} }
function Save-ObservedPause { param($Observer,$Kind,$From,$To,$Resumed) $script:pauseRecorded=$Resumed }
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
  $window=[IntPtr]1;$process=[pscustomobject]@{Id=99};$Diagnostics=$true;$cancel=$false
  $observer=$null;$paused=$null;$pauseFrom=$null;$result=@{};$caught=$false
  $script:resumeRecorded=$null;$script:pauseRecorded=$null
  try {. $setup;. $pause} catch {$caught=$true}
  $ok=$caught -eq $case.error -and [QuotumWindowProbe]::Pauses -eq $case.pauses -and [QuotumWindowProbe]::Posts -eq $case.posts
  $ok=$ok -and [QuotumWindowProbe]::Resumes -eq $case.pauses -and -not [QuotumWindowProbe]::Suspended
  $ok=$ok -and [QuotumWindowProbe]::PauseAt -eq $case.at -and -not [QuotumWindowProbe]::PausedForeground
  if($case.pauses){$ok=$ok -and $script:resumeRecorded -eq $true -and $script:pauseRecorded -eq $true}
  else {$ok=$ok -and [QuotumWindowProbe]::Clock -eq 5000}
  $status=if($ok){'PASS'}else{'FAIL'}
  Write-Output "$status $($case.name): caught=$caught clock=$([QuotumWindowProbe]::Clock) pauses=$([QuotumWindowProbe]::Pauses) posts=$([QuotumWindowProbe]::Posts) resumes=$([QuotumWindowProbe]::Resumes)"
  if(-not $ok){$failed.Add($case.name)}
}
if($failed.Count){throw "Background setup controls failed: $($failed -join ', ')"}
