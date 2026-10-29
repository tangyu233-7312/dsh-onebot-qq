@echo off
chcp 65001 >nul
title QQ 侧车服务 (sidecar)
cd /d "%~dp0"

rem 用 PATH 里的 node；没有就提示（本服务零 npm 依赖，只要有 Node 22+ 即可）
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请装 Node 22+ 并加进 PATH，或把本文件里的 NODE 改成 node.exe 的绝对路径。
  pause
  exit /b 1
)

echo ============================================
echo  QQ 机器人侧车服务
echo  端口: 3972   地址: http://127.0.0.1:3972
echo  关掉这个窗口 = 停止服务
echo ============================================
echo.

"%NODE%" server.mjs

echo.
echo 服务已退出（错误码 %ERRORLEVEL%）
pause
