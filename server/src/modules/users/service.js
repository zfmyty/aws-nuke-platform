/** 用户领域服务：账号创建、口令修改、状态管理 */
import { collection } from '../../lib/store.js'
import { hashPassword, verifyPassword } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import { config } from '../../config/index.js'

const users = collection('users', { items: [] })

export function toPublicUser(user) {
  if (!user) return null
  const { passwordHash, ...rest } = user
  return rest
}

export function findUserById(id) {
  return users.findById(id)
}

export function findUserByUsername(username) {
  const name = String(username || '').trim().toLowerCase()
  return users.find((user) => user.username.toLowerCase() === name)
}

export function listUsers() {
  return users
    .all()
    .map(toPublicUser)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

export function createUser({ username, password, role = 'user', displayName, email = '' }) {
  const name = String(username || '').trim()
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) {
    throw ApiError.badRequest('用户名需为 3-32 位字母、数字、下划线、点或短横线')
  }
  if (findUserByUsername(name)) throw ApiError.conflict('用户名已存在')
  assertPassword(password)
  if (!['admin', 'user'].includes(role)) throw ApiError.badRequest('角色不合法')

  return toPublicUser(
    users.insert({
      username: name,
      passwordHash: hashPassword(password),
      role,
      displayName: displayName || name,
      email,
      status: 'active',
      lastLoginAt: null,
      passwordUpdatedAt: new Date().toISOString(),
    }),
  )
}

export function updateUser(id, patch) {
  const user = users.findById(id)
  if (!user) throw ApiError.notFound('用户不存在')

  const next = {}
  if (patch.displayName !== undefined) next.displayName = String(patch.displayName).slice(0, 40)
  if (patch.email !== undefined) next.email = String(patch.email).slice(0, 120)
  if (patch.status !== undefined) {
    if (!['active', 'disabled'].includes(patch.status)) throw ApiError.badRequest('状态不合法')
    next.status = patch.status
  }
  if (patch.role !== undefined) {
    if (!['admin', 'user'].includes(patch.role)) throw ApiError.badRequest('角色不合法')
    if (user.role === 'admin' && patch.role === 'user' && countAdmins() <= 1) {
      throw ApiError.conflict('系统至少需要保留一名管理员')
    }
    next.role = patch.role
  }
  if (patch.password) {
    assertPassword(patch.password)
    next.passwordHash = hashPassword(patch.password)
    next.passwordUpdatedAt = new Date().toISOString()
  }
  return toPublicUser(users.update(id, next))
}

export function deleteUser(id, operatorId) {
  const user = users.findById(id)
  if (!user) throw ApiError.notFound('用户不存在')
  if (user.id === operatorId) throw ApiError.badRequest('不能删除当前登录账号')
  if (user.role === 'admin' && countAdmins() <= 1) throw ApiError.conflict('系统至少需要保留一名管理员')
  users.remove(id)
}

export function countAdmins() {
  return users.filter((user) => user.role === 'admin').length
}

export function authenticateUser(username, password) {
  const user = findUserByUsername(username)
  if (!user) throw ApiError.unauthorized('用户名或密码错误')
  if (user.status === 'disabled') throw ApiError.forbidden('账号已被禁用，请联系管理员')
  if (!verifyPassword(password, user.passwordHash)) throw ApiError.unauthorized('用户名或密码错误')
  users.update(user.id, { lastLoginAt: new Date().toISOString() })
  return toPublicUser(users.findById(user.id))
}

export function changePassword(userId, oldPassword, newPassword) {
  const user = users.findById(userId)
  if (!user) throw ApiError.notFound('用户不存在')
  if (!verifyPassword(oldPassword, user.passwordHash)) throw ApiError.badRequest('原密码不正确')
  assertPassword(newPassword)
  if (oldPassword === newPassword) throw ApiError.badRequest('新密码不能与原密码相同')
  users.update(userId, {
    passwordHash: hashPassword(newPassword),
    passwordUpdatedAt: new Date().toISOString(),
  })
}

function assertPassword(password) {
  const value = String(password || '')
  if (value.length < 8) throw ApiError.badRequest('密码长度至少 8 位')
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw ApiError.badRequest('密码需同时包含字母和数字')
}

/** 首次启动写入默认管理员 */
export function seedAdmin() {
  if (users.all().length > 0) return null
  const { username, password } = config.auth.seedAdmin
  const admin = createUser({ username, password, role: 'admin', displayName: '系统管理员' })
  return { username: admin.username, password }
}

export const userStore = users
