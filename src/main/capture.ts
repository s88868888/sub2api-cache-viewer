import { BrowserWindow, session } from 'electron'
import { SiteError } from './adapters/types'

const PARTITION = 'persist:login-capture'
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000
const STORAGE_POLL_MS = 1_500

/** 同一时刻只留一个登录窗口：webRequest 监听是按 session 注册的，第二个会把第一个顶掉 */
let inFlight: BrowserWindow | null = null

/**
 * 打开一个真实浏览器窗口让用户完成登录（含 Turnstile / 腾讯验证码），
 * 交回一枚确实能打开通用量接口的面板令牌。
 *
 * 候选有两个来源：同源出站请求头里的 Authorization，以及页面 storage 里的令牌值。
 * 拿到候选必须先 probe 一次才算数 —— 这个分区是持久化的，页面一加载就会带着
 * 上一次那枚已经过期的令牌发请求，抓到第一个就收工等于把死令牌存进站点。
 */
export function captureTokenWithBrowser(
  baseUrl: string,
  probe: (token: string) => Promise<boolean>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inFlight && !inFlight.isDestroyed()) {
      reject(new SiteError('已经有一个登录窗口打开着，请先完成那个窗口', 'shape'))
      return
    }

    const origin = new URL(baseUrl).origin
    const host = new URL(baseUrl).host
    const ses = session.fromPartition(PARTITION)
    const win = new BrowserWindow({
      width: 1120,
      height: 820,
      title: `登录 ${host}`,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true }
    })
    inFlight = win

    let settled = false
    let probing = false
    const seen = new Set<string>()
    const queue: string[] = []
    const timer = setTimeout(
      () =>
        fail(
          new SiteError(
            '5 分钟内没有拿到可用令牌。若页面显示已登录但仍取不到数据，' +
              '请在页面里退出登录后再登录一次',
            'auth'
          )
        ),
      CAPTURE_TIMEOUT_MS
    )
    const poll = setInterval(readStorage, STORAGE_POLL_MS)

    function stop(): void {
      clearTimeout(timer)
      clearInterval(poll)
      ses.webRequest.onBeforeSendHeaders(null)
      if (inFlight === win) inFlight = null
    }

    function fail(err: unknown): void {
      if (settled) return
      settled = true
      stop()
      reject(err)
    }

    function accept(token: string): void {
      if (settled) return
      settled = true
      stop()
      // 令牌到手就收窗口，留着不动会让人以为登录没成功而反复再登一次
      win.close()
      resolve(token)
    }

    function offer(raw: unknown): void {
      if (settled || typeof raw !== 'string') return
      const token = raw.replace(/^Bearer\s+/i, '').trim()
      if (!JWT_SHAPE.test(token) || seen.has(token)) return
      seen.add(token)
      queue.push(token)
      void drain()
    }

    async function drain(): Promise<void> {
      if (probing) return
      probing = true
      try {
        while (!settled && queue.length) {
          const token = queue.shift() as string
          win.setTitle(`登录 ${host} · 正在校验令牌`)
          if (await probe(token)) {
            accept(token)
            return
          }
          win.setTitle(`登录 ${host} · 那枚令牌已失效，请重新登录`)
        }
      } catch (err) {
        fail(err)
      } finally {
        probing = false
      }
    }

    /**
     * 前端把令牌存在哪个 key 各家不同，所以按 JWT 的形状扫整个 storage。
     * 只认目标 origin 自己的文档，页面跳到别处（OAuth）时读到什么都不算。
     */
    function readStorage(): void {
      if (settled || win.isDestroyed()) return
      void win.webContents
        .executeJavaScript(storageScript(origin))
        .then((values: unknown) => {
          if (Array.isArray(values)) values.forEach(offer)
        })
        .catch(() => undefined)
    }

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (sameOrigin(details.url, origin)) {
        offer(details.requestHeaders['Authorization'] ?? details.requestHeaders['authorization'])
      }
      callback({ requestHeaders: details.requestHeaders })
    })

    win.on('closed', () => {
      fail(new SiteError('已取消登录，站点还没有可用令牌', 'auth'))
    })

    void win.loadURL(baseUrl)
  })
}

function sameOrigin(raw: string, origin: string): boolean {
  try {
    return new URL(raw).origin === origin
  } catch {
    return false
  }
}

function storageScript(origin: string): string {
  return `(() => {
    const SHAPE = /^[\\w-]+\\.[\\w-]+\\.[\\w-]+$/
    if (location.origin !== ${JSON.stringify(origin)}) return []
    const out = []
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const value = store.getItem(store.key(i) ?? '')
          if (!value) continue
          const token = value.replace(/^"|"$/g, '').trim()
          if (SHAPE.test(token)) out.push(token)
        }
      } catch (e) {}
    }
    return out
  })()`
}
