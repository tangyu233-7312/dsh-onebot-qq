@echo off
chcp 65001 >nul
title 停止 QQ 侧车服务
echo 正在查找监听 3972 的进程...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3972" ^| findstr "LISTENING"') do (
  echo 结束 PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
echo 完成。
timeout /t 2 >nul
