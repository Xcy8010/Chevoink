param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$ExpectedSignerThumbprint
)

# Read-only preflight, not a signing tool or complete release approval.
# Obtain the expected hash and publisher identity from trusted build/signing evidence,
# not from an untrusted download next to the installer being checked.
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Installer -ErrorAction Stop
if ($item.PSIsContainer) { throw 'Expected an installer file.' }
$names = @("Chevoink_${Version}_x64-setup.exe", "Chevoink_${Version}_x64-webview2-offline-setup.exe")
if ($item.Name -cnotin $names) { throw 'Installer name/version does not match the release.' }
$digest = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
if ($digest -ine $ExpectedSha256) { throw 'Installer SHA256 mismatch. Do not publish or execute.' }
$fileVersion = $item.VersionInfo.ProductVersion
if ($fileVersion -notin @($Version, "$Version.0")) { throw 'Embedded product version does not match the release.' }
$signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
if ($signature.Status -ne 'Valid') { throw "Authenticode is not valid ($($signature.Status)). Stable release blocked." }
if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ine $ExpectedSignerThumbprint) {
    throw 'Authenticode publisher does not match the approved signing identity.'
}
if (-not $signature.TimeStamperCertificate) { throw 'Trusted signing timestamp is missing.' }
[pscustomobject]@{
    File = $item.Name
    Version = $fileVersion
    Bytes = $item.Length
    Sha256 = $digest.ToLowerInvariant()
    SignerThumbprint = $signature.SignerCertificate.Thumbprint
    Authenticode = 'Valid'
    Scope = 'Installer preflight only; updater signature, embedded app signature, CI and acceptance gates remain required.'
}
