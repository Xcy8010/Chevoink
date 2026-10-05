param(
  [string]$HostName = "124.223.188.123",
  [string]$UserName = "ubuntu",
  [string]$KeyPath = "$HOME\.ssh\chevoink_prod_sh_01.pem",
  [string]$PublicUrl = "https://chevoink.chevolink.com",
  [Parameter(Mandatory = $true)][string]$ExpectedCurrentRevision,
  [string]$CiRunId,
  [string]$SourceAddress,
  [switch]$SkipLocalChecks
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  $result = & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE). Inspect actual state before retrying." }
  return $result
}

if ($HostName -ne '124.223.188.123' -or $UserName -ne 'ubuntu' -or $PublicUrl -ne 'https://chevoink.chevolink.com') {
  throw 'This entrypoint is scoped to the configured Chevoink production target.'
}
if ($ExpectedCurrentRevision -notmatch '^[a-f0-9]{40}$') { throw 'An exact expected current SHA is required.' }
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw 'SSH key is missing.' }
if ($SourceAddress -and $SourceAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Invalid SSH source address.' }
Push-Location $ProjectRoot
try {
  $revision = (Invoke-Checked git @('rev-parse', '--verify', 'HEAD')).Trim()
  if ($revision -notmatch '^[a-f0-9]{40}$') { throw 'Cannot resolve candidate SHA.' }
  Invoke-Checked git @('diff', '--quiet', 'HEAD', '--') | Out-Null
  if (-not $CiRunId) {
    $runs = (Invoke-Checked gh @('run', 'list', '--workflow', 'CI', '--commit', $revision, '--json', 'databaseId,status,conclusion', '--limit', '20')) -join "`n" | ConvertFrom-Json
    $selected = @($runs | Where-Object { $_.status -eq 'completed' -and $_.conclusion -eq 'success' }) | Select-Object -First 1
    if (-not $selected) { throw 'No completed successful CI for this exact SHA.' }
    $CiRunId = [string]$selected.databaseId
  }
  if ($CiRunId -notmatch '^\d+$') { throw 'Invalid CI run ID.' }
  $ci = (Invoke-Checked gh @('run', 'view', $CiRunId, '--json', 'headSha,status,conclusion,workflowName,jobs')) -join "`n" | ConvertFrom-Json
  $ciEvidencePath = Join-Path ([System.IO.Path]::GetTempPath()) ("chevoink-ci-" + [guid]::NewGuid().ToString('N') + '.json')
  $ci | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ciEvidencePath -Encoding utf8
  Invoke-Checked node @('scripts/release-ci.mjs', $revision, $ciEvidencePath)
  Write-Host "CI $CiRunId passed for $revision. Reusing those gates; no duplicate local full run."
  $packageDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("chevoink-release-" + [guid]::NewGuid().ToString('N'))
  $package = (Invoke-Checked node @('scripts/release-package.mjs', '--revision', $revision, '--baseline', $ExpectedCurrentRevision, '--out', $packageDirectory)) -join "`n" | ConvertFrom-Json
  $remoteArchive = "/tmp/chevoink-$revision.tar.gz"
  $remoteManifest = "/tmp/chevoink-$revision-baseline.json"
  $sshArguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-i', $KeyPath)
  if ($SourceAddress) { $sshArguments += @('-b', $SourceAddress) }
  # Single upload/activation attempt. Interrupted mutations have an on-host
  # journal; inspect actual state instead of replaying the whole deployment.
  $scpArguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-i', $KeyPath)
  if ($SourceAddress) { $scpArguments += @('-o', "BindAddress=$SourceAddress") }
  $preflight = "set -eu; test -d /opt/chevoink/app/current; test ! -L /opt/chevoink/app/current; test ! -e '/opt/chevoink/app/release-$revision'; test ! -e '/opt/chevoink/app/.release-$revision.jsonl'; test ! -e '/opt/chevoink/app/previous-$ExpectedCurrentRevision-for-$revision'; test ! -e '$remoteArchive'; test ! -e '$remoteManifest'"
  Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", $preflight)) | Out-Null
  Invoke-Checked scp.exe ($scpArguments + @($package.archive, "${UserName}@${HostName}:$remoteArchive")) | Out-Null
  Invoke-Checked scp.exe ($scpArguments + @($package.baselineManifest, "${UserName}@${HostName}:$remoteManifest")) | Out-Null
  $remote = "set -eu; test `"`$(sha256sum '$remoteArchive' | cut -d' ' -f1)`" = '$($package.archiveSha256)'; mkdir -m 700 '/opt/chevoink/app/release-$revision'; tar -xzf '$remoteArchive' -C '/opt/chevoink/app/release-$revision'; cd '/opt/chevoink/app/release-$revision'; tr -d '\r' < deploy/deploy-production.sh | bash -s -- '$revision' '$($package.archiveSha256)' '$ExpectedCurrentRevision' '$remoteArchive' '$remoteManifest'"
  Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", $remote))
  $health = (Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', "$PublicUrl/api/health")) -join "`n" | ConvertFrom-Json
  if (-not $health.success -or $health.data.appEnv -ne 'production') { throw 'Public production health check failed.' }
  Invoke-Checked curl.exe @('--fail', '--silent', '--show-error', '--max-time', '20', '--output', (Join-Path $packageDirectory 'public-index.html'), $PublicUrl) | Out-Null
  $publicIndexHash = (Get-FileHash -LiteralPath (Join-Path $packageDirectory 'public-index.html') -Algorithm SHA256).Hash.ToLowerInvariant()
  $remoteIndexHash = ((Invoke-Checked ssh.exe ($sshArguments + @("${UserName}@${HostName}", 'sha256sum /var/www/chevoink/current/index.html'))) -split '\s+')[0]
  if ($publicIndexHash -ne $remoteIndexHash) { throw 'Public index differs from the deployed entry page.' }
  Write-Host "Deployment verified: $revision; package/evidence retained at $packageDirectory"
}
finally { Pop-Location }
