# Numeric progress from the isolated app log. No line identifies its writer PID or request.
# Counts and durations are partial and untrusted unless status is observed.
function Get-OwnedWindowProgress([string]$OwnedRoot,[string]$LogPath,[hashtable]$Expected,[hashtable]$Binding) {
  $out=[ordered]@{schemaVersion=1;scope='owned-app-log-progress';status='unavailable';reason='binding-unavailable';productionAcceptance=$false;causalPass=$false;callbackAcceptance='unknown';requestCorrelation='unknown';logScope='whole-owned-current-log';source=$null;package=$null;process=$null;cycle=$null;bytesRead=0;linesRead=0;truncated=$false;counts=@{workerEntered=0;compactBuildAttempt=0;compactNativeGetter=0};durations=@{attemptLastMs=$null;attemptMaxMs=$null;nativeGetterLastMs=$null;nativeGetterMaxMs=$null}}
  if(-not $Expected -or -not $Binding){return $out}
  if($Binding.cycle -isnot [int] -or $Binding.cycle -lt 0 -or $Binding.cycle -gt 2){return $out}
  if($Expected.run -and $Expected.run -notmatch '^\d+$' -or $Expected.attempt -and $Expected.attempt -notmatch '^\d+$'){return $out}
  if($Binding.scope -ne 'owned-ui-app-log' -or $Binding.deadlineExpired -ne $true -or $Binding.packetOwned -ne $true -or $Binding.packetPosted -ne $true){return $out}
  if($Expected.pid -le 0 -or $Expected.birthUtcTicks -le 0 -or $Expected.sourceSha -notmatch '^[0-9a-fA-F]{40}$' -or $Expected.packageHash -notmatch '^[0-9a-fA-F]{64}$'){return $out}
  if($Binding.pid -ne $Expected.pid -or $Binding.packetPid -ne $Expected.pid -or $Binding.birthUtcTicks -ne $Expected.birthUtcTicks -or $Binding.sourceSha -ne $Expected.sourceSha -or $Binding.packageHash -ne $Expected.packageHash -or $Binding.run -ne $Expected.run -or $Binding.attempt -ne $Expected.attempt){return $out}
  $out.source=@{sha=$Expected.sourceSha;run=$Expected.run;attempt=$Expected.attempt};$out.package=@{sha256=$Expected.packageHash};$out.process=@{pid=$Expected.pid;birthUtcTicks=$Expected.birthUtcTicks};$out.cycle=$Binding.cycle
  try {
    $owned=[IO.Path]::GetFullPath($OwnedRoot)
    $expectedPath=[IO.Path]::GetFullPath((Join-Path $owned 'app/logs/hub.log'))
    $actual=[IO.Path]::GetFullPath($LogPath)
    $comparison=if([IO.Path]::DirectorySeparatorChar -eq '\'){[StringComparison]::OrdinalIgnoreCase}else{[StringComparison]::Ordinal}
    if(-not [string]::Equals($expectedPath,$actual,$comparison)){$out.reason='log-scope-mismatch';return $out}
    $app=Join-Path $owned 'app';$logs=Join-Path $app 'logs';$rotated=Join-Path $logs 'hub.log.1'
    foreach($path in @($owned,$app,$logs,$actual)){
      if(-not (Test-Path -LiteralPath $path)){$out.reason='log-missing';return $out}
      if(((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){$out.reason='log-scope-reparse';return $out}
    }
    if(Test-Path -LiteralPath $rotated){$out.status='ambiguous';$out.reason='rotation-present';return $out}
    $before=Get-Item -LiteralPath $actual
    $length=$before.Length;$created=$before.CreationTimeUtc.Ticks;$modified=$before.LastWriteTimeUtc.Ticks
    if($length -gt 1048576){$out.reason='log-over-byte-limit';$out.truncated=$true;return $out}
    $buffer=New-Object byte[] ([int]$length)
    $stream=[IO.File]::Open($actual,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
      if($stream.Length -ne $length){$out.status='ambiguous';$out.reason='log-changed-during-read';return $out}
      while($out.bytesRead -lt $length){
        $read=$stream.Read($buffer,$out.bytesRead,[int]($length-$out.bytesRead))
        if($read -le 0){$out.reason='log-incomplete';$out.truncated=$true;return $out}
        $out.bytesRead+=$read
      }
    }finally{$stream.Dispose()}
    $after=Get-Item -LiteralPath $actual
    if((Test-Path -LiteralPath $rotated) -or $after.Length -ne $length -or $after.CreationTimeUtc.Ticks -ne $created -or $after.LastWriteTimeUtc.Ticks -ne $modified){$out.status='ambiguous';$out.reason='log-changed-during-read';return $out}
    $body=[Text.UTF8Encoding]::new($false,$true).GetString($buffer)
    if($body.Length -and -not $body.EndsWith("`n")){$out.reason='log-incomplete-line';$out.truncated=$true;return $out}
    $rows=$body.Split("`n")
    if($rows.Length -gt 4097){$out.reason='log-over-line-limit';$out.truncated=$true;return $out}
    foreach($row in $rows){
      if(-not $row.Length){continue}
      $out.linesRead++
      $line=$row.TrimEnd("`r")
      $stamp='\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z'
      if($line -match ('^'+$stamp+' app: the tray asks for the window$')){$out.counts.workerEntered++;continue}
      $field=$null
      if($line -match ('^'+$stamp+' app: attempt (?<attempt>\d{1,10}) to create the window compact at (?<duration>\d{1,20}) ms$')){
        $number=[uint32]0
        if(-not [uint32]::TryParse($Matches.attempt,[ref]$number) -or $number -lt 1 -or $number -gt 20){$out.reason='progress-number-unavailable';return $out}
        $out.counts.compactBuildAttempt++;$field='attempt'
      }elseif($line -match ('^'+$stamp+' app: the window compact is up after (?<duration>\d{1,20}) ms$')){
        $out.counts.compactNativeGetter++;$field='nativeGetter'
      }
      if($field){
        $duration=[uint64]0
        if(-not [uint64]::TryParse($Matches.duration,[ref]$duration)){$out.reason='progress-number-unavailable';return $out}
        $out.durations[$field+'LastMs']=$duration
        if($null -eq $out.durations[$field+'MaxMs'] -or $duration -gt $out.durations[$field+'MaxMs']){$out.durations[$field+'MaxMs']=$duration}
      }
    }
    if($Binding.cycle -ne 0 -or $out.counts.workerEntered -gt 1){$out.status='ambiguous';$out.reason='request-association-ambiguous'}
    elseif($out.counts.workerEntered+$out.counts.compactBuildAttempt+$out.counts.compactNativeGetter -eq 0){$out.reason='no-allowlisted-progress'}
    else{$out.status='observed';$out.reason=$null}
  }catch{$out.status='unavailable';$out.reason='log-read-unavailable'}
  return $out
}
