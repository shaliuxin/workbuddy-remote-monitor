@echo off
REM WorkBuddy 任务监控服务端 - Windows 启动脚本

echo ========================================
echo WorkBuddy 任务监控服务端
echo ========================================

REM 检查 Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

REM 检查依赖
if not exist "node_modules\ws" (
    echo [提示] 正在安装依赖...
    npm install ws
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

echo [启动] 正在启动服务端...
echo.

REM 启动服务端
node workbuddy-monitor-server.js

pause
