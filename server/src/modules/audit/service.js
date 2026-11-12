/** 审计日志：记录登录、账号变更、任务触发等关键操作，管理员可查 */
import { collection } from '../../lib/store.js'

const audit = collection('audit', { items: [] })
const MAX_ITEMS = 5000

export function record({ actorId, actorName, action, target = '', detail = '', ip = '', level = 'info' }) {
  audit.insert({ actorId, actorName, action, target, detail, ip, level })
  if (audit.items.length > MAX_ITEMS) {
    audit.data.items.splice(0, audit.items.length - MAX_ITEMS)
    audit.save()
  }
}

export function listAudit({ limit = 100, actorId, action, search } = {}) {
  let items = audit.all().slice()
  if (actorId) items = items.filter((item) => item.actorId === actorId)
  if (action) items = items.filter((item) => item.action === action)
  if (search) {
    const kw = search.toLowerCase()
    items = items.filter((item) =>
      [item.actorName, item.action, item.target, item.detail].join(' ').toLowerCase().includes(keyword(kw)),
    )
  }
  return items
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
}

const keyword = (kw) => kw
