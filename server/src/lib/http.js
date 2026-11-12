/**
 * 极简 HTTP 客户端：curl 与 Node fetch 双通道，自动适配代理。
 *
 * 为什么不是单纯用 fetch：
 *   1. Node 内置 fetch 不读 HTTPS_PROXY，更不读 Windows 系统代理（WinINET）；
 *      而绝大多数用户是靠 Clash / v2rayN 的系统代理上网的，直连 GitHub 必然超时。
 *   2. curl 支持 -x（HTTP/SOCKS5）与断点重试，作为统一出口更可控。
 * 因此：探测到代理就只用 curl；没有代理才先试 fetch（快，且不依赖外部程序）。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { proxyCandidates, proxyStatus, asUrl } from './proxy.js'

const UA = 'aws-nuke-platform-updater'

/** 由业务层（settings.proxyUrl）注入的显式代理，优先于环境变量与系统代理 */
let explicitProxy = ''
export function setProxyOverride(value) {
  explicitProxy = String(value ?? '').trim()
}

function curlBin() {
  return process.platform === 'win32' ? 'curl.exe' : 'curl'
}

let curlChecked = null
function curlAvailable() {
  if (curlChecked !== null) return curlChecked
  curlChecked = new Promise((resolve) => {
    let settled = false
    let child
    try {
      child = spawn(curlBin(), ['--version'], { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
    setTimeout(() => done(false), 3000)
  })
  return curlChecked
}

function runCurl(args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const child = spawn(curlBin(), args, { windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ code: -2, stderr: `${Math.round(timeoutMs / 1000)}s 内未完成` })
    }, timeoutMs)

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stderr: String(error.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 0, stderr })
    })
  })
}

function curlCommon(proxy) {
  const args = ['-L', '--fail', '--silent', '--show-error', '--connect-timeout', '12', '--retry', '1', '--retry-delay', '1']
  if (proxy) args.push('-x', proxy)
  return args
}

async function curlToFile(url, dest, proxy, timeoutMs, headers) {
  const args = curlCommon(proxy)
  for (const [key, value] of Object.entries(headers || {})) args.push('-H', `${key}: ${value}`)
  args.push('-o', dest, url)
  const result = await runCurl(args, timeoutMs)
  if (result.code !== 0) throw new Error((result.stderr || '').trim().slice(0, 240) || `curl 退出码 ${result.code}`)
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error('未产生有效文件')
  return fs.statSync(dest).size
}

async function curlToText(url, proxy, timeoutMs, headers) {
  const tmp = `${process.env.TEMP || process.env.TMP || '.'}/aws-nuke-http-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.txt`
  const args = curlCommon(proxy)
  for (const [key, value] of Object.entries(headers || {})) args.push('-H', `${key}: ${value}`)
  args.push('--compressed', '-o', tmp, url)
  try {
    const result = await runCurl(args, timeoutMs)
    if (result.code !== 0) throw new Error((result.stderr || '').trim().slice(0, 240) || `curl 退出码 ${result.code}`)
    return fs.readFileSync(tmp, 'utf8')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** 把错误串成「代理 A: xxx；代理 B: yyy」，让用户一眼看出卡在哪一层 */
function describeFailures(failures, hasProxy) {
  const detail = failures.map((item) => (item.via ? `${item.via}：${item.message}` : item.message)).join('；')
  const hint = hasProxy
    ? '代理不可用时请检查代理客户端是否在运行，或在「平台设置 → 网络代理」中修改地址'
    : '如需代理请在「平台设置 → 网络代理」填写，或设置 HTTPS_PROXY 环境变量'
  return `${detail}（${hint}）`
}

/**
 * 拉取文本内容（GitHub API / checksums.txt 等小响应）
 */
export async function httpGetText(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const merged = { 'User-Agent': UA, ...headers }
  const proxies = await proxyCandidates({ explicit: explicitProxy, env: process.env })
  const failures = []

  if (!proxies.length) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(url, { headers: merged, signal: controller.signal, redirect: 'follow' })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      failures.push({
        via: '直连 fetch',
        message: error.name === 'AbortError' ? '超时' : `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`,
      })
    }
    if (await curlAvailable()) {
      try {
        return await curlToText(url, '', timeoutMs, merged)
      } catch (error) {
        failures.push({ via: '直连 curl', message: error.message })
      }
    }
  } else {
    for (const proxy of proxies) {
      try {
        return await curlToText(url, proxy, timeoutMs, merged)
      } catch (error) {
        failures.push({ via: `代理 ${proxy}`, message: error.message })
      }
    }
  }

  throw new Error(describeFailures(failures, proxies.length > 0))
}

/**
 * 下载文件到本地，返回字节数
 */
export async function httpDownload(url, dest, { headers = {}, timeoutMs = 20 * 60 * 1000, onProgress } = {}) {
  const merged = { 'User-Agent': UA, ...headers }
  const proxies = await proxyCandidates({ explicit: explicitProxy, env: process.env })
  const failures = []

  if (!proxies.length) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(url, { headers: merged, signal: controller.signal, redirect: 'follow' })
      if (!response.ok || !response.body) {
        clearTimeout(timer)
        throw new Error(`HTTP ${response.status}`)
      }
      const total = Number(response.headers.get('content-length') || 0)
      let received = 0
      const source = Readable.fromWeb(response.body)
      source.on('data', (chunk) => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      await pipeline(source, fs.createWriteStream(dest))
      clearTimeout(timer)
      return received
    } catch (error) {
      failures.push({
        via: '直连 fetch',
        message: error.name === 'AbortError' ? '超时' : `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`,
      })
    }
  }

  if (await curlAvailable()) {
    const targets = proxies.length ? proxies : ['']
    for (const proxy of targets) {
      try {
        const size = await curlToFile(url, dest, proxy, timeoutMs, merged)
        if (onProgress) onProgress(size, size)
        return size
      } catch (error) {
        fs.rmSync(dest, { force: true })
        failures.push({ via: proxy ? `代理 ${proxy}` : '直连 curl', message: error.message })
      }
    }
  }

  throw new Error(describeFailures(failures, proxies.length > 0))
}

/** 连通性诊断：逐层报告直连 / 代理的结果 */
export async function httpDiagnose(url) {
  // 诊断时强制重读系统代理，避免 5 分钟缓存掩盖「刚改过代理」的事实
  const status = await proxyStatus({ force: true })
  const proxies = await proxyCandidates({ explicit: explicitProxy, env: process.env })
  const attempts = []

  const direct = await (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        signal: controller.signal,
        redirect: 'follow',
      })
      return { ok: response.ok, detail: `HTTP ${response.status}` }
    } catch (error) {
      return {
        ok: false,
        detail: error.name === 'AbortError' ? '8s 超时' : `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`,
      }
    } finally {
      clearTimeout(timer)
    }
  })()
  attempts.push({ via: '直连', ...direct })

  if (await curlAvailable()) {
    for (const proxy of proxies.length ? proxies : []) {
      const args = curlCommon(proxy)
      args.push('-I', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null')
      args.push('-w', '%{http_code}', url)
      const result = await runCurl(args, 15000)
      const code = (result.stderr || '').match(/\b\d{3}\b/)
      attempts.push({
        via: `代理 ${proxy}`,
        ok: result.code === 0,
        detail: result.code === 0 ? `HTTP ${code ? code[0] : '200'}` : (result.stderr || '').trim().slice(0, 160),
      })
    }
  }

  return { ...status, attempts, candidates: proxies.map(asUrl) }
}
