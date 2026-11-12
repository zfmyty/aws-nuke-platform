/**
 * 启动期自举：若 runtime/bin 下缺少 aws-nuke 可执行文件，
 * 自动在项目根目录寻找 aws-nuke-*-windows-amd64.zip 并解压，
 * 让「一键部署」在首次启动时就能补齐二进制依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config/index.js'
import { runCommand } from './shell.js'
import { createLogger } from './logger.js'

const log = createLogger('bootstrap')

function findZip() {
  const root = config.paths.projectRoot
  try {
    return fs
      .readdirSync(root)
      .filter((name) => /^aws-nuke[-_].*windows[-_]amd64\.zip$/i.test(name))
      .map((name) => path.join(root, name))
      .sort()
      .pop()
  } catch {
    return null
  }
}

async function extract(zipPath, target) {
  fs.mkdirSync(target, { recursive: true })
  // Windows 10+ 自带 bsdtar，可直接解压 zip；失败则回退 PowerShell
  const tar = await runCommand('tar', ['-xf', zipPath, '-C', target, 'aws-nuke.exe'], { timeoutMs: 120000 })
  if (fs.existsSync(config.paths.awsNukeBin)) return { ok: true, via: 'tar' }

  const psCommand = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${target}' -Force`
  const ps = await runCommand(
    `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    { timeoutMs: 180000 },
  )
  const ok = fs.existsSync(config.paths.awsNukeBin)
  return { ok, via: 'powershell', detail: (tar.stderr || ps.stderr || '').slice(0, 300) }
}

export async function ensureAwsNukeBinary() {
  if (fs.existsSync(config.paths.awsNukeBin)) {
    return { status: 'present', path: config.paths.awsNukeBin }
  }
  const zipPath = findZip()
  if (!zipPath) {
    log.warn('未找到 aws-nuke 可执行文件，也未发现安装包 zip；请在系统中手动放置 runtime/bin/aws-nuke.exe')
    return { status: 'missing', path: config.paths.awsNukeBin }
  }

  log.info(`检测到安装包 ${path.basename(zipPath)}，正在自动解压...`)
  const result = await extract(zipPath, path.dirname(config.paths.awsNukeBin))
  if (result.ok) {
    log.info(`aws-nuke 已就绪: ${config.paths.awsNukeBin}`)
    return { status: 'extracted', via: result.via, path: config.paths.awsNukeBin }
  }
  log.error('自动解压失败，请手动解压安装包到 runtime/bin', result.detail)
  return { status: 'failed', path: config.paths.awsNukeBin, detail: result.detail }
}
