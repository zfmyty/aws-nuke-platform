/**
 * 子账号 CLI 凭证解析统一出口。
 *
 * 三种 authMode 都要能拿到「能在目标账号里执行 AWS CLI」的凭证：
 *   assume-role：主账号基础凭证 → sts:AssumeRole → 临时凭证（组织默认角色）
 *   aksk       ：账号自带的 AK/SK
 *   profile    ：本机 ~/.aws 里的 profile
 *
 * 注意：这里刻意与 system/service.js 的 verifyAccountAccess 保持同一套 base 优先级，
 * 后续若要合并请一起改，避免两处口径漂移（baseProfile > 账号 AK/SK > 平台主凭证 > 平台 profile）。
 */
import { runCommand, resolveAwsCli, awsProfileExists } from '../../lib/shell.js'
import { ApiError } from '../../lib/errors.js'
import { getSettings, getMasterCredentialsRaw } from '../settings/service.js'
import { resolveCredentials, resolveRoleArn } from './service.js'

export function credentialEnv(credential, region) {
  const env = {
    AWS_ACCESS_KEY_ID: credential.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
  }
  if (credential.sessionToken) env.AWS_SESSION_TOKEN = credential.sessionToken
  if (region) {
    env.AWS_DEFAULT_REGION = region
    env.AWS_REGION = region
  }
  return env
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * AWS CLI 子命令（sts / iam / organizations）必须带区域，且分区要对：
 * 中国区不能用 us-east-1。这里只服务于「平台自己调 CLI」，**不影响 aws-nuke 的扫描范围**，
 * 所以不能因为「区域留空」就把这段删掉——CLI 没有区域会直接报错，整条链路（测试连接、别名检查）都会断。
 */
export function iamRegion(account) {
  if (account.defaultRegion) return account.defaultRegion
  if (account.partition === 'aws-cn') return 'cn-north-1'
  if (account.partition === 'aws-us-gov') return 'us-gov-west-1'
  return 'us-east-1'
}

/**
 * 解析可在目标账号内执行 CLI 的凭证
 * @returns {Promise<{mode: string, env?: object, extraArgs?: string[], roleArn?: string, sessionName?: string}>}
 */
export async function resolveCliAuth(account) {
  const settings = getSettings()
  const creds = resolveCredentials(account)

  if (creds.authMode === 'aksk') {
    if (!creds.accessKeyId || !creds.secretAccessKey) {
      throw ApiError.badRequest('该账号未保存 AK/SK，无法在目标账号内执行操作')
    }
    return { mode: 'aksk', env: credentialEnv(creds, account.defaultRegion) }
  }

  if (creds.authMode === 'profile') {
    if (!creds.profile) throw ApiError.badRequest('该账号未指定 CLI profile')
    if (!awsProfileExists(creds.profile)) {
      throw ApiError.badRequest(`本机不存在 profile「${creds.profile}」`)
    }
    return { mode: 'profile', extraArgs: ['--profile', creds.profile] }
  }

  // ---- 组织跨账号：AssumeRole ----
  const roleArn = creds.roleArn || resolveRoleArn(account)
  const sessionName = creds.roleSessionName || settings.assumeRoleSessionName || 'aws-nuke-platform'
  const args = ['sts', 'assume-role', '--role-arn', roleArn, '--role-session-name', sessionName, '--output', 'json']
  if (creds.externalId) args.push('--external-id', creds.externalId)

  const accountKeys =
    creds.accessKeyId && creds.secretAccessKey
      ? { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken }
      : null
  const base = accountKeys || getMasterCredentialsRaw()

  let env
  if (creds.baseProfile) {
    if (!awsProfileExists(creds.baseProfile)) {
      throw ApiError.badRequest(`本机不存在基础凭证 profile「${creds.baseProfile}」`)
    }
    args.push('--profile', creds.baseProfile)
  } else if (base && base.accessKeyId && base.secretAccessKey) {
    env = credentialEnv(base, account.defaultRegion)
  } else if (settings.awsProfile && awsProfileExists(settings.awsProfile)) {
    args.push('--profile', settings.awsProfile)
  } else {
    throw ApiError.badRequest('尚未配置主账号凭证：请先在「部署向导」填写主账号 IAM 用户的 AK/SK')
  }

  const result = await runCommand(resolveAwsCli(), args, { timeoutMs: 30000, env })
  if (result.code !== 0) {
    throw ApiError.badRequest(`AssumeRole 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  }

  const payload = safeJson(result.stdout)
  const temporary = payload?.Credentials
  if (!temporary) throw ApiError.badRequest('AssumeRole 未返回临时凭证')

  return {
    mode: 'assume-role',
    roleArn,
    sessionName,
    expiration: temporary.Expiration || null,
    env: credentialEnv(
      {
        accessKeyId: temporary.AccessKeyId,
        secretAccessKey: temporary.SecretAccessKey,
        sessionToken: temporary.SessionToken,
      },
      account.defaultRegion,
    ),
  }
}

/** 在目标账号内执行一条 AWS CLI 命令 */
export async function runInAccount(account, argv, { timeoutMs = 30000 } = {}) {
  const auth = await resolveCliAuth(account)
  const args = [...argv, '--region', iamRegion(account)]
  if (auth.extraArgs) args.push(...auth.extraArgs)
  const result = await runCommand(resolveAwsCli(), args, { timeoutMs, env: auth.env })
  return { ...result, mode: auth.mode, roleArn: auth.roleArn }
}
