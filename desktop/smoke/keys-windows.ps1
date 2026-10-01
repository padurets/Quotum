# Keep this isolated profile through reboot. Reads only its exact Credential Manager target.
param(
  [Parameter(Mandatory=$true)][string]$App,
  [string]$Work = (Join-Path $env:LOCALAPPDATA 'Quotum key QA'),
  [switch]$Hidden,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$appPath = (Resolve-Path -LiteralPath $App).Path
$workPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Work)
$appData = Join-Path $workPath 'app'
$state = Join-Path $workPath 'state'
$config = Join-Path $workPath 'quotum.toml'

function RunEntry {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try {
    $missing = New-Object object
    $value = if ($key) { $key.GetValue('Quotum', $missing, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $missing }
    if ([object]::ReferenceEquals($value, $missing)) { return [ordered]@{present=$false} }
    return [ordered]@{present=$true; kind=$key.GetValueKind('Quotum').ToString(); value=$value}
  } finally { if ($key) { $key.Dispose() } }
}
$runBefore = RunEntry | ConvertTo-Json -Compress

if ($VerifyOnly) {
  if (-not (Test-Path -LiteralPath $appData -PathType Container)) { throw 'The isolated test profile does not exist' }
} else {
  [IO.Directory]::CreateDirectory($workPath) | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls $workPath /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect the isolated test directory' }
  foreach ($path in @($appData, $state)) { [IO.Directory]::CreateDirectory($path) | Out-Null }
  [IO.File]::WriteAllText($config, "sessions = false`n[providers.claude]`nenabled = false`n[providers.codex]`nenabled = false`n[providers.antigravity]`nenabled = false`n")
  # The app must leave the person's global start-at-login preference alone, including after reboot.
  $appJson = Join-Path $appData 'app.json'
  try { $settings = if (Test-Path -LiteralPath $appJson) { Get-Content -LiteralPath $appJson -Raw | ConvertFrom-Json } else { [pscustomobject]@{} } }
  catch { throw 'The isolated app settings are invalid' }
  if ($settings -isnot [pscustomobject]) { throw 'The isolated app settings are invalid' }
  $settings | Add-Member -MemberType NoteProperty -Name autostartDefaulted -Value $true -Force
  $temporary = "$appJson.$([Guid]::NewGuid().ToString('N')).key-qa-new"
  try {
    [IO.File]::WriteAllText($temporary, ($settings | ConvertTo-Json -Depth 100))
    # NullString keeps the backup parameter a .NET null on PowerShell 5.1 too.
    if (Test-Path -LiteralPath $appJson) { [IO.File]::Replace($temporary, $appJson, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $appJson) }
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

if (-not ('QuotumExactKeyProbe' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QuotumExactKeyProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public long LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static bool LocalCanonicalKey(string target) {
    IntPtr pointer;
    if (!CredRead(target,1,0,out pointer)) return false;
    byte[] bytes = null;
    Credential value = new Credential();
    try {
      value = (Credential)Marshal.PtrToStructure(pointer,typeof(Credential));
      if (value.Persist != 2 || value.BlobSize != 43 || value.Blob == IntPtr.Zero) return false;
      bytes = new byte[43]; Marshal.Copy(value.Blob,bytes,0,43);
      const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      foreach (byte b in bytes) if (alphabet.IndexOf((char)b) < 0) return false;
      return (alphabet.IndexOf((char)bytes[42]) & 3) == 0;
    } finally {
      if (bytes != null) Array.Clear(bytes,0,bytes.Length);
      if (value.Blob != IntPtr.Zero) for(uint i=0;i<value.BlobSize;i++) Marshal.WriteByte(value.Blob,(int)i,0);
      CredFree(pointer);
    }
  }
}
'@
}

if (-not $VerifyOnly) {
  $names = @('QUOTUM_APP_DATA_DIR','QUOTUM_STATE_DIR','QUOTUM_CONFIG','QUOTUM_RESETS')
  $previous = @{}
  foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
  try {
    $env:QUOTUM_APP_DATA_DIR = $appData
    $env:QUOTUM_STATE_DIR = $state
    $env:QUOTUM_CONFIG = $config
    $env:QUOTUM_RESETS = 'off'
    $arguments = if ($Hidden) { @('--hidden') } else { @() }
    if ($arguments.Count) { Start-Process -FilePath $appPath -ArgumentList $arguments | Out-Null }
    else { Start-Process -FilePath $appPath | Out-Null }
  } finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$previous[$name]) }
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(90)
$markers = @()
do {
  $markers = @(Get-ChildItem -LiteralPath (Join-Path $workPath 'com.padurets.quotum-keys') -Filter marker.json -Recurse -ErrorAction SilentlyContinue)
  if ($markers.Count -eq 1) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($markers.Count -ne 1) { throw 'Expected one isolated key namespace; inspect the app settings' }
$marker = Get-Content -LiteralPath $markers[0].FullName -Raw | ConvertFrom-Json
if ($marker.current.kind -ne 'keystore' -or $marker.current.name -notmatch '^hub-secret-key@[0-9a-f]{64}#[1-9][0-9]*$') { throw 'Expected a system-store reference' }
if (-not [QuotumExactKeyProbe]::LocalCanonicalKey($marker.current.name)) { throw 'The exact test key is unavailable or is not Local/canonical' }
$runAfter = RunEntry | ConvertTo-Json -Compress
if ($runBefore -ne $runAfter) { throw 'The global start-at-login entry changed during isolated key QA' }
$report = [ordered]@{localKeyReadable=$true; target=$marker.current.name; wasFile=$marker.wasFile; hidden=[bool]$Hidden; verifyOnly=[bool]$VerifyOnly; autostartUnchanged=$true; profile=$workPath}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workPath 'key-report.json')
$report | ConvertTo-Json
