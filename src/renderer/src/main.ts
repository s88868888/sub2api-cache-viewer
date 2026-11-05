import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'

// 先定主题再挂载，否则暗色用户每次启动都会先看到一帧白底
const boot = window.apiShow.initialTheme()
if (boot === 'dark' || boot === 'light') document.documentElement.dataset.theme = boot

createApp(App).mount('#app')
