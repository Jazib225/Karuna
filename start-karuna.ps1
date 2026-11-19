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

# Public address (chat apps and invite links): a Cloudflare quick tunnel to the public port 8792.
# A quick tunnel gets a new https address every time it starts, so KARUNA_CHAT_URL in .env is
# rewritten to match and a running Gatekeeper is restarted to pick it up. Set KARUNA_NO_TUNNEL=1
# to skip this (for example with a named tunnel whose address never changes).
function Start-KarunaTunnel {
    if ($env:KARUNA_NO_TUNNEL) { return $false }
    $exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
    if (-not $exe) { $exe = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1 }
    if (-not $exe) { Write-Host "karuna: cloudflared isn't installed, so chat apps and invite links can't reach this Karuna"; return $false }
    $tunnelLog = Join-Path $logs "tunnel.log"
    if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
        Remove-Item $tunnelLog -ErrorAction SilentlyContinue
        Start-Process -WindowStyle Hidden -FilePath $exe -ArgumentList "tunnel --url http://127.0.0.1:8792 --no-autoupdate --logfile `"$tunnelLog`""
    }
    $url = $null
    for ($i = 0; $i -lt 30 -and -not $url; $i++) {
        if (Test-Path $tunnelLog) {
            $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
            if ($m) { $url = $m.Matches[-1].Value }
        }
        if (-not $url) { Start-Sleep 1 }
    }
    if (-not $url) { Write-Host "karuna: the tunnel didn't report an address (see logs\tunnel.log)"; return $false }
    # .env is UTF-8 (Windows PowerShell would read it as ANSI and mangle "—" and "→"); written back
    # without a BOM, which dotenv would read as part of line 1. Only the KARUNA_CHAT_URL line changes.
    $envFile = Join-Path $root ".env"
    $utf8 = New-Object Text.UTF8Encoding $false
    $lines = [Collections.Generic.List[string]]::new()
    if (Test-Path $envFile) { $lines.AddRange([IO.File]::ReadAllLines($envFile, $utf8)) }
    $at = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^KARUNA_CHAT_URL=') { $at = $i; break } }
    if ($at -ge 0 -and $lines[$at].Substring(16).Trim() -eq $url) { return $false }
    if ($at -ge 0) { $lines[$at] = "KARUNA_CHAT_URL=$url" } else { $lines.Add("KARUNA_CHAT_URL=$url") }
    [IO.File]::WriteAllText($envFile, (($lines.ToArray()) -join "`n") + "`n", $utf8)
    Write-Host "karuna: public address is now $url"
    return $true
}

if ((Start-KarunaTunnel) -and (Test-Port 8788)) {
    # The address changed: restart the Gatekeeper so invite links and chat apps use the new one.
    $gkPid = (Get-NetTCPConnection -LocalPort 8788 -State Listen).OwningProcess | Select-Object -First 1
    Stop-Process -Id $gkPid -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 15 -and (Test-Port 8788); $i++) { Start-Sleep 1 }
}
Start-KarunaService "gatekeeper" 8788 "--dir gatekeeper start"
Start-KarunaService "relay"      8790 "--dir relay start"
if (-not (Test-Path (Join-Path $root "web\dist\index.html"))) {
    & cmd.exe /c "pnpm --dir web build > `"$(Join-Path $logs 'web-build.log')`" 2>&1"
}
Start-KarunaService "console"    4173 "--dir web preview"

# The desktop app: the installed copy if there is one, else the one built in this checkout.
if (-not (Get-Process karuna-desktop -ErrorAction SilentlyContinue)) {
    $desktop = @(
        (Join-Path $env:LOCALAPPDATA "Karuna\karuna-desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Karuna\karuna-desktop.exe"),
        (Join-Path $root "desktop\src-tauri\target\release\karuna-desktop.exe")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($desktop) { Start-Process $desktop }
    else { Write-Host "karuna: the desktop app isn't installed or built (pnpm --dir desktop tauri build); the console is at http://127.0.0.1:4173" }
}
