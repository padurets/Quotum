# Tests the helper without launching an app or changing the person's Quotum Run entry.
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'keys-windows.ps1'
$work = Join-Path $env:LOCALAPPDATA "Quotum key helper test $([Guid]::NewGuid().ToString('N'))"
$target = "hub-secret-key@$([Guid]::NewGuid().ToString('N'))$([Guid]::NewGuid().ToString('N'))#1"
$canaryName = "Quotum key helper test $([Guid]::NewGuid().ToString('N'))"
$canaryPath = "Software\Quotum key helper tests\$([Guid]::NewGuid().ToString('N'))"
$run = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($canaryPath)
$personRun = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
$before = if ($personRun) { $personRun.GetValue('Quotum', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$launches = [Collections.Generic.List[bool]]::new()

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QuotumKeyHelperFixture {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  public static void Create(string target) {
    IntPtr pointer = Marshal.AllocHGlobal(43);
    try {
      for (int i=0;i<43;i++) Marshal.WriteByte(pointer,i,(byte)'A');
      Credential credential = new Credential {Type=1,TargetName=target,BlobSize=43,Blob=pointer,Persist=2};
      if (!CredWrite(ref credential,0)) throw new Exception("Synthetic credential creation failed");
    } finally {
      for (int i=0;i<43;i++) Marshal.WriteByte(pointer,i,0);
      Marshal.FreeHGlobal(pointer);
    }
  }
  public static void Remove(string target) { CredDelete(target,1,0); }
}
'@

function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList)
  if ($env:QUOTUM_APP_DATA_DIR -ne (Join-Path $work 'app') -or $env:QUOTUM_CONFIG -ne (Join-Path $work 'quotum.toml') -or $env:QUOTUM_RESETS -ne 'off') { throw 'Launch escaped the isolated profile' }
  $settings = Get-Content -LiteralPath (Join-Path $env:QUOTUM_APP_DATA_DIR 'app.json') -Raw | ConvertFrom-Json
  # Model the app's automatic default with a private canary entry, never the person's value.
  if (-not $settings.autostartDefaulted) { $run.SetValue($canaryName, 'fixture'); throw 'Autostart was not suppressed before launch' }
  if ($settings.port -ne 23456 -or $settings.locale -ne 'ru' -or -not $settings.takeOverConfirmed -or $settings.fixture.nested -ne 'preserved') { throw 'Fixture metadata was replaced' }
  $configuration = Get-Content -LiteralPath $env:QUOTUM_CONFIG -Raw
  if ([regex]::Matches($configuration, 'enabled = false').Count -ne 3 -or $configuration -notmatch 'sessions = false') { throw 'A real provider could be launched' }
  $launches.Add($ArgumentList -contains '--hidden')
  $namespace = Join-Path $work 'com.padurets.quotum-keys/fixture'
  [IO.Directory]::CreateDirectory($namespace) | Out-Null
  [IO.File]::WriteAllText((Join-Path $namespace 'marker.json'), (@{current=@{kind='keystore';name=$target};wasFile=$false} | ConvertTo-Json))
}

try {
  [IO.Directory]::CreateDirectory((Join-Path $work 'app')) | Out-Null
  $settingsPath = Join-Path $work 'app/app.json'
  [IO.File]::WriteAllText($settingsPath, '{"port":23456,"locale":"ru","takeOverConfirmed":true,"autostartDefaulted":false,"fixture":{"nested":"preserved"}}')
  [QuotumKeyHelperFixture]::Create($target)
  $names = @('QUOTUM_APP_DATA_DIR','QUOTUM_STATE_DIR','QUOTUM_CONFIG','QUOTUM_RESETS')
  $environment = @{}
  foreach ($name in $names) { $environment[$name] = [Environment]::GetEnvironmentVariable($name) }
  & $helper -App $PSCommandPath -Work $work | Out-Null
  & $helper -App $PSCommandPath -Work $work -Hidden | Out-Null
  if ($launches.Count -ne 2 -or $launches[0] -or -not $launches[1]) { throw 'Ordinary and hidden launch coverage failed' }
  foreach ($name in $names) { if ([Environment]::GetEnvironmentVariable($name) -ne $environment[$name]) { throw 'Launch overrides were not restored' } }
  $configPath = Join-Path $work 'quotum.toml'
  [IO.File]::WriteAllText($configPath, 'verify-only fixture must not change')
  $settingsBefore = [IO.File]::ReadAllBytes($settingsPath)
  $aclBefore = (Get-Acl -LiteralPath $work).Sddl
  & $helper -App $PSCommandPath -Work $work -VerifyOnly | Out-Null
  if ($launches.Count -ne 2 -or [IO.File]::ReadAllText($configPath) -ne 'verify-only fixture must not change' -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($settingsPath)) -ne [Convert]::ToBase64String($settingsBefore) -or (Get-Acl -LiteralPath $work).Sddl -ne $aclBefore) { throw 'VerifyOnly changed fixture settings or launched an app' }
  $report = Get-Content -LiteralPath (Join-Path $work 'key-report.json') -Raw | ConvertFrom-Json
  if (-not $report.verifyOnly -or -not $report.autostartUnchanged -or $report.target -ne $target) { throw 'The safe verification report is incomplete' }
  $after = if ($personRun) { $personRun.GetValue('Quotum', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
  if ($after -ne $before -or $null -ne $run.GetValue($canaryName)) { throw 'The helper changed a start-at-login entry' }
  Write-Output 'keys-windows helper: ordinary, hidden, metadata, VerifyOnly and Run-entry isolation passed'
} finally {
  [QuotumKeyHelperFixture]::Remove($target)
  $run.DeleteValue($canaryName, $false)
  $run.Dispose()
  if ($personRun) { $personRun.Dispose() }
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($canaryPath)
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
