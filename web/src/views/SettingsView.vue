<script setup>
/** 平台设置：账号黑名单、网络代理、默认清理范围、执行权限、运行环境 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { systemApi } from '@/api/index.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'

const toast = useToastStore()
const route = useRoute()

const status = ref(null)
const settings = ref(null)
const loading = ref(true)
const savingSettings = ref(false)

const blocklistText = ref('')
const proxyText = ref('')
const diagnosing = ref(false)
const diagnoseResult = ref(null)
const regionsText = ref('')
const excludesText = ref('')
const profileText = ref('')

const networkRef = ref(null)

/** 运行环境信息行（与网络代理面板的字段布局保持同一种节奏） */
const envRows = computed(() => {
  const platform = status.value?.platform
  if (!platform) return []
  return [
    { label: 'Node 版本', value: platform.node },
    { label: '操作系统', value: platform.os },
    { label: '主机名', value: platform.hostname },
    { label: '服务端口', value: String(platform.port) },
    { label: '数据目录', value: platform.dataDir },
  ]
})

const diagnoseText = computed(() => {
  const result = diagnoseResult.value
  if (!result) return ''
  const format = (title, block) => {
    if (!block) return ''
    const lines = [`${title} · 生效代理 ${block.effective || '无'}（来源 ${block.source}）`]
    for (const attempt of block.attempts || []) {
      lines.push(`  ${attempt.ok ? 'OK  ' : 'FAIL'} ${attempt.via}：${attempt.detail}`)
    }
    return lines.join('\n')
  }
  return [format('GitHub API', result.api), format('下载站', result.download)].filter(Boolean).join('\n\n')
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
    blocklistText.value = (data.settings.blocklist || []).join('\n')
    proxyText.value = data.settings.proxyUrl || ''
    regionsText.value = (data.settings.defaultRegions || []).join(', ')
    excludesText.value = (data.settings.defaultExcludes || []).join(', ')
    profileText.value = data.settings.awsProfile || 'nuke-operator'
  } catch (error) {
    toast.error(error.message)
  }
}

async function runDiagnose() {
  diagnosing.value = true
  try {
    diagnoseResult.value = await systemApi.diagnoseNuke()
  } catch (error) {
    diagnoseResult.value = null
    toast.error(error.message)
  } finally {
    diagnosing.value = false
  }
}

async function saveSettings() {
  savingSettings.value = true
  try {
    const payload = {
      blocklist: blocklistText.value
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      defaultRegions: regionsText.value
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      defaultExcludes: excludesText.value
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      awsProfile: profileText.value,
      proxyUrl: proxyText.value.trim(),
      organizationRoleName: settings.value.organizationRoleName,
      assumeRoleSessionName: settings.value.assumeRoleSessionName,
      protectAuthRole: settings.value.protectAuthRole,
      allowUserDestructive: settings.value.allowUserDestructive,
      bypassAliasCheck: settings.value.bypassAliasCheck,
      promptTimeoutMinutes: settings.value.promptTimeoutMinutes,
    }
    await systemApi.updateSettings(payload)
    toast.success('平台设置已保存')
    await loadSettings()
    await loadStatus(true)
  } catch (error) {
    toast.error(error.message)
  } finally {
    savingSettings.value = false
  }
}

onMounted(async () => {
  loading.value = true
  await Promise.all([loadStatus(), loadSettings()])
  loading.value = false
  if (route.query.focus === 'network') {
    await nextTick()
    networkRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>平台设置</h1>
        <p class="sub">黑名单、清理范围默认值、认证参数、执行权限与网络代理</p>
      </div>
      <div class="row">
        <button class="btn btn-primary btn-sm" type="button" :disabled="savingSettings" @click="saveSettings">
          <span v-if="savingSettings" class="spin" />
          <AppIcon v-else name="check" :size="14" />
          {{ savingSettings ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="panel panel-pad">
      <p class="text-muted small">正在加载平台设置…</p>
    </div>

    <div v-else class="settings-grid">
      <!-- 黑名单 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="shield" :size="15" style="color: var(--danger)" /><h3>账号黑名单</h3></div>
        </div>
        <div class="panel-body stack">
          <p class="hint">
            黑名单中的账号禁止执行任何 aws-nuke 任务，用于保护生产环境与管理账号。
            每行填写一个 12 位账号 ID。
          </p>
          <textarea
            v-model="blocklistText"
            class="textarea mono"
            rows="6"
            placeholder="请输入 12 位账号 ID，每行一个。&#10;示例：&#10;123456789012&#10;111122223333"
          />
          <div class="notice" :class="settings?.masterCredentialMode === 'standalone' ? 'notice-warn' : 'notice-info'">
            <AppIcon :name="settings?.masterCredentialMode === 'standalone' ? 'alert' : 'info'" :size="15" />
            <span v-if="settings?.masterCredentialMode === 'standalone'">
              当前使用方式为「单账号直连」：主账号不作为 AssumeRole 基础凭证，
              因此<strong>不会自动并入黑名单</strong>——主账号本身即可以是清理目标。
              此处仅需填写需要额外保护的账号（例如生产环境账号）。
            </span>
            <span v-else-if="settings?.masterCredentials?.accountId">
              已手动配置 {{ (settings?.blocklist || []).length }} 个账号。主账号
              <span class="mono">{{ settings.masterCredentials.accountId }}</span>
              由平台自动并入黑名单，无需手动填写，任何角色均无法对其执行清理。
            </span>
            <span v-else>
              已手动配置 {{ (settings?.blocklist || []).length }} 个账号。尚未配置主账号凭证，
              此种情况下配置文件将写入占位 ID，以满足 aws-nuke 的强制校验要求。
            </span>
          </div>
        </div>
      </section>

      <!-- 执行权限 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="sliders" :size="15" style="color: var(--violet)" /><h3>执行权限</h3></div>
        </div>
        <div class="panel-body">
          <div class="switch-row">
            <div>
              <strong>允许普通用户执行真实删除</strong>
              <p>关闭后，普通用户仅可执行演练（dry-run），真实删除操作仅限管理员。</p>
            </div>
            <button
              type="button"
              class="switch"
              :class="{ on: settings?.allowUserDestructive }"
              @click="settings.allowUserDestructive = !settings.allowUserDestructive"
            />
          </div>
          <div class="switch-row">
            <div>
              <strong>自动保护认证角色</strong>
              <p>
                为组织账号自动追加 <code>IAMRole</code>、<code>IAMRolePolicy</code>、
                <code>IAMRolePolicyAttachment</code>、<code>IAMInstanceProfile</code> 过滤规则，
                防止清理过程中误删正在用于 AssumeRole 认证的角色。
              </p>
            </div>
            <button
              type="button"
              class="switch"
              :class="{ on: settings?.protectAuthRole }"
              @click="settings.protectAuthRole = !settings.protectAuthRole"
            />
          </div>
          <div class="switch-row">
            <div>
              <strong>跳过账号别名检查</strong>
              <p>开启后，aws-nuke 将不再校验账号别名中包含 prod、live 等敏感词的账号。</p>
            </div>
            <button
              type="button"
              class="switch"
              :class="{ on: settings?.bypassAliasCheck }"
              @click="settings.bypassAliasCheck = !settings.bypassAliasCheck"
            />
          </div>
          <div class="switch-row">
            <div>
              <strong>确认等待时长（分钟）</strong>
              <p>
                「扫描后确认」模式下，扫描完成后等待用户输入别名确认的时间；
                超时自动终止任务，不会执行任何删除。范围 1-120 分钟，默认 5 分钟。
              </p>
            </div>
            <input
              v-model.number="settings.promptTimeoutMinutes"
              type="number"
              min="1"
              max="120"
              class="input timeout-input"
            />
          </div>
        </div>
      </section>

      <!-- 清理范围默认值 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="filter" :size="15" style="color: var(--accent)" /><h3>清理范围默认值</h3></div>
        </div>
        <div class="panel-body stack">
          <div class="field">
            <label>默认扫描区域（可选）</label>
            <input v-model="regionsText" class="input mono" placeholder="留空表示不设置兜底区域；示例：global, us-east-1" />
            <span class="hint">
              仅在账号未选择扫描区域时作为兜底值，推荐留空，由各账号在编辑页自行确定清理范围。
              <code>global</code> 表示 IAM、S3 等全局资源。
            </span>
          </div>
          <div class="field">
            <label>默认排除资源类型</label>
            <input v-model="excludesText" class="input mono" placeholder="示例：S3Object, IAMUser" />
            <span class="hint">
              对全部账号生效的资源类型排除项。建议保留 <code>S3Object</code>，
              以避免删除存储桶时连带清空其中的对象数据。
            </span>
          </div>
        </div>
      </section>

      <!-- 认证与组织参数 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="key" :size="15" style="color: var(--accent)" /><h3>认证与组织参数</h3></div>
        </div>
        <div class="panel-body stack">
          <div class="field">
            <label>AWS CLI Profile</label>
            <input v-model="profileText" class="input mono" placeholder="请输入 profile 名称，默认 nuke-operator" />
            <span class="hint">平台保存主账号凭证时，写入本机 <code>~/.aws/credentials</code> 所使用的 profile 名称。</span>
          </div>
          <div class="field">
            <label>组织默认角色名</label>
            <input
              v-model="settings.organizationRoleName"
              class="input mono"
              placeholder="请输入组织角色名称，默认 OrganizationAccountAccessRole"
            />
            <span class="hint">AWS Organizations 创建成员账号时自动生成的角色名称，新建组织账号时将自动带出。</span>
          </div>
          <div class="field">
            <label>AssumeRole Session 名称</label>
            <input
              v-model="settings.assumeRoleSessionName"
              class="input mono"
              placeholder="请输入会话名称，默认 aws-nuke-platform"
            />
            <span class="hint">AssumeRole 会话名称，将记录在 CloudTrail 审计日志中，便于操作追溯。</span>
          </div>
        </div>
      </section>

      <!-- 网络代理 -->
      <section ref="networkRef" class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="cloud" :size="15" style="color: var(--accent)" /><h3>网络代理</h3></div>
        </div>
        <div class="panel-body stack">
          <div class="field">
            <label>代理地址</label>
            <input v-model="proxyText" class="input mono" placeholder="留空表示自动探测；填写 off 表示强制直连" />
            <span class="hint">
              用于检查 aws-nuke 版本更新与下载二进制文件。留空时自动读取 Windows 系统代理与
              <code>HTTPS_PROXY</code> 环境变量；支持 <code>http://</code>、<code>https://</code>、
              <code>socks5h://</code> 地址格式，例如 <code>http://127.0.0.1:7890</code>。
            </span>
          </div>
          <div class="row">
            <button class="btn btn-sm" type="button" :disabled="diagnosing" @click="runDiagnose">
              <span v-if="diagnosing" class="spin" />
              <AppIcon v-else name="activity" :size="13" />
              测试连通性
            </button>
          </div>
          <pre v-if="diagnoseText" class="explain-output mono">{{ diagnoseText }}</pre>
        </div>
      </section>

      <!-- 运行环境 -->
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="cpu" :size="15" style="color: var(--text-muted)" /><h3>运行环境</h3></div>
        </div>
        <div class="panel-body stack">
          <div v-if="envRows.length" class="stack">
            <div v-for="row in envRows" :key="row.label" class="env-row">
              <span class="env-label">{{ row.label }}</span>
              <span class="env-value mono">{{ row.value }}</span>
            </div>
          </div>
          <p v-else class="text-muted small">环境信息不可用</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 固定两栏分组：同行业的设置左右对齐，避免 auto-fit 造成的参差布局 */
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}
@media (max-width: 860px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(120, 170, 210, 0.08);
}
.switch-row:last-child {
  border-bottom: none;
}
.timeout-input {
  width: 110px;
  flex: none;
  text-align: center;
}
.switch-row strong {
  display: block;
  font-size: 12.5px;
}
.switch-row p {
  margin-top: 4px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-muted);
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
.explain-output {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}
/* 运行环境信息行：与网络代理面板的字段同节奏（标签顶格、值靠右） */
.env-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 7px 0;
  border-bottom: 1px dashed rgba(120, 170, 210, 0.1);
}
.env-row:last-child {
  border-bottom: none;
}
.env-label {
  flex: none;
  font-size: 12px;
  color: var(--text-muted);
}
.env-value {
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
  word-break: break-all;
}
</style>
