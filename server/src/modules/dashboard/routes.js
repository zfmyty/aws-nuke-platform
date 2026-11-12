/** 首页概览：按角色聚合账号、任务与用户维度数据 */
import { Router } from 'express'
import { accountStats, listAccounts, toPublicAccount } from '../accounts/service.js'
import { jobStats, listJobs, toPublic } from '../jobs/runner.js'
import { findUserById, listUsers } from '../users/service.js'
import { getPublicSettings } from '../settings/service.js'
import { resolveBlocklist } from '../nuke/configBuilder.js'

export const dashboardRouter = Router()

dashboardRouter.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin'
  const scope = { isAdmin, userId: req.user.id }
  const ownerLookup = (id) => findUserById(id)

  const accounts = listAccounts({ isAdmin, userId: req.user.id })
  const recentJobs = listJobs({ ...scope, limit: 8 }).map(toPublic)
  const stats = accountStats(scope)
  const jobs = jobStats(scope)

  const payload = {
    role: req.user.role,
    accounts: stats,
    jobs,
    recentJobs,
    recentAccounts: accounts.slice(0, 5).map((account) => toPublicAccount(account, ownerLookup)),
    health: {
      blocklistSize: resolveBlocklist(getPublicSettings()).length,
      allowUserDestructive: getPublicSettings().allowUserDestructive,
    },
  }

  if (isAdmin) {
    payload.users = { total: listUsers().length, admins: listUsers().filter((u) => u.role === 'admin').length }
    payload.allAccounts = accountStats({ isAdmin: true, userId: null })
    payload.ownerBreakdown = Object.values(
      accounts.reduce((acc, account) => {
        const key = account.ownerId
        acc[key] = acc[key] || {
          ownerId: key,
          ownerName: ownerLookup(key)?.displayName || '未知用户',
          accounts: 0,
        }
        acc[key].accounts += 1
        return acc
      }, {}),
    ).sort((a, b) => b.accounts - a.accounts)
  }

  res.json(payload)
})
