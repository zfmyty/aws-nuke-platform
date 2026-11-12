/** 全局轻提示 */
import { defineStore } from 'pinia'

let seq = 0

export const useToastStore = defineStore('toast', {
  state: () => ({ items: [] }),
  actions: {
    push(message, type = 'info', timeout = 3800) {
      const id = ++seq
      this.items.push({ id, message, type })
      if (timeout) setTimeout(() => this.dismiss(id), timeout)
      return id
    },
    success(message) {
      return this.push(message, 'success')
    },
    error(message) {
      return this.push(message, 'error', 5200)
    },
    info(message) {
      return this.push(message, 'info')
    },
    dismiss(id) {
      this.items = this.items.filter((item) => item.id !== id)
    },
  },
})
