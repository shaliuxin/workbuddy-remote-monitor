@echo off
title WorkBuddy Console
cd /d "%~dp0"

echo ========================================
echo   WorkBuddy Monitor Console
echo ========================================

REM 优先使用分发包自带的 Node 运行时，无需目标机器安装 Node
set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" (
    echo [OK] using built-in runtime\node.exe
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Node.js not found.
        echo         Please install Node.js, or use the full package
        echo         which contains the runtime\node.exe folder.
        pause
        exit /b 1
    )
    set "NODE=node"
    echo [OK] using system Node
)

if not exist "node_modules\ws" (
    echo [INFO] installing dependency ws ...
    call npm install ws --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed. Please use the full package
        echo         which already contains node_modules.
        pause
        exit /b 1
    )
)

echo.
echo [START] console running in this window (close window = stop console)
echo         monitor server keeps running after console closes
echo         browser will open http://127.0.0.1:48790 automatically
echo.

REM 先打开浏览器（页面每 2 秒自动重试，服务一起来就会显示数据）
start "" http://127.0.0.1:48790

REM 当前窗口直接运行控制台，不用 start / cmd /k 嵌套，避免引号被拆散
"%NODE%" wb-console-server.js

echo.
echo [EXIT] console stopped.
pause
