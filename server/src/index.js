/** 服务入口：初始化目录、自举二进制、种子管理员、恢复任务状态，然后监听端口 */
import { spawn } from 'node:child_process'
import { createApp } from './app.js'
import { config, ensureDirs } from './config/index.js'
import { seedAdmin } from './modules/users/service.js'
import { markOrphans, killAllRunning } from './modules/jobs/runner.js'
import { ensureAwsNukeBinary } from './lib/bootstrap.js'
import { logger } from './lib/logger.js'

ensureDirs()
markOrphans()

const seeded = seedAdmin()
if (seeded) {
  logger.warn('已创建初始管理员账号，请登录后立即修改密码')
  logger.warn(`  用户名: ${seeded.username}`)
  logger.warn(`  密码  : ${seeded.password}`)
}

const app = createApp()

const binary = await ensureAwsNukeBinary()
if (binary.status === 'missing') logger.warn('aws-nuke 二进制缺失，账号任务将无法执行')

const server = app.listen(config.port, config.host, () => {
  logger.info(`AWS Nuke 管理平台已启动 -> http://localhost:${config.port}`)
  logger.info(`数据目录: ${config.paths.dataDir}`)
  logger.info('按 Ctrl+Enter 停止服务（或直接关闭窗口 / 运行 stop.bat）')
  // 由服务进程在监听成功后拉起浏览器：比启动脚本抢先打开可靠（脚本侧无法感知何时就绪）
  if (process.env.NUKE_OPEN_BROWSER === '1') {
    const url = `http://localhost:${config.port}`
    try {
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: false,
      }).unref()
    } catch (error) {
      logger.warn(`自动打开浏览器失败: ${error.message}（可手动访问 ${url}）`)
    }
  }
  setupHotkey()
})

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.warn(`收到 ${signal}，正在关闭服务...`)
  killAllRunning('服务停止，任务被中断')
  server.close(() => {
    logger.info('服务已停止，可以安全关闭窗口')
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000)
}

/**
 * 控制台快捷键（原始模式）：
 * - Ctrl+Enter → 优雅停止（Node 在原始模式下收到 0x0A，即 Ctrl+Enter/Ctrl+J）。
 * 关键点：原始模式接管后 Ctrl+C 不再产生系统级 CTRL_C_EVENT，外层 cmd 批处理
 * 感知不到中断，因此不会再出现 "Terminate batch job (Y/N)?" 的二次询问；
 * Ctrl+C 在此被忽略（不做任何事），停止请使用 Ctrl+Enter / 关闭窗口 / stop.bat。
 */
function setupHotkey() {
  if (!process.stdin.isTTY) return
  try {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0a) return shutdown('Ctrl+Enter')
      }
    })
  } catch (error) {
    logger.warn(`快捷键监听不可用: ${error.message}（仍可关闭窗口或运行 stop.bat 停止服务）`)
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))
