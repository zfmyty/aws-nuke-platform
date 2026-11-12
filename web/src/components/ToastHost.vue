<script setup>
/** 全局提示宿主，渲染 toast 队列 */
import { useToastStore } from '@/stores/toast.js'
import AppIcon from './AppIcon.vue'

const toast = useToastStore()
const iconOf = (type) => (type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info')
const colorOf = (type) => (type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--accent)')
</script>

<template>
  <div class="toast-host">
    <div v-for="item in toast.items" :key="item.id" class="toast" :class="item.type">
      <AppIcon :name="iconOf(item.type)" :size="17" :style="{ color: colorOf(item.type), flex: 'none' }" />
      <span class="grow">{{ item.message }}</span>
      <button class="toast-close" type="button" @click="toast.dismiss(item.id)">
        <AppIcon name="close" :size="13" />
      </button>
    </div>
  </div>
</template>
