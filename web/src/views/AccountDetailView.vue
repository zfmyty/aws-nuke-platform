<script setup>
/** 账号详情：概览、配置预览（含合法性校验）、执行历史 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { accountsApi, jobsApi, systemApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import RunDialog from '@/components/RunDialog.vue'
import { authModeLabel, copyText, envMeta, formatDuration, formatTime, statusMeta, timeAgo } from '@/utils/format.js'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

const account = ref(null)
const jobs = ref([])
const yaml = ref('')
const configStatus = ref({ exists: false, source: null, stale: false, generatedAt: null, editedAt: null })
const editingConfig = ref(false)
const configDraft = ref('')
const configSaving = ref(false)
const configRegenerating = ref(false)
const loading = ref(true)
const tab = ref('overview')
const explain = ref(null)
const explaining = ref(false)
const showRun = ref(false)
const policy = ref({ allowUserDestructive: true })
const verifying = ref(false)
const verifyResult = ref(null)

const aliasState = ref(null)
const aliasDraft = ref('')
const aliasLoading = ref(false)
const aliasSaving = ref(false)
const aliasConfirming = ref(false)

/** 把一次检测结果（快照或实时查询）写入展示状态，并预填创建别名的草稿 */
function applyAliasData(data) {
  aliasState.value = data
  if (data.ok && !data.hasAlias && data.suggested) aliasDraft.value = data.suggested
  else if (data.ok && data.aliases?.length) aliasDraft.value = data.aliases[0]
}

async function loadAlias() {
  if (!account.value) return
  aliasLoading.value = true
  try {
    const data = await accountsApi.alias(account.value.id)
    applyAliasData(data)
    // 服务端已保存快照，本地同步一份保证概览处一致
    if (account.value) account.value.aliasCheck = { ...data, checkedAt: data.checkedAt }
  } catch (error) {
    aliasState.value = { ok: false, error: error.message, aliases: [] }
  } finally {
    aliasLoading.value = false
  }
}

/** 进入详情页：用服务端保存的最近一次检测快照回显，不自动发起 AWS 查询 */
function restoreAliasCheck() {
  const snapshot = account.value?.aliasCheck
  if (snapshot) applyAliasData({ ...snapshot, checkedAt: snapshot.checkedAt })
}

async function createAlias() {
  const value = aliasDraft.value.trim()
  if (!value) {
    toast.error('请先填写别名')
    return
  }
  aliasSaving.value = true
  try {
    const data = await accountsApi.createAlias(account.value.id, value)
    toast.success(`别名「${data.alias}」已创建`)
    aliasConfirming.value = false
    await loadAlias()
  } catch (error) {
    toast.error(error.message)
  } finally {
    aliasSaving.value = false
  }
}

function askCreateAlias() {
  if (!aliasDraft.value.trim()) {
    toast.error('请先填写别名')
    return
  }
  aliasConfirming.value = true
}

const filters = computed(() => Object.keys(account.value?.rules?.filters || {}))
const filterTotal = computed(() =>
  Object.values(account.value?.rules?.filters || {}).reduce((sum, list) => sum + list.length, 0),
)

async function load() {
  loading.value = true
  try {
    const [{ account: data }, jobData, policyData] = await Promise.all([
      accountsApi.get(route.params.id),
      jobsApi.list({ limit: 200 }),
      systemApi.policy(),
    ])
    account.value = data
    jobs.value = jobData.items.filter((job) => job.meta?.accountId === data.accountId)
    policy.value = policyData
  } catch (error) {
    toast.error(error.message)
    router.push('/accounts')
  } finally {
    loading.value = false
  }
}

async function loadConfig() {
  try {
    const data = await accountsApi.config(route.params.id)
    yaml.value = data.yaml
    configStatus.value = data.status || configStatus.value
  } catch (error) {
    toast.error(error.message)
  }
}

function startEditConfig() {
  configDraft.value = yaml.value
  editingConfig.value = true
  explain.value = null
}

function cancelEditConfig() {
  editingConfig.value = false
  configDraft.value = ''
}

async function saveConfig() {
  if (!configDraft.value.trim()) {
    toast.error('配置内容不能为空')
    return
  }
  configSaving.value = true
  try {
    const data = await accountsApi.saveConfig(route.params.id, configDraft.value)
    yaml.value = data.yaml
    configStatus.value = data.status || configStatus.value
    editingConfig.value = false
    toast.success('配置已保存，后续不会自动改写')
  } catch (error) {
    toast.error(error.message)
  } finally {
    configSaving.value = false
  }
}

async function regenerateConfig() {
  const hint = configStatus.value.source === 'manual'
    ? '这会覆盖你手工保存的内容，确定按当前设置重新生成吗？'
    : '将按当前账号规则与平台设置重新生成配置，确定吗？'
  if (!window.confirm(hint)) return
  configRegenerating.value = true
  try {
    const data = await accountsApi.regenerateConfig(route.params.id)
    yaml.value = data.yaml
    configStatus.value = data.status || configStatus.value
    editingConfig.value = false
    explain.value = null
    toast.success('配置已重新生成')
  } catch (error) {
    toast.error(error.message)
  } finally {
    configRegenerating.value = false
  }
}

async function copyConfig() {
  const ok = await copyText(yaml.value)
  toast[ok ? 'success' : 'error'](ok ? '配置已复制' : '复制失败')
}

async function validateConfig() {
  explaining.value = true
  explain.value = null
  try {
    const data = await systemApi.explainConfig(route.params.id)
    explain.value = data
    if (data.ok) toast.success('配置校验通过')
    else toast.error('配置校验未通过，请检查输出')
  } catch (error) {
    toast.error(error.message)
  } finally {
    explaining.value = false
  }
}

/** 测试连接：组织模式下会真实调用 sts:AssumeRole，验证信任策略是否打通 */
async function verifyConnection() {
  verifying.value = true
  verifyResult.value = null
  try {
    const result = await accountsApi.verify(route.params.id)
    verifyResult.value = result
    if (result.ok) {
      toast.success(result.mode === 'assume-role' ? 'AssumeRole 成功，身份已确认' : '连接正常，身份已确认')
    } else {
      toast.error(result.error || '连接失败')
    }
  } catch (error) {
    verifyResult.value = { ok: false, error: error.message }
    toast.error(error.message)
  } finally {
    verifying.value = false
  }
}

function onStarted(job) {
  showRun.value = false
  router.push(`/jobs/${job.id}`)
}

watch(tab, (value) => {
  if (value === 'config' && !yaml.value) loadConfig()
})

onMounted(async () => {
  await load()
  restoreAliasCheck()
})
</script>

<template>
  <div v-if="loading" class="stack">
    <div class="skeleton" style="width: 40%; height: 26px" />
    <div class="skeleton" style="height: 120px" />
    <div class="skeleton" style="height: 220px" />
  </div>

  <div v-else-if="account" class="stack fade-up">
    <div class="page-head">
      <div>
        <button class="back" type="button" @click="router.push('/accounts')">
          <AppIcon name="arrow-left" :size="14" />账号列表
        </button>
        <div class="title-row">
          <h1>{{ account.name }}</h1>
          <span class="badge" :class="`badge-${envMeta(account.environment).tone}`">
            {{ envMeta(account.environment).label }}
          </span>
        </div>
        <p class="sub mono">{{ account.accountId }} · 归属 {{ account.ownerName }}</p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="verifying" @click="verifyConnection">
          <span v-if="verifying" class="spin" />
          <AppIcon v-else name="shield-check" :size="14" />
          {{ verifying ? '测试中...' : '测试连接' }}
        </button>
        <button class="btn" type="button" @click="router.push(`/accounts/${account.id}/edit`)">
          <AppIcon name="edit" :size="14" />编辑
        </button>
        <button class="btn btn-primary" type="button" @click="showRun = true">
          <AppIcon name="play" :size="14" />执行 aws-nuke
        </button>
      </div>
    </div>

    <div class="tabs">
      <button type="button" :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button>
      <button type="button" :class="{ active: tab === 'config' }" @click="tab = 'config'">配置预览</button>
      <button type="button" :class="{ active: tab === 'history' }" @click="tab = 'history'">
        执行记录（{{ jobs.length }}）
      </button>
    </div>

    <!-- 概览 -->
    <div v-if="tab === 'overview'" class="overview-grid">
      <section v-if="verifyResult" class="panel panel-pad verify-panel">
        <div class="verify-head">
          <AppIcon :name="verifyResult.ok ? 'shield-check' : 'alert'" :size="16" />
          <h3>连接测试结果</h3>
          <span class="badge" :class="verifyResult.ok ? 'badge-green' : 'badge-red'">
            {{ verifyResult.ok ? '通过' : '失败' }}
          </span>
          <span v-if="verifyResult.matched === false" class="badge badge-amber">账号 ID 不一致</span>
        </div>

        <template v-if="verifyResult.ok">
          <dl class="kv">
            <dt>实际身份</dt>
            <dd class="mono small">{{ verifyResult.arn }}</dd>
            <dt v-if="verifyResult.assumedArn">Assumed ARN</dt>
            <dd v-if="verifyResult.assumedArn" class="mono small">{{ verifyResult.assumedArn }}</dd>
            <dt>账号 ID</dt>
            <dd class="mono">{{ verifyResult.accountId }}</dd>
            <dt v-if="verifyResult.expiration">凭证有效期</dt>
            <dd v-if="verifyResult.expiration">至 {{ formatTime(verifyResult.expiration) }}</dd>
          </dl>
          <p v-if="verifyResult.matched === false" class="verify-warn">
            返回的账号 ID 与账号配置不一致，请检查角色 ARN 是否指到了其它账号。
          </p>
        </template>
        <p v-else class="verify-error">{{ verifyResult.error }}</p>
      </section>
      <section class="panel panel-pad">
        <h3 class="section-title"><AppIcon name="info" :size="15" />基本信息</h3>
        <dl class="kv">
          <dt>账号 ID</dt>
          <dd class="mono">{{ account.accountId }}</dd>
          <dt>认证方式</dt>
          <dd>
            <span class="badge" :class="account.authMode === 'assume-role' ? 'badge-violet' : 'badge-cyan'">
              {{ authModeLabel(account.authMode) }}
            </span>
          </dd>
          <template v-if="account.authMode === 'assume-role'">
            <dt>角色 ARN</dt>
            <dd class="mono small">{{ account.roleArn }}</dd>
            <dt>Session 名称</dt>
            <dd class="mono">{{ account.assumeRoleSessionName || '—' }}</dd>
            <dt v-if="account.externalId">External ID</dt>
            <dd v-if="account.externalId" class="mono small">{{ account.externalId }}</dd>
            <dt>基础凭证</dt>
            <dd>
              <template v-if="account.baseCredentialSource === 'profile'">
                本机 profile <code class="mono">{{ account.baseProfile }}</code>
              </template>
              <template v-else-if="account.baseCredentialSource === 'account'">账号自带 AK/SK</template>
              <template v-else>平台主账号 IAM 用户</template>
            </dd>
          </template>
          <template v-else-if="account.authMode === 'aksk'">
            <dt>Access Key</dt>
            <dd :class="account.accessKeyIdMasked ? 'mono' : 'text-muted'">
              {{ account.accessKeyIdMasked || '未保存' }}
            </dd>
          </template>
          <template v-else>
            <dt>Profile</dt>
            <dd class="mono">{{ account.profile }}</dd>
          </template>
          <dt>默认区域</dt>
          <dd :class="account.defaultRegion ? 'mono' : 'text-muted'">
            {{ account.defaultRegion || '未设置' }}
          </dd>
          <dt>创建时间</dt>
          <dd>{{ formatTime(account.createdAt) }}</dd>
          <dt>最近执行</dt>
          <dd>
            <span v-if="account.lastRunAt" class="row">
              <span class="badge" :class="`badge-${statusMeta(account.lastRunStatus).tone}`">
                {{ statusMeta(account.lastRunStatus).label }}
              </span>
              <span class="small text-muted">{{ timeAgo(account.lastRunAt) }}</span>
            </span>
            <span v-else class="text-muted">尚未执行</span>
          </dd>
        </dl>
      </section>

      <section class="panel panel-pad">
        <h3 class="section-title"><AppIcon name="cloud" :size="15" />AWS 账号别名</h3>
        <p class="alias-hint">
          aws-nuke 默认要求目标账号具备别名并据此二次确认；没有别名就只能用
          <code>--no-alias-check</code> 关掉这道校验。
          <template v-if="account.authMode === 'assume-role'">
            组织模式下由主账号凭证 AssumeRole 进入
            <code class="mono">{{ account.roleName || 'OrganizationAccountAccessRole' }}</code>
            后创建，无需登录子账号。
          </template>
        </p>

        <div v-if="aliasLoading" class="skeleton" style="height: 34px; margin-top: 10px" />
        <template v-else-if="!aliasState">
          <!-- 未检测：不自动发起 AWS 查询，由用户手动触发 -->
          <div class="alias-status" style="margin-top: 10px">
            <span class="badge">未检测</span>
            <span class="small text-muted">检测会实时查询 AWS 上的账号别名状态</span>
          </div>
          <div class="alias-form">
            <button class="btn btn-sm btn-primary" type="button" @click="loadAlias">
              <AppIcon name="refresh" :size="13" />
              检测别名
            </button>
          </div>
        </template>
        <template v-else>
          <div class="alias-status" style="margin-top: 10px">
            <template v-if="aliasState.ok && aliasState.hasAlias">
              <span class="badge badge-green">已设置</span>
              <span class="mono small">{{ (aliasState.aliases || []).join(', ') }}</span>
            </template>
            <template v-else-if="aliasState.ok">
              <span class="badge badge-amber">未设置</span>
              <span class="small text-muted">该账号当前没有别名，aws-nuke 的别名校验无法通过</span>
            </template>
            <template v-else>
              <span class="badge badge-red">查询失败</span>
              <span class="small alias-error">{{ aliasState.error }}</span>
            </template>
          </div>
          <p v-if="aliasState.checkedAt" class="small text-faint" style="margin: 6px 0 0">
            上次检测：{{ formatTime(aliasState.checkedAt) }}
          </p>

          <div v-if="aliasState.ok" class="alias-form">
            <template v-if="!aliasState.hasAlias && !aliasConfirming">
              <input v-model="aliasDraft" class="input mono" placeholder="account-123456789012" maxlength="63" />
              <button class="btn btn-sm btn-primary" type="button" :disabled="aliasSaving" @click="askCreateAlias">
                <AppIcon name="plus" :size="13" />
                创建别名
              </button>
            </template>
            <template v-else-if="aliasConfirming">
              <span class="small alias-error">
                确认在 {{ account.accountId }} 下创建「{{ aliasDraft }}」？别名全局唯一且每账号仅一个。
              </span>
              <button class="btn btn-sm btn-danger" type="button" :disabled="aliasSaving" @click="createAlias">
                <span v-if="aliasSaving" class="spin" />
                <AppIcon v-else name="check" :size="13" />
                确认创建
              </button>
              <button class="btn btn-sm" type="button" @click="aliasConfirming = false">取消</button>
            </template>
          </div>
          <div class="alias-form">
            <button class="btn btn-sm" type="button" @click="loadAlias">
              <AppIcon name="refresh" :size="13" />
              重新检测
            </button>
          </div>
        </template>
      </section>

      <section class="panel panel-pad">
        <h3 class="section-title"><AppIcon name="filter" :size="15" />清理范围</h3>
        <dl class="kv">
          <dt>扫描区域</dt>
          <dd>
            <div v-if="(account.rules?.regions || []).length" class="chips">
              <span v-for="region in account.rules.regions" :key="region" class="chip mono">{{ region }}</span>
            </div>
            <span v-else class="text-muted">未设置，请到编辑页选择扫描区域</span>
          </dd>
          <dt>排除类型</dt>
          <dd>
            <div v-if="account.rules?.resourceTypes?.excludes?.length" class="chips">
              <span v-for="type in account.rules.resourceTypes.excludes" :key="type" class="chip mono">
                {{ type }}
              </span>
            </div>
            <span v-else class="text-muted">未设置</span>
          </dd>
          <dt>保留规则</dt>
          <dd>
            <span v-if="filterTotal">{{ filterTotal }} 条，覆盖 {{ filters.length }} 类资源</span>
            <span v-else class="text-muted">无过滤，全部资源将被清理</span>
          </dd>
        </dl>

        <div v-if="filterTotal" class="filter-list">
          <div v-for="type in filters" :key="type" class="filter-row">
            <span class="filter-type mono">{{ type }}</span>
            <div class="chips">
              <span v-for="(rule, index) in account.rules.filters[type]" :key="index" class="chip">
                {{ typeof rule === 'string' ? rule : `${rule.type}:${rule.value}` }}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 配置预览 / 编辑 -->
    <section v-else-if="tab === 'config'" class="panel">
      <div class="panel-head">
        <div class="panel-title"><AppIcon name="file" :size="15" style="color: var(--accent)" /><h3>aws-nuke 配置</h3></div>
        <div class="row">
          <template v-if="editingConfig">
            <button class="btn btn-sm" type="button" :disabled="configSaving" @click="cancelEditConfig">取消</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="configSaving" @click="saveConfig">
              <span v-if="configSaving" class="spin" />
              <AppIcon v-else name="check" :size="13" />
              保存配置
            </button>
          </template>
          <template v-else>
            <button class="btn btn-sm" type="button" @click="copyConfig"><AppIcon name="copy" :size="13" />复制</button>
            <button class="btn btn-sm" type="button" @click="startEditConfig">
              <AppIcon name="edit" :size="13" />编辑
            </button>
            <button
              v-if="auth.isAdmin"
              class="btn btn-sm"
              type="button"
              :disabled="explaining"
              @click="validateConfig"
            >
              <span v-if="explaining" class="spin" />
              <AppIcon v-else name="shield-check" :size="13" />
              校验配置
            </button>
            <button class="btn btn-sm" type="button" :disabled="configRegenerating" @click="regenerateConfig">
              <span v-if="configRegenerating" class="spin" />
              <AppIcon v-else name="refresh" :size="13" />
              重新生成
            </button>
          </template>
        </div>
      </div>
      <div class="panel-body stack">
        <div class="notice" :class="configStatus.source === 'manual' ? 'notice-warn' : configStatus.stale ? 'notice-warn' : 'notice-info'">
          <AppIcon :name="configStatus.source === 'manual' || configStatus.stale ? 'alert' : 'lock'" :size="15" />
          <div v-if="configStatus.source === 'manual'">
            这份配置是你手工编辑保存的，平台不会自动改写。修改账号规则或平台设置都不会影响它，
            需要新内容请点「重新生成」或再次编辑。
            <span v-if="configStatus.editedAt" class="small"> · 最后编辑 {{ formatTime(configStatus.editedAt) }}</span>
          </div>
          <div v-else-if="configStatus.stale">
            当前账号规则或平台设置与这份配置不一致（配置生成于
            {{ formatTime(configStatus.generatedAt) }}）。执行时仍使用下面这份，需要同步请点「重新生成」。
          </div>
          <div v-else>
            配置已在账号创建时生成并冻结：之后修改平台设置不会改写它，执行时使用的就是下面这份内容。
            <span v-if="configStatus.generatedAt" class="small"> · 生成于 {{ formatTime(configStatus.generatedAt) }}</span>
          </div>
        </div>

        <div v-if="explain" class="explain" :class="explain.ok ? 'ok' : 'fail'">
          <div class="row">
            <AppIcon :name="explain.ok ? 'check' : 'alert'" :size="15" />
            <strong>{{ explain.ok ? 'aws-nuke 已接受该配置' : '配置校验失败' }}</strong>
            <span v-if="explain.stats.total" class="small">
              资源类型 {{ explain.stats.total }} 类 · 启用 {{ explain.stats.included }} · 排除
              {{ explain.stats.excluded }}
            </span>
          </div>
          <pre class="explain-output mono">{{ explain.output }}</pre>
        </div>

        <textarea
          v-if="editingConfig"
          v-model="configDraft"
          class="config-editor mono"
          spellcheck="false"
        />
        <pre v-else class="code">{{ yaml || '加载中...' }}</pre>
      </div>
    </section>

    <!-- 执行记录 -->
    <section v-else class="panel">
      <div class="panel-head">
        <div class="panel-title"><AppIcon name="activity" :size="15" style="color: var(--accent)" /><h3>执行记录</h3></div>
        <button class="btn btn-ghost btn-sm" type="button" @click="router.push('/jobs')">
          全部任务<AppIcon name="right" :size="13" />
        </button>
      </div>
      <AppEmpty
        v-if="!jobs.length"
        icon="terminal"
        title="还没有执行记录"
        description="建议先执行一次演练，确认将被删除的资源清单"
      />
      <div v-else class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>任务</th>
              <th>模式</th>
              <th>状态</th>
              <th>触发人</th>
              <th>耗时</th>
              <th>开始时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.id">
              <td class="truncate" style="max-width: 260px">{{ job.title }}</td>
              <td>
                <span class="badge" :class="job.meta?.mode === 'live' ? 'badge-red' : 'badge-cyan'">
                  {{ job.meta?.mode === 'live' ? '真实删除' : '演练' }}
                </span>
              </td>
              <td>
                <span class="badge" :class="`badge-${statusMeta(job.status).tone}`">
                  {{ statusMeta(job.status).label }}
                </span>
              </td>
              <td class="text-dim">{{ job.createdBy }}</td>
              <td class="mono small">{{ formatDuration(job.startedAt, job.finishedAt) }}</td>
              <td class="small text-muted">{{ formatTime(job.startedAt) }}</td>
              <td style="text-align: right">
                <button class="icon-btn" type="button" @click="router.push(`/jobs/${job.id}`)">
                  <AppIcon name="right" :size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <RunDialog
      v-if="showRun"
      :account="account"
      :allow-live="policy.allowUserDestructive"
      @close="showRun = false"
      @started="onStarted"
    />
  </div>
</template>

<style scoped>
/* 配置编辑器：与 .code 保持同一视觉口径，避免编辑/预览切换时跳动 */
.config-editor {
  width: 100%;
  min-height: 460px;
  margin: 0;
  padding: 15px 16px;
  border-radius: var(--radius);
  border: 1px solid rgba(34, 211, 238, 0.3);
  background: #070d16;
  color: #bfe3f5;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  tab-size: 2;
  resize: vertical;
  outline: none;
}
.config-editor:focus {
  border-color: rgba(34, 211, 238, 0.5);
  box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.08);
}
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
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 16px;
  align-items: start;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 16px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.07);
  font-size: 11px;
  color: var(--text-dim);
}

.filter-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.filter-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.filter-type {
  min-width: 110px;
  font-size: 11.5px;
  color: var(--accent);
  padding-top: 3px;
}

.verify-panel {
  grid-column: 1 / -1;
}
.verify-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 14px;
  color: var(--text-dim);
}
.verify-head h3 {
  font-size: 13px;
}
.verify-error {
  font-size: 12.5px;
  line-height: 1.7;
  color: #ffb3c1;
}
.verify-warn {
  margin-top: 12px;
  font-size: 12px;
  color: var(--warning);
}

.explain {
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  font-size: 12.5px;
}
.explain.ok {
  border-color: rgba(52, 211, 153, 0.32);
  background: rgba(52, 211, 153, 0.06);
  color: #8bf3c9;
}
.explain.fail {
  border-color: rgba(244, 63, 94, 0.32);
  background: rgba(244, 63, 94, 0.07);
  color: #ffb3c1;
}
.explain-output {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-muted);
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}

/* AWS 账号别名 */
.alias-hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-muted);
}
.alias-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  color: var(--text-dim);
  font-size: 10.5px;
}
.alias-status {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.alias-error {
  color: #ffb3c1;
  line-height: 1.6;
}
.alias-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.alias-form .input {
  flex: 1 1 220px;
  min-width: 180px;
}
</style>
