/** 统一 HTTP 客户端：附加令牌、解析错误、401 自动登出 */
const TOKEN_KEY = 'aws-nuke-platform:token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  constructor(message, { code = 'ERROR', status = 500, details } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

function buildUrl(path, query) {
  const url = new URL(path, window.location.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

export async function api(path, { method = 'GET', body, query, signal } = {}) {
  const token = tokenStore.get()
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('无法连接服务器，请检查后端服务是否运行', { code: 'NETWORK' })
  }

  const text = await response.text()
  const data = text ? safeJson(text) : {}

  if (!response.ok) {
    const error = data?.error || {}
    if (response.status === 401 && !path.includes('/auth/login')) {
      tokenStore.clear()
      window.dispatchEvent(new CustomEvent('auth:expired'))
    }
    throw new ApiError(error.message || `请求失败 (${response.status})`, {
      code: error.code,
      status: response.status,
      details: error.details,
    })
  }
  return data
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/** SSE 地址（EventSource 无法自定义请求头，令牌通过 query 传递） */
export function streamUrl(path, query = {}) {
  const url = new URL(path, window.location.origin)
  url.searchParams.set('token', tokenStore.get())
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}
