<script setup>
/** 任务中心：跨账号的执行记录，实时状态刷新 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { jobsApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useSystemStore } from '@/stores/system.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppModal from '@/components/AppModal.vue'
import { formatDuration, formatTime, jobKindMeta, statusMeta, timeAgo } from '@/utils/format.js'

const router = useRouter()
const auth = useAuthStore()
const system = useSystemStore()
const toast = useToastStore()

const items = ref([])
const loading = ref(true)
const statusFilter = ref('')
const timer = ref(null)

const tabs = [
  { value: '', label: '全部' },
  { value: 'running', label: '执行中' },
  { value: 'waiting-input', label: '待确认' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
]

const counts = computed(() => {
  const base = { all: items.value.length, running: 0, 'waiting-input': 0, succeeded: 0, failed: 0 }
  for (const job of items.value) {
    if (base[job.status] !== undefined) base[job.status] += 1
  }
  return base
})

const visible = computed(() =>
  statusFilter.value ? items.value.filter((job) => job.status === statusFilter.value) : items.value,
)

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const data = await jobsApi.list({ limit: 100 })
    // 轮询时内容无变化就不替换数组，避免整表重渲染干扰连续点击
    if (silent && items.value.length) {
      const prev = items.value
      const same =
        prev.length === data.items.length &&
        prev.every((item, index) => {
          const next = data.items[index]
          return next && item.id === next.id && item.status === next.status
        })
      if (same) return
    }
    items.value = data.items
  } catch (error) {
    if (!silent) toast.error(error.message)
  } finally {
    loading.value = false
  }
}

async function cancel(job) {
  try {
    await jobsApi.cancel(job.id)
    toast.info('已请求终止任务')
    load(true)
  } catch (error) {
    toast.error(error.message)
  }
}

/* ---- 记录删除 ---- */
const checkedIds = ref([])
const allChecked = computed(
  () => visible.value.length > 0 && checkedIds.value.length === visible.value.length,
)
function toggleCheck(job) {
  const index = checkedIds.value.indexOf(job.id)
  if (index >= 0) checkedIds.value.splice(index, 1)
  else checkedIds.value.push(job.id)
}
function toggleCheckAll() {
  checkedIds.value = allChecked.value ? [] : visible.value.map((item) => item.id)
}
/** 点在勾选框上时由 input 的 change 事件处理，点在格子空白处才由单元格 click 处理，避免双触发 */
function onCheckCell(event, job, all = false) {
  if (event.target?.tagName === 'INPUT') return
  if (all) toggleCheckAll()
  else toggleCheck(job)
}
// 列表轮询刷新后，清除已不存在的勾选
watch(items, (list) => {
  const ids = new Set(list.map((item) => item.id))
  if (checkedIds.value.some((id) => !ids.has(id))) {
    checkedIds.value = checkedIds.value.filter((id) => ids.has(id))
  }
})

const deleteOpen = ref(false)
const deleteTarget = ref(null) // null = 批量，数组 = 待删 ids
const deleting = ref(false)

const deleteCount = computed(() => (deleteTarget.value ? deleteTarget.value.length : 0))

function askDelete(job) {
  deleteTarget.value = [job.id]
  deleteOpen.value = true
}
function askBatchDelete() {
  deleteTarget.value = [...checkedIds.value]
  deleteOpen.value = true
}

async function confirmDelete() {
  deleting.value = true
  try {
    let okCount = 0
    let failCount = 0
    let failMsg = ''
    if (deleteCount.value === 1) {
      try {
        await jobsApi.remove(deleteTarget.value[0])
        okCount = 1
      } catch (error) {
        failCount = 1
        failMsg = error.message
      }
    } else {
      const result = await jobsApi.batchDelete(deleteTarget.value)
      okCount = result.deleted.length
      failCount = result.failed.length
      if (result.failed.length) failMsg = result.failed.map((item) => item.reason).join('；')
    }
    if (failCount) toast.error(`删除完成：成功 ${okCount} / 失败 ${failCount}（${failMsg}）`)
    else toast.success(`已删除 ${okCount} 条任务记录`)
    checkedIds.value = []
    deleteOpen.value = false
    await load()
  } catch (error) {
    toast.error(error.message)
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  load()
  // 轻量轮询：间隔由管理员统一控制（平台设置），页面不可见时跳过请求
  system.loadPolicy().then(startPolling)
})

const pollIntervalMs = computed(() => system.pollIntervalMs)
watch(pollIntervalMs, () => {
  // 管理员修改设置后，已打开的任务中心页立即生效
  startPolling()
})

function startPolling() {
  clearInterval(timer.value)
  timer.value = setInterval(() => {
    if (!document.hidden) load(true)
  }, pollIntervalMs.value)
}
onBeforeUnmount(() => clearInterval(timer.value))
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>任务中心</h1>
        <p class="sub">{{ auth.isAdmin ? '全平台 aws-nuke 与部署任务' : '你触发的任务与实时日志' }}</p>
      </div>
      <div class="row">
        <button class="btn btn-sm" type="button" @click="load()"><AppIcon name="refresh" :size="14" />刷新</button>
      </div>
    </div>

    <div class="filters">
      <div class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          type="button"
          :class="{ active: statusFilter === tab.value }"
          @click="statusFilter = tab.value"
        >
          {{ tab.label }}
          <span v-if="tab.value === 'running' && counts.running" class="count">{{ counts.running }}</span>
        </button>
      </div>
      <span class="small text-muted">共 {{ counts.all }} 条记录</span>
    </div>

    <!-- 已选提示：固定在顶栏下方悬浮，不占用页面布局，勾选时内容不位移 -->
    <div v-if="checkedIds.length" class="select-notice">
      <div class="select-notice-inner">
        <AppIcon name="check" :size="15" />
        <span>已选择 <strong>{{ checkedIds.length }}</strong> 条记录，删除按钮在表头行右侧</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="checkedIds = []">清空选择</button>
      </div>
    </div>

    <section class="panel">
      <div v-if="loading" class="panel-body stack">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 30px" />
      </div>

      <AppEmpty
        v-else-if="!visible.length"
        icon="terminal"
        title="暂无任务"
        description="在账号详情页发起演练或删除，任务会实时出现在这里"
      >
        <button class="btn btn-sm" type="button" @click="router.push('/accounts')">前往账号管理</button>
      </AppEmpty>

      <div v-else class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th class="col-check" title="全选/全不选" @click="onCheckCell($event, null, true)">
                <input type="checkbox" :checked="allChecked" @change="toggleCheckAll" />
              </th>
              <th>任务</th>
              <th>类型</th>
              <th>模式</th>
              <th v-if="auth.isAdmin">触发人</th>
              <th>状态</th>
              <th>耗时</th>
              <th>开始时间</th>
              <th style="text-align: right">
                <div class="head-col">
                  <span>操作</span>
                  <div v-if="checkedIds.length" class="head-actions">
                    <button class="btn btn-sm btn-danger" type="button" @click="askBatchDelete">
                      <AppIcon name="trash" :size="13" />删除选中
                    </button>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in visible" :key="job.id" class="clickable" @click="router.push(`/jobs/${job.id}`)">
              <td class="col-check" title="选中/取消选中" @click.stop="onCheckCell($event, job)">
                <input
                  type="checkbox"
                  :checked="checkedIds.includes(job.id)"
                  @change="toggleCheck(job)"
                />
              </td>
              <td>
                <div class="job-title">{{ job.title }}</div>
                <div class="small text-faint mono">{{ job.meta?.accountId || '平台级任务' }}</div>
              </td>
              <td>
                <span class="kind">
                  <AppIcon :name="jobKindMeta(job.kind).icon" :size="13" />
                  {{ jobKindMeta(job.kind).label }}
                </span>
              </td>
              <td>
                <span
                  v-if="job.meta?.mode"
                  class="badge"
                  :class="job.meta.mode === 'live' ? 'badge-red' : 'badge-cyan'"
                >
                  {{ job.meta.mode === 'live' ? '真实删除' : '演练' }}
                </span>
                <span v-else class="text-faint">—</span>
              </td>
              <td v-if="auth.isAdmin" class="text-dim">{{ job.createdBy }}</td>
              <td>
                <span class="badge" :class="`badge-${statusMeta(job.status).tone}`">
                  <i v-if="job.status === 'running' || job.status === 'waiting-input'" class="dot-pulse" />
                  {{ statusMeta(job.status).label }}
                </span>
              </td>
              <td class="mono small">{{ formatDuration(job.startedAt, job.finishedAt) }}</td>
              <td class="small text-muted" :title="formatTime(job.startedAt)">{{ timeAgo(job.createdAt) }}</td>
              <td>
                <div class="cell-actions" @click.stop>
                  <button
                    v-if="job.status === 'running' || job.status === 'waiting-input'"
                    class="icon-btn danger"
                    type="button"
                    title="终止"
                    @click="cancel(job)"
                  >
                    <AppIcon name="pause" :size="14" />
                  </button>
                  <button
                    v-if="job.status !== 'running' && job.status !== 'waiting-input'"
                    class="icon-btn danger"
                    type="button"
                    title="删除记录"
                    @click="askDelete(job)"
                  >
                    <AppIcon name="trash" :size="14" />
                  </button>
                  <button class="icon-btn" type="button" title="查看" @click="router.push(`/jobs/${job.id}`)">
                    <AppIcon name="right" :size="14" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <AppModal
      v-if="deleteOpen"
      :title="deleteCount > 1 ? `删除 ${deleteCount} 条任务记录` : '删除任务记录'"
      subtitle="记录与对应日志文件一并移除，不影响账号与 AWS 资源"
      @close="deleteOpen = false"
    >
      <div class="stack">
        <div class="notice notice-warn">
          <AppIcon name="alert" :size="17" />
          <div>确认删除选中的 <strong>{{ deleteCount }}</strong> 条任务记录？此操作不可恢复。</div>
        </div>
      </div>
      <template #footer>
        <button class="btn" type="button" :disabled="deleting" @click="deleteOpen = false">取消</button>
        <button class="btn btn-danger" type="button" :disabled="deleting" @click="confirmDelete">
          <span v-if="deleting" class="spin" />
          {{ deleting ? '删除中...' : '确认删除' }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.count {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(34, 211, 238, 0.22);
  font-size: 10.5px;
  color: #9beeff;
}
.clickable {
  cursor: pointer;
}
.job-title {
  font-size: 13px;
}
.kind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-dim);
}
.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse-dot 1.6s infinite;
}
.icon-btn.danger:hover {
  background: rgba(244, 63, 94, 0.12);
  color: #ff8fa3;
}

/* 记录删除：整格作为勾选热区 */
.col-check {
  width: 44px;
  min-width: 44px;
  text-align: center;
  cursor: pointer;
}
.col-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
  vertical-align: middle;
}

/* 已选提示条：固定在顶栏正下方悬浮，不参与文档流，勾选时内容零位移；绿色系 */
.select-notice {
  position: fixed;
  top: var(--header-h);
  left: 0;
  right: 0;
  z-index: 25;
  pointer-events: none;
}
.select-notice-inner {
  pointer-events: auto;
  margin: 0 auto;
  width: min(1440px, calc(100% - 52px));
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid rgba(52, 211, 153, 0.35);
  background: rgba(9, 22, 18, 0.92);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(2, 8, 20, 0.45);
  font-size: 12.5px;
  color: #8bf3c9;
  animation: fade-up 0.25s var(--ease) both;
}
.select-notice-inner svg {
  color: var(--success);
}
.select-notice-inner strong {
  font-family: var(--font-mono);
  color: #34d399;
}
.select-notice-inner .btn {
  margin-left: auto;
}

/* 表头操作列里的删除按钮：绝对定位悬浮，不参与表格列宽计算 */
.head-col {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  white-space: nowrap;
}
.head-actions {
  position: absolute;
  right: 44px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
</style>
