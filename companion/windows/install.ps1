param([switch]$SelfTest)
$ErrorActionPreference='Stop'
$packageRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$required=@('background.cjs','helper.cjs','pair.cjs','run-background.ps1')
foreach($name in $required){if(-not (Test-Path -LiteralPath (Join-Path $packageRoot $name))){throw "Installer package is missing $name"}}
if($SelfTest){Write-Output 'Duo Board Helper installer package is complete.';exit 0}

function Show-Result([string]$message,[bool]$failed=$false){
  Add-Type -AssemblyName PresentationFramework
  $icon=if($failed){[System.Windows.MessageBoxImage]::Error}else{[System.Windows.MessageBoxImage]::Information}
  [void][System.Windows.MessageBox]::Show($message,'Duo Board Helper',[System.Windows.MessageBoxButton]::OK,$icon)
}
function Stop-ExistingHelper([string]$stateDirectory) {
  $statusFile=Join-Path $stateDirectory 'startup\status.json'
  if(-not (Test-Path -LiteralPath $statusFile)){return}
  $saved=Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json
  if($saved.status -eq 'stopped' -or -not (Get-Process -Id $saved.pid -ErrorAction SilentlyContinue)){return}
  $stopFile=Join-Path $stateDirectory 'startup\stop.json'
  [IO.File]::WriteAllText($stopFile,(@{instance=$saved.instance}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $saved=Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json
  } while($saved.status -ne 'stopped' -and [DateTime]::UtcNow -lt $deadline)
  if($saved.status -ne 'stopped'){throw 'The existing helper is still closing. Wait a moment, then open the installer again.'}
}
try {
  $pairing=(Get-Clipboard -Raw).Trim()
  if($pairing -notmatch '^duo_pair_[A-Za-z0-9_-]{43}$'){throw 'Return to Duo Board Settings, click Connect helper, then open this installer from Downloads.'}
  $node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if(-not $node){$node=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.cache\codex-runtimes') -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue|Where-Object FullName -Match '\\dependencies\\node\\bin\\node.exe$'|Sort-Object LastWriteTime -Descending|Select-Object -First 1 -ExpandProperty FullName}
  if(-not $node){throw 'Node.js was not found. Install the Codex desktop runtime or Node.js, then open this installer again.'}
  $codex=(Get-Command codex.exe -ErrorAction SilentlyContinue).Source
  if(-not $codex){$candidate=Join-Path $env:USERPROFILE '.codex\.sandbox-bin\codex.exe';if(Test-Path -LiteralPath $candidate){$codex=$candidate}}
  if(-not $codex){$candidate=Join-Path $env:USERPROFILE '.codex\plugins\.plugin-appserver\codex.exe';if(Test-Path -LiteralPath $candidate){$codex=$candidate}}
  if(-not $codex){throw 'Codex was not found. Open the Codex desktop app once, then open this installer again.'}

  $root=Join-Path $env:LOCALAPPDATA 'DuoBoard\Helper'
  $application=Join-Path $root 'app'
  $state=Join-Path $root 'state'
  $workspaceRoot=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Duo Board Workspaces'
  New-Item -ItemType Directory -Force -Path $application,$state,$workspaceRoot|Out-Null
  $taskName='Duo Board Helper'
  $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($existing) {
    $currentDescription="Duo Board Windows companion: $state"
    $legacyDescription="Duo Board background helper: $state"
    if($existing.Description -ne $currentDescription -and $existing.Description -ne $legacyDescription){throw 'An unrelated Windows task already uses the Duo Board Helper name.'}
    Stop-ExistingHelper $state
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  foreach($pathValue in @($node,$codex,$application,$state)){if($pathValue.Contains('"')){throw 'A required Windows path contains an unsupported quote character.'}}
  foreach($name in $required){Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (Join-Path $application $name) -Force}
  $pairingFile=Join-Path $root ('pair-'+[guid]::NewGuid().ToString('N')+'.txt')
  [IO.File]::WriteAllText($pairingFile,$pairing,(New-Object Text.UTF8Encoding($false)))
  $env:DUO_COMPANION_ENTRY='1'
  try {& $node (Join-Path $application 'pair.cjs') --pairing-file $pairingFile --origin 'https://wispbound.com' --state-dir $state --workspace-root $workspaceRoot|Out-Null;if($LASTEXITCODE -ne 0){throw 'The helper could not pair with Duo Board.'}}
  finally {Remove-Item -LiteralPath $pairingFile -Force -ErrorAction SilentlyContinue}
  Set-Clipboard -Value ''

  $launcher=Join-Path $application 'run-background.ps1'
  $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$launcher+'" -Node "'+$node+'" -Application "'+$application+'" -StateDirectory "'+$state+'" -Codex "'+$codex+'"'
  $action=New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $arguments -WorkingDirectory $application
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Description "Duo Board Windows companion: $state" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null
  Start-ScheduledTask -TaskName $taskName
  Show-Result 'Duo Board Helper is connected and running. You can close this window.'
} catch {
  Set-Clipboard -Value '' -ErrorAction SilentlyContinue
  Show-Result $_.Exception.Message $true
  exit 1
}
