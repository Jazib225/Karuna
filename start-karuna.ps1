# Starts Karuna in the background: Gatekeeper, relay and the built console (hidden windows,
# logs in .\logs), then the Karuna desktop app. Services already running are left alone.
# Each start first pulls the latest main and rebuilds what changed (see Update-Karuna below).
#   powershell -ExecutionPolicy Bypass -File start-karuna.ps1

$root = $PSScriptRoot
# Run from the checkout, so pnpm reads this repo's package.json and not one in a parent folder.
Set-Location $root
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

# The process listening on a port, plus the pnpm/cmd parents that started it.
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

function Stop-Karuna {
    Stop-Process -Name karuna-desktop -Force -ErrorAction SilentlyContinue
    foreach ($port in 8788, 8790, 4173) {
        foreach ($id in (Get-ListenerTree $port)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        for ($i = 0; $i -lt 15 -and (Test-Port $port); $i++) { Start-Sleep 1 }
    }
}

# Updates: pull the latest main. When that brings new code, Karuna is stopped, new dependencies
# are installed, the console is rebuilt, and the desktop app is rebuilt if its code changed; the
# rest of this script then starts everything again. Skipped when this checkout has local edits
# (they're never overwritten). Set KARUNA_NO_UPDATE=1 to skip it.
function Update-Karuna {
    if ($env:KARUNA_NO_UPDATE -or -not (Get-Command git -ErrorAction SilentlyContinue)) { return }
    Push-Location $root
    try {
        if (git status --porcelain --untracked-files=no) {
            Write-Host "karuna: this checkout has local changes, so it wasn't updated"
            return
        }
        $before = git rev-parse HEAD
        git pull --ff-only --quiet
        if ($LASTEXITCODE -ne 0) { Write-Host "karuna: couldn't pull the latest main (see the git message above)"; return }
        $after = git rev-parse HEAD
        if ($before -eq $after) { return }
        $changed = @(git diff --name-only $before $after)
        Write-Host "karuna: updated to $(git log -1 --format='%h %s')"
        Stop-Karuna
        $env:CI = "true"   # lets pnpm replace node_modules without a prompt
        if ($changed -match '(^|/)package\.json$|^pnpm-lock\.yaml$') {
            Write-Host "karuna: installing new dependencies"
            & cmd.exe /c "pnpm install > `"$(Join-Path $logs 'install.log')`" 2>&1"
        }
        Remove-Item -Recurse -Force (Join-Path $root "web\dist") -ErrorAction SilentlyContinue
        if ($changed -match '^desktop/') {
            Write-Host "karuna: rebuilding the desktop app (logs\desktop-build.log)"
            & cmd.exe /c "pnpm --dir desktop tauri build --no-bundle > `"$(Join-Path $logs 'desktop-build.log')`" 2>&1"
            if ($LASTEXITCODE -ne 0) { Write-Host "karuna: the desktop app didn't build; the previous build starts instead" }
        }
    } finally { Pop-Location }
}

Update-Karuna

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
# The offline wake-phrase model (about 40 MB, not in git); the console build serves it.
if (-not (Test-Path (Join-Path $root "web\public\models\vosk-small-en.tar.gz"))) {
    & cmd.exe /c "pnpm --dir desktop wake:model > `"$(Join-Path $logs 'wake-model.log')`" 2>&1"
    Remove-Item -Recurse -Force (Join-Path $root "web\dist") -ErrorAction SilentlyContinue
}
if (-not (Test-Path (Join-Path $root "web\dist\index.html"))) {
    & cmd.exe /c "pnpm --dir web build > `"$(Join-Path $logs 'web-build.log')`" 2>&1"
}
Start-KarunaService "console"    4173 "--dir web preview"

# The desktop app: the newest of the installed copy and the one built in this checkout.
if (-not (Get-Process karuna-desktop -ErrorAction SilentlyContinue)) {
    $desktop = @(
        (Join-Path $env:LOCALAPPDATA "Karuna\karuna-desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Karuna\karuna-desktop.exe"),
        (Join-Path $root "desktop\src-tauri\target\release\karuna-desktop.exe")
    ) | Where-Object { Test-Path $_ } | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1
    if ($desktop) { Start-Process $desktop }
    else { Write-Host "karuna: the desktop app isn't installed or built (pnpm --dir desktop tauri build); the console is at http://127.0.0.1:4173" }
}
