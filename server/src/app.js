/**
 * Express 应用装配：中间件 → 领域路由 → 静态资源 → 错误处理
 * 路由前缀统一 /api，前端构建产物由本服务托管，实现单端口发布。
 */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config/index.js'
import { cors } from './middleware/cors.js'
import { authenticate } from './middleware/auth.js'
import { errorHandler, notFound } from './middleware/error.js'
import { authRouter } from './modules/auth/routes.js'
import { usersRouter } from './modules/users/routes.js'
import { accountsRouter } from './modules/accounts/routes.js'
import { jobsRouter } from './modules/jobs/routes.js'
import { systemRouter } from './modules/system/routes.js'
import { dashboardRouter } from './modules/dashboard/routes.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use(cors)
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'aws-nuke-platform', version: '1.0.0', time: new Date().toISOString() })
  })

  app.use('/api/auth', authRouter)

  // 以下接口都需要登录
  app.use('/api/users', authenticate, usersRouter)
  app.use('/api/accounts', authenticate, accountsRouter)
  app.use('/api/jobs', authenticate, jobsRouter)
  app.use('/api/system', authenticate, systemRouter)
  app.use('/api/dashboard', authenticate, dashboardRouter)

  app.use('/api', notFound)

  // 前端静态资源 + SPA history 回退
  const publicDir = config.paths.publicDir
  if (fs.existsSync(publicDir)) {
    app.use(
      express.static(publicDir, {
        index: 'index.html',
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) {
            // index.html 引用的是带内容哈希的产物文件，重新构建后旧引用会 404；
            // 它本身绝不能被浏览器缓存，否则升级后要手动刷新才能恢复页面。
            res.setHeader('Cache-Control', 'no-cache')
          } else {
            // 带 hash 的产物文件可以长缓存
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
          }
        },
      }),
    )
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      const indexFile = path.join(publicDir, 'index.html')
      if (!fs.existsSync(indexFile)) return next()
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(indexFile)
    })
  }

  app.use(errorHandler)
  return app
}
