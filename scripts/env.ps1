<#
  AWS Nuke 平台 - 运行环境自检与自动补齐
  被 start.ps1 / check.ps1 点引用（dot-source），本文件只定义函数，不直接执行。

  设计原则：
  1. 只做「本机最小侵入」的自动配置：缺 Node 时下载官方便携版到 runtime\node，
     不改系统环境变量、不写注册表、不需要管理员权限；
  2. 所有网络请求依赖 PowerShell 自带的 Invoke-WebRequest，它会自动使用 Windows 系统代理，
     与平台内部（lib/proxy.js）的判断口径一致；
  3. 检测项统一返回对象，便于 start.ps1 静默使用、check.ps1 完整打印。
#>

$script:NodeMinMajor = 18
$script:NodeDefaultVersion = 'v22.11.0'
$script:NodeDownloadHosts = @(
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node'
)

function Write-Line {
  param(
    [string]$Tag,
    [string]$Message,
    [string]$Color = 'Gray'
  )
  Write-Host ("  [{0}] {1}" -f $Tag, $Message) -ForegroundColor $Color
}

function Get-TargetArch {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
  return 'x64'
}

# 项目内置的便携 Node 优先于系统安装，保证「用什么版本运行」可预期
function Get-PortableNodePath {
  param([string]$Root)
  $candidate = Join-Path $Root 'runtime\node\node.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function Resolve-NodePath {
  param([string]$Root)

  $portable = Get-PortableNodePath -Root $Root
  if ($portable) { return $portable }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  # PATH 里没有时，回退到常见安装目录（含环境变量缺失时的硬编码兜底）
  $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\Program Files', 'C:\Program Files (x86)')
  $candidates = New-Object System.Collections.ArrayList
  foreach ($base in $bases) {
    if ($base) { [void]$candidates.Add((Join-Path $base 'nodejs\node.exe')) }
  }
  if ($env:LOCALAPPDATA) { [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')) }
  if ($env:USERPROFILE) { [void]$candidates.Add((Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe')) }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Get-NodeInfo {
  param([string]$NodePath)

  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) { return $null }
  $raw = $null
  try { $raw = (& $NodePath '-v' 2>$null | Select-Object -First 1) } catch { $raw = $null }

  $npmPath = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npmPath)) { $npmPath = $null }

  # 探测失败（权限受限、被杀软拦截等）时不要误判为「未安装」：路径存在就先按可用处理，
  # 否则会白下载一个 30MB 的便携版，反而把问题搞复杂。
  if (-not $raw) {
    return @{
      Path = $NodePath
      Version = '未知'
      Major = 0
      Ok = $true
      Probed = $false
      Npm = $npmPath
    }
  }

  $version = ([string]$raw).Trim()
  $major = 0
  if ($version -match '^v?(\d+)\.') { $major = [int]$Matches[1] }

  return @{
    Path = $NodePath
    Version = $version
    Major = $major
    Ok = ($major -ge $script:NodeMinMajor)
    Probed = $true
    Npm = $npmPath
  }
}

# 从官方 SHASUMS 里取准确版本号，避免把版本号写死导致链接失效
function Resolve-PortableNodeVersion {
  param([string]$Wanted)

  if ($Wanted) { return $Wanted }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $arch = Get-TargetArch
  foreach ($mirror in $script:NodeDownloadHosts) {
    try {
      $url = "$mirror/latest-v22.x/SHASUMS256.txt"
      $text = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20 | Select-Object -ExpandProperty Content
      $match = [regex]::Match($text, "node-(v[\d.]+)-win-$arch\.zip")
      if ($match.Success) { return $match.Groups[1].Value }
    } catch { }
  }
  return $script:NodeDefaultVersion
}

function Install-PortableNode {
  param(
    [string]$Root,
    [string]$Version
  )

  $arch = Get-TargetArch
  $version = Resolve-PortableNodeVersion -Wanted $Version
  $file = "node-$version-win-$arch.zip"
  $tempDir = Join-Path $Root 'runtime\_node_tmp'
  $zipPath = Join-Path $tempDir $file
  $targetDir = Join-Path $Root 'runtime\node'

  Write-Line '信息' "准备下载便携版 Node.js $version ($arch)" 'Cyan'

  if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $oldProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'

  $downloaded = $false
  foreach ($mirror in $script:NodeDownloadHosts) {
    $url = "$mirror/$version/$file"
    try {
      Write-Line '下载' $url 'DarkGray'
      Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
      if ((Test-Path -LiteralPath $zipPath) -and ((Get-Item -LiteralPath $zipPath).Length -gt 1MB)) {
        $downloaded = $true
        break
      }
    } catch {
      Write-Line '重试' ("该来源失败：" + $_.Exception.Message) 'Yellow'
    }
  }
  $ProgressPreference = $oldProgress

  if (-not $downloaded) {
    Write-Line '失败' '所有下载源均不可用，请检查网络或在浏览器手动下载' 'Red'
    Write-Line '提示' 'https://nodejs.org/zh-cn/download' 'Yellow'
    return $null
  }

  Write-Line '解压' "展开到 runtime\node ..." 'DarkGray'
  $extractDir = Join-Path $tempDir 'extract'
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

  $extracted = $false

  # 1) .NET ZipFile：PS 5.1 下比 Expand-Archive 快一个数量级，且不刷进度条
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractDir)
    $extracted = $true
  } catch {
    Write-Line '提示' ("内置解压失败：" + $_.Exception.Message) 'DarkGray'
  }

  # 2) 系统 tar（Win10 1803+）
  if (-not $extracted) {
    $systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $systemTar) {
      & $systemTar -xf $zipPath -C $extractDir 2>$null
      if ($LASTEXITCODE -eq 0) { $extracted = $true }
    }
  }

  # 3) Expand-Archive 兜底
  if (-not $extracted) {
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
      Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
      $extracted = $true
    } catch {
      Write-Line '失败' ("解压失败：" + $_.Exception.Message) 'Red'
      return $null
    } finally {
      $ProgressPreference = $oldProgress
    }
  }

  $inner = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
  if (-not $inner) {
    Write-Line '失败' '压缩包结构异常，未找到解压后的目录' 'Red'
    return $null
  }

  if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path -Parent $targetDir) -Force | Out-Null
  Move-Item -LiteralPath $inner.FullName -Destination $targetDir
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue

  $nodeExe = Join-Path $targetDir 'node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-Line '失败' '安装后未找到 node.exe' 'Red'
    return $null
  }

  Write-Line '完成' "便携版 Node.js 已就绪：runtime\node" 'Green'
  return $nodeExe
}

# 解析可用的 Node：优先已安装且版本达标，其次询问是否下载便携版
function Ensure-Node {
  param(
    [string]$Root,
    [switch]$NoPrompt
  )

  $path = Resolve-NodePath -Root $Root
  $info = Get-NodeInfo -NodePath $path

  if ($info -and $info.Ok) {
    if (-not $info.Probed) {
      Write-Line '提示' ("已找到 Node.js（{0}），但无法执行版本探测，将直接尝试启动" -f $info.Path) 'DarkGray'
    }
    return $info
  }

  if ($info) {
    Write-Line '警告' ("检测到 Node.js {0}，低于要求的 v{1}" -f $info.Version, $script:NodeMinMajor) 'Yellow'
  } else {
    Write-Line '警告' '未检测到 Node.js' 'Yellow'
  }

  if ($NoPrompt) { return $null }

  Write-Host ''
  Write-Host '  可以自动下载官方便携版到项目内（无需管理员权限，不改系统环境变量）。' -ForegroundColor Gray
  $answer = Read-Host '  是否自动安装? [Y/n]'
  if ($answer -match '^(n|no|否)$') { return $null }

  $nodeExe = Install-PortableNode -Root $Root
  if (-not $nodeExe) { return $null }
  return Get-NodeInfo -NodePath $nodeExe
}

# 把 Node 所在目录放到当前会话 PATH 最前面，npm / 子进程都能直接找到
function Use-Node {
  param($NodeInfo)

  if (-not $NodeInfo) { return }
  $dir = Split-Path -Parent $NodeInfo.Path
  if ($env:PATH -notlike "*$dir*") {
    $env:PATH = "$dir;$env:PATH"
  }
}

function Get-PrerequisiteReport {
  param([string]$Root)

  $items = New-Object System.Collections.ArrayList

  # PowerShell
  [void]$items.Add([pscustomobject]@{
    Name = 'PowerShell'
    Ok = ($PSVersionTable.PSVersion.Major -ge 5)
    Detail = "$($PSVersionTable.PSVersion)"
    Fix = 'Windows 7 自带 2.0，需升级到 5.1'
  })

  # Node.js
  $nodePath = Resolve-NodePath -Root $Root
  $nodeInfo = Get-NodeInfo -NodePath $nodePath
  $nodeDetail = '未找到 node.exe'
  $nodeOk = $false
  if ($nodeInfo) {
    if ($nodeInfo.Probed) {
      $nodeDetail = "$($nodeInfo.Version) · $($nodeInfo.Path)"
      $nodeOk = $nodeInfo.Ok
    } else {
      $nodeDetail = "已找到（版本探测失败）· $($nodeInfo.Path)"
      $nodeOk = $true
    }
  }
  [void]$items.Add([pscustomobject]@{
    Name = 'Node.js'
    Ok = $nodeOk
    Detail = $nodeDetail
    Fix = "需要 v$($script:NodeMinMajor)+，启动时可自动下载便携版"
  })

  # npm
  $npmOk = $false
  $npmDetail = '未找到'
  if ($nodeInfo -and $nodeInfo.Npm) {
    $npmOk = $true
    $npmDetail = $nodeInfo.Npm
  }
  [void]$items.Add([pscustomobject]@{
    Name = 'npm'
    Ok = $npmOk
    Detail = $npmDetail
    Fix = '随 Node.js 一同安装'
  })

  # 后端依赖
  $depsOk = Test-Path -LiteralPath (Join-Path $Root 'server\node_modules\express')
  [void]$items.Add([pscustomobject]@{
    Name = '后端依赖'
    Ok = $depsOk
    Detail = $(if ($depsOk) { 'server\node_modules 已就绪' } else { '尚未安装' })
    Fix = '首次启动会自动执行 npm install'
  })

  # 前端构建产物
  $distOk = Test-Path -LiteralPath (Join-Path $Root 'server\public\index.html')
  [void]$items.Add([pscustomobject]@{
    Name = '前端产物'
    Ok = $distOk
    Detail = $(if ($distOk) { 'server\public 已就绪' } else { '缺少 server\public\index.html' })
    Fix = '在开发机执行 npm run build 后重新打包'
  })

  # 系统 tar（解压 zip 用，Win10 1803+ 自带）
  $tarOk = Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\tar.exe')
  [void]$items.Add([pscustomobject]@{
    Name = '系统 tar'
    Ok = $tarOk
    Detail = $(if ($tarOk) { 'System32\tar.exe' } else { '不可用，将退化为 Expand-Archive' })
    Fix = '可选，缺失不影响运行'
  })

  # aws-nuke 二进制
  $nukeOk = Test-Path -LiteralPath (Join-Path $Root 'runtime\bin\aws-nuke.exe')
  [void]$items.Add([pscustomobject]@{
    Name = 'aws-nuke'
    Ok = $nukeOk
    Detail = $(if ($nukeOk) { 'runtime\bin\aws-nuke.exe' } else { '未放置二进制' })
    Fix = '启动平台后可在「部署与设置」一键下载'
  })

  return $items
}

# 中文在控制台占两格，用 -f 的宽度会按字符数算导致列错位，这里按显示宽度补空格
function Get-DisplayWidth {
  param([string]$Text)
  $width = 0
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    if (($code -ge 0x1100 -and $code -le 0x115F) -or
      ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
      ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
      ($code -ge 0xF900 -and $code -le 0xFAFF) -or
      ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
      ($code -ge 0xFF00 -and $code -le 0xFF60) -or
      ($code -ge 0xFFE0 -and $code -le 0xFFE6)) {
      $width = $width + 2
    } else {
      $width = $width + 1
    }
  }
  return $width
}

function Format-Pad {
  param([string]$Text, [int]$Width)
  $pad = $Width - (Get-DisplayWidth -Text $Text)
  if ($pad -lt 0) { $pad = 0 }
  return $Text + (' ' * $pad)
}

function Show-PrerequisiteReport {
  param([string]$Root)

  $items = Get-PrerequisiteReport -Root $Root
  $failed = 0
  Write-Host ''
  Write-Host '  运行环境检测' -ForegroundColor Cyan
  Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
  foreach ($item in $items) {
    $label = Format-Pad -Text $item.Name -Width 12
    if ($item.Ok) {
      Write-Host ('  [ OK ] {0} {1}' -f $label, $item.Detail) -ForegroundColor Green
    } else {
      $failed = $failed + 1
      Write-Host ('  [缺失] {0} {1}' -f $label, $item.Detail) -ForegroundColor Yellow
      if ($item.Fix) {
        Write-Host ('         → {0}' -f $item.Fix) -ForegroundColor DarkGray
      }
    }
  }
  Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
  return $failed
}
