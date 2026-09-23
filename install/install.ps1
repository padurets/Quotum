# Installs the Quotum agent, the `quotum` command, from GitHub Releases on Windows:
#
#   irm https://github.com/padurets/quotum/releases/latest/download/install.ps1 | iex
#
# It downloads the binary, checks it against the release's SHA256SUMS, puts it in
# %LOCALAPPDATA%\Programs\quotum and adds that folder to your PATH. Nothing runs as
# administrator. Settings:
#   QUOTUM_INSTALL_DIR   where to put quotum.exe
#   QUOTUM_VERSION       a version to install, e.g. 0.3.0 (default: the latest)
#   QUOTUM_RELEASES_URL  where the releases are (default: GitHub)
# Later, `quotum update` keeps it up to date.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $releases = if ($env:QUOTUM_RELEASES_URL) { $env:QUOTUM_RELEASES_URL.TrimEnd('/') } else { 'https://github.com/padurets/quotum/releases' }
    $dir = if ($env:QUOTUM_INSTALL_DIR) { $env:QUOTUM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\quotum' }
    # One build, for x64; Windows on ARM runs it emulated.
    $asset = 'quotum-cli-windows-x64.exe'

    $version = $env:QUOTUM_VERSION
    if (-not $version) {
        # The latest version, from where releases/latest redirects to (…/tag/v0.3.0).
        $request = [Net.HttpWebRequest]::Create("$releases/latest")
        $request.AllowAutoRedirect = $false
        $request.Method = 'HEAD'
        $response = $request.GetResponse()
        $location = $response.Headers['Location']
        $response.Close()
        $version = ($location -split '/')[-1]
    }
    $version = $version.TrimStart('v')
    if ($version -notmatch '^\d+\.\d+\.\d+') { throw "quotum: cannot tell the latest version from $releases/latest" }
    Write-Host "quotum: installing $version into $dir"

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("quotum-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $binary = Join-Path $tmp 'quotum.exe'
        Invoke-WebRequest -UseBasicParsing -Uri "$releases/download/v$version/$asset" -OutFile $binary
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$releases/download/v$version/SHA256SUMS").Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        $expected = foreach ($line in $sums -split "`n") {
            $hash, $name = $line.Trim() -split '\s+', 2
            if ($name -and $name.TrimStart('*') -eq $asset) { $hash.ToLower() }
        }
        if (-not $expected) { throw "quotum: SHA256SUMS of $version has no $asset" }
        if ((Get-FileHash -Algorithm SHA256 $binary).Hash.ToLower() -ne $expected) {
            throw 'quotum: the download does not match its checksum; nothing was installed'
        }

        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $target = Join-Path $dir 'quotum.exe'
        # A running quotum.exe cannot be overwritten, but it can be moved aside; `quotum update`
        # moves it to the same name and removes it later.
        $aside = Join-Path $dir 'quotum.old.exe'
        if (Test-Path $target) {
            Remove-Item -Force -ErrorAction SilentlyContinue $aside
            Move-Item -Force $target $aside
        }
        Move-Item -Force $binary $target
        Remove-Item -Force -ErrorAction SilentlyContinue $aside
    } finally {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
    }

    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($path -split ';') -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', ((@($path, $dir) | Where-Object { $_ }) -join ';'), 'User')
        $env:Path = "$env:Path;$dir"
        Write-Host "quotum: added $dir to your PATH (new terminals see it)"
    }
    Write-Host "quotum: installed $(& (Join-Path $dir 'quotum.exe') --version)"
    Write-Host 'quotum: next: `quotum` shows the limits here; `quotum connect <hub>` and `quotum start` deliver them to a hub'
}
