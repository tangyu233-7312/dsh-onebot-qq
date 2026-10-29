@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  唱歌整合包 - 环境安装（Windows）
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [!] 没找到 python。请先安装 Python 3.10 或 3.11
  echo     https://www.python.org/downloads/
  echo     安装时记得勾选 "Add Python to PATH"
  exit /b 1
)

if not exist ".venv" (
  echo [1/3] 创建虚拟环境 .venv ...
  python -m venv .venv
  if errorlevel 1 ( echo [!] 创建虚拟环境失败 & exit /b 1 )
) else (
  echo [1/3] .venv 已存在，跳过
)

echo [2/3] 升级 pip ...
".venv\Scripts\python.exe" -m pip install --upgrade pip

echo [3/3] 安装依赖（rvc-python + imageio-ffmpeg）...
echo     这一步会下载 torch，体积较大，请耐心等待。
echo     没有 NVIDIA 显卡的话请改用: install.bat --torch-cpu
".venv\Scripts\python.exe" python\rvc-infer.py install %1
if errorlevel 1 ( echo [!] 依赖安装失败 & exit /b 1 )

echo.
echo [检查] 环境状态：
".venv\Scripts\python.exe" python\rvc-infer.py info

echo.
echo ============================================
echo  安装完成。接下来：
echo   1. 把你的 .pth 音色模型放进 voice-models\
echo      （可配同名 .index 提升音色相似度）
echo   2. 把歌放进 songs\，或用 tools\fetch-song.js 抓
echo   3. 把 skills\singing 整个目录复制到 QQ-agent 的 skills\
echo   4. 控制台里启用「唱歌」技能，填好 Python 路径
echo ============================================
endlocal
