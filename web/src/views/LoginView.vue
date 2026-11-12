<script setup>
/** 登录页：单卡居中，背景即全局壁纸（App.vue 提供），本页不再叠任何背景层 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'

const auth = useAuthStore()
const toast = useToastStore()
const router = useRouter()
const route = useRoute()

const form = ref({ username: '', password: '' })
const showPassword = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  if (!form.value.username || !form.value.password) {
    error.value = '请输入用户名与密码'
    return
  }
  try {
    const user = await auth.login(form.value.username.trim(), form.value.password)
    toast.success(`欢迎回来，${user.displayName || user.username}`)
    router.push(route.query.redirect || '/')
  } catch (err) {
    error.value = err.message || '登录失败'
  }
}
</script>

<template>
  <div class="login">
    <div class="login-card fade-up">
      <div class="brand">
        <img src="/logo.png" alt="平台 Logo" class="brand-logo" />
        <div class="brand-text">
          <strong>AWS Nuke 管理平台</strong>
          <span>MULTI-ACCOUNT RESOURCE PURGE</span>
        </div>
      </div>

      <div class="form-head">
        <h2>登录控制台</h2>
        <p>请使用平台账号登录，操作将被记录至审计日志</p>
      </div>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="username">用户名</label>
          <div class="input-icon">
            <span class="icon-slot"><AppIcon name="user" :size="15" /></span>
            <input
              id="username"
              v-model="form.username"
              class="input"
              autocomplete="username"
              placeholder="请输入用户名"
              autofocus
            />
          </div>
        </div>

        <div class="field">
          <label for="password">密码</label>
          <div class="input-icon">
            <span class="icon-slot"><AppIcon name="lock" :size="15" /></span>
            <input
              id="password"
              v-model="form.password"
              class="input"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="请输入密码"
              style="padding-right: 38px"
            />
            <button class="peek" type="button" @click="showPassword = !showPassword">
              <AppIcon :name="showPassword ? 'eye-off' : 'eye'" :size="15" />
            </button>
          </div>
        </div>

        <p v-if="error" class="form-error">
          <AppIcon name="alert" :size="14" />
          <span>{{ error }}</span>
        </p>

        <button class="btn btn-primary btn-lg btn-block" type="submit" :disabled="auth.loading">
          <span v-if="auth.loading" class="spin" />
          <span>{{ auth.loading ? '正在验证...' : '进入控制台' }}</span>
          <AppIcon v-if="!auth.loading" name="right" :size="15" />
        </button>
      </form>

      <div class="hint-box">
        <div class="hint-title"><AppIcon name="info" :size="13" />首次部署提示</div>
        <p>初始管理员账号为 <code>admin</code>，初始密码 <code>Admin@123456</code>，登录后请立即在「个人信息」中修改。</p>
      </div>
    </div>

    <p class="copyright">AWS Nuke Platform · v1.0.0 · 基于 ekristen/aws-nuke</p>
  </div>
</template>

<style scoped>
/* 整页只依赖 App.vue 的全局壁纸，这里不再有任何背景层 */
.login {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  min-height: 100vh;
  padding: 40px 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 30px 30px 26px;
  border-radius: 20px;
  border: 1px solid rgba(150, 190, 225, 0.24);
  /* 毛玻璃：低透明度底 + 背景模糊，壁纸清晰透出 */
  background: linear-gradient(180deg, rgba(16, 26, 42, 0.42), rgba(9, 15, 25, 0.46));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px) saturate(1.15);
  -webkit-backdrop-filter: blur(18px) saturate(1.15);
}
.login-card::before {
  content: '';
  position: absolute;
  inset: 0 22% auto 22%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: 0.7;
}

/* 品牌行 */
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 22px;
  margin-bottom: 22px;
  border-bottom: 1px solid rgba(120, 170, 210, 0.14);
}
.brand-logo {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid rgba(120, 170, 210, 0.22);
  background: rgba(10, 18, 30, 0.75);
  transform: translateZ(0);
}
.brand-text strong {
  display: block;
  font-size: 15px;
}
.brand-text span {
  font-size: 9.5px;
  letter-spacing: 0.22em;
  color: var(--text-faint);
}

.form-head {
  margin-bottom: 24px;
}
.form-head h2 {
  font-size: 22px;
}
.form-head p {
  margin-top: 7px;
  font-size: 12.5px;
  color: var(--text-muted);
}

form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.peek {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}
.peek:hover {
  color: var(--text);
}
form .btn {
  margin-top: 6px;
}
.form-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(244, 63, 94, 0.32);
  background: rgba(244, 63, 94, 0.1);
  font-size: 12px;
  color: #ffb3c1;
}

.hint-box {
  margin-top: 24px;
  padding: 13px 15px;
  border-radius: 10px;
  border: 1px dashed rgba(34, 211, 238, 0.26);
  background: rgba(34, 211, 238, 0.04);
}
.hint-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--accent);
  margin-bottom: 6px;
}
.hint-box p {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-muted);
}
.hint-box code {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(120, 170, 210, 0.12);
  color: var(--text-dim);
  font-size: 11px;
}

.copyright {
  font-size: 10.5px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.6);
}
</style>
