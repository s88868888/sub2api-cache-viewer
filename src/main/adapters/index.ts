import { requestJson } from '../http'
import type { SiteKind } from './types'

interface LooseJson {
  [key: string]: unknown
}

/**
 * 探测后台类型。
 *
 * 判据取自两端真实存在差异的接口，而不是页面文案：
 * - new-api 有 GET /api/status（sub2api 对该路径返回 404 且不是 JSON）
 * - sub2api 的 GET /api/v1/usage 未登录时返回带 code 的 JSON 401
 *
 * 只支持 sub2api，但 new-api 仍要能认出来 —— 否则用户加的是一站 new-api，
 * 界面只会说「无法识别」，而正确的话是「这一类已经不支持」。
 */
export async function detectSite(baseUrl: string): Promise<SiteKind | null> {
  const [statusProbe, usageProbe, htmlProbe] = await Promise.allSettled([
    requestJson<LooseJson>(baseUrl, '/api/status', { timeoutMs: 8000 }),
    requestJson<LooseJson>(baseUrl, '/api/v1/usage', { query: { page: 1, page_size: 1 }, timeoutMs: 8000 }),
    fetchText(baseUrl)
  ])

  if (statusProbe.status === 'fulfilled') {
    const body = statusProbe.value.data
    if (body && typeof body === 'object' && ('data' in body || 'success' in body)) return 'newapi'
  }

  if (usageProbe.status === 'fulfilled') {
    const body = usageProbe.value.data
    if (body && typeof body === 'object' && 'code' in body) return 'sub2api'
  } else if (usageProbe.status === 'rejected') {
    const err = usageProbe.reason as { status?: number; message?: string }
    if (err?.status === 401 || /Authorization header is required/i.test(err?.message ?? '')) {
      return 'sub2api'
    }
  }

  if (htmlProbe.status === 'fulfilled') {
    const html = htmlProbe.value
    if (/AI API Gateway/i.test(html) || html.includes('/api/v1/admin')) {
      return 'sub2api'
    }
    if (/new-api|one-api/i.test(html) || html.includes('/api/status')) return 'newapi'
  }

  return null
}

async function fetchText(baseUrl: string): Promise<string> {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/', {
    headers: { 'User-Agent': 'api-show/0.1' },
    signal: AbortSignal.timeout(8000)
  })
  return res.text()
}

export {
  sub2apiLoginWithToken,
  sub2apiProbeToken,
  sub2apiQuery,
  sub2apiPanelSeed
} from './sub2api'
export type { PanelSeed } from './sub2api'
export * from './types'
