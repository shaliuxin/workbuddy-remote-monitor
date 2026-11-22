@echo off
title 停止 WorkBuddy 监控服务端

echo ========================================
echo   停止 WorkBuddy 监控服务端 (48787)
echo ========================================

set FOUND=0
for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":48787 " ^| findstr LISTENING') do (
    echo [停止] PID=%%A
    taskkill /F /PID %%A >nul 2>nul
    set FOUND=1
)

if "%FOUND%"=="0" (
    echo [提示] 48787 端口没有监听进程
) else (
    echo [完成] 监控服务端已停止
)
echo.
pause
