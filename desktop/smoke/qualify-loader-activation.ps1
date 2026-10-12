# Pure qualification of native receipts; this never runs a window or trusts a model's passed flag.
function Test-LoaderActivationEvidence($Reading,$Worker,[string]$Policy,[string]$Scenario) {
  $problems=New-Object 'System.Collections.Generic.List[string]'
  $behavior=New-Object 'System.Collections.Generic.List[string]'
  $scope='native-policy-model'
  if(-not $Reading){return @{scope=$scope;status='unavailable';nativeScheduleQualified=$false;modelOutcomeMatched=$false;productionAcceptance=$false;problems=@('native-receipt-missing')}}
  if(-not $Worker -or $Worker.exited -ne $true){return @{scope=$scope;status='cleanup-unconfirmed';nativeScheduleQualified=$false;modelOutcomeMatched=$false;productionAcceptance=$false;problems=@('worker-exit-unconfirmed')}}
  if($Worker.killed -ne $false){$problems.Add('worker-required-kill')}
  if($Reading.scope -ne $scope -or $Reading.policy -ne $Policy -or $Reading.scenario -ne $Scenario){$problems.Add('scope-or-case-mismatch')}
  if($Reading.nativeRuntimeExecuted -ne $true){$problems.Add('native-runtime-unavailable')}
  if($Reading.overflow -ne 0 -or $Reading.gateExpired -ne 0){$problems.Add('truncated-or-expired')}
  $rows=@($Reading.receipts)
  if($rows.Count -gt 128 -or -not $rows.Count){$problems.Add('receipt-count-unqualified')}
  $numbers=@($rows | ForEach-Object {$_.N})
  if(@($numbers | Select-Object -Unique).Count -ne $rows.Count){$problems.Add('duplicate-receipt-number')}
  if(@($numbers | Where-Object {$_ -le 0 -or ($_ % 1) -ne 0}).Count){$problems.Add('invalid-receipt-number')}
  $created=@($rows | Where-Object {$_.Kind -eq 'created' -and $_.Owned -eq $true})
  if($created.Count -ne 2 -or @($created.Thread | Select-Object -Unique).Count -ne 2 -or @($created.Window | Select-Object -Unique).Count -ne 2 -or @($created.Process | Select-Object -Unique).Count -ne 1 -or @($created | Where-Object {$_.Process -ne $Worker.pid -or -not $_.Thread -or -not $_.Window -or $_.CurrentThread -ne $_.Thread}).Count){$problems.Add('two-owned-native-threads-unqualified')}
  $initial=@($rows | Where-Object {$_.Kind -eq 'initial-main-observed'})
  $shown=@($rows | Where-Object {$_.Kind -eq 'transition-main-loader'})
  # Destruction can add another cancellation. Judge the trial before its cleanup.
  $final=@($rows | Where-Object {$_.Kind -eq 'final-snapshot'})
  if($initial.Count -ne 1 -or $shown.Count -ne 1 -or $final.Count -ne 1){$problems.Add('initial-or-final-snapshot-unavailable')}
  else {
    $main=$initial[0].Window;$loader=$shown[0].Window
    $identities=@{}
    foreach($window in $created){$identities[[string]$window.Window]=$window}
    foreach($row in $rows){
      if($row.Kind -eq 'loop-ended'){continue}
      $identity=$identities[[string]$row.Window]
      if(-not $identity -or -not $row.Owned -or $row.Process -ne $identity.Process -or $row.Thread -ne $identity.Thread -or -not $row.CurrentThread -or $row.UtcTicks -le 0 -or $row.MonotonicTicks -le 0){$problems.Add('owned-receipt-identity-unqualified');break}
    }
    if(-not $main -or -not $loader -or $main -eq $loader -or $initial[0].Foreground -ne $main -or $shown[0].Foreground -ne $loader -or -not $initial[0].Owned -or -not $shown[0].Owned -or -not $final[0].Owned -or $final[0].Window -ne $loader){$problems.Add('foreground-identity-unqualified')}
    $native=@($rows | Where-Object {$_.Kind -eq 'native-message' -and $_.Window -eq $loader -and $_.Message -eq 6 -and $_.Owned -eq $true -and $_.CurrentThread -eq $_.Thread})
    if($Scenario -eq 'stale'){
      $selected=@{}
      foreach($kind in @('gate-entered','gate-returned','transition-loader-main','transition-main-loader-again','stale-inactive')){
        $selected[$kind]=@($rows | Where-Object {$_.Kind -eq $kind})
        if($selected[$kind].Count -ne 1){$problems.Add('stale-schedule-'+$kind+'-unqualified')}
      }
      if(@($selected.Keys | Where-Object {$selected[$_].Count -ne 1}).Count -eq 0){
        $enter=$selected['gate-entered'][0];$leave=$selected['gate-returned'][0];$a=$selected['transition-loader-main'][0];$b=$selected['transition-main-loader-again'][0];$stale=$selected['stale-inactive'][0]
        if(-not ($enter.N -lt $a.N -and $a.N -lt $b.N -and $b.N -lt $leave.N -and $leave.N -lt $stale.N)){$problems.Add('stale-message-order-unqualified')}
        if($a.Foreground -ne $main -or $b.Foreground -ne $loader -or $b.GateStarted -ne 1 -or $b.GateReturned -ne 0){$problems.Add('held-foreground-reversal-unqualified')}
        if($stale.Foreground -ne $loader -or $stale.L -ne $main -or $stale.Message -ne 6 -or ($stale.W -band 65535) -ne 0 -or -not $stale.Owned -or $stale.CurrentThread -ne $stale.Thread -or -not $stale.Visible -or -not $stale.Wanted){$problems.Add('actual-stale-event-unqualified')}
        if(-not @($native | Where-Object {$_.N -lt $stale.N -and $_.L -eq $main -and $_.Foreground -eq $loader -and ($_.W -band 65535) -eq 0}).Count){$problems.Add('native-message-not-retained')}
      }
      if($Reading.transitions -ne 3 -or $Reading.gateStarted -ne 1 -or $Reading.gateReturned -ne 1 -or $Reading.linkedStaleObserved -lt 1){$problems.Add('three-real-transitions-unqualified')}
      if($Policy -eq 'baseline'){
        if($final[0].Cancellations -ne 1 -or $final[0].Wanted -ne $false -or $final[0].Visible -ne $false -or $final[0].NativeVisible -ne $false){$behavior.Add('baseline-did-not-reproduce-cancellation')}
      } elseif($Reading.staleIgnored -lt 1 -or $final[0].Cancellations -ne 0 -or $final[0].Wanted -ne $true -or $final[0].Visible -ne $true -or $final[0].NativeVisible -ne $true -or $final[0].Foreground -ne $loader){$behavior.Add('guard-did-not-preserve-open')}
    } elseif($Scenario -in @('blur','handoff')){
      if(-not @($native | Where-Object {($_.W -band 65535) -eq 0 -and $_.Foreground -eq $main -and $_.Visible -eq $true -and $_.Wanted -eq $true}).Count){$problems.Add('actual-foreground-leave-unqualified')}
      if($Scenario -eq 'handoff' -and (-not @($rows | Where-Object {$_.Kind -eq 'ready-target' -and $_.Ready -eq $main}).Count -or $final[0].Ready -ne $main)){$problems.Add('ready-handoff-target-unqualified')}
      $expected=if($Scenario -eq 'blur'){'cancel'}else{'handoff'}
      if(-not @($rows | Where-Object {$_.Kind -eq $expected}).Count){$behavior.Add('leave-policy-unmatched')}
      if($final[0].Visible -ne $false -or $final[0].NativeVisible -ne $false -or $final[0].Cancellations -ne $(if($Scenario -eq 'blur'){1}else{0}) -or $final[0].Wanted -ne ($Scenario -eq 'handoff')){$behavior.Add('leave-state-unmatched')}
    } elseif($Scenario -eq 'escape'){
      if(-not @($rows | Where-Object {$_.Kind -eq 'escape-input' -and $_.Foreground -eq $loader}).Count){$problems.Add('escape-input-unqualified')}
      if(-not @($rows | Where-Object {$_.Kind -eq 'native-message' -and $_.Message -eq 0x100 -and $_.W -eq 27 -and $_.Owned -eq $true -and $_.CurrentThread -eq $_.Thread}).Count){$problems.Add('native-escape-delivery-unqualified')}
      if($final[0].Cancellations -ne 1 -or $final[0].Wanted -ne $false -or $final[0].Visible -ne $false -or $final[0].NativeVisible -ne $false){$behavior.Add('escape-did-not-cancel')}
    } else {$problems.Add('unknown-scenario')}
  }
  $qualified=$problems.Count -eq 0
  $matched=$qualified -and $behavior.Count -eq 0
  $status=if(-not $qualified){'insufficient'}elseif(-not $matched){'policy-failed'}else{'qualified'}
  return @{scope=$scope;status=$status;nativeScheduleQualified=$qualified;modelOutcomeMatched=$matched;productionAcceptance=$false;problems=@($problems.ToArray());behavior=@($behavior.ToArray())}
}
