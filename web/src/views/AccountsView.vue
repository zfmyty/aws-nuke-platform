<script setup>
/** 账号管理：按角色展示可见范围，支持搜索、筛选与执行入口 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { accountsApi, systemApi, usersApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppModal from '@/components/AppModal.vue'
import RunDialog from '@/components/RunDialog.vue'
import { AUTH_MODE_LABEL, ENV_META, envMeta, formatTime, statusMeta, timeAgo } from '@/utils/format.js'

const auth = useAuthStore()
const toast = useToastStore()
const router = useRouter()

const items = ref([])
const loading = ref(true)
const filters = ref({ search: '', environment: '', ownerId: '' })
const owners = ref([])
const policy = ref({ allowUserDestructive: true })

const runTarget = ref(null)
const deleteTarget = ref(null)
const deleting = ref(false)

/* ---- 组织账号扫描 ---- */
const scanOpen = ref(false)
const scanning = ref(false)
const scanError = ref('')
const scanData = ref(null)
const selectedIds = ref([])
const importing = ref(false)
const importLog = ref([])
const withAlias = ref(true)
const aliasDrafts = ref({})
const importOptions = ref({ environment: 'test', ownerId: '', defaultRegion: '', roleName: '', description: '' })

const selectableAccounts = computed(() =>
  (scanData.value?.accounts || []).filter((item) => item.selectable && !item.imported),
)
const allSelected = computed(
  () => selectableAccounts.value.length > 0 && selectedIds.value.length === selectableAccounts.value.length,
)

async function openScan() {
  scanOpen.value = true
  scanError.value = ''
  scanData.value = null
  importLog.value = []
  selectedIds.value = []
  await runScan()
}

async function runScan() {
  scanning.value = true
  scanError.value = ''
  try {
    const data = await accountsApi.scanOrganization()
    scanData.value = data
    selectedIds.value = data.accounts.filter((item) => item.selectable && !item.imported).map((item) => item.accountId)
    aliasDrafts.value = Object.fromEntries(data.accounts.map((item) => [item.accountId, item.suggestedAlias]))
    // 区域不预填任何默认值，由用户自己决定；角色名仍取平台配置的组织默认角色
    if (!importOptions.value.roleName) importOptions.value.roleName = data.defaultRole || ''
  } catch (error) {
    scanError.value = error.message
  } finally {
    scanning.value = false
  }
}

function toggleOne(accountId) {
  const index = selectedIds.value.indexOf(accountId)
  if (index >= 0) selectedIds.value.splice(index, 1)
  else selectedIds.value.push(accountId)
}

function toggleAll() {
  selectedIds.value = allSelected.value ? [] : selectableAccounts.value.map((item) => item.accountId)
}

async function doImport() {
  if (!selectedIds.value.length) {
    toast.error('请先勾选要接入的账号')
    return
  }
  if (withAlias.value) {
    const bad = selectedIds.value.find((id) => {
      const value = String(aliasDrafts.value[id] || '').trim()
      return value && !/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(value)
    })
    if (bad) {
      toast.error(`账号 ${bad} 的别名不合法：只能用小写字母、数字和连字符，3-63 位`)
      return
    }
  }

  importing.value = true
  importLog.value = []
  try {
    const accounts = selectedIds.value.map((accountId) => {
      const row = (scanData.value?.accounts || []).find((item) => item.accountId === accountId)
      return {
        accountId,
        name: row?.name || `account-${accountId}`,
        alias: withAlias.value ? String(aliasDrafts.value[accountId] || '').trim() : '',
      }
    })

    const result = await accountsApi.importAccounts({ accounts, options: importOptions.value })
    for (const item of result.created) importLog.value.push(`已接入 ${item.accountId} · ${item.name}`)
    for (const item of result.skipped) importLog.value.push(`跳过 ${item.accountId}：${item.reason}`)

    if (withAlias.value) {
      for (const item of result.created) {
        const alias = String(aliasDrafts.value[item.accountId] || '').trim()
        if (!alias) {
          importLog.value.push(`跳过别名 ${item.accountId}：未填写`)
          continue
        }
        try {
          await accountsApi.createAlias(item.id, alias)
          importLog.value.push(`别名 ${alias} 创建成功`)
        } catch (error) {
          importLog.value.push(`别名失败 ${item.accountId}：${error.message}`)
        }
      }
    }

    toast.success(`接入完成：新增 ${result.created.length} 个账号`)
    await load()
    await runScan()
  } catch (error) {
    toast.error(error.message)
  } finally {
    importing.value = false
  }
}

const emptyHint = computed(() =>
  auth.isAdmin ? '还没有用户提交 AWS 账号' : '提交你的第一个 AWS 账号，平台会自动生成 aws-nuke 配置',
)

const stats = computed(() => {
  const total = items.value.length
  const prod = items.value.filter((item) => item.environment === 'prod').length
  const failed = items.value.filter((item) => item.lastRunStatus === 'failed').length
  return { total, prod, failed }
})

let searchTimer = null
watch(
  () => filters.value.search,
  () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(load, 320)
  },
)
watch(() => [filters.value.environment, filters.value.ownerId], load)

async function load() {
  loading.value = true
  try {
    const data = await accountsApi.list(filters.value)
    items.value = data.items
  } catch (error) {
    toast.error(error.message)
  } finally {
    loading.value = false
  }
}

async function loadMeta() {
  try {
    const tasks = [systemApi.policy()]
    if (auth.isAdmin) tasks.push(usersApi.list())
    const [policyData, usersData] = await Promise.all(tasks)
    policy.value = policyData
    if (usersData) owners.value = usersData.items
  } catch {
    /* 元信息失败不影响主流程 */
  }
}

function openRun(account) {
  runTarget.value = account
}

function onStarted(job) {
  runTarget.value = null
  router.push(`/jobs/${job.id}`)
}

/* ---- 批量执行 ---- */
const checkedIds = ref([])
const allChecked = computed(
  () => items.value.length > 0 && checkedIds.value.length === items.value.length,
)
function toggleCheck(account) {
  const index = checkedIds.value.indexOf(account.id)
  if (index >= 0) checkedIds.value.splice(index, 1)
  else checkedIds.value.push(account.id)
}
function toggleCheckAll() {
  checkedIds.value = allChecked.value ? [] : items.value.map((item) => item.id)
}
/** 点在勾选框上时由 input 的 change 事件处理，点在格子空白处才由单元格 click 处理，避免双触发 */
function onCheckCell(event, account, all = false) {
  if (event.target?.tagName === 'INPUT') return
  if (all) toggleCheckAll()
  else toggleCheck(account)
}

const batchOpen = ref(false)
const batchMode = ref('dry')
const batchRunning = ref(false)
const batchTargets = ref([])
const batchResults = ref([])
const batchConfirmText = ref('')

const batchDone = computed(() => batchResults.value.length)
const batchOkCount = computed(() => batchResults.value.filter((item) => item.ok).length)
/** 批量已跑完一轮（与「执行中」互斥，用于隐藏启动按钮、切换结果态） */
const batchFinished = computed(() => !batchRunning.value && batchResults.value.length > 0)
const batchAllOk = computed(() => batchFinished.value && batchOkCount.value === batchResults.value.length)
const batchFailLines = computed(() =>
  batchResults.value
    .filter((item) => !item.ok)
    .map((item) => `${item.name} (${item.accountId})：${item.error}`),
)
const batchCanStart = computed(
  () =>
    !batchRunning.value &&
    !batchFinished.value &&
    batchTargets.value.length > 0 &&
    (batchMode.value === 'dry' || batchConfirmText.value.trim() === '批量删除'),
)

function openBatch(mode) {
  batchMode.value = mode
  batchTargets.value = items.value.filter((item) => checkedIds.value.includes(item.id))
  batchResults.value = []
  batchConfirmText.value = ''
  batchOpen.value = true
}

function closeBatch() {
  if (!batchRunning.value) batchOpen.value = false
}

/** 逐个账号调用执行接口；单个失败不影响后续，结束后汇总展示 */
async function startBatch() {
  batchRunning.value = true
  batchResults.value = []
  for (const account of batchTargets.value) {
    try {
      const data = await accountsApi.run(account.id, {
        mode: batchMode.value,
        confirmText: account.accountId,
        confirmMode: 'direct',
      })
      batchResults.value.push({
        name: account.name,
        accountId: account.accountId,
        ok: true,
        jobId: data.job.id,
      })
    } catch (error) {
      batchResults.value.push({
        name: account.name,
        accountId: account.accountId,
        ok: false,
        error: error.message,
      })
    }
  }
  batchRunning.value = false
  checkedIds.value = []
  await load()
  toast.success(`批量执行完成：成功 ${batchOkCount.value} / 失败 ${batchResults.value.length - batchOkCount.value}`)
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await accountsApi.remove(deleteTarget.value.id)
    toast.success(`已删除账号 ${deleteTarget.value.name}`)
    deleteTarget.value = null
    await load()
  } catch (error) {
    toast.error(error.message)
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  load()
  loadMeta()
})
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>账号管理</h1>
        <p class="sub">
          {{ auth.isAdmin ? '管理全平台已接入的 AWS 账号与清理策略' : '仅展示与操作你本人提交的账号' }}
        </p>
      </div>
      <div class="row">
        <button class="btn btn-sm" type="button" @click="load"><AppIcon name="refresh" :size="14" />刷新</button>
        <button v-if="auth.isAdmin" class="btn btn-sm" type="button" @click="openScan">
          <AppIcon name="cloud" :size="14" />扫描组织账号
        </button>
        <button class="btn btn-primary btn-sm" type="button" @click="router.push('/accounts/new')">
          <AppIcon name="plus" :size="14" />提交账号
        </button>
      </div>
    </div>

    <div class="summary">
      <span><strong>{{ stats.total }}</strong> 个账号</span>
      <i />
      <span><strong>{{ stats.prod }}</strong> 个生产环境</span>
      <i />
      <span :class="{ danger: stats.failed > 0 }"><strong>{{ stats.failed }}</strong> 个最近执行失败</span>
    </div>

    <!-- 已选提示：固定在顶栏下方悬浮，不占用页面布局，勾选时内容不位移 -->
    <div v-if="checkedIds.length" class="select-notice">
      <div class="select-notice-inner">
        <AppIcon name="check" :size="15" style="color: var(--accent)" />
        <span>已选择 <strong>{{ checkedIds.length }}</strong> 个账号，操作按钮在表头行右侧</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="checkedIds = []">清空选择</button>
      </div>
    </div>

    <section class="panel">
      <div class="toolbar">
        <div class="input-icon search">
          <span class="icon-slot"><AppIcon name="search" :size="15" /></span>
          <input v-model="filters.search" class="input" placeholder="搜索账号名称 / ID / 备注" />
        </div>

        <select v-model="filters.environment" class="select env">
          <option value="">全部环境</option>
          <option value="prod">生产</option>
          <option value="staging">预发</option>
          <option value="dev">开发</option>
          <option value="sandbox">沙箱</option>
          <option value="test">测试</option>
        </select>

        <select v-if="auth.isAdmin" v-model="filters.ownerId" class="select owner">
          <option value="">全部归属用户</option>
          <option v-for="user in owners" :key="user.id" :value="user.id">
            {{ user.displayName }}（{{ user.role === 'admin' ? '管理员' : '用户' }}）
          </option>
        </select>
      </div>

      <div v-if="loading" class="panel-body stack">
        <div v-for="i in 3" :key="i" class="skeleton" style="height: 34px" />
      </div>

      <AppEmpty v-else-if="!items.length" icon="cloud" title="暂无账号" :description="emptyHint">
        <button class="btn btn-primary btn-sm" type="button" @click="router.push('/accounts/new')">
          <AppIcon name="plus" :size="14" />提交账号
        </button>
      </AppEmpty>

      <div v-else class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th class="col-check" title="全选/全不选" @click="onCheckCell($event, null, true)">
                <input type="checkbox" :checked="allChecked" @change="toggleCheckAll" />
              </th>
              <th>账号</th>
              <th>环境</th>
              <th>认证方式</th>
              <th v-if="auth.isAdmin">归属</th>
              <th>最近执行</th>
              <th style="text-align: right">
                <div class="head-col">
                  <span>操作</span>
                  <div v-if="checkedIds.length" class="head-actions">
                    <button class="btn btn-sm" type="button" @click="openBatch('dry')">
                      <AppIcon name="play" :size="13" />批量演练
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      type="button"
                      :disabled="!policy.allowUserDestructive"
                      :title="policy.allowUserDestructive ? '' : '管理员已关闭真实删除权限'"
                      @click="openBatch('live')"
                    >
                      <AppIcon name="zap" :size="13" />批量真实删除
                    </button>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in items" :key="account.id">
              <td class="col-check" title="选中/取消选中" @click="onCheckCell($event, account)">
                <input
                  type="checkbox"
                  :checked="checkedIds.includes(account.id)"
                  @change="toggleCheck(account)"
                />
              </td>
              <td>
                <button class="account-link" type="button" @click="router.push(`/accounts/${account.id}`)">
                  <span class="account-name">{{ account.name }}</span>
                  <span class="mono small text-muted">{{ account.accountId }}</span>
                </button>
              </td>
              <td>
                <span class="badge" :class="`badge-${envMeta(account.environment).tone}`">
                  {{ envMeta(account.environment).label }}
                </span>
              </td>
              <td>
                <span class="auth-cell">
                  <AppIcon
                    :name="account.authMode === 'assume-role' ? 'layers' : account.authMode === 'aksk' ? 'key' : 'file'"
                    :size="13"
                  />
                  {{ AUTH_MODE_LABEL[account.authMode] }}
                </span>
              </td>
              <td v-if="auth.isAdmin">
                <span class="owner-cell">{{ account.ownerName }}</span>
              </td>
              <td>
                <div v-if="account.lastRunAt" class="run-cell">
                  <span class="badge" :class="`badge-${statusMeta(account.lastRunStatus).tone}`">
                    {{ statusMeta(account.lastRunStatus).label }}
                  </span>
                  <span class="small text-muted" :title="formatTime(account.lastRunAt)">
                    {{ timeAgo(account.lastRunAt) }}
                  </span>
                </div>
                <span v-else class="small text-faint">尚未执行</span>
              </td>
              <td style="text-align: right">
                <div class="cell-actions">
                  <button class="cell-action" type="button" @click="router.push(`/accounts/${account.id}`)">
                    <AppIcon name="eye" :size="14" />详情
                  </button>
                  <button class="cell-action" type="button" @click="openRun(account)">
                    <AppIcon name="play" :size="14" />执行
                  </button>
                  <button class="cell-action danger" type="button" @click="deleteTarget = account">
                    <AppIcon name="trash" :size="14" />删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <RunDialog
      v-if="runTarget"
      :account="runTarget"
      :allow-live="policy.allowUserDestructive"
      @close="runTarget = null"
      @started="onStarted"
    />

    <AppModal
      v-if="scanOpen"
      title="扫描 AWS Organization"
      subtitle="用主账号凭证列出组织下的子账号，勾选后直接接入平台"
      size="lg"
      @close="scanOpen = false"
    >
      <div class="stack">
        <div v-if="scanning" class="stack">
          <div class="skeleton" style="height: 40px" />
          <div class="skeleton" style="height: 40px" />
          <div class="skeleton" style="height: 40px" />
        </div>

        <div v-else-if="scanError" class="notice notice-danger">
          <AppIcon name="alert" :size="17" />
          <div>{{ scanError }}</div>
        </div>

        <template v-else-if="scanData">
          <div class="scan-meta">
            <span class="small text-muted">
              共 {{ scanData.total }} 个账号 · 已接入 {{ scanData.imported }} · 默认角色
              <code class="mono">{{ scanData.defaultRole }}</code>
            </span>
            <button class="btn btn-sm" type="button" :disabled="scanning || importing" @click="runScan">
              <AppIcon name="refresh" :size="13" />重新扫描
            </button>
          </div>

          <div class="scan-config">
            <div class="field">
              <label>环境</label>
              <select v-model="importOptions.environment" class="select" :disabled="importing">
                <option v-for="(meta, key) in ENV_META" :key="key" :value="key">{{ meta.label }}</option>
              </select>
            </div>
            <div class="field">
              <label>归属用户</label>
              <select v-model="importOptions.ownerId" class="select" :disabled="importing">
                <option value="">我自己</option>
                <option v-for="user in owners" :key="user.id" :value="user.id">
                  {{ user.displayName || user.username }}
                </option>
              </select>
            </div>
              <div class="field">
              <label>扫描区域（可选）</label>
              <input
                v-model="importOptions.defaultRegion"
                class="input mono"
                :disabled="importing"
                placeholder="可选。留空表示导入时不指定区域，可导入后在编辑页补充"
              />
              <span class="hint">填写后将同时作为该账号的扫描区域；留空则导入后需在账号编辑页选择</span>
            </div>
            <div class="field">
              <label>组织角色名</label>
              <input
                v-model="importOptions.roleName"
                class="input mono"
                :disabled="importing"
                placeholder="请输入组织角色名称，默认 OrganizationAccountAccessRole"
              />
            </div>
            <div class="field scan-config-wide">
              <label>备注（可选）</label>
              <input v-model="importOptions.description" class="input" :disabled="importing" placeholder="可选。请输入批次或用途说明，例如：2026Q4 清理批次" />
            </div>
          </div>

          <div class="scan-list">
            <div v-if="selectableAccounts.length" class="scan-row scan-head">
              <label class="scan-main">
                <input type="checkbox" :checked="allSelected" :disabled="importing" @change="toggleAll" />
                <span class="grow">全选可接入账号（{{ selectableAccounts.length }}）</span>
              </label>
            </div>

            <div
              v-for="item in scanData.accounts"
              :key="item.accountId"
              class="scan-row"
              :class="{ muted: !item.selectable || item.imported }"
            >
              <label class="scan-main">
                <input
                  type="checkbox"
                  :disabled="!item.selectable || item.imported || importing"
                  :checked="selectedIds.includes(item.accountId)"
                  @change="toggleOne(item.accountId)"
                />
                <span class="grow truncate">
                  <span class="mono small">{{ item.accountId }}</span>
                  <span class="scan-name">{{ item.name }}</span>
                </span>
              </label>

              <input
                v-if="withAlias && selectedIds.includes(item.accountId)"
                v-model="aliasDrafts[item.accountId]"
                class="input mono scan-alias-input"
                maxlength="63"
                placeholder="别名"
                :disabled="importing"
              />

              <span v-if="item.isMaster" class="badge badge-amber">主账号</span>
              <span v-else-if="item.imported" class="badge badge-green">已接入</span>
              <span v-else-if="item.status !== 'ACTIVE'" class="badge badge-red">{{ item.status }}</span>
              <span v-else class="badge badge-cyan">可接入</span>
            </div>
          </div>

          <label class="scan-alias">
            <input v-model="withAlias" type="checkbox" :disabled="importing" />
            <span>接入后创建别名（可逐行修改，留空即跳过该账号）</span>
          </label>

          <pre v-if="importLog.length" class="scan-log mono">{{ importLog.join('\n') }}</pre>
        </template>
      </div>

      <template #footer>
        <button class="btn" type="button" :disabled="importing" @click="scanOpen = false">关闭</button>
        <button class="btn btn-primary" type="button" :disabled="importing || !selectedIds.length" @click="doImport">
          <span v-if="importing" class="spin" />
          {{ importing ? '接入中…' : `接入选中（${selectedIds.length}）` }}
        </button>
      </template>
    </AppModal>

    <AppModal
      v-if="deleteTarget"
      title="删除账号"
      subtitle="删除后配置与凭证一并移除，历史任务日志保留"
      @close="deleteTarget = null"
    >
      <div class="stack">
        <div class="notice notice-danger">
          <AppIcon name="alert" :size="17" />
          <div>
            即将移除 <strong>{{ deleteTarget.name }}</strong>（<span class="mono">{{ deleteTarget.accountId }}</span>）。
            该操作不会删除 AWS 中的任何资源，但会清除本平台保存的凭证。
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="deleteTarget = null">取消</button>
        <button class="btn btn-danger" type="button" :disabled="deleting" @click="confirmDelete">
          <span v-if="deleting" class="spin" />
          {{ deleting ? '正在删除...' : '确认删除' }}
        </button>
      </template>
    </AppModal>

    <AppModal
      v-if="batchOpen"
      :title="batchMode === 'live' ? '批量真实删除' : '批量演练'"
      :subtitle="`共 ${batchTargets.length} 个账号 · 统一使用「直接执行」方式`"
      size="lg"
      @close="closeBatch"
    >
      <div class="stack">
        <div class="notice" :class="batchMode === 'live' ? 'notice-danger' : 'notice-info'">
          <AppIcon :name="batchMode === 'live' ? 'alert' : 'info'" :size="17" />
          <div v-if="batchMode === 'live'">
            <strong>高风险批量操作</strong>：将按各账号配置逐个执行真实删除，不可撤销。
            批量模式不做扫描后确认，请确认每个账号都已完成演练、核对过过滤规则。
          </div>
          <div v-else>仅扫描并列出各账号将被删除的资源，不产生任何删除动作。</div>
        </div>

        <div class="batch-list">
          <div v-for="(account, index) in batchTargets" :key="account.id" class="batch-row">
            <span class="batch-index mono">{{ index + 1 }}</span>
            <span class="batch-name">{{ account.name }}</span>
            <span class="mono small text-muted">{{ account.accountId }}</span>
            <span class="batch-state">
              <template v-if="!batchResults[index]">
                <span v-if="batchRunning && batchDone === index" class="small" style="color: var(--accent)">执行中…</span>
                <span v-else class="small text-faint">等待</span>
              </template>
              <span v-else-if="batchResults[index].ok" class="badge badge-green">已启动</span>
              <span v-else class="badge badge-red" :title="batchResults[index].error">失败</span>
            </span>
          </div>
        </div>

        <div v-if="batchFinished" class="batch-summary" :class="batchAllOk ? 'ok' : 'fail'">
          <AppIcon :name="batchAllOk ? 'check' : 'alert'" :size="16" />
          <div class="batch-summary-body">
            <strong>
              {{ batchAllOk
                ? `全部 ${batchResults.length} 个账号任务启动成功`
                : `启动完成：成功 ${batchOkCount} / 失败 ${batchResults.length - batchOkCount}` }}
            </strong>
            <pre v-if="batchFailLines.length" class="batch-err-list mono">{{ batchFailLines.join('\n') }}</pre>
          </div>
        </div>

        <div v-if="batchMode === 'live'" class="field">
          <label>输入「批量删除」以确认 <span class="text-muted">（共 {{ batchTargets.length }} 个账号）</span></label>
          <input
            v-model="batchConfirmText"
            class="input mono"
            placeholder="批量删除"
            autocomplete="off"
            spellcheck="false"
            :disabled="batchRunning"
          />
        </div>
      </div>

      <template #footer>
        <button class="btn" type="button" :disabled="batchRunning" @click="closeBatch">
          {{ batchRunning ? '后台执行中' : '关闭' }}
        </button>
        <button
          v-if="!batchFinished"
          class="btn"
          :class="batchMode === 'live' ? 'btn-danger' : 'btn-primary'"
          type="button"
          :disabled="!batchCanStart"
          @click="startBatch"
        >
          <span v-if="batchRunning" class="spin" />
          <AppIcon v-else :name="batchMode === 'live' ? 'zap' : 'play'" :size="14" />
          {{ batchRunning
            ? `执行中 ${batchDone}/${batchTargets.length}`
            : batchMode === 'live' ? '确认批量删除' : `开始批量演练（${batchTargets.length}）` }}
        </button>
        <button v-else class="btn btn-primary" type="button" @click="router.push('/jobs')">
          <AppIcon name="right" :size="14" />查看任务中心
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.summary {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.04);
  font-size: 12.5px;
  color: var(--text-muted);
}
.summary strong {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 14px;
}
.summary i {
  width: 1px;
  height: 14px;
  background: var(--border);
}
.summary .danger strong {
  color: #ffa8b6;
}

.toolbar {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.search {
  flex: 1;
  min-width: 220px;
}
.env {
  width: 140px;
}
.owner {
  width: 190px;
}

.account-link {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: none;
  background: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: var(--text);
}
.account-name {
  font-size: 13px;
  font-weight: 500;
}
.account-link:hover .account-name {
  color: var(--accent);
}

/* 行内操作：文字按钮，拉开间距并与上方列头对齐 */
.cell-actions {
  display: flex;
  justify-content: flex-end;
  gap: 18px;
}
.cell-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 2px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.2s var(--ease);
}
.cell-action:hover {
  color: var(--accent);
}
.cell-action.danger:hover {
  color: #ff8fa3;
}

.auth-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.owner-cell {
  font-size: 12.5px;
  color: var(--text-dim);
}
.run-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 记录删除/批量操作：整格作为勾选热区 */
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

/* 表头操作列里的批量按钮组：绝对定位悬浮，不参与表格列宽计算，出现与否都不影响表结构 */
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
.batch-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-height: 280px;
  overflow-y: auto;
}
.batch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.batch-row:last-child {
  border-bottom: none;
}
.batch-index {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  flex: none;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
}
.batch-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-state {
  flex: none;
  min-width: 64px;
  text-align: right;
}
.batch-summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  font-size: 12.5px;
}
.batch-summary.ok {
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.07);
  color: #8bf3c9;
}
.batch-summary.fail {
  border-color: rgba(244, 63, 94, 0.35);
  background: rgba(244, 63, 94, 0.07);
  color: #ffb3c1;
}
.batch-summary-body {
  flex: 1;
  min-width: 0;
}
.batch-summary-body strong {
  display: block;
  font-weight: 500;
}
.batch-err-list {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(5, 9, 15, 0.7);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-muted);
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
}

/* 组织账号扫描 */
.scan-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.scan-meta code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  color: var(--text-dim);
  font-size: 10.5px;
}
.scan-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  max-height: 360px;
  overflow-y: auto;
}
.scan-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.scan-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.scan-alias-input {
  width: 190px;
  flex: none;
  min-height: 30px;
  padding: 4px 8px;
  font-size: 11.5px;
}
.scan-config {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgba(120, 170, 210, 0.03);
}
.scan-config .field > label {
  font-size: 11.5px;
  color: var(--text-muted);
}
.scan-config-wide {
  grid-column: 1 / -1;
}
.scan-row:last-child {
  border-bottom: none;
}
.scan-row:hover {
  background: rgba(34, 211, 238, 0.05);
}
.scan-row.muted {
  cursor: not-allowed;
  opacity: 0.55;
}
.scan-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-panel);
  font-size: 11.5px;
  color: var(--text-muted);
}
.scan-name {
  margin-left: 10px;
  color: var(--text);
}
.scan-alias {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.scan-log {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(5, 9, 15, 0.8);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
</style>
