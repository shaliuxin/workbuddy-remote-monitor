@echo off
title Remote AI Task Manager
cd /d "%~dp0"

echo ========================================
echo   Remote AI Task Manager
echo ========================================

REM ����ʹ�÷ַ����Դ��� Node ����ʱ������Ŀ�������װ Node
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

REM �ȴ��������ҳ��ÿ 2 ���Զ����ԣ�����һ�����ͻ���ʾ���ݣ�
start "" http://127.0.0.1:48790

REM ��ǰ����ֱ�����п���̨������ start / cmd /k Ƕ�ף��������ű���ɢ
"%NODE%" wb-console-server.js

echo.
echo [EXIT] console stopped.
pause
