/** 展示层格式化与语义映射，统一各视图的措辞与配色 */

export function formatTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function timeAgo(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return '—'
  const minute = 60 * 1000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  return formatTime(iso)
}

export function formatDuration(startIso, endIso) {
  if (!startIso) return '—'
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const ms = end - new Date(startIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const STATUS_META = {
  queued: { label: '排队中', tone: 'muted' },
  running: { label: '执行中', tone: 'cyan' },
  'waiting-input': { label: '待确认', tone: 'amber' },
  succeeded: { label: '成功', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  canceled: { label: '中止', tone: 'amber' },
  success: { label: '成功', tone: 'green' },
}

export const statusMeta = (status) => STATUS_META[status] || { label: status || '未知', tone: 'muted' }

export const ENV_META = {
  prod: { label: '生产', tone: 'red' },
  staging: { label: '预发', tone: 'amber' },
  dev: { label: '开发', tone: 'cyan' },
  sandbox: { label: '沙箱', tone: 'violet' },
  test: { label: '测试', tone: 'muted' },
}

export const envMeta = (env) => ENV_META[env] || { label: env || '未知', tone: 'muted' }

export const JOB_KIND_META = {
  nuke: { label: 'aws-nuke', icon: 'zap' },
  'install-cli': { label: '安装 AWS CLI', icon: 'download' },
  configure: { label: '凭证配置', icon: 'key' },
  verify: { label: '配置校验', icon: 'shield-check' },
  'update-nuke': { label: '更新 aws-nuke', icon: 'refresh' },
}

export const jobKindMeta = (kind) => JOB_KIND_META[kind] || { label: kind, icon: 'terminal' }

export const AUTH_MODE_LABEL = {
  'assume-role': '组织跨账号',
  aksk: '账号 AK/SK',
  profile: 'CLI Profile',
}

export const authModeLabel = (mode) => AUTH_MODE_LABEL[mode] || '未配置'

/** 组织跨账号模式下用于展示的角色描述 */
export function roleSummary(account) {
  if (!account || account.authMode !== 'assume-role') return ''
  return account.roleArn || `${account.roleName || 'OrganizationAccountAccessRole'} @ ${account.accountId}`
}

/** 复制到剪贴板（带降级方案） */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  }
}

export const shortId = (id) => (id ? String(id).slice(0, 8) : '—')
