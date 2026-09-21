$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot '.companion-build'))
if(-not $buildRoot.StartsWith($projectRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid companion build directory'}
if(Test-Path -LiteralPath $buildRoot){Remove-Item -LiteralPath $buildRoot -Recurse -Force}
$stage=Join-Path $buildRoot 'windows'
New-Item -ItemType Directory -Force -Path $stage|Out-Null
$ncc=Join-Path $projectRoot 'node_modules\.bin\ncc.cmd'
if(-not (Test-Path -LiteralPath $ncc)){throw 'Run npm install before building the companion'}

$entries=@{
  'background.cjs'='companion\background-entry.js'
  'helper.cjs'='companion\helper-entry.js'
  'pair.cjs'='companion\pair-entry.js'
}
foreach($target in $entries.Keys){
  $output=Join-Path $buildRoot ([IO.Path]::GetFileNameWithoutExtension($target))
  & $ncc build (Join-Path $projectRoot $entries[$target]) -o $output -m --no-cache
  if($LASTEXITCODE -ne 0){throw "Could not bundle $target"}
  Copy-Item -LiteralPath (Join-Path $output 'index.js') -Destination (Join-Path $stage $target)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\install.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\run-background.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\launch.vbs') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\setup-functions.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\THIRD_PARTY_NOTICES.txt') -Destination $stage
Write-Output 'Companion bundles staged.'

$downloadDirectory=Join-Path $projectRoot 'public\downloads'
New-Item -ItemType Directory -Force -Path $downloadDirectory|Out-Null
Write-Output 'Download directory ready.'
$installer=Join-Path $downloadDirectory 'DuoBoardHelperSetup.exe'
Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
Write-Output 'Previous installer cleared.'
$sed=Join-Path $buildRoot 'DuoBoardHelperSetup.sed'
$source=$stage.TrimEnd('\')+'\'
$definition=@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$installer
FriendlyName=Duo Board Helper
AppLaunched=wscript.exe launch.vbs
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0=background.cjs
FILE1=helper.cjs
FILE2=pair.cjs
FILE3=install.ps1
FILE4=run-background.ps1
FILE5=launch.vbs
FILE6=setup-functions.ps1
FILE7=THIRD_PARTY_NOTICES.txt
[SourceFiles]
SourceFiles0=$source
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
%FILE4%=
%FILE5%=
%FILE6%=
%FILE7%=
"@
[IO.File]::WriteAllText($sed,$definition,(New-Object Text.UTF8Encoding($false)))
Write-Output 'Windows package definition ready.'
& (Join-Path $env:SystemRoot 'System32\iexpress.exe') /N /Q $sed
Write-Output 'Windows packager finished.'
$packageDeadline=[DateTime]::UtcNow.AddSeconds(30)
$stubLength=(Get-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\wextract.exe')).Length
while(((-not (Test-Path -LiteralPath $installer)) -or (Get-Item -LiteralPath $installer -ErrorAction SilentlyContinue).Length -le $stubLength) -and [DateTime]::UtcNow -lt $packageDeadline){
  Start-Sleep -Milliseconds 100
}
if(-not (Test-Path -LiteralPath $installer) -or (Get-Item -LiteralPath $installer).Length -le $stubLength){throw 'IExpress could not create the Windows installer'}
$stream=[IO.File]::OpenRead($installer)
try {$hash=[BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
finally {$stream.Dispose()}
$manifest=@{version='0.3.0';file='DuoBoardHelperSetup.exe';sha256=$hash;size=(Get-Item -LiteralPath $installer).Length;built_at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $downloadDirectory 'DuoBoardHelperSetup.json'),$manifest,(New-Object Text.UTF8Encoding($false)))
Write-Output $manifest
