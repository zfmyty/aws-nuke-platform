/**
 * 鉴权中间件：解析 Bearer 令牌 → 注入 req.user
 * 权限模型：admin（全部数据）/ user（仅自己创建的账号与任务）
 */
import { verifyToken } from '../lib/token.js'
import { ApiError } from '../lib/errors.js'
import { findUserById, toPublicUser } from '../modules/users/service.js'

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token
  const payload = verifyToken(token)
  if (!payload) return next(ApiError.unauthorized())

  const user = findUserById(payload.sub)
  if (!user) return next(ApiError.unauthorized('账号不存在或已被删除'))
  if (user.status === 'disabled') return next(ApiError.forbidden('账号已被禁用，请联系管理员'))

  req.user = toPublicUser(user)
  next()
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(ApiError.forbidden('该操作仅限管理员'))
  next()
}

/** 数据隔离作用域：管理员不限，普通用户仅限自己 */
export function scopeOf(user) {
  return { isAdmin: user.role === 'admin', userId: user.id }
}
