# Synthetic owned-directory/parser controls only; no app, native API or account is used.
param([string]$Helper=(Join-Path $PSScriptRoot 'windows-progress.ps1'),[string]$Report)
$ErrorActionPreference='Stop'
. $Helper
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('quotum-progress-'+[guid]::NewGuid().ToString('N'))
$logs=Join-Path $fixture 'app/logs';$path=Join-Path $logs 'hub.log'
New-Item -ItemType Directory -Force $logs|Out-Null
$expected=@{pid=101;birthUtcTicks=123456789;sourceSha=('a'*40);packageHash=('b'*64);run='38315462644';attempt='1'}
$binding=@{scope='owned-ui-app-log';deadlineExpired=$true;packetOwned=$true;packetPosted=$true;pid=101;packetPid=101;birthUtcTicks=123456789;sourceSha=('a'*40);packageHash=('b'*64);run='38315462644';attempt='1';cycle=0}
$body="2026-10-12T22:00:00Z app: the tray asks for the window`n2026-10-12T22:00:00Z app: attempt 1 to create the window compact at 23 ms`n2026-10-12T22:00:01Z app: the window compact is up after 157 ms`n"
$results=New-Object 'System.Collections.Generic.List[object]'
function Check([string]$Name,[string]$ExpectedStatus,$ExpectedBinding=$expected,$ActualBinding=$binding,[string]$ActualPath=$path){
  $reading=Get-OwnedWindowProgress $fixture $ActualPath $ExpectedBinding $ActualBinding
  if($reading.status -ne $ExpectedStatus -or $reading.productionAcceptance -ne $false -or $reading.causalPass -ne $false -or $reading.callbackAcceptance -ne 'unknown' -or $reading.requestCorrelation -ne 'unknown'){throw "Unexpected progress verdict: $Name"}
  $json=$reading|ConvertTo-Json -Depth 6
  if($json.Contains('secret-sentinel') -or $json.Contains($fixture) -or $json.Contains('the tray asks for the window')){throw 'Raw line or path escaped numeric progress'}
  $results.Add(@{name=$Name;status=$reading.status;reason=$reading.reason;callbackAcceptance=$reading.callbackAcceptance;productionAcceptance=$reading.productionAcceptance})
  return $reading
}
try {
  [IO.File]::WriteAllText($path,$body)
  $r=Check 'single-worker-numeric-progress' 'observed'
  if($r.counts.workerEntered -ne 1 -or $r.counts.compactBuildAttempt -ne 1 -or $r.counts.compactNativeGetter -ne 1 -or $r.durations.attemptLastMs -ne 23 -or $r.durations.nativeGetterMaxMs -ne 157){throw 'Allowlist lost numeric progress'}
  $b=$binding.Clone();$b.pid=999;$null=Check 'wrong-pid' 'unavailable' $expected $b
  $b=$binding.Clone();$b.packetPid=999;$null=Check 'wrong-packet-owner' 'unavailable' $expected $b
  $b=$binding.Clone();$b.birthUtcTicks++;$null=Check 'wrong-process-birth' 'unavailable' $expected $b
  $b=$binding.Clone();$b.scope='foreign-log';$null=Check 'wrong-log-binding-scope' 'unavailable' $expected $b
  $b=$binding.Clone();$b.sourceSha=('c'*40);$null=Check 'wrong-source' 'unavailable' $expected $b
  $b=$binding.Clone();$b.packageHash=('d'*64);$null=Check 'wrong-package' 'unavailable' $expected $b
  $b=$binding.Clone();$b.run='1';$null=Check 'wrong-run' 'unavailable' $expected $b
  $b=$binding.Clone();$b.packetPosted=$false;$null=Check 'packet-not-posted' 'unavailable' $expected $b
  $b=$binding.Clone();$b.deadlineExpired=$false;$null=Check 'before-original-deadline' 'unavailable' $expected $b
  $b=$binding.Clone();$b.cycle=1;$null=Check 'previous-panel-history' 'ambiguous' $expected $b
  $null=Check 'outside-owned-log-path' 'unavailable' $expected $binding (Join-Path $fixture 'other.log')
  [IO.File]::WriteAllText((Join-Path $logs 'hub.log.1'),$body)
  $null=Check 'ambiguous-rotation' 'ambiguous'
  Remove-Item -LiteralPath (Join-Path $logs 'hub.log.1')
  Remove-Item -LiteralPath $path
  $null=Check 'missing-log' 'unavailable'
  [IO.File]::WriteAllBytes($path,(New-Object byte[] 1048577))
  $r=Check 'oversize-log' 'unavailable';if(-not $r.truncated -or $r.bytesRead -ne 0){throw 'Oversize log was read'}
  [IO.File]::WriteAllText($path,(("ignored`n")*4097))
  $r=Check 'over-line-limit' 'unavailable';if(-not $r.truncated){throw 'Line overflow was not retained'}
  [IO.File]::WriteAllText($path,$body.TrimEnd("`n"))
  $r=Check 'incomplete-last-line' 'unavailable';if(-not $r.truncated){throw 'Partial line was accepted'}
  [IO.File]::WriteAllBytes($path,[byte[]]@(255,10))
  $null=Check 'invalid-utf8' 'unavailable'
  [IO.File]::WriteAllText($path,($body+"2026-10-12T22:00:02Z app: the tray asks for the window`n"))
  $null=Check 'multiple-worker-association' 'ambiguous'
  [IO.File]::WriteAllText($path,($body+"2026-10-12T22:00:02Z app: attempt 21 to create the window compact at 1 ms`n"))
  $r=Check 'invalid-attempt-number' 'unavailable'
  if($r.reason -ne 'progress-number-unavailable' -or $r.counts.workerEntered -ne 1 -or $r.durations.attemptLastMs -ne 23){throw 'Partial counts lost their unavailable verdict'}
  [IO.File]::WriteAllText($path,($body+"2026-10-12T22:00:02Z app: the window compact is up after 18446744073709551616 ms`n"))
  $r=Check 'overflow-duration' 'unavailable'
  if($r.reason -ne 'progress-number-unavailable' -or $r.counts.compactNativeGetter -ne 2 -or $r.durations.nativeGetterLastMs -ne 157){throw 'Partial duration escaped its unavailable verdict'}
  [IO.File]::WriteAllText($path,"2026-10-12T22:00:00Z app: attempt 1 to create the window main at 9 ms`nsecret-sentinel`n{`"msg`":`"app: the tray asks for the window`"}`n")
  $r=Check 'foreign-lines-and-secrets-not-exported' 'unavailable';if($r.counts.workerEntered+$r.counts.compactBuildAttempt+$r.counts.compactNativeGetter -ne 0){throw 'Non-allowlisted content was credited'}
  $result=@{scope='synthetic-progress-qualification-controls';nativeExecuted=$false;productionAcceptance=$false;passed=$true;count=$results.Count;cases=$results.ToArray()}
  if($Report){[IO.File]::WriteAllText($Report,($result|ConvertTo-Json -Depth 6))}
  Write-Host "$($results.Count) synthetic progress controls passed; nativeExecuted=false"
}finally{Remove-Item -LiteralPath $fixture -Recurse -Force}
