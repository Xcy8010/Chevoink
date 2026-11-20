param(
  [string]$HostName = "124.223.188.123",
  [string]$UserName = "ubuntu",
  [string]$KeyPath = "$HOME\.ssh\chevoink_prod_sh_01.pem",
  [string]$PublicUrl = "https://chevoink.chevolink.com",
  [Parameter(Mandatory = $true)][string]$ExpectedCurrentRevision,
  [string]$CiRunId,
  [string]$SourceAddress,
  [string]$ReceiptPath,
  [string]$OperationId,
  [string]$RequestId,
  [string]$RequestSha,
  [ValidateNotNullOrEmpty()][string]$AndroidPublicEntryBaseline,
  [switch]$SkipLocalChecks,
  [switch]$ApiOnly
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 decodes external program output with the console code page;
# gh emits UTF-8 (CJK job names) and ConvertFrom-Json breaks on the garbled bytes.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  $result = & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE). Inspect actual state before retrying." }
  return $result
}

$androidEntryOnly = $PSBoundParameters.ContainsKey('AndroidPublicEntryBaseline')
if ($androidEntryOnly -and [string]::IsNullOrWhiteSpace($AndroidPublicEntryBaseline)) { throw 'Historical launcher checkout path is required.' }
if ($HostName -ne '124.223.188.123' -or $UserName -ne 'ubuntu' -or $PublicUrl -ne 'https://chevoink.chevolink.com') {
  throw 'This entrypoint is scoped to the configured Chevoink production target.'
}
if ($ExpectedCurrentRevision -notmatch '^[a-f0-9]{40}$') { throw 'An exact expected current SHA is required.' }
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw 'SSH key is missing.' }
if ($SourceAddress -and $SourceAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Invalid SSH source address.' }
if (($ReceiptPath -and $OperationId -notmatch '^[1-9]\d*$') -or ($OperationId -and !$ReceiptPath)) { throw 'Receipt requires the exact operation ID and a new output path.' }
if ($ReceiptPath -and $RequestId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Receipt requires the originating request UUID.' }
if ($ReceiptPath -and $RequestSha -notmatch '^[a-f0-9]{40}$') { throw 'Receipt requires the originating request commit.' }
if ($ReceiptPath -and (Test-Path -LiteralPath $ReceiptPath)) { throw 'Receipt path already exists; do not reuse old evidence.' }
if ($androidEntryOnly -and ($ApiOnly -or $ReceiptPath)) { throw 'Choose a single publication mode.' }
Push-Location $ProjectRoot
try {
  $revision = (Invoke-Checked git @('rev-parse', '--verify', 'HEAD')).Trim()
  if ($revision -notmatch '^[a-f0-9]{40}$') { throw 'Cannot resolve candidate SHA.' }
  Invoke-Checked git @('diff', '--quiet', 'HEAD', '--') | Out-Null
  # Standard readonly REST endpoints avoid run view's legacy preview media types.
  # The same complete SHA/job gates still run before packaging or any SSH action.
  $ciArguments = @('scripts/release-ci-read.mjs', $revision)
  if ($CiRunId) { $ciArguments += $CiRunId }
  $ciRead = (Invoke-Checked node $ciArguments) -join "`n" | ConvertFrom-Json
  $CiRunId = [string]$ciRead.ciRunId
  $ci = $ciRead.ci
  $ciEvidencePath = Join-Path ([System.IO.Path]::GetTempPath()) ("chevoink-ci-" + [guid]::NewGuid().ToString('N') + '.json')
  $ci | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ciEvidencePath -Encoding utf8
  Invoke-Checked node @('scripts/release-ci.mjs', $revision, $ciEvidencePath)
  Write-Host "CI $CiRunId passed for $revision. Reusing those gates; no duplicate local full run."
  $packageDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("chevoink-release-" + [guid]::NewGuid().ToString('N'))
  $remoteArchive = "/tmp/chevoink-$revision.tar.gz"
  $remoteManifest = "/tmp/chevoink-$revision-baseline.json"
  # Keepalive options fail stalled sessions fast: blocked data paths otherwise
  # hang the single attempt forever and leave an ambiguous zombie connection.
  $sshArguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-i', $KeyPath)
  if ($SourceAddress) { $sshArguments += @('-b', $SourceAddress) }
  # Single upload/activation attempt. Interrupted mutations have an on-host
  # journal; inspect actual state instead of replaying the whole deployment.
  $scpArguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-i', $KeyPath)
  if ($SourceAddress) { $scpArguments += @('-o', "BindAddress=$SourceAddress") }
  if ($androidEntryOnly) {
    $liveIndex = "$packageDirectory.html"
    Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', '--output', $liveIndex, "$PublicUrl/") | Out-Null
    Invoke-Checked node @('scripts/prepare-android-public-entry.mjs', $AndroidPublicEntryBaseline, $packageDirectory, $liveIndex)
    $entry = Get-Content -Raw -LiteralPath (Join-Path $packageDirectory 'launcher.json') | ConvertFrom-Json
    if ($entry.revision -ne $revision) { throw 'Prepared launcher revision mismatch.' }
    $remoteBase = "/tmp/chevoink-android-launcher-$revision"
    $operator = Join-Path $ProjectRoot 'deploy/publish-android-public-entry.sh'
    $operatorHash = (Get-FileHash -LiteralPath $operator -Algorithm SHA256).Hash.ToLowerInvariant()
    Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", "test ! -e '$remoteBase.tar.gz' && test ! -e '$remoteBase.sh'")) | Out-Null
    Invoke-Checked scp.exe ($scpArguments + @((Join-Path $packageDirectory 'launcher.tar.gz'), "${UserName}@${HostName}:$remoteBase.tar.gz")) | Out-Null
    Invoke-Checked scp.exe ($scpArguments + @($operator, "${UserName}@${HostName}:$remoteBase.sh")) | Out-Null
    $activate = "set -eu; echo '$operatorHash  $remoteBase.sh' | sha256sum -c -; bash '$remoteBase.sh' '$revision' '$ExpectedCurrentRevision' '$($entry.archive)' '$($entry.oldIndex)' '$($entry.newIndex)'"
    Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", $activate))
    $observedIndex = Join-Path $packageDirectory 'observed.html'
    Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', '--output', $observedIndex, "$PublicUrl/") | Out-Null
    if ((Get-FileHash -LiteralPath $observedIndex -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.newIndex) { throw 'Public launcher readback mismatch.' }
    $observedModule = Join-Path $packageDirectory 'observed.js'
    Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', '--output', $observedModule, "$PublicUrl/$($entry.modulePath)") | Out-Null
    if ((Get-FileHash -LiteralPath $observedModule -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.moduleDigest) { throw 'Public launcher module readback mismatch.' }
    Write-Host "Verified Android public entry. Evidence: $packageDirectory"
    return
  }
  $package = (Invoke-Checked node @('scripts/release-package.mjs', '--revision', $revision, '--baseline', $ExpectedCurrentRevision, '--out', $packageDirectory)) -join "`n" | ConvertFrom-Json
  $preflight = "set -eu; test -d /opt/chevoink/app/current; test ! -L /opt/chevoink/app/current; test ! -e '/opt/chevoink/app/release-$revision'; test ! -e '/opt/chevoink/app/.release-$revision.jsonl'; test ! -e '/opt/chevoink/app/previous-$ExpectedCurrentRevision-for-$revision'; test ! -e '$remoteArchive'; test ! -e '$remoteManifest'"
  Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", $preflight)) | Out-Null
  Invoke-Checked scp.exe ($scpArguments + @($package.archive, "${UserName}@${HostName}:$remoteArchive")) | Out-Null
  Invoke-Checked scp.exe ($scpArguments + @($package.baselineManifest, "${UserName}@${HostName}:$remoteManifest")) | Out-Null
  $publication = if ($ApiOnly) { 'api-only' } else { 'full' }
  $priorPublicIndexHash = $null
  if ($ApiOnly) {
    $priorPublicIndexHash = ((Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", 'sha256sum /var/www/chevoink/current/index.html'))) -split '\s+')[0]
    if ($priorPublicIndexHash -notmatch '^[a-f0-9]{64}$') { throw 'Cannot verify the current public launcher.' }
  }
  $remote = "set -eu; test `"`$(sha256sum '$remoteArchive' | cut -d' ' -f1)`" = '$($package.archiveSha256)'; mkdir -m 700 '/opt/chevoink/app/release-$revision'; tar -xzf '$remoteArchive' -C '/opt/chevoink/app/release-$revision'; cd '/opt/chevoink/app/release-$revision'; tr -d '\r' < deploy/deploy-production.sh | bash -s -- '$revision' '$($package.archiveSha256)' '$ExpectedCurrentRevision' '$remoteArchive' '$remoteManifest' '$publication'"
  Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", $remote))
  $health = (Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', "$PublicUrl/api/health")) -join "`n" | ConvertFrom-Json
  if (-not $health.success -or $health.data.appEnv -ne 'production') { throw 'Public production health check failed.' }
  Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', '--output', (Join-Path $packageDirectory 'public-index.html'), $PublicUrl) | Out-Null
  $publicIndexHash = (Get-FileHash -LiteralPath (Join-Path $packageDirectory 'public-index.html') -Algorithm SHA256).Hash.ToLowerInvariant()
  $remoteIndexHash = ((Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", 'sha256sum /var/www/chevoink/current/index.html'))) -split '\s+')[0]
  if ($publicIndexHash -ne $remoteIndexHash) { throw 'Public index differs from the deployed entry page.' }
  if ($ApiOnly -and $publicIndexHash -ne $priorPublicIndexHash) { throw 'API-only deployment changed the public launcher.' }
  if ($ReceiptPath) {
    $receipt = @{ schemaVersion = 1; runId = $OperationId; requestId = $RequestId; requestSha = $RequestSha; revision = $revision; baseline = $ExpectedCurrentRevision;
      ciRunId = $CiRunId; archiveSha256 = $package.archiveSha256; publicIndexSha256 = $publicIndexHash; verifiedAt = [DateTime]::UtcNow.ToString('o') }
    $receiptJson = $receipt | ConvertTo-Json -Depth 8 -Compress
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($ReceiptPath), $receiptJson + "`n")
    Write-Host "CHEVOINK_DEPLOYMENT_RECEIPT $receiptJson"
  }
  Write-Host "Deployment verified: $revision; package/evidence retained at $packageDirectory"
}
finally { Pop-Location }
