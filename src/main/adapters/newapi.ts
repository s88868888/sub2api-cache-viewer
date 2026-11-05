import { CookieJar, requestJson } from '../http'
import {
  GroupOption,
  QueryFilters,
  QueryResult,
  SiteBalance,
  SiteError,
  SiteSession,
  UsageRecord,
  cacheRateOf,
  summarize
} from './types'

interface Envelope<T> {
  success?: boolean
  message?: string
  data?: T
}

interface LoginData {
  id?: number
  username?: string
  email?: string
  role?: number
  group?: string
}

interface RawLog {
  id: number
  created_at: number
  type: number
  model_name: string
  prompt_tokens: number
  completion_tokens: number
  quota: number
  use_time: number
  is_stream: boolean
  group: string
  channel?: number
  channel_name?: string
  token_name?: string
  ip?: string
  /** JSON 字符串，public 字段落在顶层，管理员字段在 admin_info 下 */
  other?: string
}

interface OtherInfo {
  cache_tokens?: number
  cache_creation_tokens?: number
  cache_ratio?: number
  frt?: number
  reasoning_effort?: string
  admin_info?: { frt?: number }
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseOther(raw: string | undefined): OtherInfo {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as OtherInfo
  } catch {
    return {}
  }
}

/**
 * new-api 的 prompt_tokens 口径随上游协议变化：
 * - OpenAI 兼容：cached_tokens 已包含在 prompt_tokens 内，需要减掉才是未命中部分
 * - Anthropic：input_tokens 本就不含 cache_read / cache_creation，减掉会变成负数
 * 用 prompt 是否容得下缓存量来判别，两种情况都能落到同一个「未命中输入」定义上。
 */
export function uncachedInput(
  prompt: number,
  cacheRead: number,
  cacheCreation: number
): number {
  return prompt >= cacheRead + cacheCreation ? prompt - cacheRead - cacheCreation : prompt
}

function toRecord(raw: RawLog, quotaPerUnit: number | null): UsageRecord {
  const other = parseOther(raw.other)
  const cacheRead = num(other.cache_tokens)
  const cacheCreation = num(other.cache_creation_tokens)
  const prompt = num(raw.prompt_tokens)
  const output = num(raw.completion_tokens)
  const input = uncachedInput(prompt, cacheRead, cacheCreation)
  const quota = num(raw.quota)

  return {
    id: String(raw.id),
    createdAt: num(raw.created_at) * 1000,
    model: raw.model_name ?? '',
    groupName: raw.group || '-',
    endpoint: raw.channel_name ? `渠道 ${raw.channel_name}` : '',
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheCreation + cacheRead,
    // new-api 以 quota 整数记账，换算成美元需要站点的 quota_per_unit，这里保留原始值
    cost: quota,
    actualCost: quota,
    costUsd: quotaPerUnit && quotaPerUnit > 0 ? quota / quotaPerUnit : null,
    durationMs: num(raw.use_time) ? num(raw.use_time) * 1000 : null,
    firstTokenMs: other.frt ?? other.admin_info?.frt ?? null,
    stream: Boolean(raw.is_stream),
    cacheRate: cacheRateOf(input, cacheCreation, cacheRead)
  }
}

function epochSec(ms: number | null): string | undefined {
  return ms ? String(Math.floor(ms / 1000)) : undefined
}

export async function newapiLogin(
  baseUrl: string,
  username: string,
  password: string
): Promise<{ session: SiteSession; jar: CookieJar }> {
  const jar = new CookieJar()
  const res = await requestJson<Envelope<LoginData>>(baseUrl, '/api/user/login', {
    method: 'POST',
    body: { username, password },
    cookieJar: jar
  })

  if (res.data?.success === false) {
    const msg = res.data.message ?? ''
    if (/captcha|验证码/i.test(msg)) {
      throw new SiteError(`该站点登录需要人机验证码，自动登录无法完成：${msg}`, 'auth')
    }
    throw new SiteError(msg || '用户名或密码不正确', 'auth', res.status)
  }

  const user = res.data?.data
  if (!user?.id) throw new SiteError('登录成功但没有拿到用户信息', 'shape')
  if (!jar.size) {
    throw new SiteError('登录未返回会话 Cookie，该站点可能要求额外的验证步骤', 'auth')
  }

  const session: SiteSession = {
    kind: 'newapi',
    baseUrl,
    account: user.username ?? username,
    groups: [],
    cred: { userId: user.id, quotaPerUnit: await fetchQuotaPerUnit(baseUrl, jar) }
  }

  session.groups = await newapiGroups(baseUrl, jar, user.id)
  return { session, jar }
}

/** new-api 没有「我的可用分组」接口，从近期记录里归纳。 */
async function newapiGroups(
  baseUrl: string,
  jar: CookieJar,
  userId: number
): Promise<GroupOption[]> {
  const res = await requestJson<Envelope<{ items?: RawLog[] } | RawLog[]>>(
    baseUrl,
    '/api/log/self',
    {
      query: { p: 1, page_size: 100, type: 2 },
      headers: { 'New-Api-User': String(userId) },
      cookieJar: jar
    }
  ).catch(() => null)

  const payload = res?.data?.data
  const items = Array.isArray(payload) ? payload : (payload?.items ?? [])
  const seen = new Map<string, GroupOption>()
  for (const row of items) {
    const name = row.group?.trim()
    if (name && !seen.has(name)) seen.set(name, { id: name, name })
  }
  return [...seen.values()]
}

export async function newapiQuery(
  session: SiteSession,
  jar: CookieJar,
  filters: QueryFilters
): Promise<QueryResult> {
  const res = await requestJson<Envelope<{ items?: RawLog[]; total?: number } | RawLog[]>>(
    session.baseUrl,
    '/api/log/self',
    {
      query: {
        p: filters.page,
        page_size: filters.pageSize,
        // type=2 是消费记录，1 是管理类操作
        type: 2,
        model_name: filters.model || undefined,
        group: filters.groupId || undefined,
        username: filters.keyword || undefined,
        start_timestamp: epochSec(filters.startMs),
        end_timestamp: epochSec(filters.endMs)
      },
      headers: { 'New-Api-User': String(session.cred.userId ?? '') },
      cookieJar: jar
    }
  )

  if (res.data?.success === false) {
    throw new SiteError(res.data.message || '用量查询失败', 'unknown')
  }

  const payload = res.data?.data
  const rawItems = Array.isArray(payload) ? payload : (payload?.items ?? [])
  const total = Array.isArray(payload) ? rawItems.length : num(payload?.total)

  const perUnit = num(session.cred.quotaPerUnit) || null
  const items = rawItems
    .filter((row) => num(row.type) === 2 || row.type === undefined)
    .map((row) => toRecord(row, perUnit))
  const summary = summarize(items)

  return {
    items,
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    summary,
    summaryIsPageScoped: true,
    balance: filters.skipBalance ? null : await newapiBalance(session, jar)
  }
}

/**
 * new-api 的余额是 quota 整数，换算成美元要用站点自己的 quota_per_unit
 * （默认 500000，但部署方可改），所以取不到换算系数时只展示原生值。
 */
async function newapiBalance(session: SiteSession, jar: CookieJar): Promise<SiteBalance | null> {
  const res = await requestJson<Envelope<{ quota?: number }>>(session.baseUrl, '/api/user/self', {
    headers: { 'New-Api-User': String(session.cred.userId ?? '') },
    cookieJar: jar
  }).catch(() => null)

  const quota = res?.data?.data?.quota
  if (typeof quota !== 'number' || !Number.isFinite(quota)) return null

  const perUnit = num(session.cred.quotaPerUnit)
  const usd = perUnit > 0 ? quota / perUnit : null
  return { raw: quota, unit: 'quota', usd }
}

/** 登录时抓一次计费单位，避免每次查询都多打一个 /api/status。 */
async function fetchQuotaPerUnit(baseUrl: string, jar: CookieJar): Promise<number | null> {
  const res = await requestJson<Envelope<{ quota_per_unit?: number }>>(baseUrl, '/api/status', {
    cookieJar: jar
  }).catch(() => null)
  const value = res?.data?.data?.quota_per_unit
  return typeof value === 'number' && value > 0 ? value : null
}
