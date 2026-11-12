/** 登录态与权限：token 持久化在 localStorage，用户信息随会话加载 */
import { defineStore } from 'pinia'
import { authApi } from '@/api/index.js'
import { tokenStore } from '@/api/client.js'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: tokenStore.get(),
    user: null,
    loading: false,
    ready: false,
  }),

  getters: {
    isLoggedIn: (state) => Boolean(state.token && state.user),
    isAdmin: (state) => state.user?.role === 'admin',
    displayName: (state) => state.user?.displayName || state.user?.username || '',
    initials: (state) => {
      const name = state.user?.displayName || state.user?.username || '?'
      return name.slice(0, 1).toUpperCase()
    },
  },

  actions: {
    async login(username, password) {
      this.loading = true
      try {
        const data = await authApi.login({ username, password })
        this.token = data.token
        this.user = data.user
        tokenStore.set(data.token)
        this.ready = true
        return data.user
      } finally {
        this.loading = false
      }
    },

    async restore() {
      if (!this.token) {
        this.ready = true
        return null
      }
      try {
        const data = await authApi.me()
        this.user = data.user
        return data.user
      } catch {
        this.logout()
        return null
      } finally {
        this.ready = true
      }
    },

    logout() {
      this.token = ''
      this.user = null
      tokenStore.clear()
    },

    /** 数据可见性：管理员全量，普通用户仅自己 */
    canManage(ownerId) {
      return this.user?.role === 'admin' || ownerId === this.user?.id
    },
  },
})
