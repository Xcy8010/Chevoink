# Runs only on the disposable Windows CI runner; never uses a real user's profile.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Startup smoke is restricted to the disposable CI runner.' }
$version = (Get-Content (Join-Path $PSScriptRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $PSScriptRoot "src-tauri/target/release/bundle/nsis/Chevoink_${version}_x64-setup.exe"
$installDir = Join-Path $env:RUNNER_TEMP 'Chevoink-install-smoke'
$install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -WindowStyle Hidden -PassThru -Wait
if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
$binary = Join-Path $installDir 'chevoink-desktop.exe'
if (!(Test-Path -LiteralPath $binary)) { throw 'Installer did not use the requested independent directory.' }
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Chevoink.lnk'
if (!(Test-Path -LiteralPath $desktopLink)) { throw 'Installer did not create the desktop shortcut.' }
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($desktopLink)
if ($shortcut.TargetPath -ne $binary) { throw 'Desktop shortcut points outside the installed application.' }
$icon = Join-Path $installDir 'chevoink-logo-212aa389.ico'
if ($shortcut.IconLocation -ne "$icon,0") { throw 'Incorrect installed icon reference.' }
if ((Get-FileHash -LiteralPath $icon).Hash -ne (Get-FileHash (Join-Path $PSScriptRoot 'src-tauri/icons/icon.ico')).Hash) {
    throw 'Installed desktop logo differs from the approved source.'
}
Write-Output 'Installer directory, shortcut and logo verified before first application launch.'
$logs = Join-Path $PSScriptRoot 'test-results'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$stderr = Join-Path $logs 'startup-stderr.txt'
$previousBrowserArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
# CDP is enabled only in this disposable runner process, never in shipped config.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=19222 --remote-debugging-address=127.0.0.1'
$child = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru -RedirectStandardError $stderr
try {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $child.Refresh()
        if ($child.HasExited) { throw "Desktop exited before startup completed: $($child.ExitCode)" }
        $errorText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue
        if ($errorText -match 'startup failed|panicked|PluginInitialization') { throw "Desktop startup failed: $errorText" }
    } while ((Get-Date) -lt $deadline)
    if ($child.MainWindowHandle -eq 0) { throw 'Desktop remained alive but did not create a main window.' }
    Write-Output 'Packaged desktop stayed alive for 30 seconds and created a native window.'
    & node (Join-Path $PSScriptRoot 'test-webview.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Real WebView2 regression failed.' }
    # A second unattended installation must leave the active writer in control.
    $retry = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -WindowStyle Hidden -PassThru -Wait
    if ($retry.ExitCode -eq 0 -or $child.HasExited) { throw 'Setup did not protect the running desktop session.' }
    if (!$child.CloseMainWindow()) { throw 'Unable to request native close.' }
    if (!$child.WaitForExit(15000)) { throw 'Packaged fallback did not close normally.' }
    Write-Output 'Packaged fallback closed normally without a discard/download prompt.'
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousBrowserArgs
    # This PID belongs to the process created above in an isolated runner.
    if (!$child.HasExited) { Stop-Process -Id $child.Id -Force }
}
