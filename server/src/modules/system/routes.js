/** 系统部署接口：环境自检、安装 CLI、配置凭证、设置管理 */
import { Router } from 'express'
import {
  checkEnvironment,
  configureCredentials,
  explainConfig,
  installAwsCli,
  listResourceTypes,
  removeCredentials,
  verifyExistingCredentials,
} from './service.js'
import { getPublicSettings, updateSettings } from '../settings/service.js'
import { resolveBlocklist } from '../nuke/configBuilder.js'
import { checkUpdate, startUpdate, diagnoseNetwork } from './updater.js'
import { listAwsProfiles } from '../../lib/awsConfig.js'
import { ApiError } from '../../lib/errors.js'
import { requireAdmin } from '../../middleware/auth.js'
import { record } from '../audit/service.js'
import { getAccountForUser } from '../accounts/service.js'
import { getConfigState } from '../nuke/service.js'
import { configFilePath } from '../nuke/configFile.js'

export const systemRouter = Router()

systemRouter.get('/status', async (req, res, next) => {
  try {
    const refresh = req.query.refresh === '1'
    res.json(await checkEnvironment({ refresh }))
  } catch (error) {
    next(error)
  }
})

systemRouter.post('/install-cli', requireAdmin, (req, res) => {
  const job = installAwsCli(req.user)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'system.install-cli',
    target: 'AWS CLI v2',
    detail: `任务 ${job.id}`,
    ip: req.ip,
  })
  res.status(202).json({ job })
})

systemRouter.post('/credentials', requireAdmin, async (req, res, next) => {
  try {
    const result = await configureCredentials(req.body || {})
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'system.credentials',
      target: result.identity.accountId,
      detail: `profile=${result.profile} arn=${result.identity.arn}`,
      ip: req.ip,
      level: 'warn',
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

systemRouter.post('/credentials/verify', requireAdmin, async (_req, res, next) => {
  try {
    res.json(await verifyExistingCredentials())
  } catch (error) {
    next(error)
  }
})

systemRouter.delete('/credentials', requireAdmin, (req, res) => {
  removeCredentials()
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'system.credentials.clear',
    target: 'master',
    ip: req.ip,
    level: 'warn',
  })
  res.json({ ok: true })
})

systemRouter.get('/settings', requireAdmin, (_req, res) => {
  res.json({ settings: getPublicSettings() })
})

systemRouter.patch('/settings', requireAdmin, (req, res, next) => {
  try {
    const updated = updateSettings(req.body || {})
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'system.settings',
      target: Object.keys(req.body || {}).join(','),
      ip: req.ip,
    })
    res.json({ settings: getPublicSettings(), updated })
  } catch (error) {
    next(error)
  }
})

systemRouter.get('/policy', (_req, res) => {
  // 面向所有登录用户的策略视图：只暴露与账号配置、执行权限相关的字段
  const settings = getPublicSettings()
  res.json({
    allowUserDestructive: settings.allowUserDestructive,
    blocklistSize: resolveBlocklist(settings).length,
    defaultRegions: settings.defaultRegions,
    organizationRoleName: settings.organizationRoleName,
    assumeRoleSessionName: settings.assumeRoleSessionName,
    masterReady: Boolean(settings.masterCredentials?.configured),
    masterProfile: settings.awsProfile,
    masterMode: settings.masterCredentialMode === 'standalone' ? 'standalone' : 'organization',
    // 任务中心轮询间隔（管理员全局控制，普通用户仅消费该值）
    jobPollIntervalSeconds: settings.jobPollIntervalSeconds,
    // 顶栏健康检查间隔（同上）
    healthPollIntervalSeconds: settings.healthPollIntervalSeconds,
  })
})

systemRouter.get('/profiles', (_req, res) => {
  // 只返回 profile 元信息（是否含 AK/SK、是否已配角色），不返回任何密钥
  res.json({ items: listAwsProfiles() })
})

systemRouter.get('/resource-types', async (_req, res, next) => {
  try {
    res.json({ items: await listResourceTypes() })
  } catch (error) {
    next(error)
  }
})

/** 让 aws-nuke 自己校验配置是否合法（explain-config），校验的是账号正在使用的那份文件 */
systemRouter.post('/explain-config', requireAdmin, async (req, res, next) => {
  try {
    const account = getAccountForUser(req.body?.accountId, req.user)
    // 不在这里预检「有没有配区域」：配置可能被手工编辑过，以 aws-nuke 的解析结果为准
    const file = configFilePath(account)
    getConfigState(account)
    const result = await explainConfig(file, account.accountId)
    res.json(result)
  } catch (error) {
    next(error)
  }
})

systemRouter.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    const { listAudit } = await import('../audit/service.js')
    res.json({ items: listAudit({ limit: Math.min(Number(req.query.limit) || 100, 500) }) })
  } catch (error) {
    next(error)
  }
})

/** 检查 aws-nuke 上游版本（结果带 10 分钟缓存，force=1 强制刷新） */
systemRouter.get('/aws-nuke/update', requireAdmin, async (req, res, next) => {
  try {
    res.json(await checkUpdate({ force: req.query.force === '1' }))
  } catch (error) {
    next(error)
  }
})

/** 网络诊断：直连与各代理分别探测 GitHub 的可达性 */
systemRouter.get('/aws-nuke/diagnose', requireAdmin, async (_req, res, next) => {
  try {
    res.json(await diagnoseNetwork())
  } catch (error) {
    next(error)
  }
})

/** 下载并替换 aws-nuke 二进制：长任务，日志走任务详情页 */
systemRouter.post('/aws-nuke/update', requireAdmin, async (req, res, next) => {
  try {
    const job = await startUpdate(req.user, req.body || {})
    // 结果由 updater 的 onExit 回写审计（含实际版本与状态），此处不重复记录
    res.status(202).json({ job })
  } catch (error) {
    next(error)
  }
})
