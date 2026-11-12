/** AWS 账号接口：列表 / 详情 / 增删改 / 配置预览 / 触发执行 */
import { Router } from 'express'
import {
  createAccount,
  deleteAccount,
  getAccountForUser,
  listAccounts,
  saveAliasCheck,
  toPublicAccount,
  updateAccount,
} from './service.js'
import { findUserById } from '../users/service.js'
import { getConfigState, regenerateConfig, saveConfig, startRun } from '../nuke/service.js'
import { removeConfigFile } from '../nuke/configFile.js'
import { createAlias, readAlias } from './alias.js'
import { importAccounts, scanOrganization } from './discovery.js'
import { requireAdmin } from '../../middleware/auth.js'
import { verifyAccountAccess } from '../system/service.js'
import { record } from '../audit/service.js'

export const accountsRouter = Router()

const ownerLookup = (id) => findUserById(id)

accountsRouter.get('/', (req, res) => {
  const { search, environment, ownerId } = req.query
  const items = listAccounts({
    isAdmin: req.user.role === 'admin',
    userId: req.user.id,
    search: search || '',
    environment: environment || '',
    ownerId: ownerId || '',
  })
  res.json({ items: items.map((account) => toPublicAccount(account, ownerLookup)) })
})

accountsRouter.post('/', (req, res, next) => {
  try {
    const account = createAccount(req.body || {}, req.user)
    // 配置在账号创建时就生成一次，此后冻结：平台设置变化不会改写它
    const created = getConfigState(account)
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'account.create',
      target: `${account.name} (${account.accountId})`,
      detail: `认证方式 ${account.authMode} · 配置已生成 ${Buffer.byteLength(created.yaml, 'utf8')} 字节`,
      ip: req.ip,
    })
    res.status(201).json({ account: toPublicAccount(account, ownerLookup) })
  } catch (error) {
    next(error)
  }
})

/**
 * 扫描 AWS Organization 下的子账号（只读）。
 * 必须注册在 '/:id' 之前，否则会被当成账号 ID 匹配掉。
 */
accountsRouter.get('/organization', requireAdmin, async (_req, res, next) => {
  try {
    res.json(await scanOrganization())
  } catch (error) {
    next(error)
  }
})

/** 批量接入选中的组织账号（只写平台数据，不触达 AWS） */
accountsRouter.post('/organization/import', requireAdmin, (req, res, next) => {
  try {
    const result = importAccounts(req.body?.accounts, req.user, req.body?.options || {})
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'account.import',
      target: `${result.created.length} 个账号`,
      detail: [
        result.created.map((item) => item.accountId).join(', ') || '无新增',
        `环境=${result.options.environment}`,
        `区域=${result.options.defaultRegion}`,
        `角色=${result.options.roleName}`,
      ].join(' · '),
      ip: req.ip,
    })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

accountsRouter.get('/:id', (req, res) => {
  const account = getAccountForUser(req.params.id, req.user)
  res.json({ account: toPublicAccount(account, ownerLookup) })
})

accountsRouter.patch('/:id', (req, res) => {
  const account = updateAccount(req.params.id, req.body || {}, req.user)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'account.update',
    target: `${account.name} (${account.accountId})`,
    detail: Object.keys(req.body || {}).join(','),
    ip: req.ip,
  })
  res.json({ account: toPublicAccount(account, ownerLookup) })
})

accountsRouter.delete('/:id', (req, res) => {
  const account = deleteAccount(req.params.id, req.user)
  removeConfigFile(account)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'account.delete',
    target: `${account.name} (${account.accountId})`,
    ip: req.ip,
    level: 'warn',
  })
  res.json({ ok: true })
})

/**
 * 读取该账号的 aws-nuke 配置。
 * 配置一旦生成即冻结：这里只在文件不存在时生成一次，之后原样返回，
 * 平台设置的改变不会悄悄改写已有配置。
 */
accountsRouter.get('/:id/config', (req, res, next) => {
  try {
    const account = getAccountForUser(req.params.id, req.user)
    const { yaml, status } = getConfigState(account)
    res.json({ yaml, status })
  } catch (error) {
    next(error)
  }
})

/** 用户手工保存配置：保存后标记为 manual，不再被自动生成覆盖 */
accountsRouter.put('/:id/config', (req, res, next) => {
  try {
    const account = getAccountForUser(req.params.id, req.user)
    const result = saveConfig(account, req.body?.yaml, req.user, req.ip)
    res.json({ yaml: result.yaml, status: result.status })
  } catch (error) {
    next(error)
  }
})

/** 按当前账号规则与平台设置重新生成（会覆盖手工改动，前端需二次确认） */
accountsRouter.post('/:id/config/regenerate', (req, res, next) => {
  try {
    const account = getAccountForUser(req.params.id, req.user)
    const result = regenerateConfig(account, req.user, req.ip)
    res.json({ yaml: result.yaml, status: result.status })
  } catch (error) {
    next(error)
  }
})

/** 测试连通性：组织模式下会真跑一次 sts:AssumeRole，确认信任策略与权限是否打通 */
accountsRouter.post('/:id/verify', async (req, res, next) => {
  try {
    const account = getAccountForUser(req.params.id, req.user)
    const result = await verifyAccountAccess(account)
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'account.verify',
      target: `${account.name} (${account.accountId})`,
      detail: result.ok ? `身份 ${result.arn}` : `失败：${result.error}`,
      ip: req.ip,
      level: result.ok ? 'info' : 'warn',
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

/** 读取目标账号当前的 AWS 别名（只读，不修改任何资源）；结果快照落库供详情页回显 */
accountsRouter.get('/:id/alias', async (req, res, next) => {
  try {
    const account = getAccountForUser(req.params.id, req.user)
    const result = await readAlias(account)
    const updated = saveAliasCheck(account.id, result)
    res.json({ ...result, checkedAt: updated.aliasCheck.checkedAt })
  } catch (error) {
    next(error)
  }
})

/**
 * 为目标账号创建别名。
 * 组织模式下由主账号凭证 AssumeRole 进入 OrganizationAccountAccessRole 后执行，
 * 不需要登录子账号；属于对真实 AWS 的写操作，前端必须做一次显式确认。
 */
accountsRouter.post('/:id/alias', async (req, res, next) => {
  try {
    const account = getAccountForUser(req.params.id, req.user)
    const result = await createAlias(account, req.body?.alias)
    // 创建成功后同步别名检测快照，详情页回显保持一致
    saveAliasCheck(account.id, { ok: true, hasAlias: true, aliases: [result.alias], mode: result.mode })
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'account.alias',
      target: `${account.name} (${account.accountId})`,
      detail: `别名 ${result.alias} · ${result.mode}`,
      ip: req.ip,
      level: 'warn',
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

/** 触发执行：mode = dry（演练）| live（真实删除）；confirmMode = direct | confirm（仅 live 有效） */
accountsRouter.post('/:id/run', (req, res) => {
  const account = getAccountForUser(req.params.id, req.user)
  const { job } = startRun({
    account,
    mode: req.body?.mode,
    confirmText: req.body?.confirmText,
    confirmMode: req.body?.confirmMode,
    user: req.user,
    ip: req.ip,
  })
  res.status(202).json({ job })
})
