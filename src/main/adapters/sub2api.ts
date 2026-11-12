import { requestJson, type Response_ } from '../http'
import {
  GroupOption,
  QueryFilters,
  QueryResult,
  SiteBalance,
  SiteError,
  SiteSession,
  UsageRecord,
  UsageSummary,
  cacheRateOf,
  summarize
} from './types'

const API = '/api/v1'

/**
 * 用量接口是按条数变慢的：实测有站点一页 100 条要 24s，
 * 用默认的 20s 超时会有数据的站点被误报成请求失败。
 */
const USAGE_TIMEOUT_MS = 90_000

interface Envelope<T> {
  /** 成功时是数字 0；部分中间件把 reason 写在这里，所以可能是字符串 */
  code?: number | string
  message?: string
  reason?: string
  data?: T
}

interface RawUsageLog {
  id: number
  created_at: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens?: number
  input_cost?: number
  output_cost?: number
  cache_read_cost?: number
  total_cost: number
  actual_cost: number
  duration_ms?: number | null
  first_token_ms?: number | null
  stream?: boolean
  billing_mode?: string | null
  group?: { id?: number; name?: string } | null
  inbound_endpoint?: string | null
  upstream_endpoint?: string | null
}

interface Paginated<T> {
  items?: T[]
  total?: number
  page?: number
  page_size?: number
}

/**
 * sub2api 的 total = input + output + cache_creation + cache_read，
 * 即 input_tokens 已经是「未命中」部分，直接作为 cacheRate 的未命中项。
 */
function toRecord(raw: RawUsageLog): UsageRecord {
  const input = num(raw.input_tokens)
  const output = num(raw.output_tokens)
  const creation = num(raw.cache_creation_tokens)
  const read = num(raw.cache_read_tokens)
  return {
    id: String(raw.id),
    createdAt: Date.parse(raw.created_at) || 0,
    model: raw.model ?? '',
    groupName: raw.group?.name ?? '-',
    endpoint: raw.inbound_endpoint ?? raw.upstream_endpoint ?? '',
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: creation,
    cacheReadTokens: read,
    totalTokens: num(raw.total_tokens) || input + output + creation + read,
    cost: num(raw.total_cost),
    actualCost: num(raw.actual_cost),
    // sub2api 的计费与余额都是美元，直接沿用
    costUsd: num(raw.actual_cost),
    durationMs: raw.duration_ms == null ? null : num(raw.duration_ms),
    firstTokenMs: raw.first_token_ms == null ? null : num(raw.first_token_ms),
    stream: raw.stream ?? null,
    cacheRate: cacheRateOf(input, creation, read)
  }
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function unwrap<T>(res: Response_<Envelope<T>>, path: string): T {
  const body = res.data
  if (!body || typeof body !== 'object') {
    throw new SiteError(`${path}：响应体为空`, 'shape')
  }
  const failed =
    typeof body.code === 'string' || (typeof body.code === 'number' && body.code !== 0)
  if (failed) {
    throw new SiteError(
      `${path}：${body.message || body.reason || String(body.code)}`,
      'unknown'
    )
  }
  return body.data as T
}

function toDate(ms: number | null): string | undefined {
  if (!ms) return undefined
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 令牌能不能用，只有真的打一次用量接口才算数。
 * 内置浏览器截获时每个候选都要过这里，接口明确拒绝才判它不可用；
 * 拦截页那种 403（响应体不是 JSON）要照抛 —— 把「请求被挡」报成「令牌已过期」，
 * 用户就会对着一枚好令牌反复重登。
 */
export async function sub2apiProbeToken(baseUrl: string, token: string): Promise<boolean> {
  try {
    await requestJson<Envelope<Paginated<RawUsageLog>>>(baseUrl, `${API}/usage`, {
      headers: { Authorization: `Bearer ${token}` },
      query: { page: 1, page_size: 1 }
    })
    return true
  } catch (err) {
    if (err instanceof SiteError && err.kind === 'auth' && !err.nonJson) return false
    throw err
  }
}

/** 用内置浏览器截获的面板令牌建立会话。 */
export async function sub2apiLoginWithToken(baseUrl: string, token: string): Promise<SiteSession> {
  if (!(await sub2apiProbeToken(baseUrl, token))) {
    throw new SiteError('面板令牌已失效，请在这一站的编辑弹窗里重新用浏览器登录', 'auth')
  }
  const [groups, account] = await Promise.all([
    sub2apiGroups(baseUrl, token),
    sub2apiAccount(baseUrl, token)
  ])
  return { kind: 'sub2api', baseUrl, account, groups, cred: { accessToken: token } }
}

/** 顶栏要显示这是哪个账号的面板。 */
async function sub2apiAccount(baseUrl: string, token: string): Promise<string> {
  const res = await requestJson<Envelope<{ email?: string; username?: string }>>(
    baseUrl,
    `${API}/user/profile`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => null)
  const user = res?.data?.data
  return user?.email || user?.username || '面板令牌'
}

async function sub2apiGroups(baseUrl: string, token: string): Promise<GroupOption[]> {
  const res = await requestJson<
    Envelope<Array<{ id: number; name: string; status?: string }> | null>
  >(baseUrl, `${API}/groups/available`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null)
  const list = res?.data?.data ?? []
  return list.map((g) => ({ id: String(g.id), name: g.name }))
}

export async function sub2apiQuery(
  session: SiteSession,
  filters: QueryFilters
): Promise<QueryResult> {
  const token = String(session.cred.accessToken ?? '')
  const res = await requestJson<Envelope<Paginated<RawUsageLog>>>(session.baseUrl, `${API}/usage`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: USAGE_TIMEOUT_MS,
    query: {
      page: filters.page,
      page_size: filters.pageSize,
      sort_by: 'created_at',
      sort_order: 'desc',
      group_id: filters.groupId || undefined,
      model: filters.model || undefined,
      start_date: toDate(filters.startMs),
      end_date: toDate(filters.endMs),
      // start_date/end_date 按用户时区解析，不传会落到服务器时区导致边界差一天
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  })

  const data = unwrap(res, '用量查询')
  const items = (data?.items ?? []).map(toRecord)
  const total = num(data?.total)

  // /api/v1/usage/stats 需要强制日期区间且口径与筛选不完全一致，
  // 这里统一用当前页明细累加，保证汇总与表格永远对得上。
  const summary: UsageSummary = summarize(items)

  return {
    items,
    total,
    page: num(data?.page) || filters.page,
    pageSize: num(data?.page_size) || filters.pageSize,
    summary,
    summaryIsPageScoped: true,
    balance: filters.skipBalance ? null : await sub2apiBalance(session.baseUrl, token)
  }
}

/** userProfileResponse 内嵌 dto.User，balance 直接落在 data 顶层。 */
async function sub2apiBalance(baseUrl: string, token: string): Promise<SiteBalance | null> {
  const res = await requestJson<Envelope<{ balance?: number; frozen_balance?: number }>>(
    baseUrl,
    `${API}/user/profile`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => null)
  const balance = res?.data?.data?.balance
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return null
  return { raw: balance, unit: 'USD', usd: balance }
}

/** 只解 payload 读 exp，不验签 —— 这里要的是过期时间，不是可信性 */
function jwtExpiresAtMs(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number
    }
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null
  } catch {
    return null
  }
}

export interface PanelSeed {
  token: string
  expiresAtMs: number | null
  /** 前端 isAuthenticated 同时要求 auth_token 和 auth_user，缺一个仍算未登录 */
  userJson: string
}

/**
 * 免登录直达面板所需的种子。
 * user 一律重新拉 /user/profile —— 昵称/权限可能在令牌签发之后变过。
 */
export async function sub2apiPanelSeed(session: SiteSession): Promise<PanelSeed | null> {
  const token = String(session.cred.accessToken ?? '')
  if (!token) return null

  const res = await requestJson<Envelope<Record<string, unknown>>>(
    session.baseUrl,
    `${API}/user/profile`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => null)

  const user = res?.data?.data
  if (!user || typeof user !== 'object') return null

  return { token, expiresAtMs: jwtExpiresAtMs(token), userJson: JSON.stringify(user) }
}
