param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'start-work.mjs'
$nodeArgs = @($entry)
if ($Offline) { $nodeArgs += '--offline' }
& node @nodeArgs
exit $LASTEXITCODE
