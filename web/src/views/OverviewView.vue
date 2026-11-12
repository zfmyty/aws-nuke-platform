<script setup>
/** 运营概览：账号规模、任务健康度、最近动态 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { dashboardApi, systemApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import { envMeta, formatDuration, statusMeta, timeAgo } from '@/utils/format.js'

const auth = useAuthStore()
const toast = useToastStore()
const router = useRouter()

const data = ref(null)
const status = ref(null)
const loading = ref(true)

const cards = computed(() => {
  const accounts = data.value?.accounts
  const jobs = data.value?.jobs
  return [
    {
      label: auth.isAdmin ? '平台账号总数' : '我的 AWS 账号',
      value: accounts?.total ?? 0,
      icon: 'cloud',
      tone: 'cyan',
      foot: accounts ? `生产 ${accounts.byEnvironment.prod || 0} · 开发 ${accounts.byEnvironment.dev || 0}` : '',
    },
    {
      label: '累计任务',
      value: jobs?.total ?? 0,
      icon: 'terminal',
      tone: 'violet',
      foot: jobs ? `成功 ${jobs.byStatus.succeeded || 0} · 失败 ${jobs.byStatus.failed || 0}` : '',
    },
    {
      label: '执行中',
      value: jobs?.byStatus.running ?? 0,
      icon: 'activity',
      tone: (jobs?.byStatus.running ?? 0) > 0 ? 'green' : 'muted',
      foot: '实时进程',
    },
    {
      label: '失败任务',
      value: jobs?.byStatus.failed ?? 0,
      icon: 'alert',
      tone: (jobs?.byStatus.failed ?? 0) > 0 ? 'red' : 'muted',
      foot: jobs
        ? `已取消 ${jobs.byStatus.canceled || 0} · 排队中 ${jobs.byStatus.queued || 0}`
        : '',
    },
    {
      label: '最近执行',
      value: accounts?.lastRunAt ? timeAgo(accounts.lastRunAt) : '暂无',
      icon: 'clock',
      tone: 'muted',
      foot: '按账号维度统计',
    },
  ]
})

const readySteps = computed(() => status.value?.steps || [])
const notReady = computed(() => status.value && !status.value.ready)

async function load() {
  loading.value = true
  try {
    const tasks = [dashboardApi.get()]
    if (auth.isAdmin) tasks.push(systemApi.status())
    const [dashboard, sys] = await Promise.all(tasks)
    data.value = dashboard
    status.value = sys || null
  } catch (error) {
    toast.error(error.message)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>运营概览</h1>
        <p class="sub">
          {{ auth.isAdmin ? '全平台账号与清理任务的实时态势' : '你提交的账号与清理任务动态' }}
        </p>
      </div>
      <div class="row">
        <button class="btn btn-sm" type="button" @click="load">
          <AppIcon name="refresh" :size="14" />刷新
        </button>
        <button class="btn btn-primary btn-sm" type="button" @click="router.push('/accounts/new')">
          <AppIcon name="plus" :size="14" />提交账号
        </button>
      </div>
    </div>

    <!-- 部署未就绪提示 -->
    <div v-if="notReady" class="notice notice-warn">
      <AppIcon name="alert" :size="17" />
      <div class="grow">
        <strong>部署尚未完成</strong>，以下环节需要处理：
        <span v-for="step in readySteps.filter((s) => !s.ready)" :key="step.id" class="chip">{{ step.title }}</span>
      </div>
      <button class="btn btn-sm" type="button" @click="router.push('/deploy')">前往部署</button>
    </div>

    <!-- 统计卡 -->
    <div class="grid-cards">
      <div v-for="card in cards" :key="card.label" class="panel panel-pad stat" :class="`tone-${card.tone}`">
        <div class="stat-top">
          <span class="stat-label">{{ card.label }}</span>
          <span class="stat-icon"><AppIcon :name="card.icon" :size="16" /></span>
        </div>
        <p class="stat-value">{{ loading ? '—' : card.value }}</p>
        <p class="stat-foot">{{ card.foot }}</p>
      </div>
    </div>

    <div class="split">
      <!-- 最近任务 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">
            <AppIcon name="activity" :size="15" style="color: var(--accent)" />
            <h3>最近任务</h3>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click="router.push('/jobs')">
            全部任务<AppIcon name="right" :size="13" />
          </button>
        </div>
        <div v-if="loading" class="panel-body stack">
          <div class="skeleton" style="width: 70%" />
          <div class="skeleton" style="width: 50%" />
          <div class="skeleton" style="width: 60%" />
        </div>
        <AppEmpty
          v-else-if="!data?.recentJobs?.length"
          icon="terminal"
          title="还没有任务记录"
          description="选择账号发起一次演练，即可在这里看到执行过程"
        >
          <button class="btn btn-sm" type="button" @click="router.push('/accounts')">去选择账号</button>
        </AppEmpty>
        <div v-else class="job-list">
          <button
            v-for="job in data.recentJobs"
            :key="job.id"
            class="job-row"
            type="button"
            @click="router.push(`/jobs/${job.id}`)"
          >
            <span class="job-icon" :class="job.meta?.mode === 'live' ? 'danger' : ''">
              <AppIcon :name="job.meta?.mode === 'live' ? 'zap' : 'play'" :size="15" />
            </span>
            <div class="grow truncate">
              <p class="job-title truncate">{{ job.title }}</p>
              <p class="job-sub">
                <span>{{ job.createdBy }}</span>
                <i />
                <span>{{ timeAgo(job.createdAt) }}</span>
                <i />
                <span>{{ formatDuration(job.startedAt, job.finishedAt) }}</span>
              </p>
            </div>
            <span class="badge" :class="`badge-${statusMeta(job.status).tone}`">
              <i v-if="job.status === 'running'" class="dot-pulse" />
              <i v-else class="dot" />
              {{ statusMeta(job.status).label }}
            </span>
          </button>
        </div>
      </section>

      <!-- 账号概览 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">
            <AppIcon name="cloud" :size="15" style="color: var(--violet)" />
            <h3>{{ auth.isAdmin ? '账号归属分布' : '我的账号' }}</h3>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click="router.push('/accounts')">
            管理<AppIcon name="right" :size="13" />
          </button>
        </div>

        <div v-if="auth.isAdmin" class="panel-body">
          <AppEmpty v-if="!data?.ownerBreakdown?.length" icon="users" title="暂无账号归属数据" />
          <ul v-else class="owners">
            <li v-for="owner in data.ownerBreakdown" :key="owner.ownerId">
              <span class="owner-avatar">{{ owner.ownerName.slice(0, 1) }}</span>
              <span class="grow truncate">{{ owner.ownerName }}</span>
              <span class="owner-count mono">{{ owner.accounts }}</span>
              <span class="owner-bar">
                <i :style="{ width: `${(owner.accounts / (data.ownerBreakdown[0]?.accounts || 1)) * 100}%` }" />
              </span>
            </li>
          </ul>
        </div>

        <div v-else class="panel-body">
          <AppEmpty
            v-if="!data?.recentAccounts?.length"
            icon="cloud"
            title="还没有提交账号"
            description="提交 AWS 账号后即可生成配置并执行演练"
          >
            <button class="btn btn-sm btn-primary" type="button" @click="router.push('/accounts/new')">
              提交账号
            </button>
          </AppEmpty>
          <ul v-else class="account-mini">
            <li v-for="account in data.recentAccounts" :key="account.id" @click="router.push(`/accounts/${account.id}`)">
              <div class="grow truncate">
                <p class="truncate">{{ account.name }}</p>
                <p class="mono small text-muted">{{ account.accountId }}</p>
              </div>
              <span class="badge" :class="`badge-${envMeta(account.environment).tone}`">
                {{ envMeta(account.environment).label }}
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <!-- 安全边界说明 -->
    <section class="panel panel-pad safety">
      <div class="safety-head">
        <AppIcon name="shield-check" :size="17" style="color: var(--success)" />
        <h3>安全边界</h3>
        <span class="badge badge-green badge-lg">已启用</span>
      </div>
      <div class="safety-grid">
        <div>
          <strong>演练优先</strong>
          <p>默认执行 dry-run，只列举资源不执行删除；真实删除需精确输入账号 ID。</p>
        </div>
        <div>
          <strong>平台黑名单</strong>
          <p>当前黑名单 {{ data?.health?.blocklistSize ?? 0 }} 个账号，命中后任何角色都无法执行。</p>
        </div>
        <div>
          <strong>数据隔离</strong>
          <p>普通用户仅能访问自己提交的账号与任务，越权请求在服务端直接拒绝。</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 5px;
  background: rgba(251, 191, 36, 0.14);
  color: #fcd34d;
  font-size: 11.5px;
}

/* 统计卡 */
.stat {
  position: relative;
  overflow: hidden;
}
.stat::after {
  content: "";
  position: absolute;
  right: -30px;
  bottom: -40px;
  width: 110px;
  height: 110px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(34, 211, 238, 0.12), transparent 70%);
}
.tone-violet::after {
  background: radial-gradient(circle, rgba(168, 85, 247, 0.14), transparent 70%);
}
.tone-green::after {
  background: radial-gradient(circle, rgba(52, 211, 153, 0.12), transparent 70%);
}
.tone-red::after {
  background: radial-gradient(circle, rgba(244, 63, 94, 0.13), transparent 70%);
}
.stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}
.stat-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--accent);
  background: rgba(34, 211, 238, 0.08);
}
.tone-violet .stat-icon {
  color: #d8b4fe;
  background: rgba(168, 85, 247, 0.1);
}
.tone-green .stat-icon {
  color: #7ff0c4;
  background: rgba(52, 211, 153, 0.1);
}
.tone-red .stat-icon {
  color: #ffa2b3;
  background: rgba(244, 63, 94, 0.12);
  border-color: rgba(244, 63, 94, 0.3);
}
.tone-muted .stat-icon {
  color: var(--text-muted);
  background: rgba(120, 170, 210, 0.08);
}
.stat-value {
  margin-top: 14px;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-family: var(--font-mono);
}
.stat-foot {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-faint);
}

.split {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 16px;
  /* 两栏等高：面板底部对齐，避免左右一高一低 */
  align-items: stretch;
}

/* 面板内部改成纵向弹性布局，让列表区吃掉剩余高度 */
.split > .panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.split > .panel > .job-list,
.split > .panel > .panel-body {
  flex: 1 1 auto;
  min-height: 0;
  /* 条目多时内部滚动，不把整行撑高 */
  max-height: 372px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.split > .panel > .job-list::-webkit-scrollbar,
.split > .panel > .panel-body::-webkit-scrollbar {
  width: 6px;
}
.split > .panel > .job-list::-webkit-scrollbar-thumb,
.split > .panel > .panel-body::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.26);
}

/* 任务列表 */
.job-list {
  /* 上边距 7px + 行内 11px = 18px，与右侧 .panel-body 的 18px 对齐，
     否则第一行会比「账号归属分布」低/高一截，整块面板也跟着差 8px */
  padding: 7px 10px;
}
.job-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background 0.18s var(--ease);
}
.job-row:hover {
  background: rgba(34, 211, 238, 0.06);
}
.job-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 9px;
  border: 1px solid rgba(34, 211, 238, 0.22);
  background: rgba(34, 211, 238, 0.08);
  color: var(--accent);
}
.job-icon.danger {
  border-color: rgba(244, 63, 94, 0.3);
  background: rgba(244, 63, 94, 0.1);
  color: #ff8fa3;
}
.job-title {
  font-size: 13px;
}
.job-sub {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.job-sub i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse-dot 1.6s infinite;
}

/* 用户分布 */
.owners {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.owners li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.owner-avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 8px;
  background: rgba(168, 85, 247, 0.14);
  color: #d8b4fe;
  font-size: 11.5px;
}
.owner-count {
  color: var(--text-dim);
}
.owner-bar {
  width: 74px;
  height: 4px;
  border-radius: 999px;
  background: rgba(120, 170, 210, 0.12);
  overflow: hidden;
}
.owner-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--violet));
}

.account-mini {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.account-mini li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.18s var(--ease);
}
.account-mini li:hover {
  background: rgba(34, 211, 238, 0.06);
}
.account-mini p {
  font-size: 12.5px;
}

/* 安全边界 */
.safety-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 14px;
}
.safety-head h3 {
  font-size: 14px;
}
.safety-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 18px;
}
.safety-grid strong {
  display: block;
  font-size: 12.5px;
  margin-bottom: 5px;
}
.safety-grid p {
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-muted);
}

@media (max-width: 1080px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
