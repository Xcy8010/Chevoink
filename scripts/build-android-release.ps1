# Local-only signed release, preserving the previously published APK. No deployment/push.
[CmdletBinding()]
param([string]$GradleCommand = '', [switch]$AllowDependencyNetwork, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidRoot = Join-Path $projectRoot 'android'
$outputRoot = Join-Path $projectRoot 'artifacts/android'
$oldApk = Join-Path $androidRoot 'app/build/outputs/apk/release/app-release.apk'
$preservedOld = Join-Path $outputRoot 'previous-chevoink-v1.0.5.1.apk'
$oldHash = '9b2f2f8505c330dca2ea1801bed359843b75ba60895e03ab9c95d1926bbfc1fc'
$expectedCert = '558a98608deab1e68ee26c9188821766516b4aee59186a9beb371212787fb21d'
& node (Join-Path $PSScriptRoot 'stage-speech-licenses.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'License verification failed.' }
$sdkRoot = $env:ANDROID_HOME
if (!$sdkRoot) { throw 'ANDROID_HOME is required.' }
$buildTools = Join-Path $sdkRoot 'build-tools/36.0.0'
$signer = Join-Path $buildTools 'apksigner.bat'
$aapt = Join-Path $buildTools 'aapt.exe'
foreach ($required in @($signer, $aapt, (Join-Path $androidRoot 'keystore.properties'))) {
    if (!(Test-Path -LiteralPath $required)) { throw 'Required SDK tool or private signing configuration is missing.' }
}

function Check-Command { if ($LASTEXITCODE -ne 0) { throw "External command failed (exit $LASTEXITCODE)." } }
function Get-Certificate([string]$Path) {
    $verification = & $signer verify --verbose --print-certs $Path 2>&1
    Check-Command
    $matches = @($verification | Select-String '^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)$')
    if ($matches.Count -ne 1) { throw 'Expected exactly one verified APK signer.' }
    return $matches[0].Matches[0].Groups[1].Value.ToLowerInvariant()
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
if (!(Test-Path -LiteralPath $preservedOld)) {
    if (!(Test-Path -LiteralPath $oldApk) -or
        (Get-FileHash -LiteralPath $oldApk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oldHash) {
        throw 'Published baseline APK is absent or differs; do not overwrite release outputs.'
    }
    Copy-Item -LiteralPath $oldApk -Destination $preservedOld
}
if ((Get-FileHash -LiteralPath $preservedOld -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oldHash -or
    (Get-Certificate $preservedOld) -ne $expectedCert) { throw 'Old APK baseline verification failed.' }

if (!$GradleCommand) { $GradleCommand = Join-Path $androidRoot 'gradlew.bat' }
if (!(Test-Path -LiteralPath $GradleCommand)) { throw 'Gradle executable not found.' }
$arguments = @('-p', $androidRoot, '--console=plain')
if (!$AllowDependencyNetwork) { $arguments += '--offline' }
$arguments += @(':app:verifyReleaseSigning', ':app:verifyShellVersion', ':app:testDebugUnitTest', ':app:assembleRelease')
if (!$VerifyOnly) {
    & $GradleCommand @arguments
    Check-Command
}

$newApk = Join-Path $androidRoot 'app/build/outputs/apk/release/chevoink-v1.0.11.apk'
if ((Get-Certificate $newApk) -ne $expectedCert) { throw 'New APK certificate differs from the published baseline.' }
$badging = & $aapt dump badging $newApk
Check-Command
if (!($badging | Select-String "^package: name='com.chevoink.app' versionCode='14' versionName='1.0.11'")) {
    throw 'Packaged applicationId/version differs from release contract.'
}
& (Join-Path $buildTools 'zipalign.exe') -c -P 16 4 $newApk
Check-Command
$packageHash = (Get-FileHash -LiteralPath $newApk -Algorithm SHA256).Hash.ToLowerInvariant()
$finalApk = Join-Path $outputRoot "chevoink-v1.0.11-$($packageHash.Substring(0,12)).apk"
if (Test-Path -LiteralPath $finalApk) {
    if ((Get-FileHash -LiteralPath $finalApk).Hash -ne (Get-FileHash -LiteralPath $newApk).Hash) {
        throw 'A different handoff APK already exists; retained, not overwritten. Use the verified Gradle output.'
    }
} else { Copy-Item -LiteralPath $newApk -Destination $finalApk }
Write-Output 'Verified release: com.chevoink.app 1.0.11/code14; certificate matches v1.0.5.1.'
Write-Output "Certificate SHA256: $expectedCert"
Get-FileHash -LiteralPath $finalApk -Algorithm SHA256 | Format-List
