/**
 * 全局配置：集中管理路径、端口、运行参数。
 * 所有模块只通过本文件获取环境相关信息，避免路径散落。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** server/ 目录 */
export const SERVER_ROOT = path.resolve(__dirname, '../..')
/** 项目根目录 */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')

const env = process.env

export const config = {
  env: env.NODE_ENV || 'production',
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',

  paths: {
    serverRoot: SERVER_ROOT,
    projectRoot: PROJECT_ROOT,
    dataDir: env.NUKE_DATA_DIR || path.join(SERVER_ROOT, 'data'),
    publicDir: path.join(SERVER_ROOT, 'public'),
    runtimeBinDir: path.join(PROJECT_ROOT, 'runtime', 'bin'),
    awsNukeBin: env.AWS_NUKE_BIN || path.join(PROJECT_ROOT, 'runtime', 'bin', 'aws-nuke.exe'),
    awsCliCandidates: [
      'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
      'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe',
      path.join(env.LOCALAPPDATA || '', 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'),
    ],
  },

  auth: {
    tokenTtlSeconds: Number(env.TOKEN_TTL || 60 * 60 * 12),
    // 初始管理员账号，可通过环境变量覆盖
    seedAdmin: {
      username: env.SEED_ADMIN_USER || 'admin',
      password: env.SEED_ADMIN_PASS || 'Admin@123456',
    },
  },

  nuke: {
    /** 单次任务最长运行时间（毫秒），超时后强制终止 */
    jobTimeoutMs: Number(env.NUKE_JOB_TIMEOUT || 1000 * 60 * 60),
    /** 「扫描后确认」模式下等待用户确认的时长（毫秒），超时自动终止任务 */
    promptTimeoutMs: Number(env.NUKE_PROMPT_TIMEOUT || 1000 * 60 * 5),
    /** 内存中保留的日志行数上限 */
    logBufferLines: 3000,
  },
}

/** 确保运行期目录存在 */
export function ensureDirs() {
  const dirs = [
    config.paths.dataDir,
    path.join(config.paths.dataDir, 'db'),
    path.join(config.paths.dataDir, 'configs'),
    path.join(config.paths.dataDir, 'logs'),
  ]
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true })
  return dirs
}

export const dataPath = (...segments) => path.join(config.paths.dataDir, ...segments)
