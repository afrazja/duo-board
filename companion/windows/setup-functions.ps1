function Find-DesktopCodex {
  $bin=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  return Get-ChildItem -LiteralPath $bin -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue} |
    Where-Object {-not $_.PSIsContainer} | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
function Install-Whisper([string]$application) {
  $whisper=Join-Path $application 'whisper'
  $executable=Join-Path $whisper 'whisper-cli.exe'
  $model=Join-Path $whisper 'ggml-base-q5_1.bin'
  $modelSha1='a3733eda680ef76256db5fc5dd9de8629e62c5e7'
  $binaryUrl='https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip'
  $binarySha256='49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
  if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){
    $binaryUrl='https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-win-cpu-arm64.zip'
    $binarySha256='799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc'
  }
  $ready=(Test-Path -LiteralPath $executable -PathType Leaf) -and (Test-Path -LiteralPath $model -PathType Leaf)
  if($ready){
    $ready=((Get-FileHash -LiteralPath $model -Algorithm SHA1).Hash.ToLowerInvariant() -eq $modelSha1)
    if($ready){return}
  }
  New-Item -ItemType Directory -Force -Path $application,$whisper | Out-Null
  $download=Join-Path $application ('whisper-download-'+[guid]::NewGuid().ToString('N'))
  $archive=$download+'.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $binaryUrl -OutFile $archive
    if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binarySha256){throw 'The Whisper program download failed its security check. Run setup again.'}
    Expand-Archive -LiteralPath $archive -DestinationPath $download -Force
    $cli=Get-ChildItem -LiteralPath $download -Filter whisper-cli.exe -File -Recurse | Select-Object -First 1
    if(-not $cli){throw 'The Whisper program download was incomplete. Run setup again.'}
    Get-ChildItem -LiteralPath $cli.Directory.FullName -File | Copy-Item -Destination $whisper -Force
    Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin?download=true' -OutFile ($model+'.download')
    if((Get-FileHash -LiteralPath ($model+'.download') -Algorithm SHA1).Hash.ToLowerInvariant() -ne $modelSha1){throw 'The Whisper language model download failed its security check. Run setup again.'}
    Move-Item -LiteralPath ($model+'.download') -Destination $model -Force
    if(-not (Test-Path -LiteralPath $executable -PathType Leaf)){throw 'Whisper was not installed. Run setup again.'}
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($model+'.download') -Force -ErrorAction SilentlyContinue
  }
}
function Get-HelperProcess([int]$processId,[string]$scriptFile,[string]$stateDirectory) {
  if($processId -le 0){return $null}
  $process=Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if($process -and $process.ExecutablePath -and [IO.Path]::GetFileName($process.ExecutablePath) -eq 'node.exe' -and
    $process.CommandLine -and $process.CommandLine.IndexOf($scriptFile,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $process.CommandLine.IndexOf($stateDirectory,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $process}
  return $null
}
function Stop-ExistingHelper([string]$stateDirectory,[string]$application) {
  $statusFile=Join-Path $stateDirectory 'startup\status.json'
  if(-not (Test-Path -LiteralPath $statusFile)){return}
  $saved=Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
  $supervisor=Get-HelperProcess $saved.pid (Join-Path $application 'background.cjs') $stateDirectory
  if(-not $supervisor){
    if(Get-HelperProcess $saved.childPid (Join-Path $application 'helper.cjs') $stateDirectory){throw 'The previous helper is still closing. Restart Windows, then open Repair Duo Board Helper from Start.'}
    return
  }
  $jobsFile=Join-Path $stateDirectory 'state.json'
  if(Test-Path -LiteralPath $jobsFile){
    $state=Get-Content -LiteralPath $jobsFile -Raw | ConvertFrom-Json
    if(@($state.jobs.PSObject.Properties | Where-Object {$_.Value.status -in @('starting','running','recovering')}).Count){throw 'An answer is still running. Wait for it to finish, or press Stop in Duo Board, then run setup again.'}
  }
  $instance=$saved.instance
  [IO.File]::WriteAllText((Join-Path $stateDirectory 'startup\stop.json'),(@{instance=$instance}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  do {
    if(Get-Command Update-SetupProgress -ErrorAction SilentlyContinue){Update-SetupProgress}
    Start-Sleep -Milliseconds 250
    if(-not (Get-HelperProcess $saved.pid (Join-Path $application 'background.cjs') $stateDirectory)){return}
    $current=Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
    if($current.instance -ne $instance){throw 'The helper restarted during repair. Open setup again.'}
  } while([DateTime]::UtcNow -lt $deadline)
  # Recover the old build's failed-launch shutdown hang only when idle.
  $state=Get-Content -LiteralPath $jobsFile -Raw | ConvertFrom-Json
  if(@($state.jobs.PSObject.Properties | Where-Object {$_.Value.status -in @('starting','running','recovering')}).Count){throw 'The helper is still finishing an answer. Wait, then run setup again.'}
  $child=Get-HelperProcess $saved.childPid (Join-Path $application 'helper.cjs') $stateDirectory
  if($child -and $child.ParentProcessId -eq $saved.pid){Stop-Process -Id $child.ProcessId -ErrorAction Stop}
  $deadline=[DateTime]::UtcNow.AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 250
    if(-not (Get-HelperProcess $saved.pid (Join-Path $application 'background.cjs') $stateDirectory)){return}
  } while([DateTime]::UtcNow -lt $deadline)
  throw 'The helper could not close safely. Restart Windows, then open Repair Duo Board Helper from Start.'
}
function Register-HelperTask([string]$node,[string]$codex,[string]$claude,[string]$application,[string]$stateDirectory) {
  foreach($value in @($node,$codex,$claude,$application,$stateDirectory)){if($value -and $value.Contains('"')){throw 'An installation path contains an unsupported quote character.'}}
  $existing=Get-ScheduledTask -TaskName 'Duo Board Helper' -ErrorAction SilentlyContinue
  if($existing -and $existing.Description -notin @("Duo Board Windows companion: $stateDirectory","Duo Board background helper: $stateDirectory")){throw 'An unrelated Windows task already uses the Duo Board Helper name.'}
  $launcher=Join-Path $application 'run-background.ps1'
  $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$launcher+'" -Node "'+$node+'" -Application "'+$application+'" -StateDirectory "'+$stateDirectory+'" -Codex "'+$codex+'"'
  if($claude){$arguments+=' -Claude "'+$claude+'"'}
  $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action=New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $application
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $account
  $principal=New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'Duo Board Helper' -TaskPath '\' -Description "Duo Board Windows companion: $stateDirectory" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  if(-not (Get-ScheduledTask -TaskName 'Duo Board Helper' -ErrorAction Stop)){throw 'Windows did not create the helper startup task.'}
}
function New-RepairShortcut([string]$application) {
  $shortcutFile=Join-Path ([Environment]::GetFolderPath('Programs')) 'Repair Duo Board Helper.lnk'
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($shortcutFile)
  $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments='"'+(Join-Path $application 'launch.vbs')+'" /repair'
  $shortcut.WorkingDirectory=$application
  $shortcut.Description='Restore Duo Board automatic startup and check its connection.'
  $shortcut.Save()
}
function Wait-HelperReady([string]$stateDirectory,[string]$application,[datetime]$since,[int]$timeoutSeconds=40) {
  $deadline=[DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  $localReady=$false
  do {
    try {
      if(Get-Command Update-SetupProgress -ErrorAction SilentlyContinue){Update-SetupProgress}
      $status=Get-Content -LiteralPath (Join-Path $stateDirectory 'startup\status.json') -Raw -ErrorAction Stop | ConvertFrom-Json
      $service=Get-Content -LiteralPath (Join-Path $stateDirectory 'service.json') -Raw -ErrorAction Stop | ConvertFrom-Json
      $localReady=$status.status -eq 'running' -and ([datetime]$status.startedAt).ToUniversalTime() -ge $since -and
        $service.status -eq 'ready' -and $service.pid -eq $status.childPid -and
        (Get-HelperProcess $status.pid (Join-Path $application 'background.cjs') $stateDirectory) -and
        (Get-HelperProcess $status.childPid (Join-Path $application 'helper.cjs') $stateDirectory)
      if($localReady){
        $saved=Get-Content -LiteralPath (Join-Path $stateDirectory 'state.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        if($saved.remote.status -eq 'connected'){return 'connected'}
        if($saved.remote.status -eq 'attention'){return 'reconnect'}
      }
    } catch { $localReady=$false }
    Start-Sleep -Milliseconds 500
  } while([DateTime]::UtcNow -lt $deadline)
  if($localReady){return 'offline'}
  throw 'Windows registered the startup task, but the helper did not become ready. Restart Windows and run Repair Duo Board Helper. On a work computer, your IT team may need to allow it.'
}
