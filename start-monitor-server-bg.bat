@echo off
REM WorkBuddy 任务监控服务端 - 后台启动脚本 (Windows)

echo ========================================
echo WorkBuddy 任务监控服务端 - 后台启动
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

echo [启动] 正在后台启动服务端...
echo.

REM 后台启动（使用 PowerShell Start-Process）
powershell -Command "Start-Process node -ArgumentList 'workbuddy-monitor-server.js' -WindowStyle Hidden"

echo [完成] 服务端已在后台启动
echo.
echo 查看日志:
echo   type monitor-server.log
echo.
echo 停止服务端:
echo   taskkill /F /IM node.exe
echo   或运行 stop-monitor-server.bat
echo.
pause
