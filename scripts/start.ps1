<#
  AWS Nuke 平台 - 启动服务
  用法： powershell -ExecutionPolicy Bypass -File scripts\start.ps1 [-Port 3000] [-NoBrowser]
  说明： 本窗口即服务进程，日志实时打印；Ctrl+Enter（或 Ctrl+C、关闭窗口）即停止平台。
#>
param(
  [int]$Port = 3000,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Continue'

# 控制台统一按 UTF-8 输出，避免中文在 GBK 代码页下出现乱码
try {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $OutputEncoding = New-Object Text.UTF8Encoding($false)
} catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($env:NUKE_PORT) {
  $Port = [int]$env:NUKE_PORT
}

function Write-Pause {
  try {
    Read-Host '按回车键关闭窗口' | Out-Null
  } catch {
    Start-Sleep -Seconds 3
  }
}

# 运行环境模块：Node 检测、便携版下载、依赖自检
. (Join-Path $PSScriptRoot 'env.ps1')


Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   AWS Nuke 管理平台' -ForegroundColor Cyan
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '   本窗口就是平台的服务进程，运行日志会实时显示在这里。'
Write-Host '   * 停止平台：按 Ctrl+C ，或直接关闭本窗口'
Write-Host '   * 强制停止：双击 stop.bat'
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

# ---- 运行环境：检测 Node，缺失或版本过低时可自动下载便携版 ----
$nodeInfo = Ensure-Node -Root $root
if (-not $nodeInfo) {
  Write-Host ''
  Write-Host ("[错误] 未找到可用的 Node.js（需要 v{0} 或更高版本）" -f $script:NodeMinMajor) -ForegroundColor Red
  Write-Host '       双击 check.bat 可查看完整的环境检测结果'
  Write-Host '       手动下载: https://nodejs.org/zh-cn/download'
  Write-Host ''
  Write-Pause
  exit 1
}
Use-Node -NodeInfo $nodeInfo
$nodePath = $nodeInfo.Path
$nodeDir = Split-Path -Parent $nodePath

# ---- 首次启动安装后端依赖 ----
if (-not (Test-Path 'server\node_modules\express')) {
  Write-Host '[信息] 首次启动，正在安装后端依赖...' -ForegroundColor Yellow
  $npmCmd = Join-Path $nodeDir 'npm.cmd'
  if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm' }
  & $npmCmd install --prefix server --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[错误] 依赖安装失败，请检查网络后重试' -ForegroundColor Red
    Write-Pause
    exit 1
  }
  Write-Host ''
}

if (-not (Test-Path 'server\public\index.html')) {
  Write-Host '[警告] 未找到前端构建产物 server\public，请先在开发机执行 npm run build' -ForegroundColor Yellow
  Write-Host ''
}

# ---- 端口占用检查，避免直接抛 EADDRINUSE ----
$listeners = @()
try {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
  $listeners = @()
}
if ($listeners.Count -gt 0) {
  $busyPids = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  Write-Host ("[提示] 端口 {0} 已被占用（PID: {1}），平台可能已经在运行。" -f $Port, $busyPids) -ForegroundColor Yellow
  Write-Host '       如需重启，请先双击 stop.bat 停止旧进程。' -ForegroundColor Yellow
  $answer = Read-Host '仍然尝试启动? [Y/N]'
  if ($answer -notmatch '^(y|yes|是)$') {
    Write-Host '已取消。'
    Write-Pause
    exit 0
  }
  Write-Host ''
}

Write-Host ("[信息] Node     : {0} {1}" -f $nodeInfo.Version, $nodePath)
Write-Host ("[信息] 数据目录 : {0}" -f (Join-Path $root 'server\data'))
Write-Host ("[信息] 访问地址 : http://localhost:{0}" -f $Port) -ForegroundColor Green
if (-not $NoBrowser) {
  # 由服务进程在端口监听成功后自行拉起浏览器（见 server/src/index.js），
  # 避免启动脚本抢先打开导致「打不开」或「页面残缺需要刷新」。
  $env:NUKE_OPEN_BROWSER = '1'
  Write-Host '[信息] 服务就绪后将自动打开浏览器...'
} else {
  $env:NUKE_OPEN_BROWSER = ''
}
Write-Host '[信息] 正在启动，日志输出如下 —'
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

# ---- 前台运行：Ctrl+C 会触发服务的优雅退出 ----
& $nodePath 'server\src\index.js'
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
if ($exitCode -eq 0) {
  Write-Host '[已停止] 服务正常退出，关闭本窗口即可。' -ForegroundColor Green
} else {
  Write-Host ("[已停止] 服务退出，退出码 {0}。若为异常退出，请查看上方日志。" -f $exitCode) -ForegroundColor Yellow
}
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''
Write-Pause
