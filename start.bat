@echo off
title WebDep — Multi-Website Deployment Platform
cd /d "%~dp0"

echo ===================================================
echo      WebDep - Multi-Website Hosting Platform
echo ===================================================
echo.

if not exist "target\release\webdep.exe" (
    echo [*] Release binary not found. Compiling first...
    cargo build --release
    if errorlevel 1 (
        echo [!] Compilation failed. Please ensure Rust / cargo is installed.
        pause
        exit /b 1
    )
)

echo [*] Stopping any previous WebDep instance...
taskkill /F /IM webdep.exe >nul 2>&1
taskkill /F /IM webdep.exe.old >nul 2>&1
taskkill /F /IM nexus-deploy.exe >nul 2>&1
taskkill /F /IM nexus-deploy.exe.old >nul 2>&1

echo [*] Starting WebDep on http://127.0.0.1:4600 ...
echo [*] SQLite Database: data\webdep.sqlite
echo [*] Default Login Credentials:
echo     - Username: admin
echo     - Password: admin123
echo.

start "" "http://127.0.0.1:4600"
"target\release\webdep.exe"

if errorlevel 1 (
    echo.
    echo [!] Server stopped unexpectedly.
    pause
)
