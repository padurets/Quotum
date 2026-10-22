$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Only the native fixture enables numeric stage observations; stderr stays private.
$observeStages = $env:QUOTUM_TEST_KEY_STAGES -eq '1'
$setupWatch = if ($observeStages) { [Diagnostics.Stopwatch]::StartNew() } else { $null }
function Observe-SetupStage([int]$stage) {
  if ($observeStages) {
    try { [Console]::Error.WriteLine('QKS1 ' + $stage + ' ' + $setupWatch.ElapsedMilliseconds); [Console]::Error.Flush() } catch {}
  }
}
Observe-SetupStage 1
try {
  Add-Type -LiteralPath (Join-Path $PSScriptRoot 'managed-key.dll') -ErrorAction Stop | Out-Null
  Observe-SetupStage 2
  [QuotumManagedKey]::Run()
} catch {
  try { $out = [Console]::OpenStandardOutput(); $bytes = [byte[]](81,75,82,49,3); $out.Write($bytes,0,5); $out.Flush() } catch {}
}
