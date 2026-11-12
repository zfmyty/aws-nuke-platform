<script setup>
/** 应用外壳：侧边导航 + 顶栏 + 内容区，按角色裁剪菜单 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { useSystemStore } from '@/stores/system.js'
import { useToastStore } from '@/stores/toast.js'
import { systemApi } from '@/api/index.js'
import { formatTime } from '@/utils/format.js'
import AppIcon from '@/components/AppIcon.vue'

const auth = useAuthStore()
const system = useSystemStore()
const toast = useToastStore()
const route = useRoute()
const router = useRouter()

const mobileOpen = ref(false)
const userMenuOpen = ref(false)
const shellRef = ref(null)

/** 侧栏收起：用户偏好持久化；收起时鼠标移入侧栏会临时展开（悬停即伸出手感） */
const COLLAPSE_KEY = 'sidebar-collapsed'
const railCollapsed = ref(false)
const hoverOpen = ref(false)
try {
  railCollapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1'
} catch {
  /* 本地存储不可用时忽略 */
}
/** railMode = 窄条状态；railCollapsed = 用户偏好收起（含悬停临时展开期间） */
const railMode = computed(() => railCollapsed.value && !hoverOpen.value)

function toggleCollapse() {
  railCollapsed.value = !railCollapsed.value
  hoverOpen.value = false
  try {
    localStorage.setItem(COLLAPSE_KEY, railCollapsed.value ? '1' : '0')
  } catch {
    /* 同上 */
  }
}
function onSidebarEnter() {
  if (railCollapsed.value) hoverOpen.value = true
}
function onSidebarLeave() {
  hoverOpen.value = false
}

const navGroups = computed(() => {
  const groups = [
    {
      label: '工作台',
      items: [
        { to: '/', label: '运营概览', icon: 'grid', exact: true },
        { to: '/accounts', label: '账号管理', icon: 'cloud' },
        { to: '/jobs', label: '任务中心', icon: 'terminal' },
      ],
    },
  ]
  if (auth.isAdmin) {
    groups.push({
      label: '平台运维',
      items: [
        { to: '/deploy', label: '部署向导', icon: 'bolt' },
        { to: '/settings', label: '平台设置', icon: 'sliders' },
        { to: '/users', label: '用户管理', icon: 'users' },
        { to: '/audit', label: '审计日志', icon: 'shield' },
      ],
    })
  }
  return groups
})

const pageTitle = computed(() => route.meta?.title || '概览')

/**
 * 顶栏面包屑：控制台 → 列表层 → 详情层。
 * 列表层（账号管理 / 任务中心）可点击返回；最后一级是当前页，不可点击。
 */
const crumbs = computed(() => {
  const path = route.path
  const root = { label: '控制台', to: '/' }
  const title = route.meta?.title || '概览'
  const parents = [
    { base: '/accounts', parent: { label: '账号管理', to: '/accounts' } },
    { base: '/jobs', parent: { label: '任务中心', to: '/jobs' } },
  ]
  const hit = parents.find((item) => path === item.base || path.startsWith(`${item.base}/`))
  if (!hit || path === hit.base) return [root, { label: title }]
  return [root, hit.parent, { label: title }]
})

function isActive(item) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to)
}

function navigate(item) {
  mobileOpen.value = false
  router.push(item.to)
}

function logout() {
  auth.logout()
  toast.info('已退出登录')
  router.push('/login')
}

function onDocumentClick(event) {
  if (!event.target.closest?.('.user-trigger')) userMenuOpen.value = false
}

/* ---- 服务健康探测：轮询 /api/health，指示灯与悬浮卡片展示真实返回结果 ---- */
const serviceState = ref('checking') // checking | online | offline
const serviceLatency = ref(null)
const serviceCheckedAt = ref(null)
const serviceInfo = ref(null)
let healthTimer = null

async function checkService() {
  const started = performance.now()
  try {
    const data = await systemApi.health()
    if (!data?.ok) throw new Error('bad payload')
    serviceLatency.value = Math.max(1, Math.round(performance.now() - started))
    serviceInfo.value = data
    serviceState.value = 'online'
  } catch {
    serviceLatency.value = null
    serviceInfo.value = null
    serviceState.value = 'offline'
  }
  serviceCheckedAt.value = new Date()
}

function startHealthPolling() {
  stopHealthPolling()
  void checkService()
  healthTimer = setInterval(() => void checkService(), system.healthIntervalMs)
}

function stopHealthPolling() {
  if (healthTimer) clearInterval(healthTimer)
  healthTimer = null
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  router.afterEach(() => {
    mobileOpen.value = false
  })
  if (auth.isAdmin) void system.load()
  // 健康检查间隔由管理员在平台统一配置；策略加载后按新间隔（重）启动
  system.loadPolicy().then(startHealthPolling)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  stopHealthPolling()
})

watch(
  () => system.healthIntervalMs,
  () => startHealthPolling(),
)
</script>

<template>
  <div ref="shellRef" class="shell">
    <div v-if="mobileOpen" class="nav-scrim" @click="mobileOpen = false" />

    <aside
      class="sidebar"
      :class="{ open: mobileOpen, rail: railMode, 'rail-open': railCollapsed && !railMode }"
      @mouseenter="onSidebarEnter"
      @mouseleave="onSidebarLeave"
    >
      <div class="brand">
        <div class="brand-mark">
          <img src="/logo.png" alt="平台 Logo" class="brand-logo" />
        </div>
        <div class="brand-text">
          <strong>AWS Nuke</strong>
          <span>资源清理平台</span>
        </div>
      </div>

      <nav class="nav">
        <div v-for="group in navGroups" :key="group.label" class="nav-group">
          <p class="nav-label">{{ group.label }}</p>
          <button
            v-for="item in group.items"
            :key="item.to"
            type="button"
            class="nav-item"
            :class="{ active: isActive(item) }"
            :title="item.label"
            @click="navigate(item)"
          >
            <AppIcon :name="item.icon" :size="17" />
            <span>{{ item.label }}</span>
            <i v-if="isActive(item)" class="nav-indicator" />
          </button>
        </div>
      </nav>

      <div class="sidebar-foot">
        <button
          class="role-card"
          type="button"
          title="进入个人信息"
          @click="router.push('/profile')"
        >
          <AppIcon :name="auth.isAdmin ? 'shield-check' : 'user'" :size="15" />
          <div>
            <strong>{{ auth.isAdmin ? '管理员权限' : '普通用户' }}</strong>
            <span>{{ auth.isAdmin ? '可管理全部账号与用户' : '仅管理本人提交的账号' }}</span>
          </div>
        </button>
        <p class="version">v1.0.0 · aws-nuke v3.68.3</p>
      </div>

      <!-- 收起/展开按钮：桌面端显示，骑在侧栏右缘 -->
      <button
        class="rail-toggle"
        type="button"
        :title="railCollapsed ? '展开侧栏' : '收起侧栏'"
        @click="toggleCollapse"
      >
        <AppIcon :name="railMode ? 'right' : 'left'" :size="12" />
      </button>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="icon-btn mobile-toggle" type="button" aria-label="菜单" @click="mobileOpen = !mobileOpen">
          <AppIcon name="sliders" :size="18" />
        </button>
        <div class="crumb">
          <template v-for="(item, index) in crumbs" :key="`${item.label}-${index}`">
            <AppIcon v-if="index" name="right" :size="13" />
            <router-link v-if="item.to && index < crumbs.length - 1" :to="item.to" class="crumb-link">
              {{ item.label }}
            </router-link>
            <strong v-else>{{ item.label }}</strong>
          </template>
        </div>

        <div class="topbar-right">
          <div
            v-if="auth.isAdmin && system.status"
            class="privilege"
            :class="system.elevated ? 'ok' : 'warn'"
            tabindex="0"
          >
            <AppIcon :name="system.elevated ? 'lock' : 'unlock'" :size="12" />
            <span>{{ system.elevated ? '管理员启动' : '普通启动' }}</span>
            <div class="privilege-tip" role="tooltip">
              <div class="tip-head">
                <AppIcon :name="system.elevated ? 'lock' : 'unlock'" :size="14" />
                <strong>{{ system.elevated ? '平台以管理员权限启动' : '平台未以管理员权限启动' }}</strong>
              </div>
              <p v-if="system.elevated">
                服务进程已提权，可以执行需要系统目录与 PATH 写入的操作。
              </p>
              <p v-else>
                服务进程为普通权限。这一状态下，除「一键安装 AWS CLI」之外的所有功能都正常可用。
              </p>
              <dl>
                <dt>需要管理员</dt>
                <dd>
                  一键安装 AWS CLI（写入 <code>Program Files</code> 并修改系统 PATH）
                  <span v-if="system.awsCliReady" class="tip-ok">当前已安装，不受影响</span>
                </dd>
                <dt>不受影响</dt>
                <dd>执行 aws-nuke 演练与清理、主账号凭证保存、配置生成、日志与任务记录</dd>
              </dl>
              <p v-if="!system.elevated" class="tip-foot">
                本次启动时未授予管理员权限。关闭服务窗口后重新双击 <code>start.bat</code>，
                在系统弹窗中点「是」即可切换为管理员启动。
              </p>
            </div>
          </div>

          <div class="live-pill" :class="serviceState" tabindex="0">
            <i class="pulse" />
            <span>
              {{ serviceState === 'online'
                ? `服务在线 · ${serviceLatency}ms`
                : serviceState === 'checking' ? '检测中…' : '服务离线' }}
            </span>
            <div class="live-tip" role="tooltip">
              <div class="tip-head">
                <AppIcon :name="serviceState === 'online' ? 'check' : 'alert'" :size="14" />
                <strong>
                  {{ serviceState === 'online'
                    ? '后端服务运行正常'
                    : serviceState === 'checking' ? '正在检测后端服务…' : '无法连接后端服务' }}
                </strong>
              </div>
              <template v-if="serviceState === 'online'">
                <dl>
                  <dt>健康检查</dt>
                  <dd><code class="mono">GET /api/health</code> · 200 OK</dd>
                  <dt>响应耗时</dt>
                  <dd class="mono">{{ serviceLatency }}ms</dd>
                  <dt>服务端版本</dt>
                  <dd class="mono">{{ serviceInfo?.version || '—' }}</dd>
                  <dt>服务端时间</dt>
                  <dd class="mono">{{ serviceInfo?.time ? formatTime(serviceInfo.time) : '—' }}</dd>
                </dl>
              </template>
              <p v-else-if="serviceState === 'offline'" class="tip-foot">
                健康检查请求失败。请确认 <code>start.bat</code> 服务窗口是否仍在运行，
                或检查网络连接后等待下次自动检测。
              </p>
            </div>
          </div>

          <div class="user-trigger" :class="{ open: userMenuOpen }" @click.stop="userMenuOpen = !userMenuOpen">
            <div class="avatar">{{ auth.initials }}</div>
            <div class="user-meta">
              <strong>{{ auth.displayName }}</strong>
              <span>{{ auth.isAdmin ? 'admin' : 'user' }}</span>
            </div>
            <AppIcon name="down" :size="14" />
          </div>

          <div v-if="userMenuOpen" class="menu user-menu">
            <button type="button" @click="router.push('/profile')">
              <AppIcon name="user" :size="15" />个人信息
            </button>
            <button v-if="auth.isAdmin" type="button" @click="router.push('/settings')">
              <AppIcon name="sliders" :size="15" />平台设置
            </button>
            <button type="button" @click="logout">
              <AppIcon name="logout" :size="15" />退出登录
            </button>
          </div>
        </div>
      </header>

      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}

/* ---------- 侧栏 ---------- */
.sidebar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  height: 100vh;
  flex: none;
  padding: 18px 14px;
  border-right: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(10, 17, 28, 0.78), rgba(7, 12, 20, 0.8));
  /* 注意：这里不能加 backdrop-filter——带背景模糊的元素做宽度动画时，
     Chromium 会把整个侧栏按初始尺寸光栅化成纹理再拉伸，收起/展开后图标和文字都会发虚。
     侧栏背后是全局已模糊的壁纸，这层模糊本来也是冗余的。 */
  transition: width 0.28s var(--ease);
}

/* ---------- 侧栏收起（桌面端） ---------- */
/* 窄条：只留图标列。文字不直接 display:none，而是透明度 + 宽度过渡，避免展开/收起瞬间跳变 */
.sidebar.rail {
  width: 68px;
  padding: 18px 10px;
}
/* 收起时容器收窄，文字被容器边缘裁切滑出，而不是突然消失 */
.brand,
.nav,
.sidebar-foot {
  overflow: hidden;
}
.brand {
  transition: gap 0.28s var(--ease);
}
.nav-item {
  transition: all 0.2s var(--ease), gap 0.28s var(--ease), padding 0.28s var(--ease);
}
.role-card {
  transition: border-color 0.2s var(--ease), background 0.2s var(--ease), gap 0.28s var(--ease);
}

.brand-text,
.nav-item span,
.role-card div {
  white-space: nowrap;
  transition: opacity 0.2s var(--ease) 0.14s;
}
.nav-label {
  white-space: nowrap;
  transition:
    opacity 0.2s var(--ease) 0.14s,
    height 0.28s var(--ease),
    padding 0.28s var(--ease);
}
.version {
  white-space: nowrap;
  transition:
    opacity 0.2s var(--ease) 0.14s,
    height 0.28s var(--ease),
    margin 0.28s var(--ease);
}

.sidebar.rail .brand {
  gap: 0;
}
.sidebar.rail .nav-item {
  gap: 0;
  justify-content: center;
  padding: 0;
}
.sidebar.rail .role-card {
  gap: 0;
  justify-content: center;
  padding: 10px 0;
}
.sidebar.rail .brand-text,
.sidebar.rail .nav-item span,
.sidebar.rail .role-card div {
  opacity: 0;
  width: 0;
  overflow: hidden;
  /* 收起时文字先快速淡出，宽度等侧栏收完再清零（已被裁切，看不见） */
  transition: opacity 0.12s var(--ease), width 0s linear 0.26s;
}
.sidebar.rail .nav-label {
  opacity: 0;
  height: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
  transition:
    opacity 0.12s var(--ease),
    height 0.28s var(--ease),
    padding 0.28s var(--ease);
}
.sidebar.rail .version {
  opacity: 0;
  height: 0;
  margin-top: 0;
  overflow: hidden;
  transition:
    opacity 0.12s var(--ease),
    height 0.28s var(--ease),
    margin 0.28s var(--ease);
}

/* 收起状态下鼠标移入：侧栏回到完整宽度，内容区随 flex 一起平滑伸缩 */
.sidebar.rail-open {
  width: var(--sidebar-w);
}

/* 骑在侧栏右缘的收起/展开按钮：相对侧栏垂直居中 */
/* 骑在侧栏右缘的收起/展开按钮：垂直居中 */
.rail-toggle {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  right: -12px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-panel-solid);
  color: var(--text-muted);
  cursor: pointer;
  z-index: 5;
  transition: color 0.2s var(--ease), border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}
/* svg 绝对定位居中：不依赖 grid/flex 的取整行为，任何 DPI 下都以按钮盒几何中心对齐 */
.rail-toggle svg {
  position: absolute;
  inset: 0;
  margin: auto;
  display: block;
}
.rail-toggle:hover {
  color: var(--accent);
  border-color: rgba(34, 211, 238, 0.45);
  box-shadow: 0 0 12px rgba(34, 211, 238, 0.3);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 4px 6px 18px;
  border-bottom: 1px solid var(--border);
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  /* 禁止收缩：收起态可用宽度比logo小 1px 时，flex 默认会把图标压扁成 33x34 */
  flex: none;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(10, 18, 30, 0.75);
  border: 1px solid rgba(120, 170, 210, 0.22);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.brand-logo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* 独立合成层：避免侧栏宽度动画期间被浏览器以低分辨率光栅化缓存，收起后图标发虚 */
  transform: translateZ(0);
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.brand-text strong {
  font-size: 14px;
  letter-spacing: 0.01em;
}
.brand-text span {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.nav {
  flex: 1;
  overflow-y: auto;
  padding: 14px 0;
}
.nav-group + .nav-group {
  margin-top: 18px;
}
.nav-label {
  padding: 0 10px 7px;
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 38px;
  margin-bottom: 3px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s var(--ease);
}
.nav-item:hover {
  color: var(--text);
  background: rgba(120, 170, 210, 0.07);
}
.nav-item.active {
  color: #d8fbff;
  border-color: rgba(34, 211, 238, 0.24);
  background: linear-gradient(90deg, rgba(34, 211, 238, 0.16), rgba(34, 211, 238, 0.02));
}
.nav-indicator {
  position: absolute;
  left: -1px;
  top: 50%;
  width: 2px;
  height: 18px;
  transform: translateY(-50%);
  border-radius: 2px;
  background: var(--accent);
  box-shadow: var(--glow-cyan);
}

.sidebar-foot {
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.role-card {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(34, 211, 238, 0.04);
  color: var(--text-dim);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.2s var(--ease),
    background 0.2s var(--ease),
    gap 0.28s var(--ease);
}
.role-card:hover {
  border-color: rgba(34, 211, 238, 0.35);
  background: rgba(34, 211, 238, 0.08);
}
.role-card strong {
  display: block;
  font-size: 12px;
  color: var(--text);
}
.role-card span {
  font-size: 10.5px;
  color: var(--text-muted);
  line-height: 1.4;
}
.version {
  margin-top: 10px;
  text-align: center;
  font-size: 10.5px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}

/* ---------- 主区域 ---------- */
.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 14px;
  height: var(--header-h);
  padding: 0 26px;
  border-bottom: 1px solid var(--border);
  background: rgba(7, 12, 20, 0.82);
  backdrop-filter: blur(14px);
}
.crumb {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text-muted);
}
/* 可点击的层级：悬停亮起 */
.crumb-link {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.15s var(--ease);
}
.crumb-link:hover {
  color: var(--accent);
}
.crumb strong {
  color: var(--text);
  font-weight: 500;
}
.topbar-right {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  margin-left: auto;
}
.live-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: default;
  outline: none;
  transition: all 0.18s var(--ease);
}
.live-pill.online {
  border: 1px solid rgba(52, 211, 153, 0.26);
  background: rgba(52, 211, 153, 0.08);
  color: #8bf3c9;
}
.live-pill.online:hover,
.live-pill.online:focus-visible {
  border-color: rgba(52, 211, 153, 0.45);
}
.live-pill.checking {
  border: 1px solid rgba(120, 170, 210, 0.25);
  background: rgba(120, 170, 210, 0.06);
  color: var(--text-muted);
}
.live-pill.offline {
  border: 1px solid rgba(244, 63, 94, 0.3);
  background: rgba(244, 63, 94, 0.08);
  color: #ffb3c1;
}
.live-pill.offline:hover,
.live-pill.offline:focus-visible {
  border-color: rgba(244, 63, 94, 0.5);
}
/* 离线/检测中：指示灯不动，颜色随状态 */
.live-pill.checking .pulse {
  background: var(--text-faint);
  animation: none;
}
.live-pill.offline .pulse {
  background: var(--danger);
  animation: none;
}
.live-pill .pulse {
  animation: pulse-dot 2s infinite;
}

/* 健康检查悬浮卡：与运行权限标识同一套卡片视觉 */
.live-tip {
  position: absolute;
  top: calc(100% + 9px);
  right: 0;
  z-index: 60;
  width: 320px;
  padding: 13px 14px;
  border-radius: 10px;
  border: 1px solid rgba(34, 211, 238, 0.2);
  background: #0b1523;
  box-shadow: 0 18px 40px rgba(2, 8, 20, 0.6);
  color: var(--text-dim, #b6c6d6);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: normal;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity 0.16s var(--ease), transform 0.16s var(--ease), visibility 0.16s;
  pointer-events: none;
}
.live-pill:hover .live-tip,
.live-pill:focus-visible .live-tip {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.live-tip .tip-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
  color: var(--text, #e6eef7);
  font-size: 12px;
}
.live-tip.online-icon .tip-head svg,
.live-tip .tip-head svg {
  color: var(--accent);
}
.live-pill.offline .live-tip .tip-head svg {
  color: #ff8fa3;
}
.live-tip dl {
  margin: 9px 0 0;
  padding-top: 9px;
  border-top: 1px solid rgba(120, 170, 210, 0.12);
  display: grid;
  gap: 6px;
}
.live-tip dt {
  color: var(--text-faint, #64768b);
  font-size: 10.5px;
  letter-spacing: 0.3px;
}
.live-tip dd {
  margin: 0;
  color: var(--text-dim, #b6c6d6);
}
.live-tip code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.14);
  color: var(--text, #e6eef7);
  font-family: var(--font-mono);
  font-size: 10.5px;
}
.live-tip .tip-foot {
  margin: 0;
  color: #ffb3c1;
}

/* 运行权限标识 + 悬浮说明 */
.privilege {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: default;
  outline: none;
  transition: all 0.18s var(--ease);
}
.privilege.ok {
  border: 1px solid rgba(52, 211, 153, 0.24);
  background: rgba(52, 211, 153, 0.06);
  color: #8bf3c9;
}
.privilege.warn {
  border: 1px solid rgba(251, 191, 36, 0.28);
  background: rgba(251, 191, 36, 0.08);
  color: #fbd38d;
}
.privilege.warn:hover,
.privilege.warn:focus-visible {
  border-color: rgba(251, 191, 36, 0.5);
  background: rgba(251, 191, 36, 0.13);
}
.privilege.ok:hover,
.privilege.ok:focus-visible {
  border-color: rgba(52, 211, 153, 0.42);
}
.privilege-tip {
  position: absolute;
  top: calc(100% + 9px);
  right: 0;
  z-index: 60;
  width: 330px;
  padding: 13px 14px;
  border-radius: 10px;
  border: 1px solid rgba(34, 211, 238, 0.2);
  background: #0b1523;
  box-shadow: 0 18px 40px rgba(2, 8, 20, 0.6);
  color: var(--text-dim, #b6c6d6);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: normal;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity 0.16s var(--ease), transform 0.16s var(--ease), visibility 0.16s;
  pointer-events: none;
}
.privilege:hover .privilege-tip,
.privilege:focus-visible .privilege-tip {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.tip-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
  color: var(--text, #e6eef7);
  font-size: 12px;
}
.privilege.warn .tip-head svg {
  color: #fbd38d;
}
.privilege.ok .tip-head svg {
  color: var(--success, #34d399);
}
.privilege-tip p {
  margin: 0;
  color: var(--text-muted, #8296ab);
}
.privilege-tip dl {
  margin: 9px 0 0;
  padding-top: 9px;
  border-top: 1px solid rgba(120, 170, 210, 0.12);
  display: grid;
  gap: 6px;
}
.privilege-tip dt {
  color: var(--text-faint, #64768b);
  font-size: 10.5px;
  letter-spacing: 0.3px;
}
.privilege-tip dd {
  margin: 0;
  color: var(--text-dim, #b6c6d6);
}
.privilege-tip code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.14);
  color: var(--text, #e6eef7);
  font-family: var(--font-mono);
  font-size: 10.5px;
}
.privilege-tip .tip-ok {
  display: inline-block;
  margin-left: 6px;
  color: var(--success, #34d399);
}
.privilege-tip .tip-foot {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid rgba(120, 170, 210, 0.12);
  color: #fbd38d;
}
.pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  animation: pulse-dot 2s infinite;
}
.user-trigger {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 8px 5px 5px;
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.2s var(--ease);
  color: var(--text-muted);
}
.user-trigger:hover,
.user-trigger.open {
  border-color: var(--border);
  background: rgba(120, 170, 210, 0.07);
}
.avatar {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  border-radius: 50%;
  font-size: 12.5px;
  font-weight: 600;
  color: #04121a;
  background: linear-gradient(135deg, #67e8f9, #a78bfa);
}
.user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.user-meta strong {
  font-size: 12.5px;
  color: var(--text);
}
.user-meta span {
  font-size: 10px;
  color: var(--text-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.user-menu {
  top: calc(100% + 10px);
}
.mobile-toggle {
  display: none;
}

.content {
  flex: 1;
  padding: 26px;
  max-width: 1440px;
  width: 100%;
  margin: 0 auto;
}

.page-enter-active,
.page-leave-active {
  transition:
    opacity 0.2s var(--ease),
    transform 0.2s var(--ease);
}
.page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.page-leave-to {
  opacity: 0;
}

.nav-scrim {
  position: fixed;
  inset: 0;
  z-index: 39;
  background: rgba(3, 7, 14, 0.6);
  backdrop-filter: blur(3px);
}

@media (max-width: 1024px) {
  .sidebar {
    position: fixed;
    left: 0;
    transform: translateX(-100%);
    transition: transform 0.28s var(--ease);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open {
    transform: translateX(0);
  }
  /* 窄屏下侧栏是抽屉，收起模式与悬停展开不生效，恢复完整宽度与文字 */
  .sidebar.rail,
  .sidebar.rail-open {
    width: var(--sidebar-w);
    padding: 18px 14px;
    position: fixed;
    box-shadow: var(--shadow-lg);
  }
  .sidebar.rail .brand {
    gap: 11px;
  }
  .sidebar.rail .nav-item {
    gap: 10px;
    justify-content: flex-start;
    padding: 0 12px;
  }
  .sidebar.rail .role-card {
    gap: 9px;
    justify-content: flex-start;
    padding: 10px;
  }
  .sidebar.rail .brand-text,
  .sidebar.rail .nav-item span,
  .sidebar.rail .role-card div {
    opacity: 1;
    width: auto;
    overflow: visible;
    transition: opacity 0.2s var(--ease);
  }
  .sidebar.rail .nav-label {
    opacity: 1;
    height: auto;
    padding: 0 10px 7px;
    overflow: visible;
  }
  .sidebar.rail .version {
    opacity: 1;
    height: auto;
    margin-top: 10px;
    overflow: visible;
  }
  .rail-toggle {
    display: none;
  }
  .mobile-toggle {
    display: inline-flex;
  }
  .content {
    padding: 18px 16px;
  }
  .topbar {
    padding: 0 14px;
  }
  .live-pill,
  .privilege,
  .user-meta {
    display: none;
  }
  /* 窄屏下悬浮卡片贴右边缘，避免超出视口 */
  .privilege-tip {
    right: -6px;
    width: min(300px, calc(100vw - 32px));
  }
}
</style>
