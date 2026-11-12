/**
 * aws-nuke 配置生成器（v3 schema）
 * 结构参考：blocklist / regions / resource-types / settings / accounts.<id>.{filters,presets,settings}
 * 这里手写 YAML 序列化，避免引入 yaml 依赖，同时保证输出可控、可审阅。
 */

const quote = (value) => {
  const str = String(value)
  return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function emitScalar(value, indent) {
  const pad = ' '.repeat(indent)
  if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${value}\n`
  return `${pad}${quote(value)}\n`
}

function emitList(values, indent) {
  if (!values || values.length === 0) return ' []\n'
  let out = '\n'
  for (const value of values) out += `${' '.repeat(indent)}- ${quote(value)}\n`
  return out
}

/** 过滤器既能是字符串，也能是 { property, type, value } 形式 */
function emitFilters(filters, indent) {
  const pad = ' '.repeat(indent)
  let out = ''
  for (const [resourceType, rules] of Object.entries(filters || {})) {
    if (!Array.isArray(rules) || rules.length === 0) continue
    out += `${pad}${resourceType}:\n`
    for (const rule of rules) {
      if (rule && typeof rule === 'object') {
        if (rule.property) {
          out += `${pad}  - property: ${quote(rule.property)}\n`
          if (rule.type) out += `${pad}    type: ${quote(rule.type)}\n`
          out += `${pad}    value: ${quote(rule.value ?? '')}\n`
        } else {
          out += `${pad}  - type: ${quote(rule.type || 'exact')}\n`
          out += `${pad}    value: ${quote(rule.value ?? '')}\n`
        }
      } else {
        out += `${pad}  - ${quote(rule)}\n`
      }
    }
  }
  return out
}

function emitSettings(settings, indent) {
  const pad = ' '.repeat(indent)
  let out = ''
  for (const [resourceType, values] of Object.entries(settings || {})) {
    const entries = Object.entries(values || {})
    if (entries.length === 0) continue
    out += `${pad}${resourceType}:\n`
    for (const [key, value] of entries) out += emitScalar(value, indent + 2).replace(/^ +/, `${pad}  ${key}: `)
  }
  return out
}

/**
 * 自动保护「aws-nuke 正在使用的组织角色」。
 * 原因：清理成员账号时会删到 IAMRole 本身；一旦角色或它的策略被删，
 * 当前 AssumeRole 会话立刻失去权限，后续资源全部删除失败。
 * 因此默认注入 4 类过滤器（角色 / 内联策略 / 策略附件 / 实例配置文件）。
 */
export function buildProtectionFilters(account, settings) {
  if (settings?.protectAuthRole === false) return {}
  if (account.authMode !== 'assume-role') return {}
  const role = account.roleName || settings?.organizationRoleName || 'OrganizationAccountAccessRole'
  return {
    IAMRole: [role],
    IAMRolePolicy: [{ property: 'RoleName', type: 'exact', value: role }],
    IAMRolePolicyAttachment: [{ property: 'RoleName', type: 'exact', value: role }],
    IAMInstanceProfile: [role],
  }
}

/** 用户规则在前，保护规则在后；按值去重，避免重复条目 */
function mergeFilters(userFilters = {}, protectionFilters = {}) {
  const merged = {}
  const seen = new Set()
  for (const [resourceType, rules] of Object.entries(userFilters)) {
    merged[resourceType] = []
    for (const rule of rules || []) {
      const key = `${resourceType}:${typeof rule === 'string' ? rule : `${rule.property}|${rule.type}|${rule.value}`}`
      if (seen.has(key)) continue
      seen.add(key)
      merged[resourceType].push(rule)
    }
  }
  for (const [resourceType, rules] of Object.entries(protectionFilters)) {
    if (!merged[resourceType]) merged[resourceType] = []
    for (const rule of rules) {
      const key = `${resourceType}:${typeof rule === 'string' ? rule : `${rule.property}|${rule.type}|${rule.value}`}`
      if (seen.has(key)) continue
      seen.add(key)
      merged[resourceType].push(rule)
    }
  }
  // 清掉空数组，保持 YAML 干净
  for (const key of Object.keys(merged)) {
    if (!merged[key].length) delete merged[key]
  }
  return merged
}

/** aws-nuke 要求 blocklist 非空；名单真空时用占位 ID 满足校验 */
const PLACEHOLDER_BLOCKLIST_ID = '000000000000'

function masterAccountIdOf(settings) {
  const id = String(settings?.masterCredentials?.accountId || '').trim()
  return /^\d{12}$/.test(id) ? id : ''
}

/**
 * 生成「这个账号」的配置时，是否要把主账号 ID 并入 blocklist。
 *
 * 三条规则：
 * 1. 目标账号就是主账号本身 —— 不并入。并进去等于禁止清理自己，会把用户的目标锁死；
 *    是否真的允许执行由执行前的 `masterProtectedForRun` 把关。
 * 2. 账号自身是组织跨账号（assume-role）—— 一定存在一个管理账号，必须保护，
 *    **不受全局「主账号使用方式」开关影响**，避免切换模式后组织账号的配置被改写。
 * 3. 其余情况跟随全局开关：organization 保护、standalone 不保护。
 */
export function shouldInjectMaster(settings, account) {
  const masterId = masterAccountIdOf(settings)
  if (!masterId) return false
  if (account && String(account.accountId || '') === masterId) return false
  if (account?.authMode === 'assume-role') return true
  return (settings?.masterCredentialMode || 'organization') === 'organization'
}

/**
 * 执行前判定：该账号是否因为「是主账号」而被禁止清理。
 * 与配置生成解耦——即使配置里没有把主账号写进 blocklist，这里依然能拦住。
 */
export function masterProtectedForRun(settings, account) {
  const masterId = masterAccountIdOf(settings)
  if (!masterId || String(account?.accountId || '') !== masterId) return false
  // 对自己 AssumeRole 本身不成立，出现即视为异常配置，直接拦
  if (account?.authMode === 'assume-role') return true
  return (settings?.masterCredentialMode || 'organization') === 'organization'
}

/**
 * 实际生效的黑名单 = 人工配置 + （按规则应保护的）主账号 ID。
 *
 * 主账号 ID 不依赖管理员在文本框里手填，由主账号凭证自动推导，
 * 保证黑名单最差也有一层真实保护，而不是退化成永不适用的占位 ID。
 */
export function resolveBlocklist(settings, account = null) {
  const list = []
  const seen = new Set()
  const push = (value) => {
    const id = String(value || '').trim()
    if (!/^\d{12}$/.test(id) || seen.has(id)) return
    seen.add(id)
    list.push(id)
  }
  for (const id of settings?.blocklist || []) push(id)
  if (shouldInjectMaster(settings, account)) push(masterAccountIdOf(settings))
  return list
}

/**
 * @param {object} params
 * @param {object} params.account   账号记录（含 accountId / rules）
 * @param {object} params.settings  平台全局设置
 * @returns {string} YAML 文本
 */
export function buildConfig({ account, settings }) {
  const rules = account.rules || {}
  const regions = (rules.regions && rules.regions.length ? rules.regions : settings.defaultRegions) || []
  const blocklist = resolveBlocklist(settings, account)
  const masterAccountId = masterAccountIdOf(settings)
  const masterAutoInjected =
    shouldInjectMaster(settings, account) &&
    !(settings.blocklist || []).map(String).includes(masterAccountId)
  const protection = buildProtectionFilters(account, settings)
  const filters = mergeFilters(rules.filters, protection)

  const lines = []
  lines.push('# ============================================================')
  lines.push(`# aws-nuke 配置 | 账号 ${account.name} (${account.accountId})`)
  lines.push('# 由 AWS Nuke 管理平台生成，可在平台的账号详情里编辑后保存')
  // 注意：这里不能写入当前时间——配置内容要可复现，否则「配置是否过期」的比对永远不成立。
  // 生成时间记录在账号记录的 configMeta.generatedAt 里。
  lines.push('# ============================================================')
  lines.push('')
  if (regions.length) {
    lines.push('regions:' + emitList(regions, 2))
  } else {
    // 区域完全留空：不替用户猜一个地区。aws-nuke 需要至少一个区域才能启动，
    // 因此这里只写出空列表并留注释，由执行前的校验拦住并提示用户去补。
    lines.push('# 尚未设置扫描区域：请在「账号编辑」里选择区域，或在「平台设置」配置默认扫描区域')
    lines.push('regions: []')
  }

  if (blocklist.length) {
    if (masterAutoInjected) {
      lines.push(`# 主账号 ${masterAccountId} 由平台自动并入黑名单：禁止作为清理目标`)
    }
    lines.push('blocklist:' + emitList(blocklist, 2))
  } else {
    // 既没有人工黑名单也没有主账号凭证（尚未完成部署）时才用占位 ID，避免 aws-nuke 拒绝启动
    lines.push('blocklist:' + emitList([PLACEHOLDER_BLOCKLIST_ID], 2))
  }

  const excludes = rules.resourceTypes?.excludes ?? settings.defaultExcludes ?? []
  const includes = rules.resourceTypes?.includes ?? []
  if (excludes.length || includes.length) {
    lines.push('resource-types:')
    if (includes.length) lines.push('  includes:' + emitList(includes, 4))
    if (excludes.length) lines.push('  excludes:' + emitList(excludes, 4))
  }

  const mergedSettings = { ...(settings.resourceSettings || {}), ...(rules.settings || {}) }
  if (Object.keys(mergedSettings).length) {
    lines.push('settings:')
    lines.push(emitSettings(mergedSettings, 2).trimEnd())
  }

  lines.push('')
  lines.push('accounts:')
  lines.push(`  ${quote(account.accountId)}:`)

  const filterBlock = emitFilters(filters, 6)
  if (filterBlock) {
    if (Object.keys(protection).length) {
      lines.push('    # 以下带 RoleName 的规则由平台自动追加：保护本次用于认证的组织角色')
    }
    lines.push('    filters:')
    lines.push(filterBlock.trimEnd())
  } else {
    lines.push('    filters: {}')
  }

  if (rules.presets?.length) lines.push('    presets:' + emitList(rules.presets, 6))

  return `${lines.join('\n')}\n`
}
