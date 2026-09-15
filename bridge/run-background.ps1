param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$StateDirectory,[Parameter(Mandatory=$true)][string]$Codex,[string]$Claude)
$ErrorActionPreference='Stop'
if($Claude){& $Node (Join-Path $PSScriptRoot 'background.mjs') --state-dir $StateDirectory --codex $Codex --claude $Claude}
else{& $Node (Join-Path $PSScriptRoot 'background.mjs') --state-dir $StateDirectory --codex $Codex}
exit $LASTEXITCODE
