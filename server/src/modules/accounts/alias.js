/**
 * AWS 账号别名（account alias）自助配置。
 *
 * 为什么需要它：aws-nuke 默认要求目标账号具备别名并做二次确认（alias check），
 * 没有别名的账号只能靠 `--no-alias-check` 跳过，等于放弃了一道防误删的闸门。
 * 组织模式下，主账号 IAM 用户 AssumeRole 进入 OrganizationAccountAccessRole 后，
 * 只要该角色带有 iam:CreateAccountAlias 权限（AdministratorAccess 默认就有），
 * 即可为成员账号创建别名，无需登录子账号。
 */
import { ApiError } from '../../lib/errors.js'
import { runInAccount } from './assume.js'

/** IAM 别名规则：3-63 位，小写字母/数字/连字符，首尾必须是字母或数字 */
const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/

export function normalizeAlias(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
}

export function validateAlias(input) {
  const alias = normalizeAlias(input)
  if (!alias) throw ApiError.badRequest('别名不能为空')
  if (alias.length < 3 || alias.length > 63) throw ApiError.badRequest('别名长度需在 3-63 个字符之间')
  if (!ALIAS_PATTERN.test(alias)) {
    throw ApiError.badRequest('别名只能包含小写字母、数字和连字符，且不能以连字符开头或结尾')
  }
  return alias
}

/** 按账号名生成一个合规的候选别名，用户可改 */
export function suggestAlias(account) {
  const source = String(account.alias || account.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  let candidate = source
  if (!candidate || candidate.length < 3) candidate = `nuke-${account.accountId}`
  candidate = candidate.slice(0, 63).replace(/-+$/, '')
  if (candidate.length < 3) candidate = `nuke-${account.accountId}`
  return candidate
}

/** 把 AWS CLI 的报错翻译成可执行建议 */
function explainAliasError(text) {
  const raw = String(text || '')
  const t = raw.toLowerCase()
  if (t.includes('entityalreadyexists')) return '该别名已被占用：AWS 账号别名全局唯一，请换一个'
  if (t.includes('limitexceeded')) return '该账号已有别名：AWS 每个账号只允许一个别名，需先删除旧别名'
  if (t.includes('not authorized') || t.includes('accessdenied')) {
    return '角色缺少 iam:CreateAccountAlias 权限：请确认 OrganizationAccountAccessRole 附加了 AdministratorAccess，或补一条允许该操作的策略'
  }
  if (t.includes('could not find profile') || t.includes('profilename')) return '未找到指定的 AWS CLI profile'
  if (t.includes('invalidclienttokenid')) return '基础凭证无效：主账号 AK/SK 错误或已禁用'
  if (t.includes('is not authorized to perform sts:assumerole')) {
    return '主账号 IAM 用户没有 sts:AssumeRole 权限，或目标角色的信任策略未包含该用户'
  }
  if (t.includes('could not connect') || t.includes('timeout') || t.includes('network')) {
    return '网络不可达，请检查代理或出网策略'
  }
  return raw.trim().slice(0, 300) || '未知错误'
}

function parseAliases(stdout) {
  try {
    const data = JSON.parse(stdout)
    return Array.isArray(data.AccountAliases) ? data.AccountAliases : []
  } catch {
    return []
  }
}

/** 读取目标账号当前别名 */
export async function readAlias(account) {
  const result = await runInAccount(account, ['iam', 'list-account-aliases', '--output', 'json'], {
    timeoutMs: 30000,
  })

  if (result.code !== 0) {
    return {
      ok: false,
      aliases: [],
      mode: result.mode,
      error: explainAliasError(result.stderr || result.stdout),
    }
  }

  const aliases = parseAliases(result.stdout)
  return { ok: true, aliases, mode: result.mode, hasAlias: aliases.length > 0, suggested: suggestAlias(account) }
}

/** 为目标账号创建别名 */
export async function createAlias(account, input) {
  const alias = validateAlias(input)
  const result = await runInAccount(account, ['iam', 'create-account-alias', '--account-alias', alias], {
    timeoutMs: 30000,
  })

  if (result.code !== 0) {
    throw ApiError.badRequest(explainAliasError(result.stderr || result.stdout))
  }

  return { ok: true, alias, mode: result.mode }
}
