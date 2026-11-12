/**
 * 系统部署服务：环境自检、AWS CLI 安装、主账号凭证配置、二进制校验。
 * 「一键部署」由前端按步骤编排，后端提供原子能力，避免黑盒脚本。
 */
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { config } from '../../config/index.js'
import { runCommand, resolveAwsCli, resolveAwsNuke, resolvePowerShell, awsNukeAvailable, awsProfileExists } from '../../lib/shell.js'
import { getSettings, saveMasterCredentials, clearMasterCredentials, getPublicSettings, getMasterCredentialsRaw } from '../settings/service.js'
import { resolveCredentials, resolveRoleArn } from '../accounts/service.js'
import { startJob, JOB_KINDS } from '../jobs/runner.js'
import { ApiError } from '../../lib/errors.js'

let versionCache = { at: 0, data: null }

/** 二进制被替换后调用，让下次自检重新读取版本 */
export function clearVersionCache() {
  versionCache = { at: 0, data: null }
}

async function nukeVersion() {
  if (!awsNukeAvailable()) return { installed: false, version: null, path: resolveAwsNuke() }
  const result = await runCommand(resolveAwsNuke(), ['version'], { timeoutMs: 15000 })
  const text = `${result.stdout}${result.stderr}`.trim()
  const match = text.match(/v?\d+\.\d+\.\d+[\w.-]*/)
  return {
    installed: result.code === 0,
    version: match ? match[0] : text.split('\n')[0] || null,
    path: resolveAwsNuke(),
    raw: result.code === 0 ? undefined : text.slice(0, 400),
  }
}

async function awsCliInfo() {
  const bin = resolveAwsCli()
  const result = await runCommand(bin, ['--version'], { timeoutMs: 15000 })
  const text = `${result.stdout}${result.stderr}`.trim()
  const match = text.match(/aws-cli\/([\d.]+)/)
  return {
    installed: result.code === 0,
    version: match ? match[1] : null,
    path: bin,
    error: result.code === 0 ? undefined : text.slice(0, 200),
  }
}

async function callerIdentity(profile, region) {
  const bin = resolveAwsCli()
  const args = ['sts', 'get-caller-identity', '--output', 'json']
  if (profile) args.push('--profile', profile)
  if (region) args.push('--region', region)
  const result = await runCommand(bin, args, { timeoutMs: 25000 })
  if (result.code !== 0) {
    return { ok: false, error: (result.stderr || result.stdout).trim().slice(0, 500) }
  }
  try {
    const data = JSON.parse(result.stdout)
    return { ok: true, accountId: data.Account, arn: data.Arn, userId: data.UserId }
  } catch {
    return { ok: false, error: '无法解析 STS 返回结果' }
  }
}

/** 校验失败时回滚刚写入的 profile，避免无效凭证留在本机 */
function rollbackProfile(profileName) {
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials')
  try {
    const content = fs.readFileSync(file, 'utf8')
    const blocks = content.split(/\r?\n(?=\[)/)
    const kept = blocks.filter((block) => block.trim().split(/\r?\n/)[0].trim() !== `[${profileName}]`)
    if (kept.length !== blocks.length) {
      let output = kept.join('\n')
      if (!output.endsWith('\n')) output += '\n'
      fs.writeFileSync(file, output, 'utf8')
    }
  } catch {
    /* 回滚失败不影响主流程 */
  }
}

export async function checkEnvironment({ refresh = false } = {}) {
  if (!refresh && versionCache.data && Date.now() - versionCache.at < 10000) {
    // 权限状态是运行期事实，不受二进制探测缓存影响，每次读取都实时判定
    return { ...versionCache.data, platform: { ...versionCache.data.platform, elevated: isElevated() } }
  }

  const [nuke, cli] = await Promise.all([nukeVersion(), awsCliInfo()])
  const settings = getPublicSettings()
  const credentialsReady = Boolean(settings.masterCredentials?.configured)
  /** 单账号直连模式：凭证属于待清理账号本身，平台不要求配置主账号凭证 */
  const masterMode = settings.masterCredentialMode === 'standalone' ? 'standalone' : 'organization'
  const credentialStepReady = masterMode === 'standalone' ? true : credentialsReady
  const credentialHint =
    masterMode === 'standalone'
      ? '单账号直连模式，无需主账号凭证，在账号管理中为每个账号填 AK/SK'
      : credentialsReady
        ? `已配置 · ${settings.masterCredentials.accountId}`
        : '尚未配置 AK/SK'

  const data = {
    checkedAt: new Date().toISOString(),
    platform: {
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      hostname: os.hostname(),
      port: config.port,
      dataDir: config.paths.dataDir,
      elevated: isElevated(),
    },
    awsNuke: nuke,
    awsCli: cli,
    credentials: {
      configured: credentialsReady,
      mode: masterMode,
      profile: settings.awsProfile,
      accountId: settings.masterCredentials?.accountId || '',
      updatedAt: settings.masterCredentials?.updatedAt || null,
    },
    steps: [
      {
        id: 'binary',
        title: 'aws-nuke 可执行文件',
        ready: nuke.installed,
        hint: nuke.installed ? `已就绪 · ${nuke.version}` : '未找到 runtime/bin/aws-nuke.exe',
      },
      {
        id: 'cli',
        title: 'AWS CLI v2',
        ready: cli.installed,
        hint: cli.installed ? `已安装 · ${cli.version}` : '未安装，可使用一键安装',
      },
      {
        id: 'credentials',
        title: '主账号凭证',
        ready: credentialStepReady,
        optional: masterMode === 'standalone',
        hint: credentialHint,
      },
      {
        id: 'profile',
        title: 'CLI Profile',
        ready: cli.installed && Boolean(settings.awsProfile),
        hint: settings.awsProfile ? `profile: ${settings.awsProfile}` : '未指定 profile',
      },
    ],
  }
  data.ready = data.steps.every((step) => step.ready)
  versionCache = { at: Date.now(), data }
  return data
}

/**
 * 判断当前进程是否以管理员（提升）权限运行。
 *
 * 不用 `net session`：Server 服务未启动时该命令会失败，管理员进程会被误判为普通权限。
 * 主路径通过 .NET 的 WindowsPrincipal 询问「当前令牌是否处于管理员角色」——
 * 未提权的管理员账户返回 False，提权后返回 True，与 UAC 实际效果一致；
 * 该判定不依赖任何外部 exe，也不会被沙箱的命令黑名单影响。
 */
function isElevated() {
  if (process.platform !== 'win32') return process.getuid?.() === 0

  const ps = [
    '$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    'if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { "1" } else { "0" }',
  ].join('; ')

  try {
    const out = execSync(
      `"${resolvePowerShell()}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${ps}"`,
      {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
        windowsHide: true,
      },
    )
    const text = Buffer.from(out).toString('latin1').trim()
    if (text === '1' || text === '0') return text === '1'
  } catch {
    /* PowerShell 不可用时走兜底 */
  }

  // 兜底：解析 whoami 的完整性级别（S-1-16-12288 = High，S-1-16-16384 = System）
  try {
    const out = execSync('whoami /groups /fo csv /nh', {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    })
    const text = Buffer.from(out).toString('latin1')
    if (!text.trim()) return false
    return /S-1-16-(12288|16384)/.test(text)
  } catch {
    return false
  }
}

/** 一键安装 AWS CLI：调用官方 install.ps1，输出通过任务日志实时回传 */
export function installAwsCli(user) {
  const script = 'irm https://awscli.amazonaws.com/v2/install.ps1 | iex'
  return startJob({
    kind: JOB_KINDS.INSTALL_CLI,
    title: '安装 AWS CLI v2',
    ownerId: user.id,
    createdBy: user.username,
    bin: resolvePowerShell(),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    meta: { step: 'aws-cli' },
  })
}

/**
 * 写入 profile 并调用 STS 校验身份。
 * 与 `aws configure` 的交互式流程对齐：只要求 AK/SK，区域、Session Token 均可留空，
 * 留空时不写 region，沿用 CLI 已有默认值。
 */
export async function configureCredentials({ accessKeyId, secretAccessKey, sessionToken, region, profile }) {
  const bin = resolveAwsCli()
  const version = await awsCliInfo()
  if (!version.installed) throw ApiError.badRequest('尚未安装 AWS CLI，请先完成第一步安装')

  const ak = String(accessKeyId || '').trim()
  const sk = String(secretAccessKey || '').trim()
  if (!/^[A-Z0-9]{16,32}$/.test(ak)) throw ApiError.badRequest('Access Key ID 格式不正确')
  if (sk.length < 20) throw ApiError.badRequest('Secret Access Key 格式不正确')

  const profileName = profile || getSettings().awsProfile || 'nuke-operator'
  const regionName = String(region || '').trim()

  const entries = [
    ['aws_access_key_id', ak],
    ['aws_secret_access_key', sk],
  ]
  if (sessionToken) entries.push(['aws_session_token', sessionToken])

  for (const [key, value] of entries) {
    const result = await runCommand(bin, ['configure', 'set', key, value, '--profile', profileName], {
      timeoutMs: 20000,
    })
    if (result.code !== 0) {
      throw ApiError.badRequest(`写入 CLI 配置失败：${(result.stderr || result.stdout).slice(0, 300)}`)
    }
  }
  // 区域按需写入：留空表示沿用 CLI 默认，不额外生成配置项
  if (regionName) {
    await runCommand(bin, ['configure', 'set', 'region', regionName, '--profile', profileName], { timeoutMs: 20000 })
  }

  const identity = await callerIdentity(profileName, regionName || undefined)
  if (!identity.ok) {
    rollbackProfile(profileName)
    throw ApiError.badRequest(`凭证校验失败：${identity.error}`)
  }

  saveMasterCredentials({
    accessKeyId: ak,
    secretAccessKey: sk,
    sessionToken,
    region: regionName,
    accountId: identity.accountId,
    arn: identity.arn,
  })
  versionCache = { at: 0, data: null }
  return { identity, profile: profileName, region: regionName }
}

export async function verifyExistingCredentials() {
  const settings = getSettings()
  const creds = settings.masterCredentials
  if (!creds) throw ApiError.badRequest('尚未配置主账号凭证')
  const identity = await callerIdentity(settings.awsProfile, creds.region)
  return { identity, profile: settings.awsProfile, region: creds.region }
}

/** 把 AWS 的原始报错翻译成可执行的处理建议 */
export function explainAwsError(text) {
  const raw = String(text || '')
  const t = raw.toLowerCase()
  if (t.includes('not authorized to perform sts:assumerole') || t.includes('is not authorized to perform: sts:assumerole')) {
    return '主账号 IAM 用户没有 sts:AssumeRole 权限，或目标角色的信任策略未包含该用户'
  }
  if (t.includes('multifactor') || t.includes('mfa')) {
    return '目标角色要求 MFA 校验，本平台无法提供动态验证码；请为自动化用户放宽 MFA 条件'
  }
  if (t.includes('invalidclienttokenid')) return '基础凭证无效：AK/SK 错误或已被禁用'
  if (t.includes('signaturedoesnotmatch')) return 'Secret Access Key 不正确'
  if (t.includes('accessdenied')) return '访问被拒绝：请检查 IAM 权限或角色信任策略'
  if (t.includes('is not authorized')) return '当前身份缺少所需权限'
  if (t.includes('could not find profile') || t.includes('profilename') || t.includes('profile could not be found')) {
    return '未找到指定的 AWS CLI profile：请先在「部署向导」保存主账号凭证，或检查 profile 名称'
  }
  if (t.includes('could not connect') || t.includes('timeout') || t.includes('network')) return '网络不可达，请检查代理或出网策略'
  return raw.trim().slice(0, 400) || '未知错误'
}

/** 构造给 AWS CLI 的临时环境变量（隔离本机已有的默认凭证） */
function credentialEnv(credential, region) {
  // 注意：不要设置空的 AWS_PROFILE，CLI 会把它当成名为 "" 的 profile 直接报错；
  // 环境变量优先级高于 profile，因此不设置即可安全覆盖本机默认凭证。
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

/**
 * 测试账号连通性：
 * - assume-role：基础凭证 → sts:AssumeRole → 用临时凭证确认身份（验证信任策略是否真的通）
 * - aksk / profile：直接用对应凭证确认身份
 */
export async function verifyAccountAccess(account) {
  const cli = await awsCliInfo()
  if (!cli.installed) throw ApiError.badRequest('尚未安装 AWS CLI，无法测试连接')

  const settings = getSettings()
  const region = account.defaultRegion || ''
  const creds = resolveCredentials(account)
  const identityArgs = ['sts', 'get-caller-identity', '--output', 'json']
  if (region) identityArgs.push('--region', region)

  if (creds.authMode !== 'assume-role') {
    let env
    const extra = []
    if (creds.authMode === 'aksk') {
      if (!creds.accessKeyId || !creds.secretAccessKey) throw ApiError.badRequest('该账号未保存 AK/SK')
      env = credentialEnv(creds, region)
    } else {
      if (!creds.profile) throw ApiError.badRequest('该账号未指定 CLI profile')
      extra.push('--profile', creds.profile)
    }
    const result = await runCommand(resolveAwsCli(), [...identityArgs, ...extra], { timeoutMs: 25000, env })
    if (result.code !== 0) {
      return { ok: false, mode: creds.authMode, error: explainAwsError(result.stderr || result.stdout) }
    }
    const data = safeJson(result.stdout)
    if (!data) return { ok: false, mode: creds.authMode, error: '无法解析 STS 返回结果' }
    return {
      ok: true,
      mode: creds.authMode,
      accountId: data.Account,
      arn: data.Arn,
      matched: data.Account === account.accountId,
    }
  }

  // ---- 组织跨账号：AssumeRole ----
  const roleArn = creds.roleArn || resolveRoleArn(account)
  const sessionName = creds.roleSessionName || settings.assumeRoleSessionName || 'aws-nuke-platform'
  const assumeArgs = [
    'sts',
    'assume-role',
    '--role-arn',
    roleArn,
    '--role-session-name',
    sessionName,
    '--output',
    'json',
  ]
  if (region) assumeArgs.push('--region', region)
  if (creds.externalId) assumeArgs.push('--external-id', creds.externalId)

  const accountKeys =
    creds.accessKeyId && creds.secretAccessKey
      ? { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken }
      : null
  const base = accountKeys || getMasterCredentialsRaw()

  let env
  if (creds.baseProfile) {
    if (!awsProfileExists(creds.baseProfile)) {
      throw ApiError.badRequest(`本机不存在 profile「${creds.baseProfile}」，请检查 ~/.aws/credentials 与 ~/.aws/config`)
    }
    assumeArgs.push('--profile', creds.baseProfile)
  } else if (base && base.accessKeyId && base.secretAccessKey) {
    env = credentialEnv(base, region)
  } else if (settings.awsProfile && awsProfileExists(settings.awsProfile)) {
    assumeArgs.push('--profile', settings.awsProfile)
  } else {
    throw ApiError.badRequest('尚未配置主账号凭证：请先在「部署向导」填写主账号 IAM 用户的 AK/SK')
  }

  const assumed = await runCommand(resolveAwsCli(), assumeArgs, { timeoutMs: 30000, env })
  if (assumed.code !== 0) {
    return {
      ok: false,
      mode: 'assume-role',
      roleArn,
      sessionName,
      error: explainAwsError(assumed.stderr || assumed.stdout),
    }
  }

  const payload = safeJson(assumed.stdout)
  const temporary = payload?.Credentials
  if (!temporary) return { ok: false, mode: 'assume-role', roleArn, sessionName, error: 'AssumeRole 未返回临时凭证' }

  const identity = await runCommand(resolveAwsCli(), identityArgs, {
    timeoutMs: 25000,
    env: credentialEnv(
      {
        accessKeyId: temporary.AccessKeyId,
        secretAccessKey: temporary.SecretAccessKey,
        sessionToken: temporary.SessionToken,
      },
      region,
    ),
  })
  if (identity.code !== 0) {
    return {
      ok: false,
      mode: 'assume-role',
      roleArn,
      sessionName,
      error: `临时凭证校验失败：${explainAwsError(identity.stderr || identity.stdout)}`,
    }
  }

  const data = safeJson(identity.stdout)
  return {
    ok: true,
    mode: 'assume-role',
    roleArn,
    sessionName,
    assumedArn: payload.AssumedRoleUser?.Arn || '',
    accountId: data?.Account || '',
    arn: data?.Arn || '',
    expiration: temporary.Expiration || null,
    matched: data?.Account === account.accountId,
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function removeCredentials() {
  clearMasterCredentials()
  versionCache = { at: 0, data: null }
  return { ok: true }
}

/**
 * 校验 aws-nuke 配置：使用 explain-config --account-id 离线解析，
 * 不需要真实凭证即可验证 YAML 结构与资源类型统计。
 */
export async function explainConfig(configFile, accountId) {
  if (!fs.existsSync(configFile)) throw ApiError.badRequest('配置文件不存在')
  const args = ['explain-config', '--config', configFile, '--with-filtered', '--with-excluded']
  if (accountId) args.push('--account-id', accountId)
  const result = await runCommand(resolveAwsNuke(), args, { timeoutMs: 60000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  const total = output.match(/Resource Types:\s*(\d+)/)
  const included = output.match(/Included:\s*(\d+)/)
  const excluded = output.match(/Excluded:\s*(\d+)/)
  return {
    ok: result.code === 0,
    output: output.slice(0, 8000),
    stats: {
      total: total ? Number(total[1]) : null,
      included: included ? Number(included[1]) : null,
      excluded: excluded ? Number(excluded[1]) : null,
    },
  }
}

export async function listResourceTypes() {
  if (!awsNukeAvailable()) throw ApiError.badRequest('aws-nuke 不可用')
  const result = await runCommand(resolveAwsNuke(), ['resource-types'], { timeoutMs: 20000 })
  const types = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Za-z0-9]+$/.test(line))
  return [...new Set(types)].sort()
}
