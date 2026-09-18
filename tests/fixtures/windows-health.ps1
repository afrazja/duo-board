$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\companion\windows\setup-functions.ps1')
$fixture=$env:DUO_TEST_ROOT
$application=Join-Path $fixture 'app'
New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'startup') | Out-Null
$since=[DateTime]::UtcNow.AddSeconds(-1)
$script:alive=$true
function Update-SetupProgress {}
function Get-HelperProcess {param($processId,$scriptFile,$stateDirectory);if($script:alive){return @{ProcessId=$processId}}}
function Start-Sleep {param($Milliseconds)}
function Save-Status([string]$remote,[bool]$fresh=$true,[int]$servicePid=222){
  $started=if($fresh){[DateTime]::UtcNow}else{[DateTime]::UtcNow.AddHours(-1)}
  @{status='running';startedAt=$started.ToString('o');pid=111;childPid=222;instance='fixture'} | ConvertTo-Json | Set-Content (Join-Path $fixture 'startup\status.json')
  @{status='ready';pid=$servicePid} | ConvertTo-Json | Set-Content (Join-Path $fixture 'service.json')
  @{remote=@{status=$remote};jobs=@{}} | ConvertTo-Json | Set-Content (Join-Path $fixture 'state.json')
}
function Assert-Rejected([string]$name){
  $rejected=$false
  try {Wait-HelperReady $fixture $application $since 0 | Out-Null}catch {$rejected=$true}
  if(-not $rejected){throw "False success: $name"}
  Write-Output "PASS: $name"
}
Save-Status 'connected'
if((Wait-HelperReady $fixture $application $since 0) -ne 'connected'){throw 'Healthy service rejected'}
Write-Output 'PASS: healthy service'
Save-Status 'connected' $false
Assert-Rejected 'stale startup status'
Save-Status 'connected' $true 333
Assert-Rejected 'wrong service process'
Save-Status 'connected'
$script:alive=$false
Assert-Rejected 'dead helper process'
$script:alive=$true
Save-Status 'attention'
if((Wait-HelperReady $fixture $application $since 0) -ne 'reconnect'){throw 'Revoked connection reported healthy'}
Write-Output 'PASS: revoked connection requires reconnect'
Save-Status 'disconnected'
if((Wait-HelperReady $fixture $application $since 0) -ne 'offline'){throw 'Offline connection reported healthy'}
Write-Output 'PASS: offline connection not reported connected'
@{jobs=@{request=@{status='running'}}} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $fixture 'state.json')
$rejected=$false
try {Stop-ExistingHelper $fixture $application}catch {$rejected=$_.Exception.Message -match 'answer is still running'}
if(-not $rejected -or (Test-Path (Join-Path $fixture 'startup\stop.json'))){throw 'Repair disturbed active model work'}
Write-Output 'PASS: active model work is preserved'
