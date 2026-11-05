import { BrowserWindow, session } from 'electron'
import { SiteError } from './adapters/types'

const PARTITION = 'persist:login-capture'
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 打开一个真实浏览器窗口让用户完成登录（含 Turnstile / 腾讯验证码），
 * 从出站请求头里截获面板 JWT。
 *
 * 之所以不直接调登录接口：sub2api 站点普遍把 /api/v1/auth/login 挂在人机验证后面，
 * 纯 HTTP 客户端拿不到 token。走 webRequest 而不是读 localStorage，是因为令牌最终
 * 一定要出现在 Authorization 头里，这个位置与前端存储方式无关。
 */
export function captureJwtWithBrowser(baseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ses = session.fromPartition(PARTITION)
    const win = new BrowserWindow({
      width: 1120,
      height: 820,
      title: `登录 ${new URL(baseUrl).host}`,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true }
    })

    let settled = false
    const finish = (token: string | null): void => {
      if (settled) return
      settled = true
      ses.webRequest.onBeforeSendHeaders(null)
      if (token) resolve(token)
      else reject(
        new SiteError('没有捕获到登录令牌，可能你取消了登录或窗口被手动关闭', 'auth')
      )
    }

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const raw = details.requestHeaders['Authorization'] ?? details.requestHeaders['authorization']
      if (typeof raw === 'string') {
        const value = raw.replace(/^Bearer\s+/i, '').trim()
        if (JWT_SHAPE.test(value)) {
          callback({ requestHeaders: details.requestHeaders })
          finish(value)
          return
        }
      }
      callback({ requestHeaders: details.requestHeaders })
    })

    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS)
    win.on('closed', () => {
      clearTimeout(timer)
      finish(null)
    })

    void win.loadURL(baseUrl)
  })
}
