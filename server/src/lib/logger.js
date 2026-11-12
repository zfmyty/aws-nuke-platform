/** 极简日志器：带时间戳与级别，便于在控制台追踪请求与任务 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function emit(level, scope, args) {
  if ((LEVELS[level] ?? 99) < threshold) return
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} [${scope}]`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(line, ...args)
}

export function createLogger(scope) {
  return {
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    child: (sub) => createLogger(`${scope}:${sub}`),
  }
}

export const logger = createLogger('app')
