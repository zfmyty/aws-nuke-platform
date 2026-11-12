/**
 * 安全相关原语：口令散列（scrypt）、敏感字段加密（AES-256-GCM）。
 * 加密主密钥保存在 data/.master.key（首次启动自动生成，权限 600）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config, dataPath } from '../config/index.js'

const SCRYPT_KEYLEN = 64

function loadMasterKey() {
  const keyFile = dataPath('.master.key')
  try {
    const hex = fs.readFileSync(keyFile, 'utf8').trim()
    if (hex.length === 64) return Buffer.from(hex, 'hex')
  } catch {
    /* 首次启动 */
  }
  const key = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(keyFile), { recursive: true })
  fs.writeFileSync(keyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  return key
}

let masterKey = null
const getKey = () => (masterKey ||= loadMasterKey())

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(expected, actual)
}

/** 加密任意字符串，输出 v1:<iv>:<tag>:<cipher>（base64） */
export function encryptSecret(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

export function decryptSecret(payload) {
  if (!payload) return ''
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':')
  if (version !== 'v1') return ''
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/** 仅保留首尾字符，用于前端展示 */
export function maskSecret(value) {
  if (!value) return ''
  const str = String(value)
  if (str.length <= 8) return '****'
  return `${str.slice(0, 4)}${'*'.repeat(Math.min(12, str.length - 8))}${str.slice(-4)}`
}

export const securityConfig = () => ({ masterKeyFile: dataPath('.master.key'), ...config.auth })
