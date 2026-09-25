# Ordinary startup, including the window-state and single-instance plugins that --smoke skips.
param([Parameter(Mandatory=$true)][string]$App, [string]$Report)
$ErrorActionPreference = 'Stop'
$appPath = (Resolve-Path -LiteralPath $App).Path
$work = Join-Path $env:TEMP ('quotum-ui-' + [guid]::NewGuid().ToString('N'))
$stateFile = Join-Path $env:APPDATA 'com.padurets.quotum/.window-state.json'
$savedState = if (Test-Path -LiteralPath $stateFile) { [IO.File]::ReadAllBytes($stateFile) } else { $null }
$environment = @{}
$names = @('QUOTUM_APP_DATA_DIR', 'QUOTUM_STATE_DIR', 'QUOTUM_CONFIG', 'QUOTUM_RESETS')
foreach ($name in $names) { $environment[$name] = [Environment]::GetEnvironmentVariable($name) }
$process = $null
$second = $null
$children = @()
$result = @{passed=$false; windows=@()}

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

try {
  if (Get-Process quotum-desktop -ErrorAction SilentlyContinue) { throw 'Another Quotum instance is already running' }
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
  $process = Start-Process -FilePath $appPath -PassThru
  $null = $process.Handle
  for ($cycle = 0; $cycle -lt 3; $cycle++) {
    $window = Wait-Window
    $bounds = [QuotumWindowProbe]::Bounds($window)
    if ($bounds[0] -lt $bounds[4] -or $bounds[1] -lt $bounds[5] -or $bounds[2] -gt $bounds[6] -or $bounds[3] -gt $bounds[7]) {
      throw "Window exceeds the monitor work area: $bounds"
    }
    $result.windows += ,$bounds
    if (-not [QuotumWindowProbe]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close the window' }
    $deadline = (Get-Date).AddSeconds(10)
    while ([QuotumWindowProbe]::Find($process.Id) -ne [IntPtr]::Zero -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ($process.HasExited -or [QuotumWindowProbe]::Find($process.Id) -ne [IntPtr]::Zero) { throw 'Closing the window did not leave a live controller without its window' }
    $second = Start-Process -FilePath $appPath -PassThru
    $null = $second.Handle
    if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw 'The second instance did not hand off to the first' }
  }
  $null = Wait-Window
  $result.passed = $true
} catch {
  $result.error = $_.Exception.Message
  throw
} finally {
  if ($process -and -not $process.HasExited) {
    $parents = @($process.Id)
    for ($depth = 0; $depth -lt 5; $depth++) {
      $next = @()
      foreach ($parent in $parents) {
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent")) {
          $owned = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
          if ($owned) { $null=$owned.Handle; $children += $owned; $next += $owned.Id }
        }
      }
      $parents = $next
    }
    $process.Kill()
    $null = $process.WaitForExit(10000)
  }
  if ($second -and -not $second.HasExited -and -not $second.WaitForExit(10000)) { $second.Kill() }
  $leftovers = @()
  foreach ($child in $children) {
    if (-not $child.WaitForExit(10000)) { $leftovers += $child.Id; $child.Kill() }
  }
  $result.leftovers = $leftovers
  if ($leftovers.Count) { $result.passed=$false; $result.error="Children survived the controller: $leftovers" }
  if ($null -ne $savedState) { [IO.File]::WriteAllBytes($stateFile, $savedState) }
  else { Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $environment[$name]) }
  $json = $result | ConvertTo-Json -Depth 4
  Write-Host $json
  if ($Report) { [IO.File]::WriteAllText($Report, $json) }
  if ($result.passed) { Remove-Item -Recurse -Force $work }
  else { Write-Host "Diagnostics: $work" }
  if ($leftovers.Count) { throw $result.error }
}
