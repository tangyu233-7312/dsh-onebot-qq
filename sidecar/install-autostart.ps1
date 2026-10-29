# 开机自启（可选）——把侧车注册成当前用户的登录启动项
#
# 用法（在 sidecar 目录里右键「用 PowerShell 运行」，或手动执行）：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#
# 卸载：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#
# 为什么用「启动文件夹」而不是计划任务：
#   · 不需要管理员权限；
#   · 你登录后才起来，跟 QQ / NapCat 的启动时机对得上；
#   · 卸载就是删一个快捷方式，不留注册表垃圾。

param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'QQ侧车服务.lnk'

if ($Remove) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已移除开机自启：$lnk" }
  else { Write-Host "没有找到自启项，无需移除" }
  exit 0
}

$cmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $cmd) {
  throw "找不到 node。请装 Node 22+ 并加进 PATH（本服务零 npm 依赖），或手动把本脚本里的 \$node 改成 node.exe 的绝对路径。"
}
$node = $cmd.Source

$server = Join-Path $here 'server.mjs'
if (-not (Test-Path $server)) { throw "找不到 server.mjs（应该在 $here）" }

$sh = New-Object -ComObject WScript.Shell
$link = $sh.CreateShortcut($lnk)
# 用 /c 起一个最小化窗口跑 node，这样后台有进程、任务栏不占地方
$link.TargetPath = "$env:ComSpec"
$link.Arguments = "/c `"`"$node`" `"$server`" >> `"$here\sidecar.log`" 2>&1`""
$link.WorkingDirectory = $here
$link.WindowStyle = 7           # 7 = 最小化
$link.Description = 'QQ 机器人侧车服务（看视频 / 链接解析）'
$link.Save()

Write-Host "已注册开机自启：$lnk"
Write-Host "日志会写到：$here\sidecar.log"
Write-Host "现在就可以双击 start.bat 先手动跑一次试试。"
