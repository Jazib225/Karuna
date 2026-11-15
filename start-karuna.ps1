# Starts Karuna in the background: Gatekeeper, relay and the built console (hidden windows,
# logs in .\logs), then the Karuna desktop app. Services already running are left alone.
#   powershell -ExecutionPolicy Bypass -File start-karuna.ps1

$root = $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# Agents are accepted only from inside a Karuna sandbox (the Gatekeeper's default), so Docker
# Desktop must be running to run agents: `pnpm karuna run --agent <id> <folder> -- <command>`.

function Test-Port($port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-KarunaService($name, $port, $pnpmArgs) {
    if (Test-Port $port) { return }
    $log = Join-Path $logs "$name.log"
    Start-Process -WindowStyle Hidden -WorkingDirectory $root -FilePath "cmd.exe" `
        -ArgumentList "/c pnpm $pnpmArgs > `"$log`" 2>&1"
}

Start-KarunaService "gatekeeper" 8788 "--dir gatekeeper start"
Start-KarunaService "relay"      8790 "--dir relay start"
if (-not (Test-Path (Join-Path $root "web\dist\index.html"))) {
    & cmd.exe /c "pnpm --dir web build > `"$(Join-Path $logs 'web-build.log')`" 2>&1"
}
Start-KarunaService "console"    4173 "--dir web preview"

if (-not (Get-Process karuna-desktop -ErrorAction SilentlyContinue)) {
    Start-Process (Join-Path $env:LOCALAPPDATA "Karuna\karuna-desktop.exe")
}
