import type { ApiShowBridge } from './index'

declare global {
  interface Window {
    apiShow: ApiShowBridge
  }
}

export {}
