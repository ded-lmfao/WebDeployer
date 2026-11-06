@echo off
title Nexus Deploy 2.0 (Rust Engine)
cd /d "%~dp0"

echo ===================================================
echo           Nexus Deploy 2.0 - Rust Engine
echo ===================================================
echo.

if not exist "target\release\nexus-deploy.exe" (
    echo [*] Release binary not found. Compiling first (this may take ~1 minute)...
    cargo build --release
    if errorlevel 1 (
        echo [!] Compilation failed. Please ensure Rust / cargo is installed.
        pause
        exit /b 1
    )
)

echo [*] Starting Nexus Deploy on http://127.0.0.1:4600 ...
echo [*] Default Login Credentials:
echo     - Username: admin
echo     - Password: admin123
echo.

start "" "http://127.0.0.1:4600"
"target\release\nexus-deploy.exe"

if errorlevel 1 (
    echo.
    echo [!] Server stopped unexpectedly.
    pause
)

