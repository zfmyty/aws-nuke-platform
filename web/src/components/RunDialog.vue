<script setup>
/** 执行对话框：演练 / 真实删除二选一，真实删除需精确输入账号 ID */
import { computed, ref } from 'vue'
import { accountsApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useToastStore } from '@/stores/toast.js'
import AppModal from './AppModal.vue'
import AppIcon from './AppIcon.vue'
import { authModeLabel } from '@/utils/format.js'

const props = defineProps({
  account: { type: Object, required: true },
  allowLive: { type: Boolean, default: true },
})
const emit = defineEmits(['close', 'started'])

const auth = useAuthStore()
const toast = useToastStore()

const mode = ref('dry')
const confirmMode = ref('direct')
const confirmText = ref('')
const submitting = ref(false)
const error = ref('')

const liveEnabled = computed(() => props.allowLive && (auth.isAdmin || props.allowLive))
const canSubmit = computed(() => {
  if (submitting.value) return false
  if (mode.value === 'live') return confirmText.value.trim() === props.account.accountId
  return true
})

async function submit() {
  error.value = ''
  if (mode.value === 'live' && confirmText.value.trim() !== props.account.accountId) {
    error.value = '账号 ID 不匹配，请重新输入'
    return
  }
  submitting.value = true
  try {
    const data = await accountsApi.run(props.account.id, {
      mode: mode.value,
      confirmText: confirmText.value.trim(),
      confirmMode: mode.value === 'live' ? confirmMode.value : 'direct',
    })
    toast.success(mode.value === 'live' ? '删除任务已启动' : '演练任务已启动')
    emit('started', data.job)
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AppModal
    title="执行 aws-nuke"
    :subtitle="`${account.name} · ${account.accountId}`"
    @close="emit('close')"
  >
    <div class="stack">
      <div class="modes">
        <button
          type="button"
          class="mode"
          :class="{ active: mode === 'dry' }"
          @click="mode = 'dry'"
        >
          <span class="mode-icon safe"><AppIcon name="play" :size="16" /></span>
          <div>
            <strong>演练模式</strong>
            <p>只扫描并列出将被删除的资源，不产生任何删除动作</p>
          </div>
          <AppIcon v-if="mode === 'dry'" name="check" :size="16" class="check" />
        </button>

        <button
          type="button"
          class="mode"
          :class="{ active: mode === 'live', disabled: !liveEnabled }"
          :disabled="!liveEnabled"
          @click="mode = 'live'"
        >
          <span class="mode-icon danger"><AppIcon name="zap" :size="16" /></span>
          <div>
            <strong>真实删除</strong>
            <p v-if="liveEnabled">按配置实际删除资源，不可撤销，请先完成演练</p>
            <p v-else>管理员已关闭真实删除权限</p>
          </div>
          <AppIcon v-if="mode === 'live'" name="check" :size="16" class="check" />
        </button>
      </div>

      <div v-if="mode === 'live'" class="notice notice-danger">
        <AppIcon name="alert" :size="17" />
        <div>
          <strong>高风险操作</strong>：将真实删除该账号下所有未被过滤的 AWS 资源。请确认已执行演练、核对过滤规则，并已完成数据备份。
        </div>
      </div>

      <div v-if="mode === 'live'" class="field">
        <label>输入账号 ID 以确认 <span class="mono text-muted">({{ account.accountId }})</span></label>
        <input
          v-model="confirmText"
          class="input mono"
          placeholder="请输入 12 位账号 ID"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div v-if="mode === 'live'" class="field">
        <label>执行方式</label>
        <div class="ways">
          <button
            type="button"
            class="way"
            :class="{ active: confirmMode === 'direct' }"
            @click="confirmMode = 'direct'"
          >
            <span class="way-icon"><AppIcon name="zap" :size="15" /></span>
            <div>
              <strong>直接执行</strong>
              <p>与原行为一致：启动后自动完成扫描与删除，适合无人值守</p>
            </div>
          </button>
          <button
            type="button"
            class="way"
            :class="{ active: confirmMode === 'confirm', disabled: !account.alias }"
            :disabled="!account.alias"
            @click="confirmMode = 'confirm'"
          >
            <span class="way-icon safe"><AppIcon name="shield-check" :size="15" /></span>
            <div>
              <strong>扫描后确认<span class="beta-tag">测试</span></strong>
              <p>{{ account.alias
                ? '扫描完成后暂停并展示可删除资源清单，输入账号别名确认后才开始删除（限时确认，超时自动中止）'
                : '需要该账号已设置 AWS 别名（可在账号详情页创建）' }}</p>
            </div>
          </button>
        </div>
      </div>

      <div class="meta">
        <div>
          <span>认证方式</span>
          <strong>{{ authModeLabel(account.authMode) }}</strong>
        </div>
        <div>
          <span>区域</span>
          <strong class="mono">{{ (account.rules?.regions || []).length || 0 }} 个</strong>
        </div>
        <div>
          <span>过滤规则</span>
          <strong>{{ Object.keys(account.rules?.filters || {}).length }} 类</strong>
        </div>
      </div>

      <p v-if="account.authMode === 'assume-role'" class="chain-hint">
        <AppIcon name="layers" :size="13" />
        <span>主账号凭证 → <code class="mono">{{ account.roleArn }}</code></span>
      </p>

      <p v-if="error" class="form-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">取消</button>
      <button
        class="btn"
        :class="mode === 'live' ? 'btn-danger' : 'btn-primary'"
        type="button"
        :disabled="!canSubmit"
        @click="submit"
      >
        <span v-if="submitting" class="spin" />
        <AppIcon v-else :name="mode === 'live' ? 'zap' : 'play'" :size="14" />
        {{ submitting ? '启动中...' : mode === 'live' ? '确认执行删除' : '开始演练' }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.modes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mode {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.6);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s var(--ease);
}
.mode:hover:not(.disabled) {
  border-color: var(--border-strong);
}
.mode.active {
  border-color: rgba(34, 211, 238, 0.42);
  background: rgba(34, 211, 238, 0.07);
}
.mode.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.mode strong {
  display: block;
  font-size: 13px;
}
.mode p {
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-muted);
}
.mode .check {
  margin-left: auto;
  color: var(--accent);
  flex: none;
}
.mode-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 9px;
  border: 1px solid var(--border);
}
.mode-icon.safe {
  color: var(--accent);
  background: rgba(34, 211, 238, 0.1);
}
.mode-icon.danger {
  color: #ff8fa3;
  background: rgba(244, 63, 94, 0.12);
  border-color: rgba(244, 63, 94, 0.28);
}
.meta {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: rgba(120, 170, 210, 0.05);
  border: 1px solid var(--border);
}
.meta span {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
}
.chain-hint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-muted);
}
.chain-hint code {
  color: #9beeff;
  font-size: 11px;
  word-break: break-all;
}
.meta strong {
  display: block;
  margin-top: 3px;
  font-size: 12.5px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.field label {
  font-size: 12px;
  color: var(--text-muted);
}
.ways {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.way {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: rgba(9, 16, 27, 0.6);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s var(--ease);
}
.way:hover:not(.disabled) {
  border-color: var(--border-strong);
}
.way.active {
  border-color: rgba(34, 211, 238, 0.42);
  background: rgba(34, 211, 238, 0.07);
}
.way.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.way strong {
  display: block;
  font-size: 12.5px;
}
.way p {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted);
}
.way-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 8px;
  border: 1px solid rgba(244, 63, 94, 0.28);
  background: rgba(244, 63, 94, 0.12);
  color: #ff8fa3;
}
.way-icon.safe {
  border-color: rgba(34, 211, 238, 0.3);
  background: rgba(34, 211, 238, 0.1);
  color: var(--accent);
}
.beta-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(250, 199, 117, 0.4);
  background: rgba(250, 199, 117, 0.12);
  color: #fac775;
  font-size: 10px;
  line-height: 1.4;
  vertical-align: 1px;
}
.form-error {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(244, 63, 94, 0.32);
  background: rgba(244, 63, 94, 0.1);
  font-size: 12px;
  color: #ffb3c1;
}
</style>
