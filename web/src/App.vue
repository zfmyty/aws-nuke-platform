<script setup>
import ToastHost from '@/components/ToastHost.vue'
</script>

<template>
  <!-- 全局壁纸：所有页面共用，位于内容层之下（z-index:-1），透过半透明面板形成毛玻璃效果 -->
  <div class="app-wallpaper" aria-hidden="true" />
  <router-view />
  <ToastHost />
</template>

<style>
.app-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -1;
  background: url('/bg.jpg') center / cover no-repeat;
  filter: blur(14px) saturate(1.08) brightness(0.8);
  /* 轻微放大，避免模糊后边缘露白 */
  transform: scale(1.06);
}
.app-wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  /* 统一压暗，保证前景文字可读，同时保留青/紫氛围 */
  background: linear-gradient(
    150deg,
    rgba(6, 10, 17, 0.78),
    rgba(6, 10, 17, 0.6) 55%,
    rgba(6, 10, 17, 0.8)
  );
}
</style>
