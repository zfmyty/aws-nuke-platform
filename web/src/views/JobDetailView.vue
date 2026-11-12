<script setup>
/** 任务详情：SSE 实时日志、执行摘要、终止操作 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { jobsApi } from '@/api/index.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import { copyText, formatDuration, formatTime, jobKindMeta, statusMeta } from '@/utils/format.js'

const route = useRoute()
const router = useRouter()
const toast = useToastStore()

const job = ref(null)
const summary = ref(null)
const lines = ref([])
const loading = ref(true)
const streaming = ref(false)
const autoScroll = ref(true)
const consoleRef = ref(null)
const aliasInput = ref('')
const confirming = ref(false)
const now = ref(Date.now())
let source = null
let pollTimer = null
let tickTimer = null

const active = computed(() => job.value && ['running', 'queued', 'waiting-input'].includes(job.value.status))
const waiting = computed(() => job.value?.status === 'waiting-input')
const confirmGate = computed(() => job.value?.meta?.confirmMode === 'confirm')

/** 扫描到的资源按类型分组统计 */
const scanGroups = computed(() => {
  const items = job.value?.scanResources || []
  const map = new Map()
  for (const item of items) {
    if (!map.has(item.type)) map.set(item.type, [])
    map.get(item.type).push(item)
  }
  return [...map.entries()]
    .map(([type, list]) => ({ type, count: list.length, items: list }))
    .sort((a, b) => b.count - a.count)
})
const scanTotal = computed(() => job.value?.scanResources?.length || 0)
/** 分组展开状态独立存储，避免轮询刷新 job 后丢失 */
const openGroups = ref({})
function toggleGroup(type) {
  openGroups.value = { ...openGroups.value, [type]: !openGroups.value[type] }
}

/** 确认闸倒计时（服务端 gateOpenedAt + gateTimeoutMs 为准） */
const countdown = computed(() => {
  if (!waiting.value || !job.value?.gateOpenedAt) return ''
  const deadline = new Date(job.value.gateOpenedAt).getTime() + (job.value.gateTimeoutMs || 300000)
  const left = Math.max(0, deadline - now.value)
  const minutes = Math.floor(left / 60000)
  const seconds = Math.floor((left % 60000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
})
const streamLabel = computed(() => {
  if (!active.value) return '任务已结束 · 历史日志'
  return streaming.value ? '实时推送中' : '正在重连...'
})
const liveMode = computed(() => job.value?.meta?.mode === 'live')

/** 把 aws-nuke / AWS SDK 的英文报错翻译成可执行的处置建议 */
const errorHint = computed(() => {
  if (!job.value || job.value.status !== 'failed') return ''
  const text = `${lines.value.slice(-60).join('\n')} ${job.value.error || ''}`.toLowerCase()
  if (text.includes('nocredentialproviders') || text.includes('no valid providers')) {
    return '未找到可用凭证：请在「部署向导」中配置主账号 AK/SK，或为该账号指定已存在的 CLI profile。'
  }
  if (text.includes('is not configured in the config file')) {
    return '账号 ID 与配置文件不一致：请核对账号 ID 是否填写正确。'
  }
  if (text.includes('accessdenied') || text.includes('not authorized')) {
    return 'AWS 返回权限不足：请确认该 IAM 用户拥有资源查询与删除权限。'
  }
  if (text.includes('could not find profile') || text.includes('profilename')) {
    return 'CLI profile 不存在：可执行 aws configure --profile <名称> 创建后重试。'
  }
  if (text.includes('expired') || text.includes('invalidclienttokenid')) {
    return '凭证无效或已过期：请在「部署向导」重新保存 AK/SK。'
  }
  return ''
})

async function load() {
  try {
    const data = await jobsApi.get(route.params.id)
    job.value = data.job
    summary.value = data.summary
  } catch (error) {
    toast.error(error.message)
    router.push('/jobs')
  } finally {
    loading.value = false
  }
}

function lineClass(line) {
  const text = line.toLowerCase()
  if (text.includes('[system]')) return 'sys'
  if (text.includes('error') || text.includes('fatal') || text.includes('failed')) return 'err'
  if (text.includes('warn')) return 'warn'
  return ''
}

function pushLine(line) {
  lines.value.push(line)
  if (lines.value.length > 3000) lines.value.shift()
  if (autoScroll.value) scrollToBottom()
}

async function scrollToBottom() {
  await nextTick()
  const el = consoleRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function connect() {
  if (source) source.close()
  streaming.value = true
  source = new EventSource(jobsApi.stream(route.params.id))

  source.addEventListener('snapshot', (event) => {
    const payload = JSON.parse(event.data)
    lines.value = payload.lines || []
    if (payload.job) job.value = payload.job
    scrollToBottom()
  })
  source.addEventListener('line', (event) => {
    const payload = JSON.parse(event.data)
    pushLine(payload.line)
  })
  source.addEventListener('gate', (event) => {
    const payload = JSON.parse(event.data)
    if (payload.job) job.value = payload.job
  })
  source.addEventListener('gate-opened', (event) => {
    const payload = JSON.parse(event.data)
    if (payload.job) job.value = payload.job
    toast.info('已确认，删除阶段开始')
  })
  source.addEventListener('status', (event) => {
    const payload = JSON.parse(event.data)
    if (payload.job) job.value = payload.job
  })
  source.addEventListener('closed', (event) => {
    const payload = JSON.parse(event.data)
    if (payload.job) job.value = payload.job
    streaming.value = false
    source.close()
    source = null
    load()
  })
  source.onerror = () => {
    streaming.value = false
  }
}

/** 等待确认期间：秒级倒计时 + 4 秒轮询兜底（SSE 断连也能恢复状态） */
watch(waiting, (value) => {
  if (value) {
    now.value = Date.now()
    tickTimer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    pollTimer = setInterval(async () => {
      try {
        const data = await jobsApi.get(route.params.id)
        job.value = data.job
        summary.value = data.summary
      } catch {
        /* 轮询失败由 SSE 与下一次轮询兜底 */
      }
    }, 4000)
  } else {
    if (tickTimer) clearInterval(tickTimer)
    if (pollTimer) clearInterval(pollTimer)
    tickTimer = null
    pollTimer = null
  }
})

async function confirmDeletion() {
  const value = aliasInput.value.trim()
  if (!value) {
    toast.error('请输入账号别名以确认删除')
    return
  }
  confirming.value = true
  try {
    const data = await jobsApi.confirmPrompt(route.params.id, value)
    job.value = data.job
    aliasInput.value = ''
    toast.success('已确认，删除阶段开始')
  } catch (error) {
    toast.error(error.message)
  } finally {
    confirming.value = false
  }
}

async function cancelJob() {
  try {
    await jobsApi.cancel(route.params.id)
    toast.info('已请求终止任务')
    await load()
  } catch (error) {
    toast.error(error.message)
  }
}

async function copyLog() {
  const ok = await copyText(lines.value.join('\n'))
  toast[ok ? 'success' : 'error'](ok ? '日志已复制' : '复制失败')
}

function onScroll() {
  const el = consoleRef.value
  if (!el) return
  autoScroll.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
}

onMounted(async () => {
  await load()
  connect()
})

onBeforeUnmount(() => {
  if (source) source.close()
  if (tickTimer) clearInterval(tickTimer)
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div v-if="loading" class="stack">
    <div class="skeleton" style="width: 35%; height: 24px" />
    <div class="skeleton" style="height: 300px" />
  </div>

  <div v-else-if="job" class="stack fade-up">
    <div class="page-head">
      <div>
        <button class="back" type="button" @click="router.push('/jobs')">
          <AppIcon name="arrow-left" :size="14" />任务中心
        </button>
        <div class="title-row">
          <h1>{{ job.title }}</h1>
          <span class="badge badge-lg" :class="`badge-${statusMeta(job.status).tone}`">
            <i v-if="active" class="dot-pulse" />
            {{ statusMeta(job.status).label }}
          </span>
          <span v-if="job.meta?.mode" class="badge badge-lg" :class="liveMode ? 'badge-red' : 'badge-cyan'">
            {{ liveMode ? '真实删除' : '演练' }}
          </span>
        </div>
        <p class="sub mono">
          {{ jobKindMeta(job.kind).label }} · {{ job.meta?.accountName || '平台任务' }}
          <template v-if="job.meta?.accountId"> · {{ job.meta.accountId }}</template>
        </p>
      </div>
      <div class="row">
        <button class="btn btn-sm" type="button" @click="copyLog"><AppIcon name="copy" :size="13" />复制日志</button>
        <button v-if="active" class="btn btn-sm btn-danger" type="button" @click="cancelJob">
          <AppIcon name="pause" :size="13" />终止任务
        </button>
      </div>
    </div>

    <!-- 摘要 -->
    <div class="meta-grid">
      <div class="panel panel-pad meta-card">
        <span>触发人</span>
        <strong>{{ job.createdBy }}</strong>
      </div>
      <div class="panel panel-pad meta-card">
        <span>开始时间</span>
        <strong class="mono">{{ formatTime(job.startedAt) }}</strong>
      </div>
      <div class="panel panel-pad meta-card">
        <span>耗时</span>
        <strong class="mono">{{ formatDuration(job.startedAt, job.finishedAt) }}</strong>
      </div>
      <div class="panel panel-pad meta-card">
        <span>退出码</span>
        <strong class="mono" :class="{ err: job.exitCode && job.exitCode !== 0 }">
          {{ job.exitCode ?? '—' }}
        </strong>
      </div>
    </div>

    <div v-if="summary" class="summary-bar">
      <div class="sum-item">
        <span>扫描资源</span>
        <strong>{{ summary.total ?? '—' }}</strong>
      </div>
      <div class="sum-item cyan">
        <span>可删除</span>
        <strong>{{ summary.nukeable ?? '—' }}</strong>
      </div>
      <div class="sum-item muted">
        <span>被过滤</span>
        <strong>{{ summary.filtered ?? '—' }}</strong>
      </div>
      <div v-if="summary.finished !== null" class="sum-item green">
        <span>已完成</span>
        <strong>{{ summary.finished ?? '—' }}</strong>
      </div>
      <div v-if="summary.failed !== null" class="sum-item red">
        <span>失败</span>
        <strong>{{ summary.failed ?? '—' }}</strong>
      </div>
    </div>

    <!-- 扫描后确认：资源清单 + 别名输入 + 倒计时 -->
    <section v-if="waiting" class="panel gate-panel">
      <div class="panel-head">
        <div class="panel-title">
          <AppIcon name="shield-check" :size="15" style="color: #fac775" />
          <h3>扫描完成 · 等待确认</h3>
          <span class="beta-tag">测试</span>
          <span class="badge badge-amber gate-countdown">{{ countdown }}</span>
        </div>
        <span class="small text-muted">超时后任务将自动终止，不会执行任何删除</span>
      </div>
      <div class="panel-body stack">
        <div class="notice notice-danger gate-notice">
          <AppIcon name="alert" :size="17" />
          <div>
            <strong>{{ scanTotal }} 个资源待删除</strong>
            <template v-if="job.scanTruncated">（清单过大仅展示前 2000 项）</template>
            ：确认后将开始真实删除，操作不可撤销。
          </div>
        </div>

        <div v-if="scanGroups.length" class="scan-groups">
          <div v-for="group in scanGroups" :key="group.type" class="scan-group">
            <button class="scan-group-head" type="button" @click="toggleGroup(group.type)">
              <span class="mono scan-type">{{ group.type }}</span>
              <span class="badge">{{ group.count }}</span>
              <AppIcon :name="openGroups[group.type] ? 'down' : 'right'" :size="13" class="scan-caret" />
            </button>
            <div v-if="openGroups[group.type]" class="scan-items">
              <div v-for="(item, index) in group.items" :key="index" class="scan-item">
                <span class="mono small text-muted">{{ item.region }}</span>
                <span class="mono small scan-id">{{ item.id }}</span>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="small text-muted">
          未解析到资源明细，请查看下方执行日志中 aws-nuke 输出的完整清单。
        </p>

        <div class="gate-actions">
          <input
            v-model="aliasInput"
            class="input mono gate-input"
            placeholder="输入该账号的 AWS 别名以确认删除"
            autocomplete="off"
            spellcheck="false"
            :disabled="confirming"
            @keyup.enter="confirmDeletion"
          />
          <button class="btn btn-danger" type="button" :disabled="confirming || !aliasInput.trim()" @click="confirmDeletion">
            <span v-if="confirming" class="spin" />
            <AppIcon v-else name="zap" :size="14" />
            确认开始删除
          </button>
          <button class="btn" type="button" :disabled="confirming" @click="cancelJob">中止任务</button>
        </div>
        <p v-if="confirmGate" class="hint-line">
          <AppIcon name="info" :size="13" />
          需要输入 aws-nuke 提示的账号别名；输入不符将被拒绝。关闭页面不影响的任务状态，倒计时结束前回来确认即可。
        </p>
      </div>
    </section>

    <div v-if="job.error" class="notice notice-danger">
      <AppIcon name="alert" :size="17" /><span>{{ job.error }}</span>
    </div>

    <div v-if="errorHint" class="notice notice-warn">
      <AppIcon name="info" :size="17" /><span>{{ errorHint }}</span>
    </div>

    <!-- 日志 -->
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">
          <span class="console-dot" :class="{ live: streaming && active }" />
          <h3>执行日志</h3>
          <span class="small text-muted">{{ streamLabel }}</span>
        </div>
        <div class="row">
          <label class="auto-scroll">
            <input v-model="autoScroll" type="checkbox" />
            <span>自动滚动</span>
          </label>
          <button class="btn btn-ghost btn-sm" type="button" @click="scrollToBottom">
            <AppIcon name="down" :size="13" />底部
          </button>
        </div>
      </div>
      <div ref="consoleRef" class="console" @scroll="onScroll">
        <div v-if="!lines.length" class="text-faint small">等待输出...</div>
        <div v-for="(line, index) in lines" :key="index" class="console-line" :class="lineClass(line)">
          {{ line }}
        </div>
      </div>
    </section>

    <p class="hint-line">
      <AppIcon name="info" :size="13" />
      日志摘要由 aws-nuke 输出解析，完整日志保存在服务端 <code>data/logs/{{ job.id }}.log</code>
    </p>
  </div>
</template>

<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 0;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 10px;
}
.back:hover {
  color: var(--accent);
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse-dot 1.6s infinite;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.meta-card {
  padding: 13px 16px;
}
.meta-card span {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}
.meta-card strong {
  display: block;
  margin-top: 5px;
  font-size: 13.5px;
}
.meta-card strong.err {
  color: #ffa8b6;
}

.summary-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 26px;
  padding: 14px 20px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.04);
}
.sum-item span {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
}
.sum-item strong {
  display: block;
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 18px;
}
.sum-item.cyan strong {
  color: var(--accent);
}
.sum-item.green strong {
  color: var(--success);
}
.sum-item.red strong {
  color: var(--danger);
}
.sum-item.muted strong {
  color: var(--text-muted);
}

.console-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.console-dot.live {
  background: var(--success);
  animation: pulse-dot 1.8s infinite;
}
.auto-scroll {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
}
.auto-scroll input {
  accent-color: var(--accent);
}
.hint-line {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-faint);
}

/* 扫描后确认面板 */
.gate-panel {
  border-color: rgba(250, 199, 117, 0.35);
}
.gate-countdown {
  font-family: var(--font-mono);
  font-size: 12px;
}
.beta-tag {
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(250, 199, 117, 0.4);
  background: rgba(250, 199, 117, 0.12);
  color: #fac775;
  font-size: 10px;
}
.gate-notice strong {
  color: #ffb3c1;
}
.scan-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow: auto;
  padding-right: 4px;
}
.scan-group-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.6);
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.scan-group-head:hover {
  border-color: var(--border-strong);
}
.scan-type {
  font-size: 12px;
  color: var(--accent);
}
.scan-caret {
  margin-left: auto;
  color: var(--text-faint);
}
.scan-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 0 14px;
  padding-left: 12px;
  border-left: 1px solid var(--border);
}
.scan-item {
  display: flex;
  gap: 14px;
  align-items: baseline;
  font-size: 11.5px;
}
.scan-id {
  color: var(--text-dim);
  word-break: break-all;
}
.gate-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.gate-input {
  flex: 1 1 260px;
}
.hint-line code {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.1);
  color: var(--text-muted);
}
</style>
