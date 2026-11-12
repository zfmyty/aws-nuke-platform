/** 登录 / 当前用户 / 修改密码 */
import { Router } from 'express'
import { authenticateUser, changePassword, toPublicUser, findUserById } from '../users/service.js'
import { signToken } from '../../lib/token.js'
import { authenticate } from '../../middleware/auth.js'
import { record } from '../audit/service.js'

export const authRouter = Router()

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  const user = authenticateUser(username, password)
  const token = signToken({ sub: user.id, role: user.role, name: user.username })
  record({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.login',
    target: user.username,
    detail: '登录成功',
    ip: req.ip,
  })
  res.json({ token, user })
})

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: toPublicUser(findUserById(req.user.id)) })
})

authRouter.post('/password', authenticate, (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  changePassword(req.user.id, oldPassword, newPassword)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'auth.password',
    target: req.user.username,
    detail: '修改密码',
    ip: req.ip,
  })
  res.json({ ok: true })
})
