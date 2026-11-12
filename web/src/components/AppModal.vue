<script setup>
/** 通用弹窗：遮罩 + 焦点约束 + esc 关闭 */
import { onBeforeUnmount, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  size: { type: String, default: 'md' },
  closable: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])

function onKey(event) {
  if (event.key === 'Escape' && props.closable) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

function onOverlay(event) {
  if (event.target === event.currentTarget && props.closable) emit('close')
}
</script>

<template>
  <teleport to="body">
    <div class="overlay" @mousedown="onOverlay">
      <div class="modal" :class="{ 'modal-lg': size === 'lg' }" role="dialog" aria-modal="true">
        <div v-if="title" class="modal-head">
          <div>
            <h3>{{ title }}</h3>
            <p v-if="subtitle" class="sub">{{ subtitle }}</p>
          </div>
          <button v-if="closable" class="icon-btn" type="button" aria-label="关闭" @click="emit('close')">
            <AppIcon name="close" :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </teleport>
</template>
