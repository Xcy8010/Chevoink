# Pure admission/serialization checks; no SDK, network, secrets or signing commands.
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$path = Join-Path $PSScriptRoot 'cloud-build-android.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Assert-CloudApproval', 'Assert-BaselineApkUrl', 'Escape-Property')) {
    $function = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object Name -eq $name
    if (@($function).Count -ne 1) { throw "Missing unique function $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
$baselineUrl = 'https://chevoink.chevolink.com/download/chevoink-v1.0.5.1.apk'
foreach ($url in @($baselineUrl,
    'https://github.com/Xcy8010/Chevoink/releases/download/android-v1.0.5.1/chevoink-v1.0.5.1.apk',
    'https://github.com/Xcy8010/chevoink/releases/download/android-v1.0.5.1/chevoink.apk')) {
    Assert-BaselineApkUrl $url
}
$invalidUrls = @('',
    'http://chevoink.chevolink.com/download/chevoink-v1.0.5.1.apk',
    'https://chevoink.chevolink.com/download/chevoink.apk',
    'https://chevoink.chevolink.com/download/chevoink-v1.0.11.apk',
    'https://chevoink.chevolink.com/other/chevoink-v1.0.5.1.apk',
    'https://chevoink.chevolink.com/download/../download/chevoink-v1.0.5.1.apk',
    'https://chevoink.chevolink.com/download/%63hevoink-v1.0.5.1.apk',
    'https://chevoink.chevolink.com:443/download/chevoink-v1.0.5.1.apk',
    'https://chevoink.chevolink.com.evil.example/download/chevoink-v1.0.5.1.apk',
    'https://chevoink.chevolink.com@evil.example/download/chevoink-v1.0.5.1.apk',
    ($baselineUrl + '?token=x'), ($baselineUrl + '#fragment'), ($baselineUrl + '/'), ($baselineUrl + "`n"),
    'https://github.com/other/Chevoink/releases/download/tag/baseline.apk',
    'https://github.com/Xcy8010/Chevoink/releases/download/../baseline.apk',
    'https://github.com/Xcy8010/Chevoink/releases/download/tag/baseline.apk?redirect=evil',
    "https://github.com/Xcy8010/Chevoink/releases/download/tag/baseline.apk`n")
foreach ($url in $invalidUrls) {
    $rejected = $false
    try { Assert-BaselineApkUrl $url } catch { $rejected = $true }
    if (!$rejected) { throw 'Unsafe baseline URL was admitted.' }
}
$environment = [pscustomobject]@{ id = 7; name = 'android-signing'; protection_rules = @(@{ type = 'required_reviewers'; reviewers = @(@{ type = 'User' }) }) }
$approval = @(@{ state = 'approved'; user = @{ type = 'User'; login = 'owner' }; environments = @(@{ id = 7; name = 'android-signing' }) })
Assert-CloudApproval $environment $approval
$negativeCases = @(
    @{ environment = @{ id = 7; name = 'android-signing'; protection_rules = @() }; history = $approval },
    @{ environment = $environment; history = @() },
    @{ environment = $environment; history = @(@{ state = 'approved'; user = @{ type = 'User'; login = 'owner' }; environments = @(@{ id = 8; name = 'android-signing' }) }) },
    @{ environment = $environment; history = @(@{ state = 'rejected'; environments = @(@{ id = 7; name = 'android-signing' }) }) }
)
foreach ($case in $negativeCases) {
    $rejected = $false
    try { Assert-CloudApproval $case.environment $case.history } catch { $rejected = $true }
    if (!$rejected) { throw 'Unsafe approval was admitted.' }
}
if ((Escape-Property "a\b:= #!`n密码") -cne 'a\u005cb\u003a\u003d\u0020\u0023\u0021\u000a\u5bc6\u7801') { throw 'Java property escaping differs.' }
$assignment = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$lines' }, $true)
if (@($assignment).Count -ne 1) { throw 'Signing serialization assignment changed.' }
$keystore = 'C:\temporary\original.keystore'
$fixture = $assignment.Extent.Text.Replace('$env:ANDROID_STORE_PASSWORD', "'store'").Replace('$env:ANDROID_KEY_ALIAS', "'alias'").Replace('$env:ANDROID_KEY_PASSWORD', "'key'")
. ([scriptblock]::Create($fixture))
if ($lines.Count -ne 4 -or $lines[0] -cne 'storeFile=C\u003a\u005ctemporary\u005coriginal.keystore' -or $lines[3] -cne 'keyPassword=key') { throw 'Signing properties must have four separate Java property lines.' }
$workflow = Get-Content (Join-Path $PSScriptRoot '../.github/workflows/cloud-android.yml') -Raw
if ($workflow -notmatch 'build-android-release' -and (Get-Content $path -Raw) -notmatch 'build-android-release.ps1') { throw 'Maintained build entrypoint absent.' }
if ($workflow -match 'keytool|continue-on-error' -or (Get-Content $path -Raw) -match 'keytool') { throw 'Signing invariant differs.' }
Write-Output 'Passed Android cloud parser, baseline URL allowlist (3 accepted / 18 rejected), approval denial and Java property escaping checks (no network/signing/build executed).'
