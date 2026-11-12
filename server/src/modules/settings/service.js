/**
 * 平台全局设置（单文档）。
 * 仅管理员可修改；包含账号黑名单、默认区域、主账号凭证（加密存储）等。
 */
import { collection } from '../../lib/store.js'
import { encryptSecret, decryptSecret, maskSecret } from '../../lib/crypto.js'

const store = collection('settings', { items: [], platform: null })

/** 主账号凭证的使用方式，见 DEFAULT_PLATFORM.masterCredentialMode */
export const MASTER_CREDENTIAL_MODES = ['organization', 'standalone']

const DEFAULT_PLATFORM = {
  blocklist: [],
  /**
   * 默认扫描区域：**默认留空**，不做任何预填。
   * 区域属于账号的清理范围，由使用者在账号编辑页按实际情况选择；
   * 这里的值只在账号自身没配区域时兜底，留空即表示「不兜底」。
   */
  defaultRegions: [],
  defaultExcludes: ['S3Object'],
  resourceSettings: {
    EC2Image: { IncludeDisabled: true },
    EC2Instance: { DisableStopProtection: true, DisableDeletionProtection: true },
    RDSInstance: { DisableDeletionProtection: true },
    CloudFormationStack: { DisableDeletionProtection: true },
  },
  awsProfile: 'nuke-operator',
  /**
   * 出网代理：
   * - 空字符串 = 自动探测系统代理（WinINET）与环境变量
   * - off/none = 强制直连
   * - http://127.0.0.1:7890 / 127.0.0.1:7890 / socks5h://... = 显式指定
   */
  proxyUrl: '',
  /** 组织跨账号默认角色（AWS Organizations 创建成员账号时自动生成） */
  organizationRoleName: 'OrganizationAccountAccessRole',
  assumeRoleSessionName: 'aws-nuke-platform',
  /** 自动在生成的配置里保护正在使用的组织角色（角色本身、策略、策略附件、实例配置文件） */
  protectAuthRole: true,
  allowUserDestructive: true,
  bypassAliasCheck: false,
  /**
   * 「扫描后确认」模式下等待用户输入别名确认的时长（分钟）。
   * 超时自动终止任务且不执行任何删除；1-120 分钟。
   */
  promptTimeoutMinutes: 5,
  /**
   * 任务中心列表轮询间隔（秒），3-60，默认 12。
   * 管理员统一控制的全局值，普通用户不感知。
   */
  jobPollIntervalSeconds: 12,
  /**
   * 顶栏「服务在线/离线」健康检查间隔（秒），3-120，默认 10。
   * 管理员统一控制的全局值。
   */
  healthPollIntervalSeconds: 10,
  /**
   * 主账号凭证的使用方式，决定「主账号是否自动并入黑名单」：
   * - organization：组织跨账号。主账号 IAM 用户作为 AssumeRole 基础凭证，
   *   主账号本身是被保护的管理账号，自动并入黑名单，禁止作为清理目标。
   * - standalone：单账号直连。凭证属于待清理账号本身（常见是 root 或该账号的 IAM 用户），
   *   此时若把该账号并入黑名单，就会把自己要清理的目标锁死，因此**不做自动并入**。
   */
  masterCredentialMode: 'organization',
  masterCredentials: null,
}

/** 兼容旧版本：字段缺失时补齐默认值 */
export function getSettings() {
  const stored = store.getRaw('platform') || {}
  return {
    ...DEFAULT_PLATFORM,
    ...stored,
    resourceSettings: { ...DEFAULT_PLATFORM.resourceSettings, ...(stored.resourceSettings || {}) },
  }
}

export function updateSettings(patch) {
  const current = getSettings()
  const next = { ...current, ...patch }
  const allowed = {
    blocklist: (value) => Array.isArray(value) && value.every((v) => /^\d{12}$/.test(String(v))),
    defaultRegions: (value) => Array.isArray(value) && value.every((v) => /^[a-z0-9-]{2,32}$/.test(String(v).trim())),
    defaultExcludes: (value) => Array.isArray(value),
    awsProfile: (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value),
    proxyUrl: (value) =>
      typeof value === 'string' &&
      (/^$/i.test(value.trim()) ||
        /^(off|none)$/i.test(value.trim()) ||
        /^(https?|socks5h?):\/\/[^\s]+$/i.test(value.trim()) ||
        /^[A-Za-z0-9.-]+:\d{1,5}$/.test(value.trim())),
    organizationRoleName: (value) => typeof value === 'string' && /^[\w+=,.@-]{1,64}$/.test(value),
    assumeRoleSessionName: (value) => typeof value === 'string' && /^[\w+=,.@-]{2,64}$/.test(value),
    allowUserDestructive: (value) => typeof value === 'boolean',
    bypassAliasCheck: (value) => typeof value === 'boolean',
    promptTimeoutMinutes: (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 120,
    jobPollIntervalSeconds: (value) => Number.isInteger(Number(value)) && Number(value) >= 3 && Number(value) <= 60,
    healthPollIntervalSeconds: (value) => Number.isInteger(Number(value)) && Number(value) >= 3 && Number(value) <= 120,
    protectAuthRole: (value) => typeof value === 'boolean',
    masterCredentialMode: (value) => MASTER_CREDENTIAL_MODES.includes(value),
  }
  for (const [key, validate] of Object.entries(allowed)) {
    if (patch[key] !== undefined && !validate(patch[key])) {
      throw new Error(`设置项 ${key} 格式不合法`)
    }
  }
  if (patch.promptTimeoutMinutes !== undefined) next.promptTimeoutMinutes = Number(patch.promptTimeoutMinutes)
  if (patch.jobPollIntervalSeconds !== undefined) next.jobPollIntervalSeconds = Number(patch.jobPollIntervalSeconds)
  if (patch.healthPollIntervalSeconds !== undefined) next.healthPollIntervalSeconds = Number(patch.healthPollIntervalSeconds)
  store.setRaw('platform', next)
  return next
}

/** 保存主账号 IAM 用户凭证（AES-256-GCM 加密） */
export function saveMasterCredentials({ accessKeyId, secretAccessKey, sessionToken, region, accountId, arn }) {
  const settings = getSettings()
  const existing = settings.masterCredentials || {}
  const credentials = {
    accessKeyId: accessKeyId ? encryptSecret(accessKeyId) : existing.accessKeyId || '',
    secretAccessKey: secretAccessKey ? encryptSecret(secretAccessKey) : existing.secretAccessKey || '',
    sessionToken: sessionToken ? encryptSecret(sessionToken) : existing.sessionToken || '',
    region: region !== undefined ? region : existing.region || '',
    accountId: accountId || existing.accountId || '',
    arn: arn || existing.arn || '',
    updatedAt: new Date().toISOString(),
  }
  store.setRaw('platform', { ...settings, masterCredentials: credentials })
  return credentials
}

export function clearMasterCredentials() {
  const settings = getSettings()
  store.setRaw('platform', { ...settings, masterCredentials: null })
}

export function getMasterCredentialsRaw() {
  const creds = getSettings().masterCredentials
  if (!creds) return null
  return {
    accessKeyId: decryptSecret(creds.accessKeyId),
    secretAccessKey: decryptSecret(creds.secretAccessKey),
    sessionToken: decryptSecret(creds.sessionToken),
    region: creds.region,
    accountId: creds.accountId,
    arn: creds.arn,
  }
}

/** 脱敏后的设置视图，供前端展示 */
export function getPublicSettings() {
  const settings = getSettings()
  const creds = settings.masterCredentials
  const credentials = creds
    ? {
        accessKeyId: maskSecret(decryptSecret(creds.accessKeyId)),
        region: creds.region,
        accountId: creds.accountId,
        arn: creds.arn,
        updatedAt: creds.updatedAt,
        configured: Boolean(decryptSecret(creds.accessKeyId) && decryptSecret(creds.secretAccessKey)),
      }
    : { configured: false }
  return { ...settings, masterCredentials: credentials }
}
