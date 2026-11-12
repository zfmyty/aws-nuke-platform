/**
 * aws-nuke 版本更新：
 *   查询上游 release → 选平台资产 → 启动更新任务（下载/校验/替换在子进程完成）
 *
 * 约束：
 *   1. 只认 https://github.com 与 objects.githubusercontent.com 的下载地址；
 *   2. 默认强制校验 sha256（checksums.txt），校验失败一律不落地；
 *   3. 替换前先自检新二进制的 `version` 输出，且在有任务运行（exe 被占用）时直接拒绝；
 *   4. 更新通过 jobs runner 执行，日志走 SSE，与安装 AWS CLI 的体验一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../../config/index.js'
import { ApiError } from '../../lib/errors.js'
import { collection } from '../../lib/store.js'
import { resolveAwsNuke, awsNukeAvailable, runCommand } from '../../lib/shell.js'
import { httpGetText, httpDiagnose, setProxyOverride } from '../../lib/http.js'
import { getSettings } from '../settings/service.js'
import { startJob, listJobs, JOB_KINDS } from '../jobs/runner.js'

const REPO = process.env.AWS_NUKE_REPO || 'ekristen/aws-nuke'
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGE = `https://github.com/${REPO}/releases`

const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'api.github.com'])

const state = collection('updates', { lastCheck: null, lastUpdate: null })

/** 进程内缓存，避免每次进页面都打 GitHub API（未认证配额 60 次/小时） */
let releaseCache = { at: 0, data: null }
const CACHE_TTL_MS = 10 * 60 * 1000

/** 把 v3.68.3 / 3.68.3-rc1 解析成可比较的结构 */
export function parseVersion(text) {
  const match = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || '',
  }
}

/** a 比 b 新返回 >0，相同返回 0，更旧返回 <0 */
export function compareVersion(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  // 正式版高于同号预发布版
  if (!a.pre && b.pre) return 1
  if (a.pre && !b.pre) return -1
  return String(a.pre).localeCompare(String(b.pre))
}

function assertHttpsUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url || ''))
  } catch {
    throw ApiError.badRequest('下载地址不合法')
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw ApiError.badRequest(`下载地址不在允许范围内：${parsed.hostname}`)
  }
  return parsed.toString()
}

async function githubJson(url) {
  const headers = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  let text
  try {
    text = await httpGetText(url, { headers, timeoutMs: 20000 })
  } catch (error) {
    const message = error.message || String(error)
    if (/HTTP 40[34]|HTTP 429|限流/.test(message)) {
      throw ApiError.badRequest(
        'GitHub API 触发限流（未认证每小时 60 次）。稍后重试，或设置环境变量 GITHUB_TOKEN 提升配额',
      )
    }
    if (/HTTP 404/.test(message)) throw ApiError.badRequest(`上游仓库不存在或没有正式发布：${REPO}`)
    throw ApiError.badRequest(`查询上游版本失败：${message}`)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw ApiError.badRequest('上游返回内容无法解析为 JSON')
  }
}

/** 当前平台对应的 release 资产后缀 */
function platformSuffix() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.platform === 'win32') return `windows-${arch}.zip`
  if (process.platform === 'darwin') return `darwin-${arch}.tar.gz`
  return `linux-${arch}.tar.gz`
}

function pickAsset(assets, suffix) {
  return (assets || []).find((asset) => asset.name.endsWith(suffix)) || null
}

/** 读取本机二进制版本（未安装返回 null） */
export async function localVersion() {
  if (!awsNukeAvailable()) return { installed: false, version: null }
  const result = await runCommand(resolveAwsNuke(), ['version'], { timeoutMs: 15000 })
  const parsed = parseVersion(`${result.stdout}${result.stderr}`)
  return { installed: result.code === 0, version: parsed ? parsed.raw.replace(/^v/, '') : null }
}

async function fetchLatestRelease() {
  const data = await githubJson(API_LATEST)
  const suffix = platformSuffix()
  const asset = pickAsset(data.assets, suffix)
  const checksums = pickAsset(data.assets, 'checksums.txt')
  return {
    tag: data.tag_name,
    publishedAt: data.published_at,
    notes: String(data.body || '').slice(0, 4000),
    releaseUrl: data.html_url || RELEASE_PAGE,
    asset: asset ? { name: asset.name, size: asset.size, url: assertHttpsUrl(asset.browser_download_url) } : null,
    checksumsUrl: checksums ? assertHttpsUrl(checksums.browser_download_url) : null,
    suffix,
  }
}

/**
 * 检查更新（结果缓存 10 分钟）
 * @param {{ force?: boolean }} options
 */
export async function checkUpdate({ force = false } = {}) {
  // 每次检查前同步平台设置里的代理（settings.proxyUrl 优先于环境变量与系统代理）
  const configuredProxy = getSettings().proxyUrl || ''
  setProxyOverride(configuredProxy)

  const local = await localVersion()
  const cached = !force && releaseCache.data && Date.now() - releaseCache.at < CACHE_TTL_MS

  let release = cached ? releaseCache.data : null
  let error = null
  if (!release) {
    try {
      release = await fetchLatestRelease()
      releaseCache = { at: Date.now(), data: release }
      state.setRaw('lastCheck', { at: new Date().toISOString(), tag: release.tag, ok: true })
    } catch (err) {
      error = err.message || String(err)
      state.setRaw('lastCheck', { at: new Date().toISOString(), ok: false, error })
    }
  }

  const currentParsed = parseVersion(local.version)
  const latestParsed = release ? parseVersion(release.tag) : null
  const lastUpdate = state.getRaw('lastUpdate') || null

  return {
    installed: local.installed,
    current: local.version,
    latest: release?.tag ? release.tag.replace(/^v/, '') : null,
    hasUpdate: Boolean(currentParsed && latestParsed && compareVersion(latestParsed, currentParsed) > 0),
    // 未安装也算需要下载
    canInstall: Boolean(release?.asset) && (!currentParsed || (latestParsed && compareVersion(latestParsed, currentParsed) > 0)),
    publishedAt: release?.publishedAt || null,
    notes: release?.notes || '',
    releaseUrl: release?.releaseUrl || RELEASE_PAGE,
    asset: release?.asset || null,
    checksumsUrl: release?.checksumsUrl || null,
    repo: REPO,
    cached,
    checkedAt: new Date().toISOString(),
    lastUpdate,
    error,
  }
}

/** 有任务在跑时不能替换 exe：Windows 下重命名会被占用锁拒绝 */
function assertNoRunningJob() {
  const running = listJobs({ isAdmin: true, status: 'running', limit: 200 })
  if (!running.length) return
  const job = running[0]
  throw ApiError.conflict(`有任务正在执行（${job.title}），请等待结束再更新二进制`)
}

/**
 * 启动更新任务。真正的下载与替换在 scripts/update-aws-nuke.mjs 子进程里完成，
 * 这样长任务不阻塞主进程，日志也能通过 jobs runner 实时推送。
 */
export async function startUpdate(user, { version } = {}) {
  const info = await checkUpdate({ force: true })
  if (info.error) throw ApiError.badRequest(info.error)
  if (!info.asset) throw ApiError.badRequest(`上游发布中找不到适配本机的资产（${platformSuffix()}）`)

  const target = String(version || '').trim()
  if (target && info.latest && target.replace(/^v/, '') !== info.latest) {
    throw ApiError.badRequest(`目前只支持更新到最新版 ${info.latest}，指定版本 ${target} 暂不支持`)
  }
  if (!info.canInstall) {
    throw ApiError.badRequest(`当前已是最新版本（${info.current || '未安装'}），无需更新`)
  }

  assertNoRunningJob()

  if (!info.checksumsUrl && process.env.NO_UPDATE_CHECKSUM !== '1') {
    throw ApiError.badRequest(
      `上游 ${info.latest} 的发布中没有 checksums.txt，无法校验下载内容。` +
        '确认可信后可设置环境变量 NO_UPDATE_CHECKSUM=1 再试',
    )
  }

  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/update-aws-nuke.mjs')
  if (!fs.existsSync(scriptPath)) throw ApiError.badRequest('缺少更新脚本，请检查安装是否完整')

  const args = [
    scriptPath,
    '--url', info.asset.url,
    '--asset', info.asset.name,
    '--tag', info.latest,
    '--target', config.paths.awsNukeBin,
    '--staging', path.join(config.paths.runtimeBinDir, '.staging'),
  ]
  if (info.asset.size) args.push('--size', String(info.asset.size))
  if (info.checksumsUrl) args.push('--checksums', info.checksumsUrl)
  // 子进程沿用同一份代理配置（写入自己的环境，避免依赖父进程 env）
  const proxy = getSettings().proxyUrl || ''
  if (proxy) args.push('--proxy', proxy)
  if (process.env.NO_UPDATE_CHECKSUM === '1') args.push('--skip-checksum')

  return startJob({
    kind: JOB_KINDS.UPDATE_NUKE,
    title: `更新 aws-nuke → ${info.latest}`,
    ownerId: user.id,
    createdBy: user.username,
    bin: process.execPath,
    args,
    meta: {
      step: 'aws-nuke-update',
      from: info.current,
      to: info.latest,
      asset: info.asset.name,
      releaseUrl: info.releaseUrl,
    },
    onExit: (finished) => {
      void recordUpdateResult(finished, info)
    },
  })
}

async function recordUpdateResult(finished, info) {  try {
    const local = await localVersion()
    const ok = finished.status === 'succeeded' && local.version && info.latest && local.version === info.latest
    const { clearVersionCache } = await import('./service.js')
    clearVersionCache()
    if (ok) {
      releaseCache = { at: 0, data: null }
      state.setRaw('lastUpdate', {
        at: new Date().toISOString(),
        from: info.current,
        to: local.version,
        jobId: finished.id,
        by: finished.createdBy,
      })
    }
    const { record } = await import('../audit/service.js')
    record({
      actorId: finished.ownerId,
      actorName: finished.createdBy,
      action: 'system.update-nuke',
      target: `aws-nuke ${info.current || '未安装'} → ${local.version || info.latest}`,
      detail: `状态=${finished.status}${ok ? '' : ' · 版本未变，请查看任务日志'}`,
      level: 'warn',
    })
  } catch (error) {
    // 更新结果回写失败不影响任务本身
    console.error('[updater] 记录更新结果失败', error.message)
  }
}

/**
 * 网络诊断：分别探测 GitHub API 与下载站，逐层报告「直连 / 各代理」的结果。
 * 用户遇到「fetch failed」时，这张表能直接指出是没代理、代理没开，还是单纯慢。
 */
export async function diagnoseNetwork() {
  const configured = getSettings().proxyUrl || ''
  setProxyOverride(configured)
  const [api, download] = await Promise.all([
    httpDiagnose(`https://api.github.com/repos/${REPO}/releases/latest`),
    httpDiagnose(`https://github.com/${REPO}`),
  ])
  return {
    repo: REPO,
    configured: configured || '(自动)',
    api,
    download,
    checkedAt: new Date().toISOString(),
  }
}
