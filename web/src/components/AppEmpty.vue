<script setup>
/** 空状态占位 */
import AppIcon from './AppIcon.vue'

defineProps({
  icon: { type: String, default: 'box' },
  title: { type: String, default: '暂无数据' },
  description: { type: String, default: '' },
})
</script>

<template>
  <div class="empty">
    <AppIcon :name="icon" :size="34" :stroke-width="1.3" style="color: var(--text-faint)" />
    <h4>{{ title }}</h4>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
