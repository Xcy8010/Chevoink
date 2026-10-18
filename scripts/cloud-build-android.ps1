# GitHub-hosted Windows only. Reuses the maintained release builder and original signer.
[CmdletBinding()]
param([switch]$VerifyAdmissionOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Invoke-CloudRead([string]$Endpoint) {
    $json = & gh api $Endpoint --method GET -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28'
    if ($LASTEXITCODE -ne 0) { throw 'Required GitHub approval evidence is unavailable.' }
    return ($json -join "`n" | ConvertFrom-Json)
}
function Assert-CloudApproval($Environment, $History) {
    $rules = @($Environment.protection_rules | Where-Object type -eq 'required_reviewers')
    if ($Environment.name -ne 'android-signing' -or !$Environment.id -or $rules.Count -ne 1 -or @($rules[0].reviewers).Count -lt 1) {
        throw 'android-signing must have required reviewers.'
    }
    $relevant = @($History | Where-Object { @($_.environments | Where-Object { $_.id -eq $Environment.id -and $_.name -eq 'android-signing' }).Count -gt 0 })
    if (@($relevant | Where-Object state -eq 'rejected').Count -gt 0 -or
        @($relevant | Where-Object { $_.state -eq 'approved' -and $_.user.type -eq 'User' -and $_.user.login }).Count -lt 1) {
        throw 'Actual human android-signing approval for this run is required.'
    }
}
function Assert-BaselineApkUrl([string]$Url) {
    $publishedBaseline = 'https://chevoink.chevolink.com/download/chevoink-v1.0.5.1.apk'
    $officialRelease = '\Ahttps://github\.com/Xcy8010/[Cc]hevoink/releases/download/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.apk\z'
    if ($Url -ceq $publishedBaseline) { return }
    if ($Url -cmatch $officialRelease -and $Url -cnotmatch '/\.{1,2}(?:/|\z)') { return }
    throw 'Set the baseline APK URL to the exact published v1.0.5.1 download or an official repository release asset.'
}
Push-Location $projectRoot
try {
    if ($env:GITHUB_REPOSITORY -ne 'Xcy8010/Chevoink' -or $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch' -or
        $env:GITHUB_REF -notin @('refs/heads/main', 'refs/heads/android-shell') -or $env:GITHUB_RUN_ATTEMPT -ne '1' -or
        $env:ANDROID_SOURCE_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -notmatch '^[1-9]\d*$') {
        throw 'A first-attempt main/android-shell dispatch with an exact Android source SHA is required.'
    }
    $head = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head -cne $env:ANDROID_SOURCE_SHA) { throw 'Android source identity differs.' }
    & git merge-base --is-ancestor $env:ANDROID_SOURCE_SHA refs/remotes/origin/android-shell
    if ($LASTEXITCODE -ne 0) { throw 'Candidate is not on the fetched android-shell branch.' }
    $base = 'repos/Xcy8010/Chevoink'
    $environment = Invoke-CloudRead "$base/environments/android-signing"
    $history = @(Invoke-CloudRead "$base/actions/runs/$($env:GITHUB_RUN_ID)/approvals")
    Assert-CloudApproval $environment $history
    if ($VerifyAdmissionOnly) { Write-Output 'Exact Android source and actual protected-environment approval verified.'; return }

    # All inputs arrive from the approved environment, never command arguments.
    foreach ($name in @('ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')) {
        if (![Environment]::GetEnvironmentVariable($name)) { throw 'Original signing inputs are missing.' }
    }
    Assert-BaselineApkUrl $env:ANDROID_BASELINE_APK_URL
    $keystore = Join-Path $env:RUNNER_TEMP 'chevoink-original-release.keystore'
    $properties = Join-Path $projectRoot 'android/keystore.properties'
    $baseline = Join-Path $projectRoot 'artifacts/android/previous-chevoink-v1.0.5.1.apk'
    $output = Join-Path $projectRoot 'cloud-output'
    foreach ($file in @($keystore, $properties, $baseline, $output)) {
        if (Test-Path -LiteralPath $file) { throw 'Cloud signing output already exists; inspect state instead of overwriting.' }
    }
    function Escape-Property([string]$Value) {
        # Java Properties.load(InputStream) uses ISO-8859-1; escape every unsafe byte/code unit.
        return -join @($Value.ToCharArray() | ForEach-Object {
            if ([int]$_ -ge 33 -and [int]$_ -le 126 -and $_ -notin @('\', '=', ':', '#', '!')) { [string]$_ }
            else { '\u' + ([int]$_).ToString('x4') }
        })
    }
    try {
        $credentialSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        [IO.File]::WriteAllBytes($keystore, [Convert]::FromBase64String($env:ANDROID_KEYSTORE_BASE64))
        & icacls.exe $keystore /inheritance:r /grant:r "*${credentialSid}:(R,D)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict original keystore ACL.' }
        $lines = @(
            ('storeFile=' + (Escape-Property $keystore))
            ('storePassword=' + (Escape-Property $env:ANDROID_STORE_PASSWORD))
            ('keyAlias=' + (Escape-Property $env:ANDROID_KEY_ALIAS))
            ('keyPassword=' + (Escape-Property $env:ANDROID_KEY_PASSWORD))
        )
        [IO.File]::WriteAllLines($properties, $lines, [Text.Encoding]::ASCII)
        & icacls.exe $properties /inheritance:r /grant:r "*${credentialSid}:(R,D)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict private signing properties ACL.' }
        New-Item -ItemType Directory -Path (Split-Path $baseline) -Force | Out-Null
        Invoke-WebRequest -Uri $env:ANDROID_BASELINE_APK_URL -OutFile $baseline -TimeoutSec 240
        if ((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant() -ne '9b2f2f8505c330dca2ea1801bed359843b75ba60895e03ab9c95d1926bbfc1fc') {
            throw 'Original published APK hash mismatch.'
        }
        & (Join-Path $PSScriptRoot 'build-android-release.ps1') -AllowDependencyNetwork
        New-Item -ItemType Directory -Path $output | Out-Null
        $packages = @(Get-ChildItem -LiteralPath (Split-Path $baseline) -Filter 'chevoink-v*.apk' -File)
        if ($packages.Count -ne 1) { throw 'Expected exactly one verified candidate APK.' }
        Copy-Item -LiteralPath $packages[0].FullName -Destination $output
        @{ sourceSha = $head; apk = $packages[0].Name; sha256 = (Get-FileHash -LiteralPath $packages[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            signerSha256 = '558a98608deab1e68ee26c9188821766516b4aee59186a9beb371212787fb21d'; published = $false
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build-receipt.json') -Encoding utf8
    } finally {
        foreach ($file in @($properties, $keystore)) {
            if (Test-Path -LiteralPath $file) { [IO.File]::Delete($file) }
        }
    }
} finally { Pop-Location }
