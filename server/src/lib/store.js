/**
 * 极简 JSON 文档存储：单进程、文件级持久化，写入使用临时文件 + 原子重命名。
 * 面向本平台的数据量（账号/任务/审计）足够，且零外部依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataPath } from '../config/index.js'

export class Collection {
  /**
   * @param {string} name 集合名，对应 data/db/<name>.json
   * @param {object} defaults 空集合时的初始数据
   */
  constructor(name, defaults = { items: [] }) {
    this.name = name
    this.file = dataPath('db', `${name}.json`)
    this.defaults = defaults
    this.data = this._load()
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      return { ...structuredClone(this.defaults), ...parsed }
    } catch {
      const initial = structuredClone(this.defaults)
      this._persist(initial)
      return initial
    }
  }

  _persist(data) {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  save() {
    this._persist(this.data)
    return this
  }

  get items() {
    return this.data.items
  }

  all() {
    return this.data.items
  }

  find(predicate) {
    return this.data.items.find(predicate)
  }

  filter(predicate) {
    return this.data.items.filter(predicate)
  }

  findById(id) {
    return this.data.items.find((item) => item.id === id)
  }

  insert(doc) {
    const record = {
      id: doc.id || crypto.randomUUID(),
      createdAt: doc.createdAt || new Date().toISOString(),
      ...doc,
    }
    this.data.items.push(record)
    this.save()
    return record
  }

  update(id, patch) {
    const index = this.data.items.findIndex((item) => item.id === id)
    if (index === -1) return null
    this.data.items[index] = {
      ...this.data.items[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.save()
    return this.data.items[index]
  }

  remove(id) {
    const index = this.data.items.findIndex((item) => item.id === id)
    if (index === -1) return false
    this.data.items.splice(index, 1)
    this.save()
    return true
  }

  /** 仅供内部结构使用（如 settings 单文档） */
  setRaw(key, value) {
    this.data[key] = value
    this.save()
    return value
  }

  getRaw(key, fallback = undefined) {
    return this.data[key] ?? fallback
  }
}

/** 单例注册表，避免同一集合被多处重复加载导致状态不一致 */
const registry = new Map()
export function collection(name, defaults) {
  if (!registry.has(name)) registry.set(name, new Collection(name, defaults))
  return registry.get(name)
}
