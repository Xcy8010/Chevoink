# Windows only: execute the actual ACL statements against nonsecret fixtures.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows ACL verification requires Windows.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workflow = Get-Content (Join-Path $root '.github/workflows/cloud-deploy.yml') -Raw
$androidHelper = Join-Path $root '../chevoink-android/scripts/cloud-build-android.ps1'
if (!(Test-Path -LiteralPath $androidHelper)) { throw 'Supply the sibling Android checkout to verify both credential paths.' }
$sources = @($workflow, (Get-Content -LiteralPath $androidHelper -Raw))
$statements = @($sources | ForEach-Object { [regex]::Matches($_, '(?m)^\s*(& icacls\.exe[^\r\n]+)') } | ForEach-Object { $_.Groups[1].Value })
if ($statements.Count -ne 3 -or @($statements | Where-Object { $_ -notmatch '\(R,D\)' }).Count) { throw 'Unexpected credential ACL statement.' }
$directory = Join-Path ([IO.Path]::GetTempPath()) ('chevoink-acl-fixture-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$keyPath = Join-Path $directory 'web-key-fixture'
$credentialSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$keystore = Join-Path $directory 'android-key-fixture'
$properties = Join-Path $directory 'android-properties-fixture'
try {
    foreach ($file in @($keyPath, $keystore, $properties)) { [IO.File]::WriteAllText($file, 'public nonsecret ACL fixture') }
    foreach ($statement in $statements) {
        . ([scriptblock]::Create($statement))
        if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL application failed.' }
    }
    foreach ($file in @($keyPath, $keystore, $properties)) {
        if ([IO.File]::ReadAllText($file) -ne 'public nonsecret ACL fixture') { throw 'Fixture read failed.' }
        $acl = Get-Acl -LiteralPath $file
        if (!$acl.AreAccessRulesProtected -or @($acl.Access | Where-Object IsInherited).Count) { throw 'Credential ACL inheritance is enabled.' }
        if (@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) }).Count -ne 1) { throw 'Expected one explicit delete grant.' }
        [IO.File]::Delete($file)
        if (Test-Path -LiteralPath $file) { throw 'Fixture cleanup failed.' }
    }
    Write-Output 'Passed actual Windows credential ACL create/read/delete checks for all three protected temporary files.'
} finally {
    foreach ($file in @($keyPath, $keystore, $properties)) { if (Test-Path -LiteralPath $file) { [IO.File]::Delete($file) } }
    Remove-Item -LiteralPath $directory
}
