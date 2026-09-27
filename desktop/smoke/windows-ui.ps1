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
# (from the second launch while the window is open).
$result = [ordered]@{passed=$false; firstWindowMs=$null; windows=@(); cycles=@(); errors=@()}
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  public static IntPtr Find(int process) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,data) => {
      uint owner; GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process || !IsWindowVisible(window)) return true;
      var text=new StringBuilder(256); GetWindowText(window,text,text.Capacity);
      if(text.ToString()!="Quotum") return true;
      found=window; return false;
    },IntPtr.Zero);
    return found;
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

# Whether the app's log has a line with $Text. The app appends to it meanwhile.
function Test-Logged([string]$Text) {
  $path = "$work/app/logs/hub.log"
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $reader = [IO.StreamReader]::new([IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
  try { return $reader.ReadToEnd().Contains($Text) } finally { $reader.Dispose() }
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
  # A second launch while the window is open shows that very window: the app finds it
  # alive, as a closing one is not.
  $asked = $clock.ElapsedMilliseconds
  $second = Start-Process -FilePath $appPath -PassThru
  $null = $second.Handle
  if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw 'The second instance did not hand off to the first while its window was open' }
  $deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Logged 'app: found the window main') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Logged 'app: found the window main')) { throw 'A second launch while the window was open did not find it alive' }
  if ((Wait-Window) -ne $window) { throw 'A second launch while the window was open did not show that window' }
  $result.openHandoffMs = $clock.ElapsedMilliseconds - $asked
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
