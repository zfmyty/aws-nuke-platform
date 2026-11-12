/** 运行环境全局状态：顶栏权限标识等需要跨页面共享 */
import { defineStore } from 'pinia'
import { systemApi } from '@/api/index.js'

export const useSystemStore = defineStore('system', {
  state: () => ({
    status: null,
    loading: false,
    /** 上次成功探测的时间戳，用于避免频繁请求 */
    fetchedAt: 0,
    /** 任务中心轮询间隔（管理员在平台设置统一控制，所有登录用户消费同一值） */
    pollIntervalSeconds: 12,
    /** 顶栏健康检查间隔（同上） */
    healthPollIntervalSeconds: 10,
    policyLoaded: false,
  }),

  getters: {
    elevated: (state) => Boolean(state.status?.platform?.elevated),
    awsCliReady: (state) => Boolean(state.status?.awsCli?.installed),
    pollIntervalMs: (state) => {
      const seconds = Number(state.pollIntervalSeconds)
      return Math.max(3, Number.isFinite(seconds) && seconds >= 3 ? seconds : 12) * 1000
    },
    healthIntervalMs: (state) => {
      const seconds = Number(state.healthPollIntervalSeconds)
      return Math.max(3, Number.isFinite(seconds) && seconds >= 3 ? seconds : 10) * 1000
    },
  },

  actions: {
    async load({ force = false, maxAgeMs = 60000 } = {}) {
      if (!force && this.status && Date.now() - this.fetchedAt < maxAgeMs) return this.status
      if (this.loading) return this.status
      this.loading = true
      try {
        const data = await systemApi.status(force)
        this.status = data
        this.fetchedAt = Date.now()
      } catch {
        /* 顶栏标识失败不打断主流程 */
      } finally {
        this.loading = false
      }
      return this.status
    },

    /** 拉取执行策略（含轮询/健康检查间隔），幂等：已加载且未强制时不重复请求 */
    async loadPolicy(force = false) {
      if (this.policyLoaded && !force) return
      try {
        const data = await systemApi.policy()
        this.pollIntervalSeconds = data.jobPollIntervalSeconds || 12
        this.healthPollIntervalSeconds = data.healthPollIntervalSeconds || 10
        this.policyLoaded = true
      } catch {
        /* 拉取失败沿用默认值 */
      }
    },

    /** 管理员保存设置后同步本地值，任务中心立即生效 */
    setPollInterval(seconds) {
      const value = Number(seconds)
      if (Number.isInteger(value) && value >= 3 && value <= 60) this.pollIntervalSeconds = value
    },

    /** 管理员保存设置后同步本地健康检查间隔，顶栏指示灯立即生效 */
    setHealthInterval(seconds) {
      const value = Number(seconds)
      if (Number.isInteger(value) && value >= 3 && value <= 120) this.healthPollIntervalSeconds = value
    },
  },
})
