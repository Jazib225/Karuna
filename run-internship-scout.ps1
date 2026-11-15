# Runs the internship-scout agent once, inside a Karuna sandbox, and saves its list to internships.txt.
#   Right-click → Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File run-internship-scout.ps1 ["only remote roles"]
# Needs Docker Desktop and Karuna (start-karuna.ps1) running. Cybersecurity listings pop up on the island.

$root = $PSScriptRoot
Set-Location $root
$env:Path += ";C:\Program Files\Docker\Docker\resources\bin"
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null

# A fresh agent token each run, issued by the local Gatekeeper (same as "Rotate token" in the app).
$consoleToken = (Get-Content (Join-Path $root "gatekeeper\data\console.token") -Raw).Trim()
$token = (Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/agents/internship-scout/rotate-token" `
    -Headers @{ "x-karuna-console-token" = $consoleToken } -ContentType "application/json" -Body "{}").token
$env:KARUNA_AGENT_TOKEN = $token

$request = ($args -join " ").Trim()
$log = Join-Path $root "logs\internship-scout.log"
$cmd = "pnpm karuna run --agent internship-scout ./agents -- npx tsx examples/internship-scout.ts"
if ($request) { $cmd += " `"$($request -replace '"', '')`"" }
cmd /c "$cmd > `"$log`" 2>&1"

# Keep just the finished list (from the "=== Internships" line on), stamped with the date.
$lines = Get-Content $log -Encoding utf8
$start = ($lines | Select-String -SimpleMatch "=== Internships" | Select-Object -First 1).LineNumber
$out = Join-Path $root "internships.txt"
if ($start) {
    @("Run $(Get-Date -Format 'yyyy-MM-dd HH:mm')") + $lines[($start - 1)..($lines.Count - 1)] | Set-Content $out -Encoding utf8
    Write-Host "Saved the list to $out"
} else {
    Write-Host "The run didn't finish a list. See $log"
    $lines | Select-Object -Last 6 | ForEach-Object { Write-Host $_ }
}
