import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router/index.js'
import { useAuthStore } from './stores/auth.js'
import { useToastStore } from './stores/toast.js'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// 令牌失效时统一回收登录态
window.addEventListener('auth:expired', () => {
  const auth = useAuthStore(pinia)
  const toast = useToastStore(pinia)
  auth.logout()
  toast.error('登录状态已失效，请重新登录')
  if (router.currentRoute.value.path !== '/login') router.push('/login')
})

app.mount('#app')
