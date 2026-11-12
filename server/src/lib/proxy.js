/**
 * 代理探测：解决「浏览器能上 GitHub，程序不能」这类问题。
 *
 * 浏览器读 Windows 的系统代理（WinINET 设置），而 Node 的 fetch 只认 HTTPS_PROXY，
 * curl 也不读 WinINET。用户开了 Clash / v2rayN 这类客户端（系统代理 127.0.0.1:7890），
 * 从资源管理器启动的进程不会带任何代理环境变量，于是直连必然超时。
 *
 * 优先级：显式配置 > 环境变量 > 系统注册表。显式值为 off/none 表示全部禁用。
 */
import { execFile } from 'node:child_process'

const CACHE_TTL_MS = 5 * 60 * 1000
let cached = { at: 0, value: null }

function runPowerShell(script, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const exe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    let stdout = ''
    let settled = false
    let child
    try {
      child = execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve('')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(stdout.trim())
    })
  })
}

/** `http=1.2.3.4:8080;https=1.2.3.4:8080` 这类写法需要取出 https 段 */
export function normalizeProxyServer(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (!value.includes('=')) return value

  const parts = value.split(';').map((item) => item.trim()).filter(Boolean)
  const pick =
    parts.find((item) => /^https=/i.test(item)) ||
    parts.find((item) => /^http=/i.test(item)) ||
    parts.find((item) => /^socks/i.test(item)) ||
    parts[0]
  if (!pick) return ''

  const match = pick.match(/^([a-z0-9]+)=(.+)$/i)
  if (!match) return pick

  const [, scheme, address] = match
  // socks= 必须保留协议：否则会被当成 http 代理，握手直接失败
  if (/^socks/i.test(scheme)) return `socks5h://${address}`
  return address
}

/** 读取 Windows 系统代理（非 Windows 或读取失败返回空） */
export async function systemProxy({ force = false } = {}) {
  if (process.platform !== 'win32') return ''
  if (!force && cached.value !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const script =
    "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' " +
    "-ErrorAction SilentlyContinue; if ($p.ProxyEnable -eq 1) { $p.ProxyServer } else { '' }"
  const raw = await runPowerShell(script)
  const value = normalizeProxyServer(raw)
  cached = { at: Date.now(), value }
  return value
}

/** 把 127.0.0.1:7890 / http://host:port 补全成 curl 可用形式 */
export function asUrl(proxy) {
  const value = String(proxy || '').trim()
  if (!value) return ''
  return /^[a-z0-9+]+:\/\//i.test(value) ? value : `http://${value}`
}

function isLoopback(proxy) {
  const url = asUrl(proxy).toLowerCase()
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)
}

/**
 * 计算实际可用的代理候选（按尝试顺序）。
 * 本地代理客户端常同时开 HTTP 与 SOCKS5，HTTP 不通时用 socks5h 兜一次。
 */
export async function proxyCandidates({ explicit = '', env = {} } = {}) {
  const declared = String(explicit ?? '').trim()
  if (/^(off|none|no|false|0)$/i.test(declared)) return []

  const fromEnv = String(env.NUKE_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '').trim()
  const source = declared || fromEnv || (await systemProxy())
  if (!source) return []

  const url = asUrl(source)
  const list = [url]
  if (isLoopback(url)) {
    const socks = url.replace(/^https?:\/\//i, 'socks5h://')
    if (socks !== url) list.push(socks)
  }
  return list
}

/** 供诊断接口展示：当前用的是哪一层配置 */
export async function proxyStatus({ force = false } = {}) {
  const fromSystem = await systemProxy({ force })
  const fromEnv = String(process.env.NUKE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '').trim()
  return {
    system: fromSystem,
    env: fromEnv,
    effective: fromEnv || fromSystem || '',
    source: fromEnv ? 'env' : fromSystem ? 'system' : 'none',
  }
}
