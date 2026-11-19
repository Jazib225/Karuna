# Karuna in live mode: see every change as soon as it's saved, without rebuilding the app.
#   powershell -ExecutionPolicy Bypass -File live-karuna.ps1
#
#   console (web/)          reloads in the window the moment a file is saved (Vite, on :4173)
#   island (desktop/src)    reloads the same way (Vite, on :1420)
#   gatekeeper/             restarts itself on save (tsx watch); logs in logs\gatekeeper.log
#   desktop/src-tauri (Rust) rebuilds and reopens the app on save (debug build, seconds)
#
# The console stays on 127.0.0.1:4173, the address the installed app uses, so the signing key this
# computer saved for it keeps working. The first run compiles the app once (a few minutes).
# Press Ctrl+C here to stop; start-karuna.ps1 goes back to the installed app.

$root = $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

function Get-ListenerTree($port) {
    $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
    if (-not $owner) { return @() }
    $ids = @($owner)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
    while ($p -and $p.ParentProcessId) {
        $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
        if (-not $pp -or $pp.Name -notmatch '^(node|cmd)\.exe$') { break }
        $ids += $pp.ProcessId
        $p = $pp
    }
    return $ids
}

function Stop-Port($port) {
    foreach ($id in (Get-ListenerTree $port)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 15 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
}

Write-Host "karuna live: closing the installed app and the built console"
Stop-Process -Name karuna-desktop -Force -ErrorAction SilentlyContinue
Stop-Port 4173

# The Gatekeeper, restarting itself whenever its code or .env changes.
$gkCmd = (Get-ListenerTree 8788 | ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$_").CommandLine }) -join " "
if ($gkCmd -notmatch "watch") {
    Write-Host "karuna live: restarting the Gatekeeper in watch mode"
    Stop-Port 8788
    Start-Process -WindowStyle Hidden -WorkingDirectory $root -FilePath "cmd.exe" `
        -ArgumentList "/c pnpm --dir gatekeeper dev > `"$(Join-Path $logs 'gatekeeper.log')`" 2>&1"
}

# The relay (live chain events), if it isn't running already.
if (-not (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -WindowStyle Hidden -WorkingDirectory $root -FilePath "cmd.exe" `
        -ArgumentList "/c pnpm --dir relay start > `"$(Join-Path $logs 'relay.log')`" 2>&1"
}

# The desktop app in dev mode: the console's and island's dev servers, then the app itself.
$env:KARUNA_WEB_PORT = "4173"
$env:VITE_KARUNA_CONSOLE_URL = "http://127.0.0.1:4173"
Write-Host "karuna live: starting the app (the first start compiles it once; after that, saves show up live)"
Set-Location (Join-Path $root "desktop")
npm run tauri dev
