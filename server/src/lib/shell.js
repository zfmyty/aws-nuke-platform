/**
 * 进程执行封装：
 * - runCommand：一次性执行并收集输出（用于环境探测、aws configure 等短命令）
 * - 二进制解析：优先使用项目内置 aws-nuke.exe；AWS CLI 支持运行中动态识别
 *   （新装 CLI 写入注册表 PATH 后无需重启平台，见 resolveAwsCli）
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config/index.js'

export function runCommand(bin, args = [], options = {}) {
  const { timeoutMs = 20000, cwd, env } = options
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error.message || error), error })
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ code: -2, stdout, stderr: `${stderr}\n[timeout] 命令执行超时` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error.message || error), error })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

/** 注册表实时 PATH 缓存（10 秒），用于绕过进程启动时的旧 PATH 快照 */
let livePathCache = { at: 0, value: null }

function readRegistryPath(hiveKey) {
  try {
    const out = spawnSync('reg', ['query', hiveKey, '/v', 'Path'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    if (out.status !== 0) return null
    const match = (out.stdout || '').match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/** 实时读取注册表中系统 + 用户的 PATH（平台进程启动后新装的软件也能看到） */
function liveRegistryPath() {
  const now = Date.now()
  if (now - livePathCache.at < 10000) return livePathCache.value
  const parts = [
    readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    readRegistryPath('HKCU\\Environment'),
  ].filter(Boolean)
  livePathCache = { at: now, value: parts.join(';') }
  return livePathCache.value
}

/** 在 PATH 字符串的各目录中查找 aws 可执行文件 */
function findAwsInPath(pathStr) {
  if (!pathStr) return null
  for (const dir of pathStr.split(';')) {
    const d = dir.trim()
    if (!d) continue
    for (const name of ['aws.exe', 'aws.cmd', 'aws.bat']) {
      try {
        const candidate = path.join(d, name)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* 忽略不可访问目录 */
      }
    }
  }
  return null
}

/**
 * 解析 AWS CLI 可执行文件。
 * 优先级：AWS_CLI_PATH 环境变量 → 常见默认安装目录 → 注册表实时 PATH
 * → 进程内旧 PATH。这样平台启动后才安装的 AWS CLI 无需重启即可被识别。
 */
export function resolveAwsCli() {
  const fromEnv = process.env.AWS_CLI_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  for (const candidate of config.paths.awsCliCandidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const fromRegistry = findAwsInPath(liveRegistryPath())
  if (fromRegistry) return fromRegistry
  const fromProcessPath = findAwsInPath(process.env.PATH || '')
  if (fromProcessPath) return fromProcessPath
  return 'aws'
}

export function awsNukeAvailable() {
  return fs.existsSync(config.paths.awsNukeBin)
}

export function resolveAwsNuke() {
  return config.paths.awsNukeBin
}

/** 在 PowerShell 中执行脚本（安装 AWS CLI 等需要管道的能力） */
export function resolvePowerShell() {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

/** 判断本机 ~/.aws/credentials 中是否存在指定 profile */
export function awsProfileExists(profileName) {
  if (!profileName) return false
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials')
  try {
    const content = fs.readFileSync(file, 'utf8')
    return content
      .split(/\r?\n(?=\[)/)
      .some((block) => block.trim().split(/\r?\n/)[0].trim() === `[${profileName}]`)
  } catch {
    return false
  }
}
