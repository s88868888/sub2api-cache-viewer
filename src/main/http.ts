import { SiteError } from './adapters/types'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  /** 会被 JSON 序列化 */
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  cookieJar?: CookieJar
  timeoutMs?: number
}

export interface Response_<T> {
  status: number
  ok: boolean
  data: T
  headers: Headers
}

/**
 * 最小 Cookie 存储。new-api 的会话登录依赖 Set-Cookie，
 * 而 Node fetch 不自动维持 cookie，必须自己接住再回传。
 */
export class CookieJar {
  private readonly store = new Map<string, string>()

  ingest(setCookieHeaders: string[]): void {
    for (const line of setCookieHeaders) {
      const [pair] = line.split(';')
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || value === 'null') this.store.delete(name)
      else this.store.set(name, value)
    }
  }

  header(): string {
    return [...this.store].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 免登录打开面板时需要把会话 cookie 原样搬进那个窗口的 session */
  entries(): Array<{ name: string; value: string }> {
    return [...this.store].map(([name, value]) => ({ name, value }))
  }

  get size(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new SiteError(`站点地址无法解析：${raw}`, 'network')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SiteError(`仅支持 http/https，收到 ${url.protocol}`, 'network')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function buildUrl(base: string, path: string, query?: RequestOptions['query']): string {
  const url = new URL(base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`))
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/**
 * 发起请求并把响应按 JSON 解析。非 JSON 响应体会带进错误信息，便于识别
 * Cloudflare 拦截页或 HTML 兜底路由。
 */
export async function requestJson<T = unknown>(
  base: string,
  path: string,
  options: RequestOptions = {}
): Promise<Response_<T>> {
  const url = buildUrl(base, path, options.query)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'api-show/0.1',
    ...options.headers
  }

  const cookie = options.cookieJar?.header()
  if (cookie) headers.Cookie = cookie

  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SiteError(`请求失败 ${path}：${msg}`, 'network')
  }

  const setCookie =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  if (options.cookieJar && setCookie.length) options.cookieJar.ingest(setCookie)

  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''

  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = undefined
  }

  if (parsed === undefined) {
    // HTML 兜底路由、Cloudflare 拦截页等，都不是可用响应
    throw new SiteError(
      `HTTP ${res.status} ${path}：${text.slice(0, 160).replace(/\s+/g, ' ')}`,
      res.status === 401 || res.status === 403 ? 'auth' : 'network',
      res.status
    )
  }

  if (!res.ok) {
    throw new SiteError(
      `${path}：${extractMessage(parsed) ?? text.slice(0, 160).replace(/\s+/g, ' ')}`,
      errorKind(res.status),
      res.status
    )
  }

  return { status: res.status, ok: res.ok, data: parsed as T, headers: res.headers }
}

function errorKind(status: number): 'auth' | 'network' | 'shape' | 'unknown' {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'shape'
  return 'network'
}

/** 两套后台的错误文案字段名不同，逐个探。 */
function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  for (const key of ['message', 'error', 'msg', 'detail']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}
