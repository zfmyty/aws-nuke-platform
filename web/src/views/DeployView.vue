<script setup>
/** 部署向导：环境自检、aws-nuke 更新、AWS CLI 安装、主账号凭证（组织跨账号 / 单账号直连） */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { jobsApi, systemApi } from '@/api/index.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import { copyText, formatTime } from '@/utils/format.js'

const toast = useToastStore()
const router = useRouter()

const status = ref(null)
const settings = ref(null)
const loading = ref(true)

const creds = ref({ accessKeyId: '', secretAccessKey: '', sessionToken: '', region: '', profile: 'nuke-operator' })
const credsSaving = ref(false)
const credsError = ref('')
const identity = ref(null)

const installJob = ref(null)
const installLog = ref([])
const installing = ref(false)
let installSource = null

const updateInfo = ref(null)
const checkingUpdate = ref(false)
const updating = ref(false)
const updateLog = ref([])
const updateJob = ref(null)
let updateSource = null

const progress = computed(() => {
  const steps = status.value?.steps || []
  if (!steps.length) return 0
  return Math.round((steps.filter((step) => step.ready).length / steps.length) * 100)
})

const stepState = (id) => status.value?.steps?.find((step) => step.id === id) || { ready: false, hint: '' }

const updateAvailable = computed(() => Boolean(updateInfo.value?.canInstall))
const assetSizeText = computed(() => {
  const size = Number(updateInfo.value?.asset?.size || 0)
  return size ? `${(size / 1048576).toFixed(1)} MB` : ''
})

async function loadStatus(refresh = false) {
  try {
    status.value = await systemApi.status(refresh)
  } catch (error) {
    toast.error(error.message)
  }
}

async function loadSettings() {
  try {
    const data = await systemApi.settings()
    settings.value = data.settings
    creds.value.region = data.settings.masterCredentials?.region || ''
    creds.value.profile = data.settings.awsProfile || 'nuke-operator'
  } catch (error) {
    toast.error(error.message)
  }
}

/** 主账号使用方式：organization（组织跨账号）/ standalone（单账号直连） */
const masterMode = computed(() => (settings.value?.masterCredentialMode === 'standalone' ? 'standalone' : 'organization'))
const modeSaving = ref(false)

async function switchMasterMode(mode) {
  if (mode === masterMode.value || modeSaving.value) return
  modeSaving.value = true
  try {
    await systemApi.updateSettings({ masterCredentialMode: mode })
    await loadSettings()
    await loadStatus(true)
    toast.success(mode === 'standalone' ? '已切换为单账号直连，主账号不再自动进入黑名单' : '已切换为组织跨账号，主账号将自动受黑名单保护')
  } catch (error) {
    toast.error(error.message)
  } finally {
    modeSaving.value = false
  }
}

async function loadUpdateInfo(force = false) {
  checkingUpdate.value = true
  try {
    updateInfo.value = await systemApi.checkNukeUpdate(force)
  } catch (error) {
    updateInfo.value = { error: error.message }
  } finally {
    checkingUpdate.value = false
  }
}

async function installCli() {
  installing.value = true
  installLog.value = []
  installJob.value = null
  try {
    const data = await systemApi.installCli()
    installJob.value = data.job
    connectInstallStream(data.job.id)
  } catch (error) {
    installing.value = false
    toast.error(error.message)
  }
}

function connectInstallStream(jobId) {
  if (installSource) installSource.close()
  installSource = new EventSource(jobsApi.stream(jobId))
  installSource.addEventListener('snapshot', (event) => {
    const payload = JSON.parse(event.data)
    installLog.value = payload.lines || []
  })
  installSource.addEventListener('line', (event) => {
    installLog.value.push(JSON.parse(event.data).line)
    if (installLog.value.length > 800) installLog.value.shift()
  })
  installSource.addEventListener('closed', async (event) => {
    installing.value = false
    installSource.close()
    installSource = null
    const job = JSON.parse(event.data).job
    installJob.value = job
    await loadStatus(true)
    if (status.value?.awsCli?.installed) toast.success('AWS CLI 已就绪')
    else toast.error('安装未完成，请查看日志；若提示权限不足，请以管理员权限重新启动平台')
  })
  installSource.onerror = () => {
    installing.value = false
  }
}

async function startUpdate() {
  updating.value = true
  updateLog.value = []
  updateJob.value = null
  try {
    const data = await systemApi.updateNuke()
    updateJob.value = data.job
    connectUpdateStream(data.job.id)
  } catch (error) {
    updating.value = false
    toast.error(error.message)
  }
}

function connectUpdateStream(jobId) {
  if (updateSource) updateSource.close()
  updateSource = new EventSource(jobsApi.stream(jobId))
  updateSource.addEventListener('snapshot', (event) => {
    updateLog.value = JSON.parse(event.data).lines || []
  })
  updateSource.addEventListener('line', (event) => {
    updateLog.value.push(JSON.parse(event.data).line)
    if (updateLog.value.length > 800) updateLog.value.shift()
  })
  updateSource.addEventListener('closed', async (event) => {
    updating.value = false
    updateSource.close()
    updateSource = null
    updateJob.value = JSON.parse(event.data).job
    await loadStatus(true)
    await loadUpdateInfo(true)
    if (updateJob.value.status === 'succeeded') toast.success('aws-nuke 已更新')
    else toast.error('更新未完成，请查看任务日志')
  })
  updateSource.onerror = () => {
    updating.value = false
  }
}

function openUpdateJob() {
  if (updateJob.value) router.push(`/jobs/${updateJob.value.id}`)
}

function goDiagnose() {
  router.push({ path: '/settings', query: { focus: 'network' } })
}

async function saveCredentials() {
  credsError.value = ''
  credsSaving.value = true
  identity.value = null
  try {
    const data = await systemApi.saveCredentials(creds.value)
    identity.value = data.identity
    creds.value.accessKeyId = ''
    creds.value.secretAccessKey = ''
    creds.value.sessionToken = ''
    toast.success('凭证已保存并通过 STS 校验')
    await loadStatus(true)
    await loadSettings()
  } catch (error) {
    credsError.value = error.message
  } finally {
    credsSaving.value = false
  }
}

async function verifyCredentials() {
  try {
    const data = await systemApi.verifyCredentials()
    identity.value = data.identity
    toast.success('凭证有效')
  } catch (error) {
    toast.error(error.message)
  }
}

async function clearCredentials() {
  try {
    await systemApi.clearCredentials()
    toast.info('已清除主账号凭证')
    await loadStatus(true)
    await loadSettings()
  } catch (error) {
    toast.error(error.message)
  }
}

async function copyTextValue(text) {
  const ok = await copyText(text)
  toast[ok ? 'success' : 'error'](ok ? '已复制' : '复制失败')
}

onMounted(async () => {
  loading.value = true
  await Promise.all([loadStatus(), loadSettings()])
  loading.value = false
  void loadUpdateInfo()
})

onBeforeUnmount(() => {
  if (installSource) installSource.close()
  if (updateSource) updateSource.close()
})
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>部署向导</h1>
        <p class="sub">环境自检、aws-nuke 与 AWS CLI 装配、主账号凭证，按步骤完成平台上线</p>
      </div>
      <div class="row">
        <button class="btn btn-sm" type="button" @click="router.push('/settings')">
          <AppIcon name="sliders" :size="14" />平台设置
        </button>
        <button class="btn btn-sm" type="button" @click="loadStatus(true)">
          <AppIcon name="refresh" :size="14" />重新检测
        </button>
      </div>
    </div>

    <!-- 首次加载骨架：避免已配置环境下短暂闪现「未就绪 / 待配置」 -->
    <template v-if="loading">
      <section class="panel panel-pad hero">
        <div class="hero-main">
          <div class="skeleton hero-skeleton-ring" />
          <div class="grow stack">
            <div class="skeleton" style="height: 18px; width: 40%" />
            <div class="skeleton" style="height: 12px; width: 70%" />
            <div class="skeleton" style="height: 22px; width: 55%" />
          </div>
        </div>
      </section>
      <div class="steps">
        <section v-for="i in 3" :key="i" class="panel step-card">
          <div class="step-head">
            <div class="skeleton" style="width: 26px; height: 26px; border-radius: 50%" />
            <div class="grow stack">
              <div class="skeleton" style="height: 14px; width: 30%" />
              <div class="skeleton" style="height: 11px; width: 60%" />
            </div>
          </div>
          <div class="skeleton" style="height: 64px; margin: 0 16px 16px 46px" />
        </section>
      </div>
      <p class="text-muted small" style="text-align: center; padding-bottom: 8px">正在检测运行环境…</p>
    </template>

    <template v-else>
    <section class="panel panel-pad hero">
      <div class="hero-main">
        <div class="hero-ring" :style="{ '--p': `${progress}%` }">
          <span>{{ progress }}<i>%</i></span>
        </div>
        <div class="grow">
          <h2>{{ status?.ready ? '运行环境已就绪' : '按步骤完成平台装配' }}</h2>
          <p class="text-muted small">
            {{
              status?.ready
                ? '所有依赖检查通过，可以为账号生成配置并执行演练。'
                : '依次完成二进制、AWS CLI、主账号凭证即可开始使用。安装过程会实时回显日志。'
            }}
          </p>
          <div class="hero-tags">
            <span class="badge" :class="status?.awsNuke?.installed ? 'badge-green' : 'badge-red'">
              aws-nuke {{ status?.awsNuke?.version || '未就绪' }}
            </span>
            <span class="badge" :class="status?.awsCli?.installed ? 'badge-green' : 'badge-red'">
              AWS CLI {{ status?.awsCli?.version || '未安装' }}
            </span>
            <span
              class="badge"
              :class="
                masterMode === 'standalone' || status?.credentials?.configured ? 'badge-green' : 'badge-amber'
              "
            >
              {{
                masterMode === 'standalone'
                  ? '单账号直连'
                  : `凭证 ${status?.credentials?.configured ? '已配置' : '待配置'}`
              }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <div class="steps">
      <!-- 步骤 1 -->
      <section class="panel step-card">
        <div class="step-head">
          <span class="step-no" :class="{ done: stepState('binary').ready }">
            <AppIcon v-if="stepState('binary').ready" name="check" :size="14" />
            <template v-else>1</template>
          </span>
          <div class="grow">
            <h3>aws-nuke 可执行文件</h3>
            <p>{{ stepState('binary').hint }}</p>
          </div>
          <span class="badge" :class="stepState('binary').ready ? 'badge-green' : 'badge-red'">
            {{ stepState('binary').ready ? '已就绪' : '缺失' }}
          </span>
        </div>
        <div v-if="status" class="step-body">
          <div class="update-row">
            <div class="grow">
              <div class="version-line">
                <span class="version-label">当前</span>
                <code class="mono">{{ updateInfo?.current ? `v${updateInfo.current}` : '未安装' }}</code>
                <template v-if="updateInfo?.latest">
                  <span class="version-sep">→</span>
                  <span class="version-label">最新</span>
                  <code class="mono">{{ `v${updateInfo.latest}` }}</code>
                </template>
                <span v-if="updateAvailable" class="badge badge-amber">可更新</span>
                <span v-else-if="updateInfo?.latest && updateInfo?.current" class="badge badge-green">已是最新</span>
                <span v-if="checkingUpdate" class="version-label">检测中…</span>
              </div>
              <p class="hint">
                上游 {{ updateInfo?.repo || 'ekristen/aws-nuke' }}
                <template v-if="updateInfo?.asset"> · 资产 <code class="mono">{{ updateInfo.asset.name }}</code> · {{ assetSizeText }}</template>
                <template v-if="updateInfo?.publishedAt"> · 发布于 {{ updateInfo.publishedAt.slice(0, 10) }}</template>
              </p>
              <p v-if="updateInfo?.error" class="hint" style="color: var(--danger)">
                {{ updateInfo.error }}
              </p>
              <p v-if="updateInfo?.error" class="hint">
                <button class="btn btn-sm" type="button" @click="goDiagnose">
                  <AppIcon name="activity" :size="13" />网络诊断
                </button>
              </p>
            </div>
            <div class="row">
              <button class="btn btn-sm" type="button" :disabled="checkingUpdate || updating" @click="loadUpdateInfo(true)">
                <span v-if="checkingUpdate" class="spin" />
                <AppIcon v-else name="refresh" :size="13" />
                检查更新
              </button>
              <button
                v-if="updateAvailable"
                class="btn btn-sm btn-primary"
                type="button"
                :disabled="updating || checkingUpdate"
                @click="startUpdate"
              >
                <span v-if="updating" class="spin" />
                <AppIcon v-else name="download" :size="13" />
                {{ updating ? '更新中…' : `更新到 v${updateInfo.latest}` }}
              </button>
            </div>
          </div>

          <div class="path-row">
            <code class="path mono">{{ status.awsNuke.path }}</code>
            <button class="btn btn-sm" type="button" @click="copyTextValue(status.awsNuke.path)">复制路径</button>
          </div>
          <p v-if="!stepState('binary').ready" class="hint">
            请将 aws-nuke-v3.68.3-windows-amd64.zip 中的 aws-nuke.exe 放入项目的 runtime/bin 目录后重新检测。
          </p>

          <div v-if="updateLog.length" class="install-console">
            <div class="install-head">
              <span class="console-dot" :class="{ live: updating }" />
              <span class="small text-muted">{{ updating ? '更新日志（实时）' : '更新日志' }}</span>
              <button v-if="updateJob" class="btn btn-sm" type="button" @click="openUpdateJob">查看任务</button>
            </div>
            <div class="console">
              <div v-for="(line, index) in updateLog" :key="index" class="console-line">{{ line }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 步骤 2 -->
      <section class="panel step-card">
        <div class="step-head">
          <span class="step-no" :class="{ done: stepState('cli').ready }">
            <AppIcon v-if="stepState('cli').ready" name="check" :size="14" />
            <template v-else>2</template>
          </span>
          <div class="grow">
            <h3>AWS CLI v2</h3>
            <p>{{ stepState('cli').hint }}</p>
          </div>
          <button class="btn btn-sm" :class="stepState('cli').ready ? '' : 'btn-primary'" :disabled="installing" @click="installCli">
            <span v-if="installing" class="spin" />
            <AppIcon v-else name="download" :size="14" />
            {{ installing ? '安装中...' : stepState('cli').ready ? '重新安装/升级' : '一键安装' }}
          </button>
        </div>

        <div class="step-body">
          <div v-if="status && !status.platform.elevated && !stepState('cli').ready" class="notice notice-warn">
            <AppIcon name="unlock" :size="16" />
            <div>
              当前为普通权限启动（启动时未通过管理员授权），一键安装会因无法写入 <code>Program Files</code> 而失败。
              请关闭服务窗口后重新双击 <code>start.bat</code>，在系统弹窗中点「是」；或自行从 AWS 官网下载 msi 安装包安装。
            </div>
          </div>
          <div class="notice notice-info">
            <AppIcon name="info" :size="16" />
            <div>
              执行官方脚本
              <code>irm https://awscli.amazonaws.com/v2/install.ps1 | iex</code>。安装到系统目录需要管理员权限，启动时授予即可。
            </div>
          </div>
          <div v-if="installLog.length" class="install-console">
            <div class="install-head">
              <span class="console-dot" :class="{ live: installing }" />
              <span class="small text-muted">{{ installing ? '安装日志（实时）' : '安装日志' }}</span>
            </div>
            <div class="console">
              <div v-for="(line, index) in installLog" :key="index" class="console-line">{{ line }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 步骤 3 -->
      <section class="panel step-card">
        <div class="step-head">
          <span class="step-no" :class="{ done: stepState('credentials').ready }">
            <AppIcon v-if="stepState('credentials').ready" name="check" :size="14" />
            <template v-else>3</template>
          </span>
          <div class="grow">
            <h3>主账号凭证与使用方式</h3>
            <p>{{ stepState('credentials').hint }}</p>
          </div>
          <span
            class="badge"
            :class="masterMode === 'standalone' ? 'badge-green' : stepState('credentials').ready ? 'badge-green' : 'badge-amber'"
          >
            {{
              masterMode === 'standalone'
                ? '无需配置'
                : stepState('credentials').ready
                  ? '已配置'
                  : '待配置'
            }}
          </span>
        </div>

        <div class="step-body stack">
          <!-- 使用方式：决定主账号是否自动进黑名单，也决定这一步是否需要填 -->
          <div class="mode-picker">
            <button
              type="button"
              class="mode-card"
              :class="{ active: masterMode === 'organization' }"
              :disabled="modeSaving"
              @click="switchMasterMode('organization')"
            >
              <div class="mode-head">
                <AppIcon name="layers" :size="15" />
                <strong>组织跨账号</strong>
                <span v-if="masterMode === 'organization'" class="mode-flag">当前</span>
              </div>
              <p>主账号 IAM 用户负责 AssumeRole 到成员账号，子账号不需要交出密钥。</p>
              <span class="mode-note">主账号自动加入黑名单保护，不可作为清理目标</span>
            </button>

            <button
              type="button"
              class="mode-card"
              :class="{ active: masterMode === 'standalone' }"
              :disabled="modeSaving"
              @click="switchMasterMode('standalone')"
            >
              <div class="mode-head">
                <AppIcon name="box" :size="15" />
                <strong>单账号直连</strong>
                <span v-if="masterMode === 'standalone'" class="mode-flag">当前</span>
              </div>
              <p>直接用账号自己的 AK/SK（可以是 root）清理本账号，不涉及组织关系。</p>
              <span class="mode-note">主账号不自动进黑名单，避免和目标账号冲突</span>
            </button>
          </div>

          <!-- 单账号直连：本步可跳过 -->
          <div v-if="masterMode === 'standalone'" class="notice notice-info">
            <AppIcon name="info" :size="16" />
            <div>
              这一步可以跳过，无需在此填写主账号凭证。请到「账号管理 → 提交账号」为每个要清理的账号
              选择「账号 AK/SK 直连」并填入该账号的密钥（root 或该账号的 IAM 用户均可）。
            </div>
          </div>

          <template v-else>
          <div v-if="settings?.masterCredentials?.configured" class="cred-summary">
            <dl class="kv">
              <dt>Access Key</dt>
              <dd class="mono">{{ settings.masterCredentials.accessKeyId }}</dd>
              <dt>账号 ID</dt>
              <dd class="mono">{{ settings.masterCredentials.accountId || '—' }}</dd>
              <dt>身份 ARN</dt>
              <dd class="mono small">{{ settings.masterCredentials.arn || '—' }}</dd>
              <dt>Profile</dt>
              <dd class="mono">{{ settings.awsProfile }}</dd>
              <dt>更新时间</dt>
              <dd>{{ formatTime(settings.masterCredentials.updatedAt) }}</dd>
            </dl>
            <div class="row">
              <button class="btn btn-sm" type="button" @click="verifyCredentials">
                <AppIcon name="shield-check" :size="13" />校验有效性
              </button>
              <button class="btn btn-sm btn-danger" type="button" @click="clearCredentials">
                <AppIcon name="trash" :size="13" />清除凭证
              </button>
            </div>
          </div>

          <div class="form-grid">
            <div class="field">
              <label>Access Key ID</label>
              <input v-model="creds.accessKeyId" class="input mono" placeholder="AKIA..." autocomplete="off" />
            </div>
            <div class="field">
              <label>Secret Access Key</label>
              <input
                v-model="creds.secretAccessKey"
                class="input mono"
                type="password"
                placeholder="••••••••••••"
                autocomplete="new-password"
              />
            </div>
          </div>

          <p class="hint">
            和 <code>aws configure</code> 一样，填 AK/SK 即可；区域等配置留空就沿用本机 CLI 的默认值。
          </p>

          <details class="adv">
            <summary>高级选项（可选）</summary>
            <div class="form-grid">
              <div class="field">
                <label>Profile 名称</label>
                <input v-model="creds.profile" class="input mono" placeholder="nuke-operator" />
                <span class="hint">平台写入 ~/.aws/credentials 使用的 profile 名</span>
              </div>
              <div class="field">
                <label>默认区域</label>
                <input v-model="creds.region" class="input mono" placeholder="留空表示沿用本机 AWS CLI 配置" />
              </div>
              <div class="field" style="grid-column: 1 / -1">
                <label>Session Token</label>
                <input v-model="creds.sessionToken" class="input mono" placeholder="可选。仅使用临时凭证时填写" />
              </div>
            </div>
          </details>

          <div class="notice notice-warn">
            <AppIcon name="lock" :size="16" />
            <div>
              凭证将以 AES-256-GCM 加密保存于服务端，并写入本机 AWS CLI 的
              <code>~/.aws/credentials</code>（profile: {{ creds.profile || settings?.awsProfile }}）。保存时会调用 STS 校验身份。
            </div>
          </div>

          <p v-if="credsError" class="notice notice-danger">
            <AppIcon name="alert" :size="16" /><span>{{ credsError }}</span>
          </p>

          <div v-if="identity" class="identity">
            <AppIcon name="check" :size="15" />
            <div>
              <strong>身份校验通过</strong>
              <p class="mono small">{{ identity.arn }}</p>
              <p class="small text-muted">账号 {{ identity.accountId }}</p>
            </div>
          </div>

          <div class="row">
            <button class="btn btn-primary" type="button" :disabled="credsSaving" @click="saveCredentials">
              <span v-if="credsSaving" class="spin" />
              <AppIcon v-else name="key" :size="14" />
              {{ credsSaving ? '校验中...' : '保存并校验' }}
            </button>
          </div>
          </template>
        </div>
      </section>
    </div>
    </template>
  </div>
</template>

<style scoped>
/* 加载骨架 */
.hero-skeleton-ring {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  flex: none;
}
/* Hero */
.hero {
  overflow: hidden;
}
.hero-main {
  display: flex;
  align-items: center;
  gap: 22px;
}
.hero-ring {
  position: relative;
  display: grid;
  place-items: center;
  width: 92px;
  height: 92px;
  flex: none;
  border-radius: 50%;
  background: conic-gradient(var(--accent) var(--p), rgba(120, 170, 210, 0.12) 0);
}
.hero-ring::before {
  content: "";
  position: absolute;
  inset: 6px;
  border-radius: 50%;
  background: #0b1320;
}
.hero-ring span {
  position: relative;
  font-family: var(--font-mono);
  font-size: 24px;
  font-weight: 600;
  color: var(--text);
}
.hero-ring i {
  font-style: normal;
  font-size: 12px;
  color: var(--text-muted);
}
.hero h2 {
  font-size: 17px;
}
.hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 12px;
}

/* 步骤 */
.steps {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.step-card {
  overflow: hidden;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 16px 20px;
}
.step-head h3 {
  font-size: 14px;
}
.step-head p {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
}
.step-no {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.06);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.step-no.done {
  border-color: rgba(52, 211, 153, 0.34);
  background: rgba(52, 211, 153, 0.1);
  color: var(--success);
}
.step-body {
  padding: 0 20px 18px 63px;
}
.path-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.update-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.05);
}
.update-row .hint {
  margin-top: 6px;
}
.version-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.version-label {
  font-size: 11px;
  color: var(--text-muted);
}
.version-sep {
  color: var(--text-faint);
}
.path {
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: rgba(5, 9, 15, 0.8);
  font-size: 11.5px;
  color: var(--text-dim);
  word-break: break-all;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.hint {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-muted);
}
.hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  color: var(--text-dim);
  font-size: 10.5px;
}
.adv {
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.5);
}
.adv summary {
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
.adv[open] summary {
  margin-bottom: 12px;
}
.cred-summary {
  padding: 14px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(52, 211, 153, 0.04);
}
.cred-summary .row {
  margin-top: 12px;
}
.identity {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid rgba(52, 211, 153, 0.32);
  background: rgba(52, 211, 153, 0.07);
  color: #8bf3c9;
  font-size: 12.5px;
}
.identity p {
  margin-top: 3px;
  color: var(--text-muted);
}

.install-console {
  margin-top: 12px;
}
.install-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
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

/* 主账号使用方式选择 */
.mode-picker {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.mode-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px 14px;
  text-align: left;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.04);
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 0.18s var(--ease), background 0.18s var(--ease);
}
.mode-card:hover:not(:disabled) {
  border-color: rgba(34, 211, 238, 0.3);
  background: rgba(34, 211, 238, 0.06);
}
.mode-card:disabled {
  cursor: progress;
  opacity: 0.7;
}
.mode-card.active {
  border-color: rgba(34, 211, 238, 0.46);
  background: rgba(34, 211, 238, 0.09);
  box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.12);
}
.mode-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.mode-head svg {
  color: var(--accent);
  flex: none;
}
.mode-head strong {
  font-size: 12.5px;
  color: var(--text);
}
.mode-flag {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid rgba(34, 211, 238, 0.3);
  background: rgba(34, 211, 238, 0.12);
  color: var(--accent);
  font-size: 10px;
}
.mode-card p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-muted);
}
.mode-note {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}
.mode-card.active .mode-note {
  color: #7fb6c9;
}
@media (max-width: 720px) {
  .form-grid,
  .mode-picker {
    grid-template-columns: 1fr;
  }
  .step-body {
    padding-left: 20px;
  }
  .hero-ring {
    display: none;
  }
}
</style>
