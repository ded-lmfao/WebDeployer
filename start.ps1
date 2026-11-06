# WebDep - Easy Start Script (PowerShell)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "     WebDep - Multi-Website Hosting Platform" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$binaryPath = Join-Path $PSScriptRoot "target\release\webdep.exe"

if (-not (Test-Path $binaryPath)) {
    Write-Host "[*] Compiling optimized release binary..." -ForegroundColor Yellow
    cargo build --release
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Build failed. Please verify Rust installation." -ForegroundColor Red
        Exit 1
    }
}

$port = if ($env:PORT) { $env:PORT } else { "4600" }
$url = "http://127.0.0.1:$port"

Stop-Process -Name "webdep*" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "nexus-deploy*" -Force -ErrorAction SilentlyContinue
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
