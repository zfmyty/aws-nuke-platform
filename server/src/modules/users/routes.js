/** 用户管理接口（仅管理员） */
import { Router } from 'express'
import { createUser, deleteUser, listUsers, updateUser } from './service.js'
import { requireAdmin } from '../../middleware/auth.js'
import { record } from '../audit/service.js'

export const usersRouter = Router()

usersRouter.use(requireAdmin)

usersRouter.get('/', (req, res) => {
  res.json({ items: listUsers() })
})

usersRouter.post('/', (req, res) => {
  const user = createUser(req.body || {})
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'user.create',
    target: user.username,
    detail: `创建${user.role === 'admin' ? '管理员' : '普通用户'}`,
    ip: req.ip,
  })
  res.status(201).json({ user })
})

usersRouter.patch('/:id', (req, res) => {
  const user = updateUser(req.params.id, req.body || {})
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'user.update',
    target: user.username,
    detail: Object.keys(req.body || {}).join(','),
    ip: req.ip,
  })
  res.json({ user })
})

usersRouter.delete('/:id', (req, res) => {
  const target = listUsers().find((item) => item.id === req.params.id)
  deleteUser(req.params.id, req.user.id)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'user.delete',
    target: target?.username || req.params.id,
    ip: req.ip,
  })
  res.json({ ok: true })
})
