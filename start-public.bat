@echo off
setlocal

cd /d "%~dp0"

echo Starting Logic Arcade public link...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo Local game server is not running. Starting it in a new window...
  start "Logic Arcade Backend" cmd /k "cd /d ""%~dp0"" && chcp 65001>nul && npm start"
  timeout /t 4 /nobreak >nul
) else (
  echo Local game server is already running on port 3001.
)

set "CLOUDFLARED=cloudflared"
where cloudflared >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if exist "C:\Program Files\cloudflared\cloudflared.exe" set "CLOUDFLARED=C:\Program Files\cloudflared\cloudflared.exe"
)

if not exist "%CLOUDFLARED%" (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo cloudflared was not found. Install it with:
    echo winget install --id Cloudflare.cloudflared -e
    pause
    exit /b 1
  )
)

echo.
echo Keep this window open.
echo Share the trycloudflare.com URL shown below with other people.
echo.
"%CLOUDFLARED%" tunnel --url http://localhost:3001

pause
