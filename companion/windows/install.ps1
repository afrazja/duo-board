param([switch]$SelfTest,[switch]$Repair,[switch]$NoUI)
$ErrorActionPreference='Stop'
$packageRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$root=Join-Path $env:LOCALAPPDATA 'DuoBoard\Helper'
$application=Join-Path $root 'app'
$state=Join-Path $root 'state'
$logFile=Join-Path $root 'setup.log'
$stage='Starting setup'
$taskRegistered=$false
$pairing=$null
$setupLock=$null
$progressWindow=$null
function Update-SetupProgress {
  if($progressWindow){$progressLabel.Text=$stage+"...`r`nPlease wait. This can take up to a minute.";[Windows.Forms.Application]::DoEvents()}
}
function Write-SetupLog([string]$message){
  Update-SetupProgress
  $safe=$message -replace 'duo_(pair|helper)_[A-Za-z0-9_-]+','[redacted]'
  try {Add-Content -LiteralPath $logFile -Value (([DateTime]::UtcNow.ToString('o'))+' '+$safe) -Encoding UTF8} catch {}
}
function Show-Result([string]$message,[bool]$failed=$false){
  if($progressWindow){$progressWindow.Hide()}
  if($NoUI){Write-Output $message;return}
  try {
    Add-Type -AssemblyName PresentationFramework
    $icon=if($failed){[System.Windows.MessageBoxImage]::Error}else{[System.Windows.MessageBoxImage]::Information}
    [void][System.Windows.MessageBox]::Show($message,'Duo Board Helper',[System.Windows.MessageBoxButton]::OK,$icon)
  } catch {
    try {$shell=New-Object -ComObject WScript.Shell;[void]$shell.Popup($message,0,'Duo Board Helper',$(if($failed){16}else{64}))} catch {Write-Error $message}
  }
}
try {
  $required=@('background.cjs','helper.cjs','pair.cjs','run-background.ps1','install.ps1','setup-functions.ps1','launch.vbs','THIRD_PARTY_NOTICES.txt')
  if(-not $SelfTest){New-Item -ItemType Directory -Force -Path $root | Out-Null}
  foreach($name in $required){if(-not (Test-Path -LiteralPath (Join-Path $packageRoot $name))){throw "Installer package is missing $name. Download the installer again from Duo Board Settings."}}
  . (Join-Path $packageRoot 'setup-functions.ps1')
  if($SelfTest){Write-Output 'Duo Board Helper installer package is complete.';exit 0}
  $setupLock=[IO.File]::Open((Join-Path $root 'setup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  if(-not $NoUI){
    try {
      Add-Type -AssemblyName System.Windows.Forms
      $progressWindow=New-Object Windows.Forms.Form
      $progressWindow.Text='Duo Board Helper';$progressWindow.Width=490;$progressWindow.Height=140
      $progressWindow.StartPosition='CenterScreen';$progressWindow.ControlBox=$false
      $progressLabel=New-Object Windows.Forms.Label
      $progressLabel.Dock='Fill';$progressLabel.Padding=New-Object Windows.Forms.Padding(20)
      $progressWindow.Controls.Add($progressLabel);$progressWindow.Show();Update-SetupProgress
    } catch {$progressWindow=$null}
  }
  if((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 256KB){Move-Item -LiteralPath $logFile -Destination (Join-Path $root 'setup.previous.log') -Force}
  Write-SetupLog 'Setup 0.3.0 started.'
  $stage='Checking the connection'
  if(-not $Repair){try {$pairing=(Get-Clipboard -Raw).Trim()}catch {$pairing=$null}}
  if($pairing -notmatch '^duo_pair_[A-Za-z0-9_-]{43}$'){$pairing=$null}
  if(-not $pairing -and -not (Test-Path -LiteralPath (Join-Path $state 'connection.json'))){throw 'Open Duo Board Settings, click Install or repair helper, then open this installer immediately. Keep the connection code on your clipboard until setup finishes.'}
  $stage='Finding the installed apps'; Write-SetupLog $stage
  $node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if(-not $node){$node=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.cache\codex-runtimes') -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object FullName -Match '\\dependencies\\node\\bin\\node.exe$' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName}
  if(-not $node){throw 'Node.js was not found. Install Node.js LTS from nodejs.org, then open this installer again.'}
  $codex=Find-DesktopCodex
  if(-not $codex){$codex=(Get-Command codex.exe -ErrorAction SilentlyContinue).Source}
  if(-not $codex){foreach($relative in @('.codex\.sandbox-bin\codex.exe','.codex\plugins\.plugin-appserver\codex.exe')){$candidate=Join-Path $env:USERPROFILE $relative;if(Test-Path -LiteralPath $candidate){$codex=$candidate;break}}}
  if(-not $codex){throw 'Codex was not found. Install and open the Codex desktop app, sign in, then open this installer again.'}
  $claude=(Get-Command claude.exe -ErrorAction SilentlyContinue).Source
  if(-not $claude){foreach($candidate in @((Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'),(Join-Path $env:USERPROFILE '.local\bin\claude.exe'))){if(Test-Path -LiteralPath $candidate){$claude=$candidate;break}}}
  $existing=Get-ScheduledTask -TaskName 'Duo Board Helper' -ErrorAction SilentlyContinue
  if($existing -and $existing.Description -notin @("Duo Board Windows companion: $state","Duo Board background helper: $state")){throw 'An unrelated Windows task already uses the Duo Board Helper name.'}
  $stage='Installing private voice transcription'; Write-SetupLog $stage
  Install-Whisper $application
  $stage='Closing the previous helper'; Write-SetupLog $stage
  Stop-ExistingHelper $state $application
  if($existing){Stop-ScheduledTask -TaskName 'Duo Board Helper' -ErrorAction Stop}
  $stage='Installing helper files'; Write-SetupLog $stage
  New-Item -ItemType Directory -Force -Path $application,$state | Out-Null
  if([IO.Path]::GetFullPath($packageRoot) -ne [IO.Path]::GetFullPath($application)){
    foreach($name in $required){Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (Join-Path $application $name) -Force}
  }
  # Register before pairing: a network failure must not leave no startup task.
  $stage='Registering automatic startup'; Write-SetupLog $stage
  Register-HelperTask $node $codex $claude $application $state
  $taskRegistered=$true
  $stage='Creating the repair shortcut'; Write-SetupLog $stage
  New-RepairShortcut $application
  if($pairing){
    $stage='Connecting to Duo Board'; Write-SetupLog $stage
    $workspaceRoot=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Duo Board Workspaces'
    $pairingFile=Join-Path $root ('pair-'+[guid]::NewGuid().ToString('N')+'.txt')
    [IO.File]::WriteAllText($pairingFile,$pairing,(New-Object Text.UTF8Encoding($false)))
    $env:DUO_COMPANION_ENTRY='1'
    try {
      # Never write the private bundle or one-time code to the log.
      $ErrorActionPreference='Continue'
      & $node (Join-Path $application 'pair.cjs') --pairing-file $pairingFile --origin 'https://wispbound.com' --state-dir $state --workspace-root $workspaceRoot 2>&1 | Out-Null
      $ErrorActionPreference='Stop'
      if($LASTEXITCODE -ne 0){throw 'The connection could not be saved. Open Duo Board Settings, click Install or repair helper for a fresh code, then open the installer again. Check your internet connection too.'}
    } finally {$ErrorActionPreference='Stop';Remove-Item -LiteralPath $pairingFile -Force -ErrorAction SilentlyContinue}
    try {if((Get-Clipboard -Raw).Trim() -eq $pairing){Set-Clipboard -Value ''}}catch {}
  }
  $stage='Verifying automatic startup and connection'; Write-SetupLog $stage
  $started=[DateTime]::UtcNow
  Start-ScheduledTask -TaskName 'Duo Board Helper'
  $health=Wait-HelperReady $state $application $started
  if($health -eq 'reconnect'){throw 'Automatic startup is repaired, but your connection needs renewal. Open Duo Board Settings, click Install or repair helper, then open the installer again.'}
  if($health -eq 'offline'){throw 'Automatic startup is working, but Duo Board is currently unreachable. Check your internet connection. The helper will retry automatically; use Repair Duo Board Helper from Start to check again.'}
  Write-SetupLog 'Verified: startup task, helper processes and board connection are healthy.'
  $models=if($claude){'ChatGPT and Claude'}else{'ChatGPT'}
  Show-Result "Duo Board Helper is connected and running for $models. Private voice transcription and automatic startup are verified.`n`nIf it stops working, open Repair Duo Board Helper from the Windows Start menu. No commands are needed."
} catch {
  $message=$_.Exception.Message -replace 'duo_(pair|helper)_[A-Za-z0-9_-]+','[redacted]'
  Write-SetupLog ("FAILED at ${stage}: "+$message)
  if($taskRegistered){try {Start-ScheduledTask -TaskName 'Duo Board Helper' -ErrorAction Stop}catch {Write-SetupLog 'Could not restart the registered task.'}}
  if(-not $SelfTest){Show-Result ("Setup needs attention ($stage).`n`n$message`n`nDiagnostic log: $logFile") $true}
  else {Write-Output $message}
  exit 1
} finally {if($setupLock){$setupLock.Dispose()};if($progressWindow){$progressWindow.Dispose()}}
