param(
  [ValidateSet('Install','Start','Stop','Status','Uninstall')][string]$Action='Status',
  [string]$StateDirectory,
  [string]$TaskName='Duo Board Helper'
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
if(-not $StateDirectory){$StateDirectory=Join-Path $taskRoot '.bridge-state/helper'}
$StateDirectory=[IO.Path]::GetFullPath($StateDirectory)
$taskStatus=Join-Path $StateDirectory 'startup/status.json'
function Stop-Helper {
  if(Test-Path -LiteralPath $taskStatus){
    $taskSaved=Get-Content -LiteralPath $taskStatus -Raw | ConvertFrom-Json
    if($taskSaved.status -ne 'stopped' -and (Get-Process -Id $taskSaved.pid -ErrorAction SilentlyContinue)){
      $taskStopFile=Join-Path $StateDirectory 'startup/stop.json'
      [IO.File]::WriteAllText($taskStopFile,(@{instance=$taskSaved.instance}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
      $taskDeadline=[DateTime]::UtcNow.AddSeconds(30)
      do {
        Start-Sleep -Milliseconds 250
        $taskSaved=Get-Content -LiteralPath $taskStatus -Raw|ConvertFrom-Json
      }while($taskSaved.status -ne 'stopped' -and [DateTime]::UtcNow -lt $taskDeadline)
      if($taskSaved.status -ne 'stopped'){throw 'The helper is still closing. No unrelated process has been stopped.'}
    }
  }
}
$taskExisting=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($taskExisting -and $taskExisting.Description -ne "Duo Board background helper: $StateDirectory"){throw 'An unrelated task uses this name. Choose another TaskName.'}
switch($Action){
  'Install' {
    $taskNode=(Get-Command node.exe).Source
    $taskCodex=(Get-Command codex.exe).Source
    $taskScript=Join-Path $PSScriptRoot 'background.mjs'
    foreach($taskPath in @($taskNode,$taskCodex,$taskScript,$StateDirectory)){if($taskPath.Contains('"')){throw 'Paths cannot contain quotes.'}}
    $taskWho=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Launch through hidden PowerShell so Windows never creates a console window.
    $taskLauncher=Join-Path $PSScriptRoot 'run-background.ps1'
    $taskLaunchArgs='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$taskLauncher+'" -Node "'+$taskNode+'" -StateDirectory "'+$StateDirectory+'" -Codex "'+$taskCodex+'"'
    $taskAction=New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $taskLaunchArgs -WorkingDirectory $taskRoot
    $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskWho
    $taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskWho -LogonType Interactive -RunLevel Limited
    $taskSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Description "Duo Board background helper: $StateDirectory" -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force|Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output 'Automatic startup is installed for this Windows account.'
  }
  'Start' {if(-not $taskExisting){throw 'Install automatic startup first.'};Start-ScheduledTask -TaskName $TaskName}
  'Stop' {Stop-Helper;Write-Output 'Helper stopped. Saved conversation links are preserved.'}
  'Uninstall' {Stop-Helper;if($taskExisting){Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false};Write-Output 'Automatic startup removed. Saved connection and conversation links are preserved.'}
  'Status' {if($taskExisting){$taskExisting|Select-Object TaskName,State};if(Test-Path -LiteralPath $taskStatus){Get-Content -LiteralPath $taskStatus}}
}
