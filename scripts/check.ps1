<#
  AWS Nuke 平台 - 运行环境检测（只检查，不启动服务）
  用法： 双击 check.bat，或在 PowerShell 中执行 powershell -ExecutionPolicy Bypass -File scripts\check.ps1
#>

$ErrorActionPreference = 'Continue'

try {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $OutputEncoding = New-Object Text.UTF8Encoding($false)
} catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot 'env.ps1')

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   AWS Nuke 管理平台 · 环境检测' -ForegroundColor Cyan
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ("   项目目录 : {0}" -f $root)
Write-Host '============================================================' -ForegroundColor Cyan

$failed = Show-PrerequisiteReport -Root $root

# 端口占用（仅提示，不影响检测结论）
$port = 3000
if ($env:NUKE_PORT) { $port = [int]$env:NUKE_PORT }
$busy = @()
try { $busy = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop) } catch { $busy = @() }
if ($busy.Count -gt 0) {
  $pids = ($busy | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  Write-Line '占用' ("端口 {0} 已被 PID {1} 监听（平台可能正在运行）" -f $port, $pids) 'Yellow'
} else {
  Write-Line '空闲' ("端口 {0} 可用" -f $port) 'Green'
}

Write-Host ''
if ($failed -eq 0) {
  Write-Host '  结论：前置条件齐备，双击 start.bat 即可启动。' -ForegroundColor Green
} else {
  Write-Host ("  结论：{0} 项待处理；其中 Node.js 与后端依赖可在 start.bat 启动时自动补齐，其余按上方提示处理。" -f $failed) -ForegroundColor Yellow
}
Write-Host ''
