<#
  AWS Nuke 平台 - 停止服务
  用法： powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 [-Port 3000]
  逻辑： 按端口定位监听进程 -> 结束其子进程（aws-nuke 等）-> 结束主进程 -> 复查端口
#>
param([int]$Port = 3000)

$ErrorActionPreference = 'Continue'

if ($env:NUKE_PORT -and -not $PSBoundParameters.ContainsKey('Port')) {
  $Port = [int]$env:NUKE_PORT
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   AWS Nuke 管理平台 - 停止服务' -ForegroundColor Cyan
Write-Host ("   目标端口: {0}" -f $Port)
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

function Get-ListenerPids {
  param([int]$TargetPort)
  $found = @()
  try {
    $found = @(
      Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    $found = @()
  }
  if ($found.Count -eq 0) {
    $found = @(
      netstat -ano |
        Select-String (":{0}\s" -f $TargetPort) |
        Select-String 'LISTENING' |
        ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' -and $_ -ne '0' } |
        Select-Object -Unique
    )
  }
  return $found
}

function Get-DescendantIds {
  param([int]$RootId)
  $result = New-Object System.Collections.ArrayList
  try {
    $all = Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId
  } catch {
    return @()
  }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootId)
  while ($queue.Count -gt 0) {
    $current = [int]$queue.Dequeue()
    foreach ($proc in ($all | Where-Object { [int]$_.ParentProcessId -eq $current })) {
      $childId = [int]$proc.ProcessId
      if (-not $result.Contains($childId)) {
        [void]$result.Add($childId)
        $queue.Enqueue($childId)
      }
    }
  }
  return $result.ToArray()
}

$pids = Get-ListenerPids -TargetPort $Port

if (-not $pids -or $pids.Count -eq 0) {
  Write-Host ("[提示] 未发现监听 {0} 端口的进程，平台可能已经停止。" -f $Port) -ForegroundColor Yellow
  Write-Host '       如果平台是双击 start.bat 启动的，直接关闭那个黑窗口也可以。'
  exit 0
}

foreach ($processId in $pids) {
  Write-Host ("[信息] 发现监听进程 PID={0}，正在结束（含子进程）..." -f $processId)
  & taskkill.exe /PID $processId /T /F 2>&1 | Out-Null

  # taskkill 可能因权限被拒；先找子进程再逐个结束，确保不留下 aws-nuke 进程
  if ((Get-ListenerPids -TargetPort $Port).Count -gt 0) {
    Write-Host '       taskkill 未生效，改用进程树逐个结束...' -ForegroundColor Yellow
    foreach ($childId in (Get-DescendantIds -RootId $processId)) {
      Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Milliseconds 500
if ((Get-ListenerPids -TargetPort $Port).Count -eq 0) {
  Write-Host ''
  Write-Host ("[完成] 端口 {0} 已释放，平台已停止。" -f $Port) -ForegroundColor Green
  exit 0
}

Write-Host ''
Write-Host ("[警告] 端口 {0} 仍被占用，请重试或以管理员身份运行本脚本。" -f $Port) -ForegroundColor Yellow
exit 1
