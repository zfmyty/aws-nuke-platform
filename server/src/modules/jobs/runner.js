/**
 * 任务运行器：统一承载「安装 AWS CLI」「凭证校验」「aws-nuke 扫描/删除」等长任务。
 * 设计要点：
 * - 任务状态持久化到 db/jobs.json，进程重启后可读历史（运行中的任务会被标记为中断）
 * - 输出同时写入 data/logs/<jobId>.log，并通过事件总线推送给 SSE 订阅者
 * - 内存中保留最近 N 行，便于新订阅者立即获得上下文
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { config, dataPath } from '../../config/index.js'
import { collection } from '../../lib/store.js'
import { createLogger } from '../../lib/logger.js'
import { ApiError } from '../../lib/errors.js'

const log = createLogger('jobs')
const jobs = collection('jobs', { items: [] })
const bus = new EventEmitter()
bus.setMaxListeners(0)
/** 结构化事件通道（waiting-input 等），与逐行日志总线分离 */
const eventBus = new EventEmitter()
eventBus.setMaxListeners(0)

/** jobId -> { child, buffer: string[], stream: fs.WriteStream, timer } */
const runtime = new Map()

export const JOB_KINDS = {
  INSTALL_CLI: 'install-cli',
  CONFIGURE: 'configure',
  VERIFY: 'verify',
  NUKE: 'nuke',
  UPDATE_NUKE: 'update-nuke',
}

export const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting-input',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
}

/** 扫描完成标记与资源行解析（与 parseSummary 使用同一已知标记，避免依赖 prompt 文案） */
const SCAN_COMPLETE_RE = /Scan complete:\s*\d+\s*total/i
const SCAN_RESOURCE_RE = /\b([a-z]{2}(?:-[a-z0-9]+){1,3})\s+-\s+([A-Za-z][A-Za-z0-9]*)\s+-\s+(.+)$/
const MAX_SCAN_RESOURCES = 2000

export function subscribeEvents(jobId, listener) {
  eventBus.on(jobId, listener)
  return () => eventBus.off(jobId, listener)
}

function emitEvent(jobId, type, data) {
  eventBus.emit(jobId, { type, data })
}

function logFileFor(jobId) {
  return dataPath('logs', `${jobId}.log`)
}

function pushLine(jobId, line) {
  const entry = runtime.get(jobId)
  if (entry) {
    entry.buffer.push(line)
    if (entry.buffer.length > config.nuke.logBufferLines) entry.buffer.shift()
  }
  bus.emit(jobId, line)
}

export function subscribe(jobId, listener) {
  bus.on(jobId, listener)
  return () => bus.off(jobId, listener)
}

export function getBufferedLog(jobId) {
  return runtime.get(jobId)?.buffer ?? []
}

export function readLog(jobId, maxLines = 2000) {
  try {
    const content = fs.readFileSync(logFileFor(jobId), 'utf8')
    const lines = content.split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
  } catch {
    return ''
  }
}

/** 敏感参数（凭证）在落库与对外输出时统一打码 */
const SENSITIVE_FLAGS = new Set(['--secret-access-key', '--session-token', '--access-key-id'])
const REDACTED = '********'

function redactArgs(args = []) {
  return args.map((arg, index) => (SENSITIVE_FLAGS.has(args[index - 1]) ? REDACTED : arg))
}

export function toPublic(job) {
  if (!job) return null
  return { ...job, args: redactArgs(job.args) }
}

export function listJobs({ userId, isAdmin, kind, status, limit = 50 } = {}) {
  let items = jobs.all()
  if (!isAdmin) items = items.filter((job) => job.ownerId === userId)
  if (kind) items = items.filter((job) => job.kind === kind)
  if (status) items = items.filter((job) => job.status === status)
  return items
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
}

export function getJob(jobId) {
  return jobs.findById(jobId)
}

/**
 * 启动一个任务
 * @param {object} options
 * @param {string} options.kind  任务类型
 * @param {string} options.title 展示标题
 * @param {string} options.ownerId 归属用户（用于数据隔离）
 * @param {string} options.createdBy 触发者用户名
 * @param {string} options.bin 可执行文件
 * @param {string[]} options.args
 * @param {object} options.meta 附加信息（账号 ID、模式等）
 * @param {string} options.stdinInit 进程启动后立即写入 stdin 的内容（用于自动应答首次别名提示）
 * @param {object|null} options.confirmGate 确认闸配置 { timeoutMs }：扫描完成后暂停等待用户确认
 * @param {Function} options.onExit 结束回调 (job, {code}) => void
 */
export function startJob({ kind, title, ownerId, createdBy, bin, args = [], meta = {}, stdinInit = '', confirmGate = null, onExit }) {
  const job = jobs.insert({
    kind,
    title,
    ownerId,
    createdBy,
    status: JOB_STATUS.RUNNING,
    bin,
    args: redactArgs(args),
    meta,
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logFile: '',
  })

  const file = logFileFor(job.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const stream = fs.createWriteStream(file, { flags: 'a' })
  jobs.update(job.id, { logFile: path.relative(config.paths.dataDir, file) })

  const entry = { child: null, buffer: [], stream, timer: null, pending: '' }
  if (confirmGate) {
    entry.confirmGate = confirmGate
    entry.gateState = 'armed'
    entry.gateTimer = null
    entry.gateResponded = false
    entry.gateTimedOut = false
    entry.resources = []
    entry.truncated = false
    entry.fuseReason = ''
  }
  runtime.set(job.id, entry)

  const write = (chunk) => {
    const text = chunk.toString()
    stream.write(text)
    // 按完整行切分：半行留在 pending 等下一个 chunk 拼接，保证检测和日志都不被截断
    entry.pending += text
    const parts = entry.pending.split(/\r?\n/)
    entry.pending = parts.pop()
    for (const line of parts) {
      if (line.trim() !== '') pushLine(job.id, line)
      handleLine(line)
    }
  }

  const handleLine = (line) => {
    if (!entry.confirmGate) return
    // 「无资源可删」：aws-nuke 扫描后直接结束，不会出现第二次确认 —— 正常收尾，不算异常
    if (/no resource to delete/i.test(line)) {
      entry.noResources = true
      if (entry.gateState === 'open') {
        clearTimeout(entry.gateTimer)
        entry.gateState = 'done'
        pushLine(job.id, '[system] 扫描未发现可删除资源，无需确认，任务正常结束')
        const updated = jobs.update(job.id, { status: JOB_STATUS.RUNNING })
        emitEvent(job.id, 'status', { job: toPublic(updated) })
      }
      return
    }
    if (entry.gateState === 'open') {
      // 等待确认期间出现删除动作 → 确认闸疑似被自动消费，安全熔断
      if (/remov|nuke complete|nuking/i.test(line)) {
        entry.fuseReason = '安全熔断：等待确认期间检测到删除动作（确认闸被跳过），任务已强制终止'
        pushLine(job.id, `[system] ${entry.fuseReason}`)
        try {
          entry.child?.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        jobs.update(job.id, { status: JOB_STATUS.FAILED, error: entry.fuseReason })
      }
      return
    }
    if (entry.gateState !== 'armed') return
    const res = line.match(SCAN_RESOURCE_RE)
    if (res) {
      if (entry.resources.length < MAX_SCAN_RESOURCES) {
        entry.resources.push({ region: res[1], type: res[2], id: res[3].trim() })
      } else {
        entry.truncated = true
      }
    }
    if (SCAN_COMPLETE_RE.test(line)) openGate()
  }

  const openGate = () => {
    entry.gateState = 'open'
    const minutes = Math.max(1, Math.round(entry.confirmGate.timeoutMs / 60000))
    pushLine(job.id, `[system] 扫描完成，任务暂停等待确认（${minutes} 分钟内有效），请在任务页面输入账号别名`)
    entry.gateTimer = setTimeout(() => {
      entry.gateTimedOut = true
      pushLine(job.id, '[system] 等待确认超时，任务自动终止（未执行删除）')
      try {
        entry.child?.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, entry.confirmGate.timeoutMs)
    const updated = jobs.update(job.id, {
      status: JOB_STATUS.WAITING_INPUT,
      gateOpenedAt: new Date().toISOString(),
      gateTimeoutMs: entry.confirmGate.timeoutMs,
      scanResources: entry.resources,
      scanTruncated: entry.truncated,
    })
    emitEvent(job.id, 'gate', { job: toPublic(updated) })
  }

  pushLine(job.id, `$ ${path.basename(bin)} ${redactArgs(args).join(' ')}`)

  let child
  try {
    child = spawn(bin, args, {
      cwd: config.paths.projectRoot,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    pushLine(job.id, `[error] 无法启动进程: ${error.message}`)
    finalize(job, -1, `进程启动失败: ${error.message}`)
    return jobs.findById(job.id)
  }

  entry.child = child
  child.stdout?.on('data', write)
  child.stderr?.on('data', write)

  // 自动应答首次别名提示（stdin 管道有缓冲，aws-nuke 读取时自然消费；扫描本身只读无风险）
  if (stdinInit) {
    try {
      child.stdin.write(stdinInit)
    } catch {
      /* 写入失败时由 aws-nuke 的等待与任务超时兜底 */
    }
  }

  entry.timer = setTimeout(() => {
    pushLine(job.id, '[timeout] 任务运行超时，正在终止进程')
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, config.nuke.jobTimeoutMs)

  child.on('error', (error) => {
    pushLine(job.id, `[error] ${error.message}`)
    finalize(job, -1, error.message)
  })

  child.on('close', (code) => {
    if (entry.pending && entry.pending.trim() !== '') pushLine(job.id, entry.pending)
    finalize(job, code ?? 0, null)
  })

  function finalize(jobRecord, code, errorMessage) {
    const current = jobs.findById(jobRecord.id)
    if (!current || current.finishedAt) return
    clearTimeout(entry.timer)
    clearTimeout(entry.gateTimer)
    try {
      stream.end()
    } catch {
      /* ignore */
    }
    try {
      entry.child?.stdin?.destroy()
    } catch {
      /* ignore */
    }
    const canceled = current.status === JOB_STATUS.CANCELED
    let status
    let error = errorMessage || null
    if (canceled) {
      status = JOB_STATUS.CANCELED
    } else if (entry.fuseReason) {
      status = JOB_STATUS.FAILED
      error = entry.fuseReason
    } else if (entry.noResources && code === 0) {
      // 扫描无资源可删，aws-nuke 正常退出
      status = JOB_STATUS.SUCCEEDED
    } else if (current.status === JOB_STATUS.WAITING_INPUT) {
      // 在等待用户确认时进程退出：无论退出码如何都视为失败（删除未获确认）
      status = JOB_STATUS.FAILED
      error = entry.gateTimedOut
        ? '等待用户确认超时，任务已自动终止（未执行删除）'
        : 'aws-nuke 在等待确认时退出（未执行删除）'
    } else if (code === 0) {
      status = JOB_STATUS.SUCCEEDED
    } else {
      status = JOB_STATUS.FAILED
      error = error || `进程退出码 ${code}`
    }
    const finished = jobs.update(jobRecord.id, {
      status,
      exitCode: code,
      finishedAt: new Date().toISOString(),
      error,
    })
    pushLine(jobRecord.id, `[system] 任务结束，状态=${status}，退出码=${code}`)
    log.info(`job ${jobRecord.id} (${jobRecord.kind}) -> ${status} code=${code}`)
    runtime.delete(jobRecord.id)
    if (typeof onExit === 'function') {
      try {
        onExit(finished, { code, status })
      } catch (error) {
        log.error('onExit 回调异常', error)
      }
    }
  }

  return jobs.findById(job.id)
}

export function cancelJob(jobId) {
  const job = jobs.findById(jobId)
  if (!job) return null
  if (job.status !== JOB_STATUS.RUNNING && job.status !== JOB_STATUS.WAITING_INPUT) return job
  const entry = runtime.get(jobId)
  if (entry?.child) {
    try {
      entry.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  return jobs.update(jobId, { status: JOB_STATUS.CANCELED, cancelRequestedAt: new Date().toISOString() })
}

/**
 * 用户确认删除闸：校验状态与输入后把别名写入子进程 stdin。
 * 仅 waiting-input 状态、每个任务只允许一次；输入需与启动时记录的账号别名一致。
 */
export function respondToGate(jobId, text) {
  const job = jobs.findById(jobId)
  if (!job) throw ApiError.notFound('任务不存在')
  if (job.status !== JOB_STATUS.WAITING_INPUT) throw ApiError.badRequest('任务当前不在等待确认状态')
  const entry = runtime.get(jobId)
  if (!entry?.child) throw ApiError.conflict('任务进程已退出，无法确认')
  if (entry.gateResponded) throw ApiError.conflict('确认已经提交过，请勿重复操作')

  const value = String(text || '').trim()
  if (!value) throw ApiError.badRequest('请输入确认内容')
  const expected = job.meta?.promptExpected
  if (expected && value !== expected) {
    throw ApiError.badRequest('输入与账号别名不一致：请输入该账号在 AWS 上的别名（与 aws-nuke 提示一致）')
  }

  entry.gateResponded = true
  entry.gateState = 'done'
  clearTimeout(entry.gateTimer)
  try {
    entry.child.stdin.write(`${value}\n`)
  } catch (error) {
    entry.fuseReason = `确认写入 stdin 失败：${error.message}`
    pushLine(jobId, `[system] ${entry.fuseReason}`)
    throw ApiError.conflict(entry.fuseReason)
  }
  const updated = jobs.update(jobId, { status: JOB_STATUS.RUNNING, confirmedAt: new Date().toISOString() })
  pushLine(jobId, '[system] 已收到用户确认，删除阶段开始')
  emitEvent(jobId, 'gate-opened', { job: toPublic(updated) })
  return updated
}

/** 删除任务记录：仅限已结束的任务；记录与对应日志文件一并清除 */
export function deleteJob(jobId) {
  const job = jobs.findById(jobId)
  if (!job) throw ApiError.notFound('任务不存在')
  if (job.status === JOB_STATUS.RUNNING || job.status === JOB_STATUS.WAITING_INPUT) {
    throw ApiError.conflict('任务仍在执行中，请先中止后再删除记录')
  }
  jobs.remove(jobId)
  try {
    fs.rmSync(logFileFor(jobId), { force: true })
  } catch {
    /* 日志文件删除失败不影响记录删除 */
  }
  return true
}

/** 服务退出时清理所有仍在运行的子进程（避免 aws-nuke 残留） */
export function killAllRunning(reason = '服务正在停止') {
  let count = 0
  for (const [jobId, entry] of runtime) {
    if (!entry.child) continue
    try {
      entry.child.kill('SIGKILL')
      count += 1
      jobs.update(jobId, {
        status: JOB_STATUS.CANCELED,
        error: reason,
        finishedAt: new Date().toISOString(),
      })
    } catch {
      /* ignore */
    }
  }
  if (count) log.warn(`已终止 ${count} 个运行中的任务进程`)
  return count
}

export function markOrphans() {
  let count = 0
  for (const job of jobs.all()) {
    if (job.status === JOB_STATUS.RUNNING || job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.WAITING_INPUT) {
      jobs.update(job.id, {
        status: JOB_STATUS.FAILED,
        error: '服务重启，任务被中断',
        finishedAt: new Date().toISOString(),
      })
      count += 1
    }
  }
  if (count) log.warn(`已将 ${count} 个残留任务标记为中断`)
  return count
}

export function jobStats({ userId, isAdmin }) {
  const items = isAdmin ? jobs.all() : jobs.filter((job) => job.ownerId === userId)
  const byStatus = items.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1
    return acc
  }, {})
  return { total: items.length, byStatus }
}
