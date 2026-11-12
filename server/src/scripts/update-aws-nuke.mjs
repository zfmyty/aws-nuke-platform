/**
 * aws-nuke 二进制更新执行器（独立子进程）
 *
 * 由 modules/system/updater.js 通过 jobs runner 拉起，流程：
 *   下载资产 → 校验 sha256 → 解压到 .staging → 自检 version → 原子替换 → 清理
 *
 * 之所以独立成进程：
 *   1. 下载体积大（~65MB），不占用主进程事件循环；
 *   2. 日志直接走 stdout，复用现有任务日志 / SSE 通道；
 *   3. 替换失败时进程退出码即可判定，主进程无需处理半成品状态。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { httpDownload, httpGetText } from '../lib/http.js'

const args = parseArgs(process.argv.slice(2))
// 代理由父进程通过 --proxy 透传（settings.proxyUrl），http.js 会优先读取
if (args.proxy) process.env.NUKE_PROXY = args.proxy

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    if (name === 'skip-checksum') {
      parsed[name] = true
      continue
    }
    parsed[name] = argv[i + 1]
    i += 1
  }
  return parsed
}

const log = (message) => console.log(`[updater] ${message}`)
const warn = (message) => console.log(`[warn] ${message}`)
const fail = (message) => {
  console.log(`[error] ${message}`)
  process.exit(1)
}

function requireArg(name) {
  const value = args[name]
  if (!value) fail(`缺少参数 --${name}`)
  return value
}

function run(bin, argv, options = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(bin, argv, { windowsHide: true, ...options })
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error.message || error) }))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

async function download(target, dest) {
  const size = Number(args.size || 0)
  let lastBucket = -1

  const bytes = await httpDownload(target, dest, {
    timeoutMs: 15 * 60 * 1000,
    onProgress: (received, total) => {
      const denominator = total || size
      if (!denominator) return
      const bucket = Math.floor((received / denominator) * 10)
      if (bucket <= lastBucket) return
      lastBucket = bucket
      log(`下载进度 ${bucket * 10}%（${(received / 1048576).toFixed(1)} MB / ${(denominator / 1048576).toFixed(1)} MB）`)
    },
  })
  log(`下载完成：${(bytes / 1048576).toFixed(1)} MB`)
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 下载前先取回期望的 sha256。
 * 放在下载之前，是为了在"上游没提供 checksums"时立刻中止，
 * 而不是先白下 60 多 MB 再报错。
 */
async function resolveExpectedChecksum(assetName) {
  if (args['skip-checksum']) {
    warn('已按参数跳过 sha256 校验（NO_UPDATE_CHECKSUM=1），请自行确认来源可信')
    return null
  }

  const checksumsUrl = args.checksums
  if (!checksumsUrl) {
    fail('上游未提供 checksums.txt，且未显式跳过校验，已中止（未下载任何内容）')
  }

  let text
  try {
    text = await httpGetText(checksumsUrl, { timeoutMs: 30000 })
  } catch (error) {
    fail(`获取 checksums.txt 失败：${error.message}`)
  }

  const line = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row.endsWith(assetName))
  if (!line) fail(`checksums.txt 中没有 ${assetName} 的条目`)

  const expected = line.split(/\s+/)[0].toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) fail('checksums.txt 格式异常：未找到有效的 sha256')
  log(`已获取期望 sha256 ${expected.slice(0, 16)}…`)
  return expected
}

async function verifyFile(file, expected) {
  if (!expected) return
  const actual = await sha256File(file)
  if (expected !== actual) fail(`sha256 校验失败\n  expected ${expected}\n  actual   ${actual}`)
  log(`sha256 校验通过 ${actual.slice(0, 16)}…`)
}

/** git-bash 的 GNU tar 解析不了 zip，优先用系统自带的 bsdtar */
function tarBinary() {
  if (process.platform !== 'win32') return 'tar'
  const system32 = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tar.exe`
  return fs.existsSync(system32) ? system32 : 'tar'
}

async function extract(archive, dir) {
  const isZip = archive.toLowerCase().endsWith('.zip')
  const tarArgs = isZip ? ['-xf', archive, '-C', dir] : ['-xzf', archive, '-C', dir]
  const result = await run(tarBinary(), tarArgs, { timeout: 180000 })
  if (result.code !== 0 && isZip) {
    warn(`tar 解压失败（${(result.stderr || '').trim().slice(0, 120)}），改用 PowerShell Expand-Archive`)
    const ps = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const expanded = await run(ps, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`,
    ])
    if (expanded.code !== 0) fail(`解压失败：${(expanded.stderr || expanded.stdout).slice(0, 300)}`)
  }
}

function findBinary(dir) {
  const names = process.platform === 'win32' ? ['aws-nuke.exe'] : ['aws-nuke']
  for (const name of names) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  const found = fs.readdirSync(dir).find((name) => /^aws-nuke(\.exe)?$/i.test(name))
  return found ? path.join(dir, found) : null
}

async function main() {
  const url = requireArg('url')
  const assetName = requireArg('asset')
  const tag = requireArg('tag')
  const target = requireArg('target')
  const staging = requireArg('staging')

  log(`目标版本 ${tag}`)
  log(`资产 ${assetName}`)
  log(`安装路径 ${target}`)

  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(url)) {
    fail(`下载地址不在允许范围内：${url}`)
  }

  fs.mkdirSync(staging, { recursive: true })
  const archive = path.join(staging, assetName)
  fs.rmSync(archive, { force: true })

  // 先确认校验来源存在，再开始下载
  const expected = await resolveExpectedChecksum(assetName)

  await download(url, archive)
  await verifyFile(archive, expected)

  const extractDir = path.join(staging, 'extract')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  log('解压中…')
  await extract(archive, extractDir)

  const staged = findBinary(extractDir)
  if (!staged) fail('压缩包中未找到 aws-nuke 可执行文件')

  // 替换前自检：新二进制必须真的能跑，且版本号与 release 一致
  const probe = await run(staged, ['version'], { timeout: 30000 })
  const probeText = `${probe.stdout}${probe.stderr}`.trim()
  if (probe.code !== 0) fail(`新二进制自检失败：${probeText.slice(0, 300)}`)
  if (!probeText.includes(tag.replace(/^v/, ''))) {
    fail(`版本不匹配：期望 ${tag}，实际 ${probeText.split('\n')[0]}`)
  }
  log(`自检通过：${probeText.split('\n')[0]}`)

  fs.mkdirSync(path.dirname(target), { recursive: true })
  const backup = `${target}.bak`
  const hadPrevious = fs.existsSync(target)
  if (hadPrevious) {
    fs.rmSync(backup, { force: true })
    try {
      fs.renameSync(target, backup)
    } catch (error) {
      fail(`无法替换 ${path.basename(target)}（可能仍有任务在运行）：${error.message}`)
    }
  }

  try {
    // 同盘 rename 保证原子性；跨盘时退化为 copy + unlink
    try {
      fs.renameSync(staged, target)
    } catch {
      fs.copyFileSync(staged, target)
      fs.rmSync(staged, { force: true })
    }
  } catch (error) {
    if (hadPrevious) {
      try {
        fs.renameSync(backup, target)
        warn('替换失败，已回滚到原二进制')
      } catch {
        warn(`替换失败且回滚失败，备份保留在 ${backup}`)
      }
    }
    fail(`写入 ${target} 失败：${error.message}`)
  }

  const verify = await run(target, ['version'], { timeout: 30000 })
  if (verify.code !== 0) {
    if (hadPrevious) {
      fs.rmSync(target, { force: true })
      fs.renameSync(backup, target)
      fail('替换后的二进制无法运行，已回滚')
    }
    fail(`替换后的二进制无法运行：${(verify.stderr || verify.stdout).slice(0, 300)}`)
  }
  log(`更新完成：${`${verify.stdout}${verify.stderr}`.trim().split('\n')[0]}`)

  fs.rmSync(staging, { recursive: true, force: true })

  const rootZip = findBundledZip()
  if (rootZip) {
    warn(`项目根目录仍保留旧的安装包 ${path.basename(rootZip)}；仅在 runtime/bin 缺失时才会被自动解压，可手动删除`)
  }
  log('全部完成')
}

function findBundledZip() {
  try {
    const root = path.resolve(path.dirname(target), '..', '..')
    return fs
      .readdirSync(root)
      .filter((name) => /^aws-nuke[-_].*windows[-_]amd64\.zip$/i.test(name))
      .map((name) => path.join(root, name))[0]
  } catch {
    return null
  }
}

main().catch((error) => fail(error.message || String(error)))
