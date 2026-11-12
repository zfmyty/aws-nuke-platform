/** 统一业务异常：HTTP 状态码 + 机器可读 code + 人类可读 message */
export class ApiError extends Error {
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }

  static badRequest(message, code = 'BAD_REQUEST') {
    return new ApiError(400, message, code)
  }
  static unauthorized(message = '未登录或登录已过期', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code)
  }
  static forbidden(message = '没有权限执行该操作', code = 'FORBIDDEN') {
    return new ApiError(403, message, code)
  }
  static notFound(message = '资源不存在', code = 'NOT_FOUND') {
    return new ApiError(404, message, code)
  }
  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, message, code)
  }
}
