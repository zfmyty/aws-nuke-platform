/**
 * aws-nuke 执行编排：
 *   配置生成 → 安全校验 → 启动进程 → 结束回写账号状态与统计
 * 安全约束：
 *   1. 平台黑名单账号禁止执行
 *   2. 同一账号不允许并发任务
 *   3. 真实删除需要精确输入 12 位账号 ID 作为二次确认
 *   4. 普通用户能否执行真实删除由管理员在设置中开关
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../config/index.js'
import { ApiError } from '../../lib/errors.js'
import { resolveAwsNuke, awsProfileExists } from '../../lib/shell.js'
import { resolveBlocklist, masterProtectedForRun } from './configBuilder.js'
import { ensureConfigFile, saveConfigFile, configStatus, configFilePath } from './configFile.js'
import { getSettings, getMasterCredentialsRaw } from '../settings/service.js'
import { markRun, resolveCredentials, setAccountConfigMeta } from '../accounts/service.js'
import { listJobs, readLog, startJob, JOB_KINDS } from '../jobs/runner.js'
import { record } from '../audit/service.js'

/**
 * 取账号的配置文件：存在就用现有的，不存在才生成。
 * 读配置的入口统一走这里，保证「生成一次后不再自动改写」。
 */
function materializeConfig(account, settings) {
  const result = ensureConfigFile(account, settings)
  if (result.created) setAccountConfigMeta(account.id, result.meta)
  return result
}

/** 配置状态（是否已生成、是否手工编辑、是否与当前设置不一致） */
export function getConfigState(account) {
  const settings = getSettings()
  const { yaml, meta } = materializeConfig(account, settings)
  const status = configStatus({ ...account, configMeta: meta || account.configMeta }, settings)
  return { yaml, status }
}

/** 用户手工保存配置（标记为 manual，之后不再被自动覆盖） */
export function saveConfig(account, yaml, user, ip) {
  const result = saveConfigFile(account, yaml)
  setAccountConfigMeta(account.id, result.meta)
  record({
    actorId: user.id,
    actorName: user.username,
    action: 'nuke.config.edit',
    target: `${account.name} (${account.accountId})`,
    detail: `手工保存配置 · ${Buffer.byteLength(result.yaml, 'utf8')} 字节`,
    ip,
    level: 'warn',
  })
  const status = configStatus({ ...account, configMeta: result.meta }, getSettings())
  return { yaml: result.yaml, status }
}

/** 显式重新生成（会覆盖用户改动，前端必须二次确认） */
export function regenerateConfig(account, user, ip) {
  const settings = getSettings()
  const result = ensureConfigFile(account, settings, { force: true })
  setAccountConfigMeta(account.id, result.meta)
  record({
    actorId: user.id,
    actorName: user.username,
    action: 'nuke.config.regenerate',
    target: `${account.name} (${account.accountId})`,
    detail: '按当前账号规则与平台设置重新生成配置',
    ip,
    level: 'warn',
  })
  const status = configStatus({ ...account, configMeta: result.meta }, settings)
  return { yaml: result.yaml, status }
}

export function assertNotBlocked(account, settings) {
  // 主账号保护独立于黑名单：即使配置里没写进 blocklist，这里也照样拦住
  if (masterProtectedForRun(settings, account)) {
    throw ApiError.forbidden(
      '该账号是平台主账号（凭证持有者 / 组织管理账号），禁止执行 aws-nuke。'
        + '如果你确实要清理这个账号，请先在「部署向导」把使用方式切换为「单账号直连」。',
    )
  }
  if (!resolveBlocklist(settings, account).includes(account.accountId)) return
  throw ApiError.forbidden('该账号在平台黑名单中，禁止执行 aws-nuke')
}

function buildArgs({ account, configFile, mode, settings, credentials, master, noPrompt = true }) {
  const args = ['run', '--config', configFile, '--log-disable-colors', '--log-full-timestamp']
  // 「扫描后确认」模式保留 aws-nuke 原生确认闸：扫完停在提示处，由平台把确认转发给用户
  if (noPrompt) args.push('--no-prompt')
  if (mode === 'live') args.push('--no-dry-run')
  if (settings.bypassAliasCheck) args.push('--no-alias-check')
  // --default-region 只影响「建立 SDK 会话时用哪个区域」，与扫描范围（config 的 regions）无关。
  // aws-nuke 不传它也能跑：会退回 AWS_DEFAULT_REGION 环境变量 / profile 里配置的区域。
  // 因此这里是纯可选——用户填了才传，没填就交给 aws-nuke 自己解析，不再替它猜一个值。
  if (account.defaultRegion) args.push('--default-region', account.defaultRegion)

  const accountKeys =
    credentials.accessKeyId && credentials.secretAccessKey
      ? { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken }
      : null

  if (credentials.authMode === 'assume-role') {
    // 组织模式：base 凭证 → sts:AssumeRole → 目标子账号
    // base 优先级：账号自带 AK/SK（主账号下另一个 IAM 用户）> 平台主凭证 > 平台配置的 CLI profile
    const base = accountKeys || master
    if (credentials.baseProfile) {
      // 复用本机 ~/.aws 里的纯凭证 profile（例如已有的 [default]）
      args.push('--profile', credentials.baseProfile)
    } else if (base && base.accessKeyId && base.secretAccessKey) {
      args.push('--access-key-id', base.accessKeyId, '--secret-access-key', base.secretAccessKey)
      if (base.sessionToken) args.push('--session-token', base.sessionToken)
    } else if (settings.awsProfile && awsProfileExists(settings.awsProfile)) {
      args.push('--profile', settings.awsProfile)
    } else {
      throw ApiError.badRequest(
        '组织跨账号模式缺少主账号凭证：请先在「部署向导」配置主账号 IAM 用户的 AK/SK',
      )
    }
    args.push('--assume-role-arn', credentials.roleArn)
    if (credentials.roleSessionName) args.push('--assume-role-session-name', credentials.roleSessionName)
    if (credentials.externalId) args.push('--assume-role-external-id', credentials.externalId)
    return args
  }

  if (credentials.authMode === 'aksk') {
    if (!accountKeys) throw ApiError.badRequest('该账号未保存 AK/SK，请先在账号详情中补全')
    args.push('--access-key-id', accountKeys.accessKeyId, '--secret-access-key', accountKeys.secretAccessKey)
    if (accountKeys.sessionToken) args.push('--session-token', accountKeys.sessionToken)
    return args
  }

  if (!credentials.profile) throw ApiError.badRequest('该账号未指定 CLI profile')
  args.push('--profile', credentials.profile)
  return args
}

export function startRun({ account, mode, confirmText, confirmMode, user, ip }) {
  const settings = getSettings()
  const runMode = mode === 'live' ? 'live' : 'dry'
  // live 且用户选择 confirm 时走「扫描后确认」：不加 --no-prompt，扫完暂停等用户输入别名
  const gateMode = runMode === 'live' && confirmMode === 'confirm' ? 'confirm' : 'direct'

  assertNotBlocked(account, settings)

  // 注意：这里不再检查「账号/平台设置有没有配区域」。
  // 配置已冻结且可手工编辑，真正决定扫描范围的是 server/data/configs 里那份文件；
  // 任何以账号规则或平台设置为准的区域预检，都会在「配置是手工改过的」场景下误判。
  // 区域缺失时 aws-nuke 自己会在任务日志里给出明确报错。

  if (runMode === 'live' && user.role !== 'admin' && !settings.allowUserDestructive) {
    throw ApiError.forbidden('管理员已关闭普通用户的真实删除权限，请先执行演练或联系管理员')
  }
  if (runMode === 'live' && String(confirmText || '').trim() !== account.accountId) {
    throw ApiError.badRequest('二次确认失败：请精确输入目标账号 ID')
  }

  // 扫描后确认依赖 aws-nuke 的别名提示与自动应答，账号必须已有别名
  if (gateMode === 'confirm' && !account.alias) {
    throw ApiError.badRequest(
      '「扫描后确认」模式要求该账号已设置 AWS 别名：请在账号详情页创建别名后重试，或改用直接执行',
    )
  }

  const running = listJobs({ userId: user.id, isAdmin: true, status: 'running', limit: 200 }).find(
    (job) => job.kind === JOB_KINDS.NUKE && job.meta?.accountId === account.accountId,
  )
  if (running) throw ApiError.conflict('该账号已有任务正在执行，请等待完成')

  if (!fs.existsSync(resolveAwsNuke())) {
    throw ApiError.badRequest('未找到 aws-nuke 可执行文件，请先在「系统部署」中完成部署')
  }

  const { created } = materializeConfig(account, settings)
  const file = configFilePath(account)
  if (created) {
    record({
      actorId: user.id,
      actorName: user.username,
      action: 'nuke.config.generate',
      target: `${account.name} (${account.accountId})`,
      detail: '执行前生成了账号配置（之后不再自动改写）',
      ip,
    })
  }
  const credentials = resolveCredentials(account)
  const master = getMasterCredentialsRaw()
  const args = buildArgs({ account, configFile: file, mode: runMode, settings, credentials, master, noPrompt: gateMode !== 'confirm' })
  // 确认等待时长：平台设置可自定义（分钟），未配置时回退到环境变量默认值
  const gateMinutes = Number(settings.promptTimeoutMinutes) > 0
    ? Number(settings.promptTimeoutMinutes)
    : Math.round(config.nuke.promptTimeoutMs / 60000)

  const job = startJob({
    kind: JOB_KINDS.NUKE,
    title: `${runMode === 'live' ? '删除执行' : '删除演练'}${gateMode === 'confirm' ? '（扫描后确认）' : ''} · ${account.name}`,
    ownerId: account.ownerId,
    createdBy: user.username,
    bin: resolveAwsNuke(),
    args,
    stdinInit: gateMode === 'confirm' ? `${account.alias}\n` : '',
    confirmGate: gateMode === 'confirm' ? { timeoutMs: gateMinutes * 60000 } : null,
    meta: {
      accountId: account.accountId,
      accountName: account.name,
      accountRecordId: account.id,
      mode: runMode,
      confirmMode: gateMode,
      promptExpected: gateMode === 'confirm' ? account.alias : '',
      configFile: path.relative(config.paths.dataDir, file),
      authMode: credentials.authMode,
      roleArn: credentials.roleArn || '',
    },
    onExit: (finished) => {
      const summary = parseSummary(finished.id)
      markRun(account.id, {
        // canceled 是用户主动中止，不是执行失败，账号「最近执行」要如实区分
        status:
          finished.status === 'succeeded'
            ? 'success'
            : finished.status === 'canceled'
              ? 'canceled'
              : 'failed',
        mode: runMode,
      })
      record({
        actorId: user.id,
        actorName: user.username,
        action: runMode === 'live' ? 'nuke.run' : 'nuke.dryrun',
        target: `${account.name} (${account.accountId})`,
        detail: `状态=${finished.status}${gateMode === 'confirm' ? ' · 扫描后确认' : ''} ${summary ? `· 资源 ${summary.total} / 可删除 ${summary.nukeable}` : ''}`,
        ip,
        level: runMode === 'live' ? 'warn' : 'info',
      })
    },
  })

  return {
    job,
    summaryPreview: runMode === 'dry'
      ? '演练模式：仅列举资源，不做任何删除'
      : gateMode === 'confirm'
        ? '真实删除（扫描后确认）：扫描完成后暂停，需在任务页输入账号别名才会开始删除'
        : '真实删除模式',
  }
}

/** 从日志尾部解析 aws-nuke 汇总，写入任务 meta 便于列表展示 */
export function parseSummary(jobId) {
  const text = readLog(jobId, 400)
  const result = { total: null, nukeable: null, filtered: null, finished: null, failed: null }
  const scan = text.match(/Scan complete:\s*(\d+)\s*total,\s*(\d+)\s*nukeable,\s*(\d+)\s*filtered/i)
  if (scan) {
    result.total = Number(scan[1])
    result.nukeable = Number(scan[2])
    result.filtered = Number(scan[3])
  }
  const nuke = text.match(/Nuke complete:\s*(\d+)\s*failed,\s*(\d+)\s*skipped,\s*(\d+)\s*finished/i)
  if (nuke) {
    result.failed = Number(nuke[1])
    result.finished = Number(nuke[3])
  }
  return result.total === null && result.failed === null ? null : result
}
