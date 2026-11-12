/** 路由与访问守卫：登录校验 + 管理员路由隔离 */
import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import AppShell from '@/layouts/AppShell.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: AppShell,
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/views/OverviewView.vue'),
        meta: { title: '运营概览' },
      },
      {
        path: 'accounts',
        name: 'accounts',
        component: () => import('@/views/AccountsView.vue'),
        meta: { title: '账号管理' },
      },
      {
        path: 'accounts/new',
        name: 'account-new',
        component: () => import('@/views/AccountEditorView.vue'),
        meta: { title: '提交 AWS 账号' },
      },
      {
        path: 'accounts/:id',
        name: 'account-detail',
        component: () => import('@/views/AccountDetailView.vue'),
        meta: { title: '账号详情' },
      },
      {
        path: 'accounts/:id/edit',
        name: 'account-edit',
        component: () => import('@/views/AccountEditorView.vue'),
        meta: { title: '编辑账号' },
      },
      {
        path: 'jobs',
        name: 'jobs',
        component: () => import('@/views/JobsView.vue'),
        meta: { title: '任务中心' },
      },
      {
        path: 'jobs/:id',
        name: 'job-detail',
        component: () => import('@/views/JobDetailView.vue'),
        meta: { title: '任务详情' },
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('@/views/ProfileView.vue'),
        meta: { title: '个人信息' },
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('@/views/UsersView.vue'),
        meta: { title: '用户管理', admin: true },
      },
      {
        path: 'deploy',
        name: 'deploy',
        component: () => import('@/views/DeployView.vue'),
        meta: { title: '部署向导', admin: true },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '平台设置', admin: true },
      },
      { path: 'system', redirect: '/deploy' },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/views/AuditView.vue'),
        meta: { title: '审计日志', admin: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (to.meta.public) {
    return auth.token ? { path: '/' } : true
  }

  if (!auth.token) return { path: '/login', query: { redirect: to.fullPath } }
  if (!auth.user) {
    const user = await auth.restore()
    if (!user) return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.meta.admin && !auth.isAdmin) return { path: '/' }
  return true
})
