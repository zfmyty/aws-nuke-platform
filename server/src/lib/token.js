/**
 * 轻量令牌（HMAC-SHA256 签名，结构兼容 JWT），避免引入第三方依赖。
 * payload 中只放非敏感信息：sub / role / name。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config, dataPath } from '../config/index.js'

function loadSecret() {
  const file = dataPath('.token.secret')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    const secret = crypto.randomBytes(48).toString('hex')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 })
    return secret
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const SECRET = loadSecret()

export function signToken(payload, ttlSeconds = config.auth.tokenTtlSeconds) {
  const now = Math.floor(Date.now() / 1000)
  const body = { ...payload, iat: now, exp: now + ttlSeconds }
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const data = `${head}.${b64url(JSON.stringify(body))}`
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  const expected = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
