# Ordinary startup, including the window-state and single-instance plugins that --smoke skips.
# Every run starts from a fresh profile of WebView2, as the first start on a machine does:
# the one there is set aside and put back at the end.
# -Diagnostics <dir> keeps there, passed or not, the report, the app's logs and its processes.
param([Parameter(Mandatory=$true)][string]$App, [string]$Report, [string]$Diagnostics)
$ErrorActionPreference = 'Stop'
# Relative to PowerShell's location: .NET would take them relative to the process's.
if ($Report) { $Report = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Report) }
if ($Diagnostics) { $Diagnostics = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Diagnostics) }
$appPath = (Resolve-Path -LiteralPath $App).Path
$work = Join-Path $env:TEMP ('quotum-ui-' + [guid]::NewGuid().ToString('N'))
$stateFile = Join-Path $env:APPDATA 'com.padurets.quotum/.window-state.json'
$savedState = if (Test-Path -LiteralPath $stateFile) { [IO.File]::ReadAllBytes($stateFile) } else { $null }
$environment = @{}
$names = @('QUOTUM_APP_DATA_DIR', 'QUOTUM_STATE_DIR', 'QUOTUM_CONFIG', 'QUOTUM_RESETS')
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
  Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QuotumWindowProbe {
  public delegate bool EnumCallback(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  public static IntPtr Find(int process) {
    return FindOther(process,IntPtr.Zero);
  }
  public static IntPtr FindOther(int process, IntPtr except) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,data) => {
      uint owner; GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process || window==except || !IsWindowVisible(window)) return true;
      var kind=new StringBuilder(256); GetClassName(window,kind,kind.Capacity);
      if(kind.ToString()=="QuotumLoading") return true;
      var text=new StringBuilder(256); GetWindowText(window,text,text.Capacity);
      if(text.ToString()!="Quotum") return true;
      found=window; return false;
    },IntPtr.Zero);
    return found;
  }
  [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access, bool inherit, uint thread);
  [DllImport("kernel32.dll")] static extern uint SuspendThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int x1,int y1,int x2,int y2);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr window,IntPtr region);
  [DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr region,int x,int y);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
  public static bool Rounded(IntPtr window) {
    IntPtr region=CreateRectRgn(0,0,0,0);
    try {
      Rect outer,client;var origin=new Point();
      if(GetWindowRgn(window,region)==0 || !GetWindowRect(window,out outer) || !GetClientRect(window,out client) || !ClientToScreen(window,ref origin)) return false;
      int x=origin.X-outer.Left,y=origin.Y-outer.Top;
      return !PtInRegion(region,x,y) && PtInRegion(region,x+client.Right/2,y+client.Bottom/2);
    } finally { DeleteObject(region); }
  }
  public static IntPtr Loading(int process) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,data)=>{
      uint owner;GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process || !IsWindowVisible(window)) return true;
      var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
      if(name.ToString()!="QuotumLoading") return true;
      found=window;return false;
    },IntPtr.Zero);return found;
  }
  public static IntPtr PauseUi(IntPtr window,int process) {
    uint owner;uint thread=GetWindowThreadProcessId(window,out owner);
    if(owner!=(uint)process || thread==0) throw new Exception("Not the test app UI thread");
    IntPtr handle=OpenThread(2,false,thread);
    if(handle==IntPtr.Zero) throw new Exception("Cannot open the test UI thread");
    if(SuspendThread(handle)==uint.MaxValue){CloseHandle(handle);throw new Exception("Cannot pause the test UI thread");}
    return handle;
  }
  public static void ResumeUi(IntPtr thread) {
    try { if(ResumeThread(thread)==uint.MaxValue) throw new Exception("Cannot resume the test UI thread"); }
    finally {CloseHandle(thread);}
  }
  public static bool OpenPanel(int process) {
    IntPtr tray=IntPtr.Zero;
    EnumWindows((window,data) => {
      uint owner; GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process) return true;
      var name=new StringBuilder(256); GetClassName(window,name,name.Capacity);
      if(name.ToString()!="QuotumTray") return true;
      tray=window; return false;
    },IntPtr.Zero);
    // The Shell icon's version-4 NIN_SELECT callback (icon 1).
    return tray!=IntPtr.Zero && PostMessage(tray,0x8002,IntPtr.Zero,new IntPtr(0x10400));
  }
  public static bool Responsive(IntPtr window) {
    IntPtr result;
    return SendMessageTimeout(window,0,IntPtr.Zero,IntPtr.Zero,2,1000,out result)!=IntPtr.Zero;
  }
  public static int[] Bounds(IntPtr window) {
    Rect rect;
    var info=new MonitorInfo(); info.Size=Marshal.SizeOf(info);
    if(!GetWindowRect(window,out rect) || !GetMonitorInfo(MonitorFromWindow(window,2),ref info)) throw new Exception("Cannot read the window work area");
    return new int[]{rect.Left,rect.Top,rect.Right,rect.Bottom,info.Work.Left,info.Work.Top,info.Work.Right,info.Work.Bottom};
  }
}
'@
}

function Wait-Window {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    if ($process.HasExited) { throw "App exited before showing a window: $($process.ExitCode)" }
    $window = [QuotumWindowProbe]::Find($process.Id)
    if ($window -ne [IntPtr]::Zero -and [QuotumWindowProbe]::Responsive($window)) { return $window }
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

try {
  if (Get-Process quotum-desktop -ErrorAction SilentlyContinue) { throw 'Another Quotum instance is already running' }
  $left = @(Get-ChildItem -LiteralPath $webviewRoot -Filter 'EBWebView.quotum-ui-*' -Directory -ErrorAction SilentlyContinue)
  if ($left.Count) { throw "A profile of WebView2 set aside by an interrupted run is left: $($left.FullName -join ', '). Put it back as $webview by hand, after removing a fresh one there." }
  New-Item -ItemType Directory -Force "$work/app", "$work/state", (Split-Path $stateFile) | Out-Null
  $env:QUOTUM_APP_DATA_DIR = "$work/app"
  $env:QUOTUM_STATE_DIR = "$work/state"
  $env:QUOTUM_CONFIG = "$work/config.toml"
  $env:QUOTUM_RESETS = 'off'
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
      if ($panel -ne [IntPtr]::Zero -and [QuotumWindowProbe]::Responsive($panel)) { break }
      Start-Sleep -Milliseconds 50
    } while ((Get-Date) -lt $deadline)
    if ($panel -eq [IntPtr]::Zero) { throw 'The tray panel did not become visible' }
    Start-Sleep -Seconds 1
    if (-not [QuotumWindowProbe]::IsWindowVisible($panel) -or -not [QuotumWindowProbe]::Responsive($panel)) { throw 'The tray panel disappeared after creation' }
    $bounds = [QuotumWindowProbe]::Bounds($panel)
    if ($bounds[0] -lt $bounds[4] -or $bounds[1] -lt $bounds[5] -or $bounds[2] -gt $bounds[6] -or $bounds[3] -gt $bounds[7]) { throw "Panel exceeds its monitor work area: $bounds" }
    $result.panels += ,$bounds
    if ($cycle -eq 0) {
      $second = Start-Process -FilePath $appPath -PassThru
      $null = $second.Handle
      if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw 'Could not activate the main window beside the panel' }
    } elseif ($cycle -eq 1) {
      if (-not [QuotumWindowProbe]::PostMessage($panel, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close the panel' }
    } elseif (-not [QuotumWindowProbe]::OpenPanel($process.Id)) { throw 'Could not toggle the panel through the tray' }
    $deadline = (Get-Date).AddSeconds(5)
    while ([QuotumWindowProbe]::IsWindowVisible($panel) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if ([QuotumWindowProbe]::IsWindowVisible($panel)) { throw 'The panel did not close after dismissal, main-window activation or a repeated tray click' }
    if (-not [QuotumWindowProbe]::IsWindowVisible($window) -or ($before -join ',') -ne ([QuotumWindowProbe]::Bounds($window) -join ',')) { throw 'The panel changed the main window geometry' }
  }
  # A blocked WebView/UI thread must not stop the tray's native loading surface.
  # Only this test process's already-verified UI thread is paused, always resumed.
  [void][QuotumWindowProbe]::ShowWindowAsync($window,6)
  $deadline=(Get-Date).AddSeconds(5)
  while(-not [QuotumWindowProbe]::IsIconic($window) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
  if(-not [QuotumWindowProbe]::IsIconic($window)){throw 'Could not put the test UI thread in the background'}
  foreach($cancel in @($false,$true)) {
    $paused=[QuotumWindowProbe]::PauseUi($window,$process.Id)
    try {
      $loadingClock=[Diagnostics.Stopwatch]::StartNew()
      if(-not [QuotumWindowProbe]::OpenPanel($process.Id)){throw 'Cannot ask for the loading panel'}
      $loader=[IntPtr]::Zero
      do {$loader=[QuotumWindowProbe]::Loading($process.Id);if($loader -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 10}while($loadingClock.ElapsedMilliseconds -lt 3000)
      if($loader -eq [IntPtr]::Zero -or -not [QuotumWindowProbe]::Responsive($loader)){throw 'Native loader waited for the blocked WebView thread'}
      if(-not [QuotumWindowProbe]::Rounded($loader)){throw 'Native loader has square corners'}
      $result.loadingMs=$loadingClock.ElapsedMilliseconds
      if($cancel){
        [void][QuotumWindowProbe]::PostMessage($loader,0x100,[IntPtr]27,[IntPtr]::Zero)
        $deadline=(Get-Date).AddSeconds(3)
        while([QuotumWindowProbe]::IsWindowVisible($loader) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 10}
        if([QuotumWindowProbe]::IsWindowVisible($loader)){throw 'Escape could not cancel native loading'}
      }
    } finally { [QuotumWindowProbe]::ResumeUi($paused) }
    if($cancel){
      Start-Sleep -Seconds 1
      if([QuotumWindowProbe]::FindOther($process.Id,$window) -ne [IntPtr]::Zero){throw 'Cancelled loading opened a panel later'}
    } else {
      $deadline=(Get-Date).AddSeconds(15)
      do {$panel=[QuotumWindowProbe]::FindOther($process.Id,$window);if($panel -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 50}while((Get-Date) -lt $deadline)
      if($panel -eq [IntPtr]::Zero -or -not [QuotumWindowProbe]::Rounded($panel)){throw 'Rounded browser panel did not replace the loader'}
      # ShowWindow and hiding the loader are separate native messages. Observe
      # the completed handoff, not the brief interval where both are visible.
      $deadline=(Get-Date).AddSeconds(2)
      while([QuotumWindowProbe]::Loading($process.Id) -ne [IntPtr]::Zero -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 10}
      if([QuotumWindowProbe]::Loading($process.Id) -ne [IntPtr]::Zero){throw 'Loader stayed over the ready panel'}
      if(-not [QuotumWindowProbe]::IsWindowVisible($panel) -or -not [QuotumWindowProbe]::Responsive($panel)){throw 'The panel disappeared during handoff'}
      [void][QuotumWindowProbe]::PostMessage($panel,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
      $deadline=(Get-Date).AddSeconds(5)
      while([QuotumWindowProbe]::IsWindowVisible($panel) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
      if([QuotumWindowProbe]::IsWindowVisible($panel)){throw 'Could not dismiss the loaded panel'}
    }
  }
  $result.passed = $true
} catch {
  $result.error = $_.Exception.Message
  $failed = $true
  throw
} finally {
  # Every step on its own: none may take the report, the diagnostics or the restoration of
  # the runner's files with it.
  $listed = @(Invoke-Step 'listing processes' {
    Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId, CreationDate, CommandLine
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
        if ($owned) { $null = $owned.Handle; $script:children += [pscustomobject]@{Process=$owned; Info=$info} }
      }
    }
  }
  if (Test-Path -LiteralPath $work) {
    Invoke-Step 'writing processes.json' {
      $mine = @($process.Id) + @($tree | ForEach-Object ProcessId)
      $kept = @($listed | Where-Object { $mine -contains $_.ProcessId -or $_.Name -eq 'msedgewebview2.exe' -or $_.Name -like 'quotum-*' } |
        ForEach-Object { [ordered]@{Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$(if ($_.CreationDate) { $_.CreationDate.ToString('o') }); CommandLine=$_.CommandLine} })
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
      $description = "$($child.Info.ProcessId) $($child.Info.Name): $($child.Info.CommandLine)"
      $leftovers += [ordered]@{pid=$child.Info.ProcessId; name=$child.Info.Name; commandLine=$child.Info.CommandLine}
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
      [IO.File]::WriteAllText((Join-Path $Diagnostics 'report.json'), $json)
      Copy-Item "$work/processes.json", "$work/app/logs/*.log" -Destination $Diagnostics -ErrorAction SilentlyContinue
      Write-Host "Diagnostics kept in $Diagnostics"
    }
  }
  if ($result.passed) { Invoke-Step 'removing the work folder' { Remove-Item -Recurse -Force $work } }
  else { Write-Host "Diagnostics: $work" }
  # A failure of the run itself is already on its way; this one is of the cleanup alone.
  if (-not $failed -and $result.errors.Count) { throw ($result.errors -join '; ') }
}
