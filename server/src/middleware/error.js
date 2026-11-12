/** 统一错误处理与 404 兜底 */
import { ApiError } from '../lib/errors.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('http')

export function notFound(req, _res, next) {
  next(new ApiError(404, `接口不存在: ${req.method} ${req.originalUrl}`, 'NOT_FOUND'))
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  const status = error instanceof ApiError ? error.status : 500
  const payload = {
    error: {
      code: error.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR'),
      message: error.message || '服务器内部错误',
    },
  }
  if (error.details) payload.error.details = error.details
  if (status >= 500) log.error(`${req.method} ${req.originalUrl}`, error)
  res.status(status).json(payload)
}
