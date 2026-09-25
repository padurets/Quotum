# The app as CI installed it, run once end to end with data of its own (see src/smoke.rs):
#
#   windows.ps1 normal <app.exe>   --smoke must pass, and no Node of the app is left after it
#   windows.ps1 crash <app.exe>    --smoke=crash aborts the app; its Node must go by itself
param([string]$Mode, [string]$App)
$ErrorActionPreference = 'Stop'

$work = Join-Path $env:RUNNER_TEMP "quotum-smoke-$Mode"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
$env:QUOTUM_APP_DATA_DIR = "$work\app"
$env:QUOTUM_STATE_DIR = "$work\state"
$env:QUOTUM_CONFIG = "$work\config.toml"
$env:QUOTUM_RESETS = 'off'
# Only Antigravity, through a stand-in: no real client starts, no account is needed. The
# path in single quotes: in a TOML string in double quotes a backslash escapes.
@"
sessions = false
[providers.claude]
enabled = false
[providers.codex]
enabled = false
[providers.antigravity]
path = '$PSScriptRoot\agy.cmd'
"@ | Set-Content -Encoding utf8NoBOM $env:QUOTUM_CONFIG

$dir = Split-Path -Parent $App
function Nodes { @(Get-Process quotum-node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir\*" }) }
function Fail([string]$why) {
  Write-Host "smoke ($Mode): $why"
  Get-ChildItem "$work\app\logs\*.log" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- $($_.FullName)"; Get-Content $_.FullName -Tail 40
  }
  exit 1
}

if ((Nodes).Count) { Fail 'a quotum-node runs before the app starts' }
$argument = if ($Mode -eq 'crash') { '--smoke=crash' } else { '--smoke' }
$p = Start-Process -FilePath $App -ArgumentList $argument -PassThru -RedirectStandardError "$work\stderr.txt"
# Without the handle cached now, ExitCode may be $null later (PowerShell #5421, #20716).
$null = $p.Handle
if (-not $p.WaitForExit(180000)) { Stop-Process -Id $p.Id -Force; Get-Content "$work\stderr.txt"; Fail 'no end within 180 s' }
$code = $p.ExitCode
Get-Content "$work\stderr.txt"
if ($null -eq $code) { Fail 'no exit code' }
if ($Mode -eq 'crash') {
  if ($code -eq 0) { Fail 'the app did not crash' }
  for ($i = 0; $i -lt 20 -and (Nodes).Count; $i++) { Start-Sleep -Milliseconds 500 }
  if ((Nodes).Count) { Fail 'quotum-node outlived the crashed app by 10 s' }
} else {
  if ($code -ne 0) { Fail "the app failed ($code)" }
  if ((Nodes).Count) { Fail 'quotum-node outlived the app' }
}
Write-Host "smoke ($Mode): passed"
