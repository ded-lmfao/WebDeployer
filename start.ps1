# WebDep - Easy Start Script (PowerShell)
param(
    [switch]$Rebuild
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "     WebDep - VPS Manager & Hosting Platform" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$binaryPath = Join-Path $PSScriptRoot "target\release\webdep.exe"

$needsBuild = $Rebuild -or (-not (Test-Path $binaryPath))
if (-not $needsBuild -and (Test-Path $binaryPath)) {
    $binTime = (Get-Item $binaryPath).LastWriteTime
    $newerSrc = Get-ChildItem -Path (Join-Path $PSScriptRoot "src") -Recurse -File | Where-Object { $_.LastWriteTime -gt $binTime } | Select-Object -First 1
    if ($newerSrc) {
        Write-Host "[*] Source changes detected in src/$($newerSrc.Name), auto-recompiling..." -ForegroundColor Cyan
        $needsBuild = $true
    }
}

if ($needsBuild) {
    Write-Host "[*] Compiling optimized release binary..." -ForegroundColor Yellow
    Stop-Process -Name "webdep*" -Force -ErrorAction SilentlyContinue
    if (Test-Path $binaryPath) {
        $oldPath = "$binaryPath.old.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
        Move-Item $binaryPath $oldPath -Force -ErrorAction SilentlyContinue
    }
    Get-ChildItem -Path (Join-Path $PSScriptRoot "target\release") -Filter "*.old*" -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
    cargo build --release
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Build failed. Please verify Rust installation." -ForegroundColor Red
        Exit 1
    }
}

$port = if ($env:PORT) { $env:PORT } else { "4600" }
$url = "http://127.0.0.1:$port"

Stop-Process -Name "webdep*" -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 4600 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Write-Host "[*] Starting WebDep server on $url" -ForegroundColor Green
Write-Host "[*] SQLite Database: data\webdep.sqlite" -ForegroundColor Cyan
Write-Host "[*] Default Credentials:" -ForegroundColor Yellow
Write-Host "    - Username: admin" -ForegroundColor White
Write-Host "    - Password: admin123" -ForegroundColor White
Write-Host ""

# Auto-open browser after 500ms
Start-Job -ScriptBlock {
    param($u)
    Start-Sleep -Milliseconds 600
    Start-Process $u
} -ArgumentList $url | Out-Null

& $binaryPath
