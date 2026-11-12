<script setup>
/** 账号提交 / 编辑：基础信息 + 认证方式 + aws-nuke 规则 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { accountsApi, systemApi } from '@/api/index.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'

const route = useRoute()
const router = useRouter()
const toast = useToastStore()

const isEdit = computed(() => Boolean(route.params.id))
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const resourceTypes = ref([])
const policy = ref({ organizationRoleName: 'OrganizationAccountAccessRole', assumeRoleSessionName: 'aws-nuke-platform', masterReady: false, masterProfile: 'nuke-operator' })

const form = ref({
  name: '',
  accountId: '',
  alias: '',
  environment: 'dev',
  description: '',
  defaultRegion: '',
  authMode: 'assume-role',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  profile: 'nuke-operator',
  // 组织跨账号：角色名（拼 ARN）或完整 ARN 二选一
  roleName: 'OrganizationAccountAccessRole',
  roleArn: '',
  externalId: '',
  sessionName: 'aws-nuke-platform',
  // 基础凭证：空 = 平台主账号凭证；填名称 = 复用本机 ~/.aws 中的纯凭证 profile
  baseProfile: '',
})

const profiles = ref([])

const regions = ref([])
const regionInput = ref('')
const excludes = ref(['S3Object'])
const excludeInput = ref('')
const groups = ref([{ resourceType: 'IAMRole', property: '', type: 'exact', patterns: '' }])

const REGION_PRESETS = [
  'global',
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-south-1',
  'cn-north-1',
  'cn-northwest-1',
]

const COMMON_EXCLUDES = ['S3Object', 'IAMUser', 'GuardDutyDetector', 'SecurityHub', 'CloudFormationStack']

const filterCount = computed(() =>
  groups.value.reduce((sum, group) => sum + group.patterns.split('\n').filter((line) => line.trim()).length, 0),
)

/** 组织模式下最终会使用的角色 ARN：手填优先，否则用角色名拼 */
const effectiveRoleArn = computed(() => {
  if (form.value.roleArn.trim()) return form.value.roleArn.trim()
  const accountId = form.value.accountId.trim() || '<账号ID>'
  return `arn:aws:iam::${accountId}:role/${form.value.roleName.trim() || 'OrganizationAccountAccessRole'}`
})

/** 可作基础凭证的 profile（config 里带 role_arn 的不能再当 base，会二次 AssumeRole） */
const usableProfiles = computed(() => profiles.value.filter((profile) => !profile.roleArn))
const roleProfiles = computed(() => profiles.value.filter((profile) => profile.roleArn))
const selectedBaseProfile = computed(() =>
  profiles.value.find((profile) => profile.name === form.value.baseProfile) || null,
)

function toggleRegion(region) {
  const index = regions.value.indexOf(region)
  if (index >= 0) regions.value.splice(index, 1)
  else regions.value.push(region)
}

function addRegion() {
  const value = regionInput.value.trim()
  if (!value) return
  if (!regions.value.includes(value)) regions.value.push(value)
  regionInput.value = ''
}

function toggleExclude(type) {
  const index = excludes.value.indexOf(type)
  if (index >= 0) excludes.value.splice(index, 1)
  else excludes.value.push(type)
}

function addExclude() {
  const value = excludeInput.value.trim()
  if (!value) return
  if (!excludes.value.includes(value)) excludes.value.push(value)
  excludeInput.value = ''
}

function addGroup() {
  groups.value.push({ resourceType: '', property: '', type: 'exact', patterns: '' })
}

function removeGroup(index) {
  groups.value.splice(index, 1)
}

function buildFilters() {
  const filters = {}
  for (const group of groups.value) {
    const type = group.resourceType.trim()
    if (!type) continue
    const patterns = group.patterns
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (!patterns.length) continue
    filters[type] = patterns.map((pattern) =>
      group.type === 'exact'
        ? pattern
        : { property: group.property.trim(), type: group.type, value: pattern },
    )
  }
  return filters
}

function validate() {
  if (!form.value.name.trim()) return '请填写账号名称'
  if (!isEdit.value && !/^\d{12}$/.test(form.value.accountId.trim())) return 'AWS 账号 ID 必须是 12 位数字'
  if (!regions.value.length) return '请至少选择一个扫描区域'
  // 默认区域允许留空；填了就必须是合法区域名，避免把非法值传进 AWS CLI / aws-nuke
  if (form.value.defaultRegion && !/^[a-z0-9-]{2,32}$/.test(form.value.defaultRegion.trim())) {
    return '默认区域格式不正确，例如 us-east-1；不需要可以留空'
  }
  if (form.value.authMode === 'aksk') {
    if (!isEdit.value && !form.value.accessKeyId.trim()) return '请填写 Access Key ID'
    if (!isEdit.value && !form.value.secretAccessKey.trim()) return '请填写 Secret Access Key'
  }
  if (form.value.authMode === 'profile' && !form.value.profile.trim()) return '请填写 AWS CLI profile 名称'
  if (form.value.authMode === 'assume-role') {
    if (!form.value.roleName.trim() && !form.value.roleArn.trim()) return '请填写组织角色名称或角色 ARN'
    if (!form.value.baseProfile && !policy.value.masterReady && !isEdit.value) {
      return '组织跨账号模式需要基础凭证：请先到「部署向导」配置主账号 AK/SK，或在下方选择本机 profile'
    }
  }
  return ''
}

async function save() {
  error.value = validate()
  if (error.value) return

  const payload = {
    name: form.value.name.trim(),
    alias: form.value.alias.trim(),
    environment: form.value.environment,
    description: form.value.description.trim(),
    defaultRegion: form.value.defaultRegion,
    authMode: form.value.authMode,
    profile: form.value.profile.trim(),
    roleName: form.value.roleName.trim(),
    roleArn: form.value.roleArn.trim(),
    externalId: form.value.externalId.trim(),
    sessionName: form.value.sessionName.trim(),
    baseProfile: form.value.authMode === 'assume-role' ? form.value.baseProfile : '',
    rules: {
      regions: regions.value,
      filters: buildFilters(),
      resourceTypes: { includes: [], excludes: excludes.value },
    },
  }
  if (!isEdit.value) payload.accountId = form.value.accountId.trim()
  if (form.value.accessKeyId.trim()) payload.accessKeyId = form.value.accessKeyId.trim()
  if (form.value.secretAccessKey.trim()) payload.secretAccessKey = form.value.secretAccessKey.trim()
  if (form.value.sessionToken.trim()) payload.sessionToken = form.value.sessionToken.trim()

  saving.value = true
  try {
    if (isEdit.value) {
      await accountsApi.update(route.params.id, payload)
      toast.success('账号已更新')
      router.push(`/accounts/${route.params.id}`)
    } else {
      const data = await accountsApi.create(payload)
      toast.success('账号已提交，配置已生成')
      router.push(`/accounts/${data.account.id}`)
    }
  } catch (err) {
    error.value = err.message
  } finally {
    saving.value = false
  }
}

async function loadAccount() {
  loading.value = true
  try {
    const { account } = await accountsApi.get(route.params.id)
    form.value = {
      name: account.name,
      accountId: account.accountId,
      alias: account.alias,
      environment: account.environment,
      description: account.description,
      defaultRegion: account.defaultRegion,
      authMode: account.authMode || 'assume-role',
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      profile: account.profile || 'nuke-operator',
      roleName: account.roleName || policy.value.organizationRoleName,
      roleArn: account.roleArn || '',
      externalId: account.externalId || '',
      sessionName: account.assumeRoleSessionName || policy.value.assumeRoleSessionName,
      baseProfile: account.baseProfile || '',
    }
    // 老账号若从未设置过区域，保持为空让用户自己选，不再预填默认区域
    regions.value = account.rules?.regions?.length ? [...account.rules.regions] : []
    excludes.value = account.rules?.resourceTypes?.excludes || []
    const filters = account.rules?.filters || {}
    groups.value = Object.entries(filters).map(([resourceType, rules]) => {
      const first = rules[0]
      const type = typeof first === 'string' ? 'exact' : first?.type || 'exact'
      const property = typeof first === 'object' ? first.property || '' : ''
      const patterns = rules
        .map((rule) => (typeof rule === 'string' ? rule : rule.value))
        .filter(Boolean)
        .join('\n')
      return { resourceType, property, type, patterns }
    })
    if (!groups.value.length) groups.value = [{ resourceType: 'IAMRole', property: '', type: 'exact', patterns: '' }]
  } catch (err) {
    toast.error(err.message)
    router.push('/accounts')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  try {
    const data = await systemApi.policy()
    policy.value = data
    if (!isEdit.value) {
      form.value.roleName = data.organizationRoleName || 'OrganizationAccountAccessRole'
      form.value.sessionName = data.assumeRoleSessionName || 'aws-nuke-platform'
      form.value.profile = data.masterProfile || 'nuke-operator'
      // 单账号直连模式下没有主账号凭证可用于 AssumeRole，默认选「账号 AK/SK」
      if (data.masterMode === 'standalone') form.value.authMode = 'aksk'
    }
  } catch {
    /* 策略读取失败不阻塞表单 */
  }
  if (isEdit.value) await loadAccount()
  try {
    const data = await systemApi.resourceTypes()
    resourceTypes.value = data.items
  } catch {
    /* 资源类型仅用于提示，失败可忽略 */
  }
  try {
    const data = await systemApi.profiles()
    profiles.value = data.items || []
  } catch {
    /* profile 列表仅用于辅助选择 */
  }
})
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <button class="back" type="button" @click="router.back()">
          <AppIcon name="arrow-left" :size="14" />返回
        </button>
        <h1 style="margin-top: 8px">{{ isEdit ? '编辑账号' : '提交 AWS 账号' }}</h1>
        <p class="sub">凭证将加密存储；配置规则会实时转换为 aws-nuke v3 的 YAML</p>
      </div>
      <div class="row">
        <button class="btn" type="button" @click="router.back()">取消</button>
        <button class="btn btn-primary" type="button" :disabled="saving || loading" @click="save">
          <span v-if="saving" class="spin" />
          <AppIcon v-else name="check" :size="14" />
          {{ saving ? '保存中...' : isEdit ? '保存修改' : '提交并生成配置' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="notice notice-danger">
      <AppIcon name="alert" :size="17" /><span>{{ error }}</span>
    </p>

    <div class="layout">
      <div class="stack">
        <!-- 基础信息 -->
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title"><span class="step">01</span><h3>基础信息</h3></div>
          </div>
          <div class="panel-body form-grid">
            <div class="field">
              <label>账号名称<span class="req">*</span></label>
              <input v-model="form.name" class="input" placeholder="例如：数据团队-开发沙箱" maxlength="60" />
            </div>
            <div class="field">
              <label>AWS 账号 ID<span class="req">*</span></label>
              <input
                v-model="form.accountId"
                class="input mono"
                placeholder="12 位数字，例如 123456789012"
                maxlength="12"
                :disabled="isEdit"
              />
              <span class="hint">{{ isEdit ? '账号 ID 创建后不可修改' : '请确认与目标账号一致，执行时会二次校验' }}</span>
            </div>
            <div class="field">
              <label>账号别名</label>
              <input v-model="form.alias" class="input" placeholder="可选。AWS 账号别名（alias）" maxlength="60" />
            </div>
            <div class="field">
              <label>环境类型</label>
              <select v-model="form.environment" class="select">
                <option value="dev">开发</option>
                <option value="test">测试</option>
                <option value="sandbox">沙箱</option>
                <option value="staging">预发</option>
                <option value="prod">生产</option>
              </select>
            </div>
            <div class="field">
              <label>默认区域（可选）</label>
              <input v-model="form.defaultRegion" class="input mono" placeholder="可选。留空表示不指定" />
              <span class="hint">
                仅用于初始化 AWS 鉴权会话（SDK / AssumeRole），不影响扫描区域；
                留空时沿用本机 AWS CLI 配置或环境变量中的区域。
              </span>
            </div>
            <div class="field">
              <label>用途说明</label>
              <input v-model="form.description" class="input" placeholder="可选。请输入用途说明，例如：每月清理一次的实验环境" maxlength="400" />
            </div>
          </div>
        </section>

        <!-- 认证方式 -->
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title"><span class="step">02</span><h3>凭证配置</h3></div>
            <span class="badge badge-cyan">AES-256-GCM 加密</span>
          </div>
          <div class="panel-body stack">
            <div class="auth-modes">
              <button
                type="button"
                class="auth-mode"
                :class="{ active: form.authMode === 'assume-role' }"
                @click="form.authMode = 'assume-role'"
              >
                <AppIcon name="layers" :size="16" />
                <div>
                  <strong>组织跨账号<span class="tag">推荐</span></strong>
                  <span>用主账号凭证 AssumeRole 进入子账号，不必保存子账号密钥</span>
                </div>
              </button>
              <button
                type="button"
                class="auth-mode"
                :class="{ active: form.authMode === 'aksk' }"
                @click="form.authMode = 'aksk'"
              >
                <AppIcon name="key" :size="16" />
                <div>
                  <strong>账号 AK/SK</strong>
                  <span>目标账号自己的 IAM 用户密钥，直连</span>
                </div>
              </button>
              <button
                type="button"
                class="auth-mode"
                :class="{ active: form.authMode === 'profile' }"
                @click="form.authMode = 'profile'"
              >
                <AppIcon name="file" :size="16" />
                <div>
                  <strong>CLI Profile</strong>
                  <span>复用本机 ~/.aws/credentials 中的 profile</span>
                </div>
              </button>
            </div>

            <template v-if="form.authMode === 'assume-role'">
              <div v-if="form.baseProfile" class="notice notice-info">
                <AppIcon name="layers" :size="16" />
                <div>
                  基础凭证使用本机 profile <code>{{ form.baseProfile }}</code>：执行时向 aws-nuke 传
                  <code>--profile</code> + <code>--assume-role-arn</code>，密钥仍留在你的 ~/.aws 中。
                </div>
              </div>
              <div v-else-if="policy.masterReady" class="notice notice-info">
                <AppIcon name="shield-check" :size="16" />
                <div>
                  基础凭证使用平台主账号 IAM 用户（CLI profile <code>{{ policy.masterProfile }}</code>），
                  先 <code>sts:AssumeRole</code> 再以子账号身份执行清理，全程不落地子账号密钥。
                </div>
              </div>
              <div v-else-if="policy.masterMode === 'standalone'" class="notice notice-warn">
                <AppIcon name="alert" :size="16" />
                <div>
                  当前是「单账号直连」模式，平台没有主账号凭证可用于 AssumeRole。
                  如需跨账号清理，请到「部署向导」切换为组织跨账号并保存主账号 AK/SK；
                  单账号清理请改用「账号 AK/SK」。
                </div>
              </div>
              <div v-else class="notice notice-warn">
                <AppIcon name="alert" :size="16" />
                <div>
                  尚未配置主账号凭证，组织跨账号模式无法执行。请先到「部署向导 → 主账号凭证与使用方式」完成配置，
                  或在下方选择本机已有的凭证 profile。
                </div>
              </div>

              <div class="form-grid">
                <div class="field">
                  <label>组织角色名称</label>
                  <input v-model="form.roleName" class="input mono" placeholder="OrganizationAccountAccessRole" />
                  <span class="hint">Organizations 创建成员账号时自动生成的角色</span>
                </div>
                <div class="field">
                  <label>Session 名称</label>
                  <input v-model="form.sessionName" class="input mono" placeholder="aws-nuke-platform" />
                  <span class="hint">会出现在 CloudTrail 的 assumed-role 会话标识中</span>
                </div>
                <div class="field" style="grid-column: 1 / -1">
                  <label>角色 ARN（可选，填写后优先于角色名）</label>
                  <input v-model="form.roleArn" class="input mono" :placeholder="effectiveRoleArn" />
                  <span class="hint">中国区等特殊分区请填完整 ARN；ARN 内的账号必须与上方账号 ID 一致</span>
                </div>
                <div class="field">
                  <label>External ID（可选）</label>
                  <input v-model="form.externalId" class="input mono" placeholder="可选。仅第三方跨账号角色需要填写" />
                </div>
              </div>

              <div class="field">
                <label>基础凭证来源</label>
                <select v-model="form.baseProfile" class="select mono">
                  <option value="">
                    平台主账号凭证{{ policy.masterReady ? `（profile ${policy.masterProfile}）` : '（尚未配置）' }}
                  </option>
                  <option v-for="profile in usableProfiles" :key="profile.name" :value="profile.name">
                    profile: {{ profile.name }}{{ profile.hasStaticKeys ? '' : ' · 无静态 AK/SK' }}
                  </option>
                </select>
                <span class="hint">
                  默认用部署向导里保存的主账号 AK/SK；也可以直接复用 ~/.aws 中只放密钥的 profile。
                </span>
                <span v-if="selectedBaseProfile && !selectedBaseProfile.hasStaticKeys" class="warn-inline">
                  该 profile 没有静态 AK/SK，若依赖 SSO / credential_process，aws-nuke 子进程可能取不到凭证。
                </span>
                <span v-if="roleProfiles.length" class="hint">
                  以下 profile 在 ~/.aws/config 中已配置 role_arn，不能当基础凭证（会二次 AssumeRole）：
                  <code v-for="profile in roleProfiles" :key="profile.name">{{ profile.name }}</code>
                </span>
              </div>

              <div class="protect-note">
                <AppIcon name="shield-check" :size="13" />
                <span>
                  生成配置时会自动追加保护规则：<code>IAMRole</code>、<code>IAMRolePolicy</code>、
                  <code>IAMRolePolicyAttachment</code>、<code>IAMInstanceProfile</code>（围绕
                  <code>{{ form.roleName || 'OrganizationAccountAccessRole' }}</code>），
                  避免清理过程中把正在用于认证的角色删掉。
                </span>
              </div>

              <div class="arn-preview">
                <span class="small text-muted">实际调用链</span>
                <code class="mono">主账号凭证 → sts:AssumeRole → {{ effectiveRoleArn }}</code>
              </div>

              <details class="policy-help">
                <summary>需要满足的权限前提</summary>
                <ul>
                  <li>主账号 IAM 用户需具备 <code>sts:AssumeRole</code> 权限（可限定到该角色 ARN）。</li>
                  <li>
                    子账号角色 <code>{{ form.roleName || 'OrganizationAccountAccessRole' }}</code> 的信任策略需允许主账号主体，
                    Organizations 默认信任管理账号 root，只要该 IAM 用户有 AssumeRole 权限即可。
                  </li>
                  <li>若角色附加了 MFA 条件，本平台无法代填动态验证码，需为自动化用户放宽该条件。</li>
                </ul>
              </details>
            </template>

            <template v-else-if="form.authMode === 'aksk'">
              <div class="form-grid">
                <div class="field">
                  <label>Access Key ID<span class="req" v-if="!isEdit">*</span></label>
                  <input
                    v-model="form.accessKeyId"
                    class="input mono"
                    placeholder="AKIA..."
                    autocomplete="off"
                  />
                </div>
                <div class="field">
                  <label>Secret Access Key<span class="req" v-if="!isEdit">*</span></label>
                  <input
                    v-model="form.secretAccessKey"
                    class="input mono"
                    type="password"
                    placeholder="••••••••"
                    autocomplete="new-password"
                  />
                </div>
                <div class="field">
                  <label>Session Token</label>
                  <input
                    v-model="form.sessionToken"
                    class="input mono"
                    placeholder="可选。仅使用临时凭证时填写"
                    autocomplete="off"
                  />
                </div>
              </div>
              <p v-if="isEdit" class="hint">留空表示保留已保存的密钥</p>
            </template>

            <div v-else class="form-grid">
              <div class="field">
                <label>Profile 名称<span class="req">*</span></label>
                <input v-model="form.profile" class="input mono" placeholder="nuke-operator" />
                <span class="hint">需已通过 aws configure --profile 名称 配置</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 过滤规则 -->
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title"><span class="step">03</span><h3>保护规则</h3></div>
            <span class="badge badge-muted">{{ filterCount }} 条过滤 · {{ excludes.length }} 类排除</span>
          </div>
          <div class="panel-body stack">
            <div class="field">
              <label>扫描区域</label>
              <div class="chips">
                <button
                  v-for="region in REGION_PRESETS"
                  :key="region"
                  type="button"
                  class="chip"
                  :class="{ on: regions.includes(region) }"
                  @click="toggleRegion(region)"
                >
                  <AppIcon v-if="regions.includes(region)" name="check" :size="11" />
                  {{ region }}
                </button>
              </div>
              <div class="row" style="margin-top: 8px">
                <input
                  v-model="regionInput"
                  class="input mono"
                  placeholder="添加其它区域，例如 eu-west-2"
                  style="max-width: 240px"
                  @keyup.enter="addRegion"
                />
                <button class="btn btn-sm" type="button" @click="addRegion">添加</button>
              </div>
              <span class="hint">不会预填任何区域，请按实际清理范围选择；<code>global</code> 表示 IAM/CloudFront 等全局资源</span>
            </div>

            <div class="field">
              <label>资源类型排除</label>
              <div class="chips">
                <button
                  v-for="type in COMMON_EXCLUDES"
                  :key="type"
                  type="button"
                  class="chip"
                  :class="{ on: excludes.includes(type) }"
                  @click="toggleExclude(type)"
                >
                  {{ type }}
                </button>
              </div>
              <div class="chips" v-if="excludes.filter((t) => !COMMON_EXCLUDES.includes(t)).length">
                <span
                  v-for="type in excludes.filter((t) => !COMMON_EXCLUDES.includes(t))"
                  :key="type"
                  class="chip on"
                >
                  {{ type }}
                  <button type="button" class="chip-x" @click="toggleExclude(type)">
                    <AppIcon name="close" :size="10" />
                  </button>
                </span>
              </div>
              <div class="row" style="margin-top: 8px">
                <input
                  v-model="excludeInput"
                  class="input mono"
                  placeholder="添加资源类型，例如 IAMUser"
                  style="max-width: 240px"
                  @keyup.enter="addExclude"
                />
                <button class="btn btn-sm" type="button" @click="addExclude">添加</button>
              </div>
            </div>

            <div class="field">
              <div class="row-between">
                <label>保留资源过滤</label>
                <button class="btn btn-ghost btn-sm" type="button" @click="addGroup">
                  <AppIcon name="plus" :size="13" />新增规则组
                </button>
              </div>
              <p class="hint">命中过滤条件的资源不会被删除，例如保留管理员角色、带特定标签的桶</p>

              <div v-for="(group, index) in groups" :key="index" class="rule-card">
                <div class="rule-head">
                  <input
                    v-model="group.resourceType"
                    class="input mono"
                    list="resource-type-list"
                    placeholder="资源类型，例如 IAMRole"
                  />
                  <select v-model="group.type" class="select" style="width: 132px">
                    <option value="exact">精确匹配</option>
                    <option value="contains">包含</option>
                    <option value="glob">通配符</option>
                    <option value="regex">正则</option>
                  </select>
                  <button class="icon-btn danger" type="button" @click="removeGroup(index)">
                    <AppIcon name="trash" :size="14" />
                  </button>
                </div>
                <input
                  v-if="group.type !== 'exact'"
                  v-model="group.property"
                  class="input mono"
                  placeholder="匹配字段（可选），例如 tag:Environment"
                />
                <textarea
                  v-model="group.patterns"
                  class="textarea mono"
                  rows="3"
                  placeholder="每行一个匹配值，例如：OrganizationAccountAccessRole"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      <aside class="stack aside">
        <section class="panel panel-pad">
          <h3 class="aside-title"><AppIcon name="info" :size="15" />生成说明</h3>
          <ul class="tips">
            <li>区域与过滤规则会写入 aws-nuke 配置文件的 <code>regions</code> 与 <code>accounts</code> 段。</li>
            <li><code>S3Object</code> 建议保持排除，由桶删除过程一并处理，速度更快。</li>
            <li>生产账号建议至少保留组织访问角色，避免失联。</li>
            <li>平台会在每次执行前重新生成配置，无需手动维护 YAML。</li>
          </ul>
        </section>

        <section class="panel panel-pad">
          <h3 class="aside-title"><AppIcon name="shield" :size="15" />执行前检查</h3>
          <ul class="checks">
            <li><AppIcon name="check" :size="13" />账号 ID 与实际一致</li>
            <li><AppIcon name="check" :size="13" />IAM 用户具备删除权限</li>
            <li><AppIcon name="check" :size="13" />已完成资源备份</li>
            <li><AppIcon name="check" :size="13" />先执行演练再删除</li>
          </ul>
        </section>
      </aside>
    </div>

    <datalist id="resource-type-list">
      <option v-for="type in resourceTypes" :key="type" :value="type" />
    </datalist>
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
}
.back:hover {
  color: var(--accent);
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

.step {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: rgba(34, 211, 238, 0.12);
  border: 1px solid rgba(34, 211, 238, 0.24);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.form-grid .field:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.auth-modes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}
.auth-mode {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.6);
  color: var(--text-dim);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s var(--ease);
}
.auth-mode:hover {
  border-color: var(--border-strong);
}
.auth-mode.active {
  border-color: rgba(34, 211, 238, 0.45);
  background: rgba(34, 211, 238, 0.08);
  color: var(--text);
}
.auth-mode strong {
  display: block;
  font-size: 12.5px;
  color: var(--text);
}
.auth-mode span {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
.tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(52, 211, 153, 0.16);
  color: #7ff0c4;
  font-size: 10px;
  font-weight: 500;
  vertical-align: 1px;
}
.arn-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px dashed var(--border);
  background: rgba(34, 211, 238, 0.04);
  overflow-x: auto;
}
.warn-inline {
  font-size: 11.5px;
  color: var(--warning);
}
.protect-note {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 9px 11px;
  border-radius: var(--radius);
  border: 1px solid rgba(52, 211, 153, 0.22);
  background: rgba(52, 211, 153, 0.05);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-muted);
}
.protect-note svg {
  color: var(--success);
  flex: none;
  margin-top: 2px;
}
.protect-note code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  color: var(--text-dim);
  font-size: 10.5px;
}
.arn-preview code {
  font-size: 11.5px;
  color: #9beeff;
  white-space: nowrap;
}
.policy-help {
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(120, 170, 210, 0.04);
}
.policy-help summary {
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
.policy-help ul {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.85;
  color: var(--text-muted);
}
.policy-help code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  color: var(--text-dim);
  font-size: 11px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.7);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.18s var(--ease);
}
.chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.chip.on {
  border-color: rgba(34, 211, 238, 0.4);
  background: rgba(34, 211, 238, 0.1);
  color: #9beeff;
}
.chip-x {
  display: grid;
  place-items: center;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  opacity: 0.7;
}
.chip-x:hover {
  opacity: 1;
}

.rule-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding: 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.5);
}
.rule-head {
  display: flex;
  gap: 8px;
}
.icon-btn.danger:hover {
  background: rgba(244, 63, 94, 0.12);
  color: #ff8fa3;
}

.aside {
  position: sticky;
  top: calc(var(--header-h) + 20px);
}
.aside-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 12px;
  color: var(--text-dim);
}
.tips {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.85;
  color: var(--text-muted);
}
.tips code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  font-size: 11px;
  color: var(--text-dim);
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--text-muted);
}
.checks li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.checks svg {
  color: var(--success);
}

@media (max-width: 1080px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .aside {
    position: static;
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
