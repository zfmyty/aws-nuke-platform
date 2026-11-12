/**
 * 任务接口：列表 / 详情 / 日志 / SSE 实时流 / 取消
 * 数据隔离同账号：普通用户只能访问自己的任务。
 */
import { Router } from 'express'
import { ApiError } from '../../lib/errors.js'
import {
  cancelJob,
  deleteJob,
  getBufferedLog,
  getJob,
  listJobs,
  readLog,
  respondToGate,
  subscribe,
  subscribeEvents,
  toPublic,
} from './runner.js'
import { parseSummary } from '../nuke/service.js'
import { record } from '../audit/service.js'

export const jobsRouter = Router()

function pickJob(req) {
  const job = getJob(req.params.id)
  if (!job) throw ApiError.notFound('任务不存在')
  if (req.user.role !== 'admin' && job.ownerId !== req.user.id) throw ApiError.forbidden('无权访问该任务')
  return job
}

jobsRouter.get('/', (req, res) => {
  const { kind, status, limit } = req.query
  const items = listJobs({
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    kind: kind || '',
    status: status || '',
    limit: Math.min(Number(limit) || 50, 200),
  })
  res.json({ items: items.map(toPublic) })
})

jobsRouter.get('/:id', (req, res) => {
  const job = pickJob(req)
  res.json({ job: toPublic(job), summary: job.kind === 'nuke' ? parseSummary(job.id) : null })
})

jobsRouter.get('/:id/log', (req, res) => {
  const job = pickJob(req)
  res.json({ job: toPublic(job), log: readLog(job.id) })
})

/** SSE：先回放缓冲，再推送增量 */
jobsRouter.get('/:id/stream', (req, res) => {
  const job = pickJob(req)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const buffered = getBufferedLog(job.id)
  const fallback = buffered.length ? buffered : readLog(job.id).split('\n').filter(Boolean)
  send('snapshot', { lines: fallback.slice(-800), status: job.status, job: toPublic(job) })

  const unsubscribe = subscribe(job.id, (line) => send('line', { line }))
  const unsubscribeEvents = subscribeEvents(job.id, ({ type, data }) => send(type, data))
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

  const finish = () => {
    clearInterval(heartbeat)
    unsubscribe()
    unsubscribeEvents()
    try {
      send('closed', { job: toPublic(getJob(job.id)) })
      res.end()
    } catch {
      /* ignore */
    }
  }

  // 任务已结束则补一次收尾事件
  if (job.status !== 'running' && job.status !== 'queued' && job.status !== 'waiting-input') {
    setTimeout(finish, 300)
  } else {
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      unsubscribeEvents()
    })
    const watcher = setInterval(() => {
      const current = getJob(job.id)
      if (current && current.status !== 'running' && current.status !== 'queued' && current.status !== 'waiting-input') {
        clearInterval(watcher)
        setTimeout(finish, 400)
      }
    }, 1000)
  }
})

/** 用户确认删除闸：仅任务归属者或管理员，且任务处于 waiting-input 时有效 */
jobsRouter.post('/:id/prompt-confirm', (req, res) => {
  const job = pickJob(req)
  const updated = respondToGate(job.id, req.body?.text)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'job.confirm',
    target: job.title,
    detail: '用户输入别名确认，删除阶段开始',
    ip: req.ip,
    level: 'warn',
  })
  res.json({ job: toPublic(updated) })
})

/** 删除单条任务记录（连同日志文件） */
jobsRouter.delete('/:id', (req, res) => {
  const job = pickJob(req)
  deleteJob(job.id)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'job.delete',
    target: job.title,
    ip: req.ip,
    level: 'warn',
  })
  res.json({ ok: true })
})

/** 批量删除任务记录：逐条校验归属与状态，失败项不影响其余 */
jobsRouter.post('/batch-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : []
  if (!ids.length) throw ApiError.badRequest('请提供要删除的任务 ID 列表')
  const deleted = []
  const failed = []
  for (const id of ids) {
    const job = getJob(id)
    if (!job || (req.user.role !== 'admin' && job.ownerId !== req.user.id)) {
      failed.push({ id, reason: '任务不存在或无权访问' })
      continue
    }
    try {
      deleteJob(id)
      deleted.push(id)
    } catch (error) {
      failed.push({ id, reason: error.message })
    }
  }
  if (deleted.length) {
    record({
      actorId: req.user.id,
      actorName: req.user.username,
      action: 'job.delete',
      target: `批量删除 ${deleted.length} 条任务记录`,
      detail: failed.length ? `${failed.length} 条未删除` : '',
      ip: req.ip,
      level: 'warn',
    })
  }
  res.json({ deleted, failed })
})

jobsRouter.post('/:id/cancel', (req, res) => {
  const job = pickJob(req)
  if (job.status !== 'running' && job.status !== 'waiting-input') {
    throw ApiError.badRequest('任务已结束，无法取消')
  }
  const updated = cancelJob(job.id)
  record({
    actorId: req.user.id,
    actorName: req.user.username,
    action: 'job.cancel',
    target: job.title,
    ip: req.ip,
    level: 'warn',
  })
  res.json({ job: toPublic(updated) })
})
