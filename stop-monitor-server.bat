@echo off
REM WorkBuddy 任务监控服务端 - 停止脚本

echo ========================================
echo 停止 WorkBuddy 任务监控服务端
echo ========================================

echo [停止] 正在查找并终止 node 进程...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq workbuddy-monitor-server*"

echo.
echo [提示] 如果上述命令未生效，可以手动查看进程:
echo   tasklist ^| findstr node
echo.
echo 然后手动终止:
echo   taskkill /F /PID ^<进程ID^>
echo.
pause
