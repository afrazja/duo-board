param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Application,[Parameter(Mandatory=$true)][string]$StateDirectory,[Parameter(Mandatory=$true)][string]$Codex,[string]$Claude)
$ErrorActionPreference='Stop'
# Desktop updates replace the versioned bin directory. Repair only paths from
# that installation; an explicitly configured custom executable stays untouched.
$desktopBin=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$desktopPrefix=[IO.Path]::GetFullPath($desktopBin).TrimEnd('\')+'\'
if(-not (Test-Path -LiteralPath $Codex -PathType Leaf) -and [IO.Path]::IsPathRooted($Codex) -and [IO.Path]::GetFullPath($Codex).StartsWith($desktopPrefix,[StringComparison]::OrdinalIgnoreCase)){
  $currentCodex=Get-ChildItem -LiteralPath $desktopBin -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue} |
    Where-Object {-not $_.PSIsContainer} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if($currentCodex){$Codex=$currentCodex.FullName}
}
$env:DUO_COMPANION_ENTRY='1'
if($Claude){& $Node (Join-Path $Application 'background.cjs') --state-dir $StateDirectory --codex $Codex --claude $Claude}
else{& $Node (Join-Path $Application 'background.cjs') --state-dir $StateDirectory --codex $Codex}
exit $LASTEXITCODE
