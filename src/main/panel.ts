import { BrowserWindow, session, shell } from 'electron'
import type { PanelCredential } from './service'

const PANEL_PARTITION = 'persist:panel'

/**
 * 免登录打开站点自带面板。
 *
 * 安全边界：这个窗口加载的是第三方站点，所以
 * - 不挂任何 preload —— 否则等于把 apiShow 的 IPC 桥交给外部页面
 * - sandbox + contextIsolation，禁 nodeIntegration
 * - 只允许停留在该站点自身的 origin，弹窗一律转交系统浏览器
 */
export async function openSitePanel(cred: PanelCredential): Promise<BrowserWindow> {
  const origin = new URL(cred.baseUrl).origin
  const ses = session.fromPartition(PANEL_PARTITION)

  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    title: `面板 · ${new URL(cred.baseUrl).host}`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PANEL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const sameOrigin = (raw: string): boolean => {
    try {
      return new URL(raw).origin === origin
    } catch {
      return false
    }
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 外链交给系统浏览器，避免面板窗口被导航到钓鱼页
    if (sameOrigin(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // new-api 这类基于会话 cookie 的前端：先写 cookie 再首次加载，不出现未登录闪屏
  if (cred.cookies.length) {
    const secure = origin.startsWith('https:')
    for (const cookie of cred.cookies) {
      await ses.cookies
        .set({ url: origin, name: cookie.name, value: cookie.value, secure })
        .catch(() => undefined)
    }
  }

  /**
   * localStorage 属于具体 origin，只能先在该 origin 下的一份文档里写入。
   * 用 favicon.ico 而不是首页：它不执行前端代码，避免 SPA 在未登录状态下
   * 先跑一遍再被我们的注入结果干扰。
   */
  if (cred.seed) {
    await win.loadURL(`${origin}/favicon.ico`).catch(() => undefined)
    await win.webContents
      .executeJavaScript(
        `(() => {
          const seed = ${JSON.stringify(cred.seed)}
          try {
            localStorage.setItem('auth_token', seed.token)
            localStorage.setItem('auth_user', seed.userJson)
            if (seed.refreshToken) localStorage.setItem('refresh_token', seed.refreshToken)
            else localStorage.removeItem('refresh_token')
            if (seed.expiresAtMs) localStorage.setItem('token_expires_at', String(seed.expiresAtMs))
            else localStorage.removeItem('token_expires_at')
            return true
          } catch (e) {
            return false
          }
        })()`
      )
      .catch(() => false)
  }

  await win.loadURL(origin).catch(() => undefined)
  return win
}
