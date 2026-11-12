/**
 * AWS Organizations 账号发现与批量接入。
 *
 * 主账号（管理账号）的 IAM 用户只要具备 organizations:ListAccounts，
 * 就能一次列出组织下所有子账号，无需逐台登录；平台据此提供「扫描 → 勾选 → 导入」，
 * 省掉手抄 12 位账号 ID 的环节。
 *
 * 注意：扫描只读，不碰任何账号内资源；真正的操作（建别名、清理）仍需 AssumeRole 到目标账号。
 */
import { runCommand, resolveAwsCli } from '../../lib/shell.js'
import { ApiError } from '../../lib/errors.js'
import { getMasterCredentialsRaw, getSettings } from '../settings/service.js'
import { resolveBlocklist } from '../nuke/configBuilder.js'
import { credentialEnv } from './assume.js'
import { createAccount, existingAccountIds, ENVIRONMENTS } from './service.js'
import { suggestAlias } from './alias.js'
import { findUserById } from '../users/service.js'

/** 扫描组织账号时用主账号凭证（组织 API 只能由管理账号调用） */
function masterEnv(master) {
  // AWS CLI 调 organizations 必须带区域；主账号凭证没填区域时用 us-east-1 兜底。
  // 这只是「平台查询组织列表」用的 CLI 参数，不进入任何账号的清理配置，与区域留空策略不冲突。
  const region = master.region || 'us-east-1'
  return { env: credentialEnv(master, region), region }
}

function explainOrgError(text) {
  const raw = String(text || '')
  const t = raw.toLowerCase()
  if (t.includes('awsorganizationsnotinuse')) {
    return '当前主账号不在任何 AWS Organization 中；组织功能需先在 AWS 控制台创建组织'
  }
  if (t.includes('accessdenied') || t.includes('not authorized')) {
    return '主账号 IAM 用户缺少 organizations:ListAccounts 权限，请为其附加相应策略'
  }
  if (t.includes('invalidclienttokenid')) return '主账号 AK/SK 无效或已禁用'
  if (t.includes('could not connect') || t.includes('timeout') || t.includes('network')) {
    return '网络不可达，请检查代理或出网策略'
  }
  return raw.trim().slice(0, 300) || '未知错误'
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 列出组织下的全部账号，并标注三类状态：
 *   imported  已在平台接入
 *   isMaster  平台主账号（永远是清理目标之外的账号，不能导入）
 *   blocked   命中平台黑名单
 */
export async function scanOrganization() {
  const master = getMasterCredentialsRaw()
  if (!master || !master.accessKeyId) {
    throw ApiError.badRequest('尚未配置主账号凭证：请先在「部署向导」填写主账号 IAM 用户的 AK/SK')
  }

  const { env } = masterEnv(master)
  const result = await runCommand(resolveAwsCli(), ['organizations', 'list-accounts', '--output', 'json'], {
    timeoutMs: 60000,
    env,
  })
  if (result.code !== 0) {
    throw ApiError.badRequest(`扫描组织账号失败：${explainOrgError(result.stderr || result.stdout)}`)
  }

  const payload = parseJson(result.stdout)
  if (!payload || !Array.isArray(payload.Accounts)) {
    throw ApiError.badRequest('无法解析 organizations list-accounts 的返回结果')
  }

  const settings = getSettings()
  const existing = existingAccountIds()
  const blocked = new Set(resolveBlocklist(settings))
  const defaultRole = settings.organizationRoleName || 'OrganizationAccountAccessRole'

  const accounts = payload.Accounts.map((item) => {
    const isMaster = item.Id === master.accountId
    return {
      accountId: item.Id,
      name: item.Name || item.Id,
      status: item.Status || '',
      joinedMethod: item.JoinedMethod || '',
      joinedAt: item.JoinedTimestamp || null,
      imported: existing.has(item.Id),
      isMaster,
      blocked: blocked.has(item.Id),
      selectable: !isMaster && item.Status === 'ACTIVE',
      roleName: defaultRole,
      suggestedAlias: suggestAlias({ name: item.Name, accountId: item.Id }),
    }
  })

  // 未接入的排前面，主账号沉底，便于一眼看出该收哪些
  accounts.sort((a, b) => {
    if (a.isMaster !== b.isMaster) return a.isMaster ? 1 : -1
    if (a.imported !== b.imported) return a.imported ? 1 : -1
    return String(a.accountId).localeCompare(String(b.accountId))
  })

  return {
    scannedAt: new Date().toISOString(),
    masterAccountId: master.accountId,
    defaultRole,
    // 注意：不再返回 defaultRegion 预填值——区域由用户在导入弹窗里自己决定填不填
    total: accounts.length,
    imported: accounts.filter((item) => item.imported).length,
    accounts,
  }
}

/**
 * 批量接入选中的账号（只写平台数据，不触达 AWS）
 *
 * @param {Array<{accountId: string, name?: string, alias?: string}>} items 勾选的账号
 * @param {object} owner 当前用户
 * @param {object} options 导入配置：environment / defaultRegion / roleName / description / ownerId
 */
export function importAccounts(items, owner, options = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === 'string' ? { accountId: item } : item || {}))
    .filter((item) => /^\d{12}$/.test(String(item.accountId || '').trim()))
  if (!list.length) throw ApiError.badRequest('请至少选择一个账号')

  const settings = getSettings()
  const master = getMasterCredentialsRaw()
  const masterId = master?.accountId || ''
  const existing = existingAccountIds()

  // ---- 导入配置（前端弹窗里由用户显式选择，不再写死默认值）----
  const environment = String(options.environment || '').trim()
  if (environment && !ENVIRONMENTS.includes(environment)) {
    throw ApiError.badRequest(`环境取值不合法：${environment}`)
  }
  // 区域留空即留空：不替用户猜一个默认值，导入后可在账号编辑页补
  const defaultRegion = String(options.defaultRegion || '').trim()
  if (defaultRegion && !/^[a-z0-9-]{2,32}$/.test(defaultRegion)) {
    throw ApiError.badRequest(`区域格式不正确：${defaultRegion}`)
  }

  const roleName = String(options.roleName || settings.organizationRoleName || 'OrganizationAccountAccessRole').trim()
  if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) throw ApiError.badRequest(`角色名不合法：${roleName}`)

  const description = String(options.description || '').trim().slice(0, 400)

  // 归属用户：管理员可指派给他人，缺省归属自己
  let targetOwner = owner
  if (options.ownerId && options.ownerId !== owner.id) {
    const picked = findUserById(options.ownerId)
    if (!picked) throw ApiError.badRequest('指定的归属用户不存在')
    targetOwner = picked
  }

  const created = []
  const skipped = []

  for (const item of list) {
    const accountId = String(item.accountId).trim()
    if (accountId === masterId) {
      skipped.push({ accountId, reason: '平台主账号不允许接入为清理目标' })
      continue
    }
    if (existing.has(accountId)) {
      skipped.push({ accountId, reason: '已在平台中接入' })
      continue
    }
    try {
      const account = createAccount(
        {
          name: String(item.name || '').trim() || `account-${accountId}`,
          accountId,
          alias: String(item.alias || '').trim(),
          authMode: 'assume-role',
          roleName,
          defaultRegion,
          // 导入时填的区域同时作为该账号的扫描区域，避免生成出空 regions 的配置
          rules: defaultRegion ? { regions: [defaultRegion] } : {},
          environment: environment || 'test',
          description,
        },
        targetOwner,
      )
      existing.add(accountId)
      created.push({ id: account.id, accountId, name: account.name, suggestedAlias: suggestAlias(account) })
    } catch (error) {
      skipped.push({ accountId, reason: error.message })
    }
  }

  return { created, skipped, options: { environment: environment || 'test', defaultRegion, roleName, ownerId: targetOwner.id } }
}
