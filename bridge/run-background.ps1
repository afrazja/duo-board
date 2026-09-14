param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$StateDirectory,[Parameter(Mandatory=$true)][string]$Codex)
$ErrorActionPreference='Stop'
& $Node (Join-Path $PSScriptRoot 'background.mjs') --state-dir $StateDirectory --codex $Codex
exit $LASTEXITCODE
