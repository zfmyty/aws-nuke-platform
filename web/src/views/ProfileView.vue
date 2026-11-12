<script setup>
/** 个人信息与密码修改 */
import { onMounted, ref } from 'vue'
import { authApi, systemApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useSystemStore } from '@/stores/system.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import { formatTime } from '@/utils/format.js'

const auth = useAuthStore()
const system = useSystemStore()
const toast = useToastStore()

const form = ref({ oldPassword: '', newPassword: '', confirm: '' })
const saving = ref(false)
const error = ref('')

/* 界面偏好（仅管理员，全局生效）：任务中心轮询间隔 + 健康检查间隔 */
const pollSeconds = ref(12)
const healthSeconds = ref(10)
const savingPrefs = ref(false)

async function loadPreferences() {
  if (!auth.isAdmin) return
  try {
    const data = await systemApi.settings()
    pollSeconds.value = Number(data.settings.jobPollIntervalSeconds) || 12
    healthSeconds.value = Number(data.settings.healthPollIntervalSeconds) || 10
  } catch {
    /* 读取失败保持默认 */
  }
}

async function savePreferences() {
  savingPrefs.value = true
  try {
    await systemApi.updateSettings({
      jobPollIntervalSeconds: Number(pollSeconds.value),
      healthPollIntervalSeconds: Number(healthSeconds.value),
    })
    system.setPollInterval(pollSeconds.value)
    system.setHealthInterval(healthSeconds.value)
    toast.success('界面偏好已保存，对所有用户生效')
  } catch (err) {
    toast.error(err.message)
  } finally {
    savingPrefs.value = false
  }
}

async function submit() {
  error.value = ''
  if (!form.value.oldPassword || !form.value.newPassword) {
    error.value = '请填写完整'
    return
  }
  if (form.value.newPassword !== form.value.confirm) {
    error.value = '两次输入的新密码不一致'
    return
  }
  saving.value = true
  try {
    await authApi.changePassword({
      oldPassword: form.value.oldPassword,
      newPassword: form.value.newPassword,
    })
    toast.success('密码已更新，请牢记新密码')
    form.value = { oldPassword: '', newPassword: '', confirm: '' }
  } catch (err) {
    error.value = err.message
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadPreferences()
})
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>个人信息</h1>
        <p class="sub">账号资料与登录安全</p>
      </div>
    </div>

    <div class="grid">
      <section class="panel panel-pad">
        <div class="profile-head">
          <div class="avatar-lg">{{ auth.initials }}</div>
          <div>
            <h2>{{ auth.displayName }}</h2>
            <p class="mono small text-muted">@{{ auth.user?.username }}</p>
            <span class="badge" :class="auth.isAdmin ? 'badge-violet' : 'badge-muted'" style="margin-top: 8px">
              <AppIcon :name="auth.isAdmin ? 'shield-check' : 'user'" :size="11" />
              {{ auth.isAdmin ? '管理员' : '普通用户' }}
            </span>
          </div>
        </div>

        <dl class="kv" style="margin-top: 22px">
          <dt>数据权限</dt>
          <dd>{{ auth.isAdmin ? '全平台账号、任务与用户' : '仅本人提交的账号与任务' }}</dd>
          <dt>创建时间</dt>
          <dd>{{ formatTime(auth.user?.createdAt) }}</dd>
          <dt>最近登录</dt>
          <dd>{{ formatTime(auth.user?.lastLoginAt) }}</dd>
        </dl>
      </section>

      <section v-if="auth.isAdmin" class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="sliders" :size="15" style="color: var(--accent)" /><h3>界面偏好</h3></div>
        </div>
        <div class="panel-body stack">
          <div class="field">
            <label>任务中心刷新间隔（秒）</label>
            <input v-model.number="pollSeconds" class="input" type="number" min="3" max="60" step="1" />
            <span class="hint">
              全平台统一值：任务中心列表向后端检查更新的频率，范围 3-60 秒，默认 12 秒，
              对所有用户（含普通用户）生效。单个任务的实时日志不受此设置影响（由页面直连推送）。
            </span>
          </div>
          <div class="field">
            <label>服务状态检查间隔（秒）</label>
            <input v-model.number="healthSeconds" class="input" type="number" min="3" max="120" step="1" />
            <span class="hint">
              全平台统一值：顶栏「服务在线/离线」指示灯向后端发起健康检查的频率，
              范围 3-120 秒，默认 10 秒。调小指示灯更灵敏，调大更省请求。
            </span>
          </div>
          <button class="btn btn-primary" type="button" :disabled="savingPrefs" @click="savePreferences">
            <span v-if="savingPrefs" class="spin" />
            <AppIcon v-else name="check" :size="14" />
            {{ savingPrefs ? '保存中...' : '保存偏好' }}
          </button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><AppIcon name="lock" :size="15" style="color: var(--accent)" /><h3>修改密码</h3></div>
        </div>
        <div class="panel-body stack">
          <div class="field">
            <label>当前密码</label>
            <input v-model="form.oldPassword" class="input" type="password" autocomplete="current-password" />
          </div>
          <div class="field">
            <label>新密码</label>
            <input v-model="form.newPassword" class="input" type="password" autocomplete="new-password" />
            <span class="hint">至少 8 位，需同时包含字母与数字</span>
          </div>
          <div class="field">
            <label>确认新密码</label>
            <input v-model="form.confirm" class="input" type="password" autocomplete="new-password" />
          </div>
          <p v-if="error" class="notice notice-danger">{{ error }}</p>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="submit">
            <span v-if="saving" class="spin" />
            <AppIcon v-else name="check" :size="14" />
            {{ saving ? '更新中...' : '更新密码' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.profile-head {
  display: flex;
  align-items: center;
  gap: 16px;
}
.avatar-lg {
  display: grid;
  place-items: center;
  width: 62px;
  height: 62px;
  border-radius: 18px;
  font-size: 24px;
  font-weight: 600;
  color: #04121a;
  background: linear-gradient(135deg, #67e8f9, #a78bfa);
  box-shadow: var(--glow-cyan);
}
.profile-head h2 {
  font-size: 18px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
