@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   照章成事游戏工坊 - 一键启动
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有检测到 Node.js。
  echo 请先打开浏览器访问 https://nodejs.org 下载安装 "LTS" 版本
  echo （建议 22.x 或更高版本，本项目需要 Node.js 22.5 以上）。
  echo 安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 第一次运行，正在自动安装依赖，请稍候...
  echo（只需要这一次，视网速大概几十秒到一两分钟）
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请检查网络连接后重试。
    pause
    exit /b 1
  )
  echo.
  echo 依赖安装完成！
  echo.
)

echo 正在启动后端服务...
start "照章成事游戏工坊 - 后端服务（请勿关闭）" cmd /k "cd /d ""%~dp0"" && chcp 65001>nul && node server.js"

timeout /t 3 /nobreak >nul

echo 正在打开浏览器...
start "" "http://localhost:3001"

echo.
echo ============================================
echo 启动完成！游戏页面应该已经在浏览器里打开了。
echo （如果没有自动打开，手动访问 http://localhost:3001 即可）
echo.
echo 注意：刚才弹出的那个黑色命令行窗口是后端服务，
echo 必须保持开着，关掉它游戏就没法用了。
echo.
echo 如果想和朋友联网对战，两人必须打开【同一个】后端地址，
echo 具体几种做法请看 README.md 里的"怎么和朋友联机对战"部分。
echo ============================================
echo.
pause
