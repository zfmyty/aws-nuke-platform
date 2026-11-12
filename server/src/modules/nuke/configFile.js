/**
 * 账号配置文件的生命周期：生成一次、之后冻结。
 *
 * 设计原因：
 *   配置一旦生成就代表「用户当时确认过的清理范围」。此后切换平台设置
 *   （主账号使用方式、默认区域、黑名单……）**不应该悄悄改写已有配置**，
 *   否则用户按旧配置评估的演练结果会与真实执行不一致。
 *
 * 因此这里的约定是：
 *   - `ensureConfigFile()` 只在文件不存在时生成，存在则原样返回，绝不覆盖；
 *   - 要让新规则生效，必须由用户显式点「重新生成」或手工编辑保存；
 *   - 执行任务时同样走 ensure，不会顺手重写用户改过的内容。
 *
 * 文件位置：server/data/configs/account-<accountId>.yaml
 * 元信息：存在账号记录的 configMeta 字段（source / generatedAt / editedAt）
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../config/index.js'
import { ApiError } from '../../lib/errors.js'
import { buildConfig } from './configBuilder.js'

/** 配置来源（仅模块内使用：generated=平台生成，manual=用户手工编辑） */
const CONFIG_SOURCES = ['generated', 'manual']

/** 单个配置文件的大小上限，防止误粘贴二进制内容 */
const MAX_CONFIG_BYTES = 256 * 1024

export function configFilePath(account) {
  return path.join(dataPath('configs'), `account-${account.accountId}.yaml`)
}

export function readConfigFile(account) {
  const file = configFilePath(account)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function generateConfigText(account, settings) {
  return buildConfig({ account, settings })
}

/** 写入配置文件（生成或用户编辑），返回新的元信息 */
function writeConfigFile(account, yaml, source) {
  const file = configFilePath(account)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, yaml, 'utf8')
  const now = new Date().toISOString()
  const previous = account.configMeta || {}
  return {
    source,
    generatedAt: source === 'generated' ? now : previous.generatedAt || now,
    editedAt: source === 'manual' ? now : previous.editedAt || null,
  }
}

/**
 * 确保配置存在。存在就原样返回（不覆盖），不存在才生成。
 * @returns {{ yaml: string, meta: object|null, created: boolean }}
 */
export function ensureConfigFile(account, settings, { force = false } = {}) {
  const existing = readConfigFile(account)
  if (existing !== null && !force) {
    return { yaml: existing, meta: account.configMeta || null, created: false }
  }
  const yaml = generateConfigText(account, settings)
  const meta = writeConfigFile(account, yaml, 'generated')
  return { yaml, meta, created: true }
}

/** 用户手工保存：内容由用户负责，标记为 manual 后不会再被自动覆盖 */
export function saveConfigFile(account, rawYaml) {
  const yaml = String(rawYaml ?? '')
  if (!yaml.trim()) throw ApiError.badRequest('配置内容不能为空')
  if (Buffer.byteLength(yaml, 'utf8') > MAX_CONFIG_BYTES) throw ApiError.badRequest('配置内容过大（上限 256 KB）')
  // 最低限度的结构检查：aws-nuke 至少需要一个 accounts 段，否则等于空跑
  if (!/^\s*accounts\s*:/m.test(yaml)) throw ApiError.badRequest('配置缺少 accounts 段，请检查是否粘贴了正确的内容')
  const meta = writeConfigFile(account, yaml, 'manual')
  return { yaml, meta }
}

/** 删除账号时清理配置文件，避免残留旧范围被误用 */
export function removeConfigFile(account) {
  try {
    fs.rmSync(configFilePath(account), { force: true })
  } catch {
    /* 清理失败不影响删除账号本身 */
  }
}

/**
 * 配置状态：给前端展示「已生成 / 手动编辑过 / 与当前设置不一致」。
 * `stale` 只在 source=generated 时计算——手工编辑本来就是有意偏离，不算过期。
 */
export function configStatus(account, settings) {
  const yaml = readConfigFile(account)
  if (yaml === null) return { exists: false, source: null, stale: false, generatedAt: null, editedAt: null }
  const meta = account.configMeta || {}
  const source = CONFIG_SOURCES.includes(meta.source) ? meta.source : 'generated'
  let stale = false
  if (source === 'generated') {
    try {
      stale = generateConfigText(account, settings).trim() !== yaml.trim()
    } catch {
      stale = false
    }
  }
  return {
    exists: true,
    source,
    stale,
    generatedAt: meta.generatedAt || null,
    editedAt: meta.editedAt || null,
  }
}
