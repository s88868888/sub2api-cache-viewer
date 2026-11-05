import { createEmptySummary, type GroupOption, type SiteKind, type UsageRecord, type UsageSummary } from '../../shared/contracts'

export type {
  AggregateResult,
  CompareColumn,
  CompareResult,
  CompareTarget,
  ConnectionInfo,
  GroupOption,
  LoginParams,
  QueryFilters,
  QueryResult,
  SiteBalance,
  SiteGroupOption,
  SiteKind,
  SiteResult,
  SiteSamples,
  ScanResult,
  SiteScan,
  TrendPoint,
  TrendSeries,
  UsageRecord,
  UsageSummary
} from '../../shared/contracts'

export class SiteError extends Error {
  readonly kind: 'auth' | 'network' | 'shape' | 'unknown'
  readonly status?: number

  constructor(
    message: string,
    kind: 'auth' | 'network' | 'shape' | 'unknown' = 'unknown',
    status?: number
  ) {
    super(message)
    this.name = 'SiteError'
    this.kind = kind
    this.status = status
  }
}

/**
 * 缓存命中率。
 *
 * 分母必须同时包含未命中输入与写入缓存的开销，否则写缓存密集的时段会虚高。
 */
export function cacheRateOf(
  uncachedInput: number,
  cacheCreation: number,
  cacheRead: number
): number {
  const denominator = uncachedInput + cacheCreation + cacheRead
  return denominator > 0 ? cacheRead / denominator : 0
}

export { createEmptySummary as emptySummary } from '../../shared/contracts'

/** 由明细累加得出汇总，用于服务端没有聚合接口或聚合口径不一致时兜底。 */
export function summarize(records: UsageRecord[]): UsageSummary {
  const s = createEmptySummary()
  for (const r of records) {
    s.requests += 1
    s.inputTokens += r.inputTokens
    s.outputTokens += r.outputTokens
    s.cacheCreationTokens += r.cacheCreationTokens
    s.cacheReadTokens += r.cacheReadTokens
    s.totalTokens += r.totalTokens
    s.cost += r.cost
    s.actualCost += r.actualCost
  }
  s.cacheRate = cacheRateOf(s.inputTokens, s.cacheCreationTokens, s.cacheReadTokens)
  return s
}

/** 主进程内部的会话状态，cred 是适配器私有的凭据 blob，必须可 JSON 序列化。 */
export interface SiteSession {
  kind: SiteKind
  baseUrl: string
  account: string
  groups: GroupOption[]
  cred: Record<string, unknown>
}
