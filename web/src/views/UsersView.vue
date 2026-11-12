<script setup>
/** 用户管理（管理员）：创建、编辑、禁用与删除 */
import { computed, onMounted, ref } from 'vue'
import { usersApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import AppModal from '@/components/AppModal.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import { formatTime, timeAgo } from '@/utils/format.js'

const auth = useAuthStore()
const toast = useToastStore()

const users = ref([])
const loading = ref(true)
const search = ref('')

const editor = ref(null)
const editorMode = ref('create')
const form = ref({ username: '', password: '', displayName: '', role: 'user' })
const saving = ref(false)
const error = ref('')
const deleteTarget = ref(null)

const visible = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return users.value
  return users.value.filter((user) =>
    [user.username, user.displayName, user.email].join(' ').toLowerCase().includes(kw),
  )
})

const adminCount = computed(() => users.value.filter((user) => user.role === 'admin').length)

async function load() {
  loading.value = true
  try {
    const data = await usersApi.list()
    users.value = data.items
  } catch (err) {
    toast.error(err.message)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editorMode.value = 'create'
  form.value = { username: '', password: '', displayName: '', role: 'user' }
  error.value = ''
  editor.value = {}
}

function openEdit(user) {
  editorMode.value = 'edit'
  form.value = { username: user.username, password: '', displayName: user.displayName, role: user.role, id: user.id }
  error.value = ''
  editor.value = user
}

async function save() {
  error.value = ''
  saving.value = true
  try {
    if (editorMode.value === 'create') {
      if (!form.value.username.trim() || !form.value.password) {
        error.value = '请填写用户名与密码'
        return
      }
      await usersApi.create({
        username: form.value.username.trim(),
        password: form.value.password,
        displayName: form.value.displayName.trim() || form.value.username.trim(),
        role: form.value.role,
      })
      toast.success('用户已创建')
    } else {
      const payload = { displayName: form.value.displayName.trim(), role: form.value.role }
      if (form.value.password) payload.password = form.value.password
      await usersApi.update(editor.value.id, payload)
      toast.success('用户已更新')
    }
    editor.value = null
    await load()
  } catch (err) {
    error.value = err.message
  } finally {
    saving.value = false
  }
}

async function toggleStatus(user) {
  try {
    await usersApi.update(user.id, { status: user.status === 'active' ? 'disabled' : 'active' })
    toast.info(user.status === 'active' ? '已禁用该账号' : '已启用该账号')
    await load()
  } catch (err) {
    toast.error(err.message)
  }
}

async function confirmDelete() {
  try {
    await usersApi.remove(deleteTarget.value.id)
    toast.success('用户已删除')
    deleteTarget.value = null
    await load()
  } catch (err) {
    toast.error(err.message)
  }
}

onMounted(load)
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>用户管理</h1>
        <p class="sub">管理员可管理全平台账号；普通用户仅能查看与操作自己的 AWS 账号</p>
      </div>
      <div class="row">
        <button class="btn btn-sm" type="button" @click="load"><AppIcon name="refresh" :size="14" />刷新</button>
        <button class="btn btn-primary btn-sm" type="button" @click="openCreate">
          <AppIcon name="plus" :size="14" />新建用户
        </button>
      </div>
    </div>

    <div class="summary">
      <span><strong>{{ users.length }}</strong> 个账号</span>
      <i />
      <span><strong>{{ adminCount }}</strong> 名管理员</span>
      <i />
      <span><strong>{{ users.filter((u) => u.status === 'disabled').length }}</strong> 个已禁用</span>
    </div>

    <section class="panel">
      <div class="toolbar">
        <div class="input-icon" style="flex: 1; max-width: 320px">
          <span class="icon-slot"><AppIcon name="search" :size="15" /></span>
          <input v-model="search" class="input" placeholder="搜索用户名 / 昵称" />
        </div>
      </div>

      <div v-if="loading" class="panel-body stack">
        <div v-for="i in 3" :key="i" class="skeleton" style="height: 30px" />
      </div>

      <AppEmpty v-else-if="!visible.length" icon="users" title="没有匹配的用户" />

      <div v-else class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>状态</th>
              <th>最近登录</th>
              <th>创建时间</th>
              <th style="text-align: right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in visible" :key="user.id">
              <td>
                <div class="user-cell">
                  <span class="avatar">{{ (user.displayName || user.username).slice(0, 1).toUpperCase() }}</span>
                  <div>
                    <div class="name">{{ user.displayName }}</div>
                    <div class="small text-muted mono">@{{ user.username }}</div>
                  </div>
                </div>
              </td>
              <td>
                <span class="badge" :class="user.role === 'admin' ? 'badge-violet' : 'badge-muted'">
                  <AppIcon :name="user.role === 'admin' ? 'shield-check' : 'user'" :size="11" />
                  {{ user.role === 'admin' ? '管理员' : '普通用户' }}
                </span>
              </td>
              <td>
                <span class="badge" :class="user.status === 'active' ? 'badge-green' : 'badge-red'">
                  {{ user.status === 'active' ? '正常' : '已禁用' }}
                </span>
              </td>
              <td class="small text-muted">{{ user.lastLoginAt ? timeAgo(user.lastLoginAt) : '从未登录' }}</td>
              <td class="small text-muted">{{ formatTime(user.createdAt) }}</td>
              <td>
                <div class="cell-actions">
                  <button class="icon-btn" type="button" title="编辑" @click="openEdit(user)">
                    <AppIcon name="edit" :size="15" />
                  </button>
                  <button
                    v-if="user.id !== auth.user.id"
                    class="icon-btn"
                    type="button"
                    :title="user.status === 'active' ? '禁用' : '启用'"
                    @click="toggleStatus(user)"
                  >
                    <AppIcon :name="user.status === 'active' ? 'lock' : 'check'" :size="15" />
                  </button>
                  <button
                    v-if="user.id !== auth.user.id"
                    class="icon-btn danger"
                    type="button"
                    title="删除"
                    @click="deleteTarget = user"
                  >
                    <AppIcon name="trash" :size="15" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <AppModal
      v-if="editor"
      :title="editorMode === 'create' ? '新建用户' : '编辑用户'"
      :subtitle="editorMode === 'create' ? '新用户将拥有独立的数据空间' : `@${form.username}`"
      @close="editor = null"
    >
      <div class="stack">
        <div v-if="editorMode === 'create'" class="field">
          <label>用户名<span class="req">*</span></label>
          <input v-model="form.username" class="input mono" placeholder="3-32 位字母数字，例如 zhangsan" />
        </div>
        <div class="field">
          <label>显示名称</label>
          <input v-model="form.displayName" class="input" placeholder="用于界面展示" />
        </div>
        <div class="field">
          <label>{{ editorMode === 'create' ? '初始密码' : '重置密码' }}<span v-if="editorMode === 'create'" class="req">*</span></label>
          <input
            v-model="form.password"
            class="input mono"
            type="text"
            :placeholder="editorMode === 'create' ? '至少 8 位，含字母与数字' : '留空表示不修改'"
          />
        </div>
        <div class="field">
          <label>角色</label>
          <select v-model="form.role" class="select">
            <option value="user">普通用户 · 仅管理本人账号</option>
            <option value="admin">管理员 · 管理全部账号与用户</option>
          </select>
        </div>
        <p v-if="error" class="notice notice-danger">{{ error }}</p>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="editor = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
          <span v-if="saving" class="spin" />
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </template>
    </AppModal>

    <AppModal v-if="deleteTarget" title="删除用户" @close="deleteTarget = null">
      <div class="notice notice-danger">
        <AppIcon name="alert" :size="17" />
        <div>
          确认删除用户 <strong>{{ deleteTarget.displayName }}</strong>？其提交的 AWS 账号数据不会自动删除，建议先处理。
        </div>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="deleteTarget = null">取消</button>
        <button class="btn btn-danger" type="button" @click="confirmDelete">确认删除</button>
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
.toolbar {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 9px;
  background: linear-gradient(135deg, rgba(34, 211, 238, 0.24), rgba(168, 85, 247, 0.24));
  color: #cdf4ff;
  font-size: 12.5px;
  font-weight: 600;
}
.name {
  font-size: 13px;
}
.icon-btn.danger:hover {
  background: rgba(244, 63, 94, 0.12);
  color: #ff8fa3;
}
</style>
