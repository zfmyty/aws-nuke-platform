/**
 * AWS 账号领域服务
 * 数据隔离规则：
 *   admin → 可见并可管理全部账号
 *   user  → 仅可见/管理自己提交的账号（ownerId === 自己）
 * 敏感信息：AKSK 使用 AES-256-GCM 加密落库，接口只返回掩码。
 */
import { collection } from '../../lib/store.js'
import { decryptSecret, encryptSecret, maskSecret } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import { getSettings } from '../settings/service.js'
import { getAwsProfile } from '../../lib/awsConfig.js'

const accounts = collection('accounts', { items: [] })
const ENVIRONMENTS = ['prod', 'staging', 'dev', 'sandbox', 'test']
export const AUTH_MODES = ['assume-role', 'aksk', 'profile']
export { ENVIRONMENTS }

/**
 * 解析目标账号的角色 ARN。
 * 组织模式下默认使用 Organizations 自动创建的 OrganizationAccountAccessRole，
 * 平台用「主账号 IAM 用户凭证」调用 sts:AssumeRole 进入该角色，再操作子账号资源。
 */
export function resolveRoleArn(account) {
  if (account.roleArn) return account.roleArn
  const roleName = account.roleName || 'OrganizationAccountAccessRole'
  const partition = account.partition === 'aws-cn' ? 'aws-cn' : 'aws'
  return `arn:${partition}:iam::${account.accountId}:role/${roleName}`
}

const ROLE_ARN_PATTERN = /^arn:aws(-cn|-us-gov|-iso)?:iam::(\d{12}):role\/[\w+=,.@/-]+$/

export function parseRoleArn(arn) {
  const match = String(arn || '').match(ROLE_ARN_PATTERN)
  if (!match) return null
  return { partition: `aws${match[1] || ''}`, accountId: match[2], arn: match[0] }
}

export function toPublicAccount(account, ownerLookup) {
  if (!account) return null
  const owner = ownerLookup?.(account.ownerId)
  return {
    id: account.id,
    name: account.name,
    accountId: account.accountId,
    alias: account.alias || '',
    environment: account.environment,
    description: account.description || '',
    defaultRegion: account.defaultRegion,
    authMode: account.authMode,
    roleArn: account.authMode === 'assume-role' ? resolveRoleArn(account) : '',
    roleName: account.roleName || '',
    externalId: account.externalId || '',
    assumeRoleSessionName: account.sessionName || '',
    baseProfile: account.baseProfile || '',
    baseCredentialSource: account.baseProfile ? 'profile' : account.accessKeyIdEnc ? 'account' : 'master',
    profile: account.profile || '',
    accessKeyIdMasked: account.accessKeyIdEnc ? maskSecret(decryptSecret(account.accessKeyIdEnc)) : '',
    hasSecret: Boolean(account.secretAccessKeyEnc),
    hasSessionToken: Boolean(account.sessionTokenEnc),
    assumeRoleArn: account.assumeRoleArn || '',
    rules: account.rules,
    status: account.status,
    lastRunAt: account.lastRunAt || null,
    lastRunStatus: account.lastRunStatus || null,
    lastRunMode: account.lastRunMode || null,
    aliasCheck: account.aliasCheck || null,
    ownerId: account.ownerId,
    ownerName: owner?.displayName || owner?.username || '未知用户',
    createdAt: account.createdAt,
    updatedAt: account.updatedAt || null,
    /** 配置文件元信息：source=generated|manual，用于前端提示「配置已冻结」 */
    configMeta: account.configMeta || null,
  }
}

function assertAccountId(accountId) {
  const value = String(accountId || '').trim()
  if (!/^\d{12}$/.test(value)) throw ApiError.badRequest('AWS 账号 ID 必须是 12 位数字')
  return value
}

/**
 * 校验「基础凭证 profile」：
 * - 必须是本机 ~/.aws 里真实存在的 profile
 * - 不能是「角色 profile」（config 里带 role_arn），否则会变成二次 AssumeRole
 */
function normalizeBaseProfile(profileName) {
  const name = String(profileName || '').trim()
  if (!name) return ''
  if (!/^[\w+=,.@-]{1,64}$/.test(name)) throw ApiError.badRequest('基础凭证 profile 名称不合法')

  const profile = getAwsProfile(name)
  if (!profile) {
    throw ApiError.badRequest(`本机 AWS 配置中不存在 profile「${name}」，请检查 ~/.aws/credentials 与 ~/.aws/config`)
  }
  if (profile.roleArn) {
    throw ApiError.badRequest(
      `profile「${name}」在 ~/.aws/config 中已配置 role_arn（${profile.roleArn}），作为基础凭证会触发二次 AssumeRole；` +
        '请改用只放 AK/SK 的 profile，或把账号认证方式改为「CLI Profile」直接使用该角色 profile',
    )
  }
  return name
}

/**
 * 规范化组织跨账号所需的角色配置。
 * 允许只给角色名（自动拼 ARN），也允许直接给完整 ARN（中国区等特殊 partition）。
 */
function normalizeRole(payload, { accountId }) {
  const settings = getSettings()
  const defaults = {
    roleName: settings.organizationRoleName || 'OrganizationAccountAccessRole',
    sessionName: settings.assumeRoleSessionName || 'aws-nuke-platform',
  }

  const rawArn = String(payload.roleArn || payload.assumeRoleArn || '').trim()
  let roleName = String(payload.roleName || '').trim()
  let partition = ['aws', 'aws-cn', 'aws-us-gov'].includes(payload.partition) ? payload.partition : 'aws'
  let roleArn = ''

  if (rawArn) {
    const parsed = parseRoleArn(rawArn)
    if (!parsed) {
      throw ApiError.badRequest(
        '角色 ARN 格式不正确，示例：arn:aws:iam::123456789012:role/OrganizationAccountAccessRole',
      )
    }
    if (parsed.accountId !== accountId) {
      throw ApiError.badRequest(
        `角色 ARN 中的账号 ID（${parsed.accountId}）与目标账号（${accountId}）不一致，跨账号会认证失败`,
      )
    }
    roleArn = parsed.arn
    partition = parsed.partition
    if (!roleName) roleName = parsed.arn.split('/').pop()
  } else {
    roleName = roleName || defaults.roleName
  }

  if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) throw ApiError.badRequest('角色名称不合法')

  const externalId = String(payload.externalId || '').trim()
  if (externalId && !/^[\w+=,.@:/-]{2,122}$/.test(externalId)) throw ApiError.badRequest('External ID 不合法')

  const sessionName = String(payload.sessionName || '').trim() || defaults.sessionName
  if (!/^[\w+=,.@-]{2,64}$/.test(sessionName)) {
    throw ApiError.badRequest('Session 名称不合法（2-64 位，允许字母数字与 +=,.@-）')
  }

  return { roleArn, roleName, partition, externalId, sessionName }
}

function normalizeRules(rules = {}) {
  const filters = {}
  for (const [resourceType, list] of Object.entries(rules.filters || {})) {
    if (!/^[A-Za-z0-9]+$/.test(resourceType)) continue
    const cleaned = (Array.isArray(list) ? list : [])
      .map((rule) => {
        if (typeof rule === 'string') return rule.trim()
        if (rule && typeof rule === 'object' && rule.value) {
          return {
            property: String(rule.property || 'Name').slice(0, 80),
            type: ['exact', 'glob', 'contains', 'regex'].includes(rule.type) ? rule.type : 'exact',
            value: String(rule.value).slice(0, 200),
          }
        }
        return null
      })
      .filter(Boolean)
      .slice(0, 200)
    if (cleaned.length) filters[resourceType] = cleaned
  }

  return {
    regions: (rules.regions || []).map((region) => String(region).trim()).filter(Boolean).slice(0, 40),
    filters,
    resourceTypes: {
      includes: (rules.resourceTypes?.includes || []).map(String).filter(Boolean).slice(0, 300),
      excludes: (rules.resourceTypes?.excludes || []).map(String).filter(Boolean).slice(0, 300),
    },
    presets: (rules.presets || []).map(String).filter(Boolean).slice(0, 20),
    settings: rules.settings && typeof rules.settings === 'object' ? rules.settings : {},
  }
}

export function listAccounts({ isAdmin, userId, search = '', environment = '', ownerId = '' }) {
  let items = accounts.all()
  if (!isAdmin) items = items.filter((account) => account.ownerId === userId)
  else if (ownerId) items = items.filter((account) => account.ownerId === ownerId)
  if (environment) items = items.filter((account) => account.environment === environment)
  if (search) {
    const kw = search.toLowerCase()
    items = items.filter((account) =>
      [account.name, account.accountId, account.alias, account.description]
        .join(' ')
        .toLowerCase()
        .includes(kw),
    )
  }
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function getAccountOrThrow(id) {
  const account = accounts.findById(id)
  if (!account) throw ApiError.notFound('账号不存在')
  return account
}

/** 取账号并校验访问权限（越权时返回 403） */
export function getAccountForUser(id, user) {
  const account = getAccountOrThrow(id)
  if (user.role !== 'admin' && account.ownerId !== user.id) {
    throw ApiError.forbidden('无权访问该账号')
  }
  return account
}

export function createAccount(payload, owner) {
  const accountId = assertAccountId(payload.accountId)
  if (accounts.find((item) => item.accountId === accountId)) {
    throw ApiError.conflict('该 AWS 账号已被提交过，请联系管理员处理')
  }
  const name = String(payload.name || '').trim()
  if (!name) throw ApiError.badRequest('请填写账号名称')
  const environment = ENVIRONMENTS.includes(payload.environment) ? payload.environment : 'dev'
  const authMode = AUTH_MODES.includes(payload.authMode) ? payload.authMode : 'assume-role'
  const role = normalizeRole(payload, { accountId })

  if (authMode === 'aksk' && (!payload.accessKeyId || !payload.secretAccessKey)) {
    throw ApiError.badRequest('选择 AK/SK 认证时必须填写 Access Key ID 与 Secret Access Key')
  }
  if (authMode === 'profile' && !payload.profile) {
    throw ApiError.badRequest('选择 Profile 认证时必须指定 AWS CLI profile 名称')
  }

  return accounts.insert({
    name: name.slice(0, 60),
    accountId,
    alias: String(payload.alias || '').slice(0, 60),
    environment,
    description: String(payload.description || '').slice(0, 400),
    defaultRegion: String(payload.defaultRegion || '').trim().slice(0, 32),
    authMode,
    profile: authMode === 'profile' ? String(payload.profile).slice(0, 60) : '',
    accessKeyIdEnc: payload.accessKeyId ? encryptSecret(payload.accessKeyId) : '',
    secretAccessKeyEnc: payload.secretAccessKey ? encryptSecret(payload.secretAccessKey) : '',
    sessionTokenEnc: payload.sessionToken ? encryptSecret(payload.sessionToken) : '',
    // 组织跨账号模式下的角色配置（非该模式时也保留，便于切换而不丢失）
    roleArn: authMode === 'assume-role' ? role.roleArn : '',
    roleName: role.roleName,
    partition: role.partition,
    externalId: role.externalId,
    sessionName: role.sessionName,
    baseProfile: authMode === 'assume-role' ? normalizeBaseProfile(payload.baseProfile) : '',
    rules: normalizeRules(payload.rules),
    status: 'ready',
    ownerId: owner.id,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMode: null,
  })
}

export function updateAccount(id, payload, user) {
  const account = getAccountForUser(id, user)
  const patch = {}

  if (payload.name !== undefined) {
    const name = String(payload.name).trim()
    if (!name) throw ApiError.badRequest('账号名称不能为空')
    patch.name = name.slice(0, 60)
  }
  if (payload.alias !== undefined) patch.alias = String(payload.alias).slice(0, 60)
  if (payload.description !== undefined) patch.description = String(payload.description).slice(0, 400)
  if (payload.environment !== undefined) {
    if (!ENVIRONMENTS.includes(payload.environment)) throw ApiError.badRequest('环境类型不合法')
    patch.environment = payload.environment
  }
  if (payload.defaultRegion !== undefined) patch.defaultRegion = String(payload.defaultRegion).trim().slice(0, 32)
  if (payload.authMode !== undefined) {
    if (!AUTH_MODES.includes(payload.authMode)) throw ApiError.badRequest('认证方式不合法')
    patch.authMode = payload.authMode
  }
  if (payload.profile !== undefined) patch.profile = String(payload.profile).slice(0, 60)
  if (payload.accessKeyId) patch.accessKeyIdEnc = encryptSecret(payload.accessKeyId)
  if (payload.secretAccessKey) patch.secretAccessKeyEnc = encryptSecret(payload.secretAccessKey)
  if (payload.sessionToken !== undefined) {
    patch.sessionTokenEnc = payload.sessionToken ? encryptSecret(payload.sessionToken) : ''
  }

  // 基础凭证 profile：空字符串表示回退到平台主凭证
  if (payload.baseProfile !== undefined) {
    patch.baseProfile = payload.baseProfile ? normalizeBaseProfile(payload.baseProfile) : ''
  }

  // 角色相关字段：任一变化都重新规范化，保证 ARN 与账号 ID 一致
  const roleTouched = ['roleArn', 'roleName', 'externalId', 'sessionName', 'partition'].some(
    (key) => payload[key] !== undefined,
  )
  if (roleTouched) {
    const role = normalizeRole(
      {
        roleArn: payload.roleArn !== undefined ? payload.roleArn : account.roleArn,
        roleName: payload.roleName !== undefined ? payload.roleName : account.roleName,
        externalId: payload.externalId !== undefined ? payload.externalId : account.externalId,
        sessionName: payload.sessionName !== undefined ? payload.sessionName : account.sessionName,
        partition: payload.partition !== undefined ? payload.partition : account.partition,
      },
      { accountId: account.accountId },
    )
    patch.roleArn = role.roleArn
    patch.roleName = role.roleName
    patch.partition = role.partition
    patch.externalId = role.externalId
    patch.sessionName = role.sessionName
  }

  if (payload.rules !== undefined) patch.rules = normalizeRules(payload.rules)

  // 允许管理员转移账号归属
  if (payload.ownerId !== undefined && user.role === 'admin') patch.ownerId = payload.ownerId

  return accounts.update(account.id, patch)
}

export function deleteAccount(id, user) {
  const account = getAccountForUser(id, user)
  accounts.remove(account.id)
  return account
}

/**
 * 记录配置文件元信息（生成时间 / 是否手工编辑）。
 * 只由 nuke/configFile.js 在写入配置后调用，避免账号模块反向依赖配置生成逻辑。
 */
export function setAccountConfigMeta(id, meta) {
  return accounts.update(id, { configMeta: meta })
}

/** 运行任务时使用：还原明文凭证 */
export function resolveCredentials(account) {
  return {
    authMode: account.authMode,
    accessKeyId: decryptSecret(account.accessKeyIdEnc),
    secretAccessKey: decryptSecret(account.secretAccessKeyEnc),
    sessionToken: decryptSecret(account.sessionTokenEnc),
    profile: account.profile,
    roleArn: account.authMode === 'assume-role' ? resolveRoleArn(account) : '',
    roleSessionName: account.sessionName || '',
    externalId: account.externalId || '',
    baseProfile: account.baseProfile || '',
    defaultRegion: account.defaultRegion,
  }
}

/** 供组织扫描判断「是否已接入」：返回已存在的账号 ID 集合 */
export function existingAccountIds() {
  return new Set(accounts.all().map((item) => item.accountId))
}

export function markRun(id, { status, mode }) {
  return accounts.update(id, {
    lastRunAt: new Date().toISOString(),
    lastRunStatus: status,
    lastRunMode: mode,
  })
}

/** 保存最近一次别名检测结果快照（详情页回显，检测一次更新一次，未检测为空） */
export function saveAliasCheck(accountId, snapshot) {
  return accounts.update(accountId, {
    aliasCheck: {
      checkedAt: new Date().toISOString(),
      ok: Boolean(snapshot.ok),
      hasAlias: Boolean(snapshot.hasAlias),
      aliases: Array.isArray(snapshot.aliases) ? snapshot.aliases.slice(0, 10) : [],
      error: snapshot.error || '',
      mode: snapshot.mode || '',
    },
  })
}

export function accountStats({ isAdmin, userId }) {
  const items = isAdmin ? accounts.all() : accounts.filter((account) => account.ownerId === userId)
  const byEnvironment = items.reduce((acc, item) => {
    acc[item.environment] = (acc[item.environment] || 0) + 1
    return acc
  }, {})
  return {
    total: items.length,
    byEnvironment,
    lastRunAt: items
      .map((item) => item.lastRunAt)
      .filter(Boolean)
      .sort()
      .pop() || null,
  }
}

export const ENV_LABELS = {
  prod: '生产',
  staging: '预发',
  dev: '开发',
  sandbox: '沙箱',
  test: '测试',
}
