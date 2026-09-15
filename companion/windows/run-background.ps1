param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Application,[Parameter(Mandatory=$true)][string]$StateDirectory,[Parameter(Mandatory=$true)][string]$Codex)
$ErrorActionPreference='Stop'
$env:DUO_COMPANION_ENTRY='1'
& $Node (Join-Path $Application 'background.cjs') --state-dir $StateDirectory --codex $Codex
exit $LASTEXITCODE
