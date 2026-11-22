@echo off
title 停止 WorkBuddy 控制台

echo ========================================
echo   停止 WorkBuddy 控制台（不影响监控服务端）
echo ========================================

set FOUND=0
for %%P in (48790 48791 48792 48793 48794 48795) do (
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
        echo [停止] 端口 %%P 上的进程 PID=%%A
        taskkill /F /PID %%A >nul 2>nul
        set FOUND=1
    )
)

if "%FOUND%"=="0" (
    echo [提示] 未发现正在运行的控制台
) else (
    echo [完成] 控制台已停止
)

echo.
echo 注意: 监控服务端(48787)仍在后台运行，如需停止请用控制台里的“停止”按钮
echo       或运行 stop-monitor-server-by-port.bat
echo.
pause
