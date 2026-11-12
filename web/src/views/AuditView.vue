<script setup>
/** 审计日志（管理员）：登录、账号变更、任务触发的完整追踪 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { systemApi } from '@/api/index.js'
import { useToastStore } from '@/stores/toast.js'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import { formatTime } from '@/utils/format.js'

const toast = useToastStore()
const items = ref([])
const loading = ref(true)
const search = ref('')
const levelFilter = ref('')

const ACTION_LABEL = {
  'auth.login': '登录',
  'auth.password': '修改密码',
  'account.create': '提交账号',
  'account.update': '编辑账号',
  'account.delete': '删除账号',
  'account.import': '批量导入',
  'account.verify': '测试连接',
  'nuke.run': '执行删除',
  'nuke.dryrun': '执行演练',
  'nuke.config.generate': '生成配置',
  'nuke.config.edit': '手工编辑配置',
  'nuke.config.regenerate': '重新生成配置',
  'job.cancel': '终止任务',
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'system.install-cli': '安装 AWS CLI',
  'system.credentials': '配置凭证',
  'system.credentials.clear': '清除凭证',
  'system.settings': '修改设置',
  'system.update-nuke': '更新 aws-nuke',
}

const ACTION_TONE = {
  'nuke.run': 'red',
  'account.delete': 'red',
  'user.delete': 'red',
  'system.credentials': 'amber',
  'system.credentials.clear': 'amber',
  'nuke.dryrun': 'cyan',
  'auth.login': 'muted',
}

const visible = computed(() => {
  const kw = search.value.trim().toLowerCase()
  return items.value.filter((item) => {
    if (levelFilter.value && item.level !== levelFilter.value) return false
    if (!kw) return true
    return [item.actorName, item.action, item.target, item.detail].join(' ').toLowerCase().includes(kw)
  })
})

/** 超过该长度视为「会被截断」，显示展开箭头 */
const LONG_TARGET = 24
const LONG_DETAIL = 40

const expanded = ref(new Set())

const isLong = (text, limit) => String(text || '').length > limit
const cellKey = (id, field) => `${id}:${field}`
const isOpen = (id, field) => expanded.value.has(cellKey(id, field))

function toggleCell(id, field, text, limit) {
  if (!isLong(text, limit)) return
  const key = cellKey(id, field)
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

/** 列宽拖拽：固定布局下拖动某一列的右边界，剩余空间由「详情」列自动让出 */
const STORE_KEY = 'audit-col-widths'
const MIN_WIDTH = { time: 100, action: 84, actor: 80, target: 140 }
const tableColumns = [
  { key: 'time', label: '时间' },
  { key: 'action', label: '操作' },
  { key: 'actor', label: '操作人' },
  { key: 'target', label: '对象' },
  { key: 'detail', label: '详情' },
]
const colWidths = ref({ time: 150, action: 118, actor: 110, target: 260 })

function loadColumnWidths() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    for (const key of Object.keys(MIN_WIDTH)) {
      if (Number.isFinite(stored[key]) && stored[key] >= MIN_WIDTH[key]) colWidths.value[key] = stored[key]
    }
  } catch {
    /* 本地存储不可用时忽略，使用默认列宽 */
  }
}

let dragContext = null

function onResizeStart(event, key) {
  event.preventDefault()
  event.stopPropagation()
  dragContext = { key, startX: event.clientX, startWidth: colWidths.value[key] }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onResizing)
  window.addEventListener('mouseup', onResizeEnd)
}

function onResizing(event) {
  if (!dragContext) return
  const delta = event.clientX - dragContext.startX
  const key = dragContext.key
  colWidths.value = { ...colWidths.value, [key]: Math.max(MIN_WIDTH[key], dragContext.startWidth + delta) }
}

function onResizeEnd() {
  dragContext = null
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onResizing)
  window.removeEventListener('mouseup', onResizeEnd)
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(colWidths.value))
  } catch {
    /* 同上 */
  }
}

onBeforeUnmount(() => {
  if (dragContext) onResizeEnd()
})

async function load() {
  loading.value = true
  try {
    const data = await systemApi.audit(300)
    items.value = data.items
  } catch (error) {
    toast.error(error.message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadColumnWidths()
  load()
})
</script>

<template>
  <div class="stack fade-up">
    <div class="page-head">
      <div>
        <h1>审计日志</h1>
        <p class="sub">所有敏感操作留痕，最多保留最近 5000 条</p>
      </div>
      <button class="btn btn-sm" type="button" @click="load"><AppIcon name="refresh" :size="14" />刷新</button>
    </div>

    <section class="panel">
      <div class="toolbar">
        <div class="input-icon" style="flex: 1; max-width: 320px">
          <span class="icon-slot"><AppIcon name="search" :size="15" /></span>
          <input v-model="search" class="input" placeholder="搜索操作人 / 对象 / 详情" />
        </div>
        <select v-model="levelFilter" class="select" style="width: 150px">
          <option value="">全部级别</option>
          <option value="info">常规</option>
          <option value="warn">高风险</option>
        </select>
      </div>

      <div v-if="loading" class="panel-body stack">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 26px" />
      </div>

      <AppEmpty v-else-if="!visible.length" icon="shield" title="暂无日志" />

      <div v-else class="table-wrap">
        <table class="data audit-table">
          <colgroup>
            <col
              v-for="col in tableColumns"
              :key="col.key"
              :style="colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : {}"
            />
          </colgroup>
          <thead>
            <tr>
              <th v-for="col in tableColumns" :key="col.key">
                {{ col.label }}
                <span
                  v-if="col.key !== 'detail'"
                  class="col-resizer"
                  title="拖动调整列宽"
                  @mousedown="onResizeStart($event, col.key)"
                  @click.stop
                />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in visible" :key="item.id">
              <td class="mono small text-muted">{{ formatTime(item.createdAt) }}</td>
              <td>
                <span class="badge" :class="`badge-${ACTION_TONE[item.action] || 'muted'}`">
                  {{ ACTION_LABEL[item.action] || item.action }}
                </span>
              </td>
              <td class="text-dim">{{ item.actorName || '—' }}</td>
              <td class="mono small">
                <span
                  class="clip"
                  :class="{ open: isOpen(item.id, 'target'), clickable: isLong(item.target, LONG_TARGET) }"
                  @click="toggleCell(item.id, 'target', item.target, LONG_TARGET)"
                >
                  {{ item.target || '—' }}
                  <AppIcon v-if="isLong(item.target, LONG_TARGET)" class="clip-icon" :name="isOpen(item.id, 'target') ? 'up' : 'down'" :size="11" />
                </span>
              </td>
              <td class="small text-muted">
                <span
                  class="clip"
                  :class="{ open: isOpen(item.id, 'detail'), clickable: isLong(item.detail, LONG_DETAIL) }"
                  @click="toggleCell(item.id, 'detail', item.detail, LONG_DETAIL)"
                >
                  {{ item.detail || '—' }}
                  <AppIcon v-if="isLong(item.detail, LONG_DETAIL)" class="clip-icon" :name="isOpen(item.id, 'detail') ? 'up' : 'down'" :size="11" />
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
/* 固定列宽：长内容不再把「详情」挤到最右边；列宽可通过表头分隔线拖动调整 */
.audit-table {
  table-layout: fixed;
}
.audit-table th,
.audit-table td {
  overflow: hidden;
  vertical-align: top;
}
.audit-table th {
  position: relative;
}
.col-resizer {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 9px;
  cursor: col-resize;
  z-index: 1;
}
/* 常显竖线：提示此处可拖动；悬停加亮加粗 */
.col-resizer::after {
  content: '';
  position: absolute;
  top: 22%;
  bottom: 22%;
  right: 3.5px;
  width: 2px;
  border-radius: 1px;
  background: rgba(120, 170, 210, 0.32);
  transition: background 0.15s var(--ease), width 0.15s var(--ease);
}
.col-resizer:hover::after {
  width: 3px;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(34, 211, 238, 0.55);
}
/* 截断 + 点击展开：默认单行省略，展开后完整换行显示 */
.clip {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.7;
}
.clip.clickable {
  cursor: pointer;
}
.clip.clickable:hover {
  color: var(--accent);
}
.clip.open {
  white-space: normal;
  word-break: break-all;
}
.clip-icon {
  display: inline-block;
  vertical-align: -1px;
  margin-left: 4px;
  color: var(--text-faint);
}
.clip.open .clip-icon {
  transform: none;
}
</style>
