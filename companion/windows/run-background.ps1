param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Application,[Parameter(Mandatory=$true)][string]$StateDirectory,[Parameter(Mandatory=$true)][string]$Codex,[string]$Claude)
$ErrorActionPreference='Stop'
$env:DUO_COMPANION_ENTRY='1'
if($Claude){& $Node (Join-Path $Application 'background.cjs') --state-dir $StateDirectory --codex $Codex --claude $Claude}
else{& $Node (Join-Path $Application 'background.cjs') --state-dir $StateDirectory --codex $Codex}
exit $LASTEXITCODE
