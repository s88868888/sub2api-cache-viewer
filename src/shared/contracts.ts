export type SiteKind = 'sub2api' | 'newapi'

export interface GroupOption {
  id: string
  name: string
}

/**
 * 归一化后的单条用量记录。
 *
 * 两个站点对 input/prompt 的口径不同，适配器必须在写入本结构前完成换算，
 * 使 inputTokens 恒等于「未命中缓存的输入」。
 */
export interface UsageRecord {
  id: string
  /** epoch 毫秒 */
  createdAt: number
  model: string
  groupName: string
  endpoint: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
  actualCost: number
  /**
   * 折算成美元的成本，跨站对比只能用它。
   * 拿不到换算系数时为 null —— 此时该站的成本列不参与对比，
   * 而不是拿别的计价单位当美元混算。
   */
  costUsd: number | null
  durationMs: number | null
  firstTokenMs: number | null
  stream: boolean | null
  /** 0..1 */
  cacheRate: number
}

export interface UsageSummary {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
  actualCost: number
  /** 0..1，按 token 加权而非逐条平均 */
  cacheRate: number
}

export function createEmptySummary(): UsageSummary {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cost: 0,
    actualCost: 0,
    cacheRate: 0
  }
}

export interface QueryFilters {
  page: number
  pageSize: number
  groupId: string | null
  model: string | null
  keyword: string | null
  startMs: number | null
  endMs: number | null
  /** 对比采样会连续翻很多页，没必要每页都去拉一次余额 */
  skipBalance?: boolean
}

/**
 * 账户余额。sub2api 直接给美元；
 * 以 quota 记账的站点换算不出来时只展示原生值。
 */
export interface SiteBalance {
  raw: number
  unit: 'USD' | 'quota'
  usd: number | null
}

export interface QueryResult {
  items: UsageRecord[]
  total: number
  page: number
  pageSize: number
  summary: UsageSummary
  /** 汇总仅由当前页明细累加得出，而非服务端全量统计 */
  summaryIsPageScoped: boolean
  balance: SiteBalance | null
}

/**
 * 建立会话用的凭据。token 是内置浏览器登录时截获并校验过的面板令牌，
 * 面板接口只认它，`sk-` 开头的 API key 读不到用量记录。
 */
export interface LoginParams {
  baseUrl: string
  token: string
  kind?: SiteKind
}

export interface ConnectionInfo {
  kind: SiteKind
  baseUrl: string
  account: string
  groups: GroupOption[]
}

/**
 * 已保存的站点。令牌只留在主进程，
 * 渲染层只看 hasToken，避免凭据跨 IPC 回流。
 */
export interface SiteProfile {
  id: string
  /** 用户自定义名称，默认取域名 */
  label: string
  baseUrl: string
  kind: SiteKind
  account: string
  hasToken: boolean
  lastUsedAt: number | null
}

export interface SiteDraft {
  id?: string
  label: string
  baseUrl: string
  kind: SiteKind
  account: string
  /** 仅在内置浏览器拿到令牌后下发；未下发时保留原值，空字符串表示清除 */
  token?: string
}

export interface SiteState {
  profile: SiteProfile
  connected: boolean
}

/** 单个站点的一次查询结果；失败也占一条，便于合并视图如实展示。 */
export interface SiteResult {
  siteId: string
  label: string
  kind: SiteKind
  error: string | null
  result: QueryResult | null
}

export interface AggregateResult {
  sites: SiteResult[]
  /** 跨站 token 加权合并；费用单位不同不参与合并 */
  merged: UsageSummary
  okCount: number
  failedCount: number
}

/**
 * 全量扫描的逐日趋势点。
 * requests 为 0 表示这一天没有数据 —— 界面按断线处理，
 * 否则一个空档日会被画成 0% 命中率，看着像缓存彻底失效。
 */
export interface TrendPoint {
  /** 本地日期 YYYY-MM-DD */
  day: string
  requests: number
  /** 0..1 */
  cacheRate: number
}

/** 一条趋势线：单站点视图按分组分线，合并视图按站点分线 */
export interface TrendSeries {
  key: string
  label: string
  /** 与 ScanResult.days 等长同序 */
  points: TrendPoint[]
}

/** 单站点的全量扫描结果；失败也占一条，便于合并视图如实展示 */
export interface SiteScan {
  siteId: string
  label: string
  kind: SiteKind
  error: string | null
  summary: UsageSummary | null
  /** 实际参与统计的记录数，可能小于服务端 total */
  sampled: number
  truncated: boolean
}

export interface ScanResult {
  sites: SiteScan[]
  /** 与 aggregate 同一合并口径：token 加权，混站时费用不合并 */
  merged: UsageSummary
  okCount: number
  failedCount: number
  days: string[]
  series: TrendSeries[]
  sampleCap: number
}

/** 明细表可隐藏的列 */
export type ColumnKey =
  | 'site'
  | 'model'
  | 'group'
  | 'input'
  | 'output'
  | 'cacheWrite'
  | 'cacheRead'
  | 'cacheRate'
  | 'total'
  | 'cost'
  | 'ttft'
  | 'tps'
  | 'duration'

export type Theme = 'light' | 'dark'

export interface Prefs {
  /** 侧栏是否折叠 */
  sidebarCollapsed: boolean
  /** 被隐藏的列，空数组表示全部显示 */
  hiddenColumns: ColumnKey[]
  /** 未设置时跟随系统 */
  theme: Theme | null
}

export const DEFAULT_PREFS: Prefs = {
  sidebarCollapsed: false,
  hiddenColumns: [],
  theme: null
}

/** 一个对比列 = 某站点的某个分组 */
export interface CompareTarget {
  siteId: string
  groupName: string
}

export interface CompareColumn {
  siteId: string
  siteLabel: string
  groupName: string
  kind: SiteKind
  requests: number
  totalTokens: number
  /** 0..1 */
  cacheRate: number
  /** 未命中输入占输入侧的比例，用来解释缓存率为什么低 */
  uncachedShare: number
  costUsd: number | null
  pricePerMTokens: number | null
  costPerRequest: number | null
  tokensPerRequest: number
  medianTps: number | null
  /** 参与 TPS 统计的请求数（输出量太小的不计入） */
  tpsSamples: number
  medianTtftMs: number | null
  /** 样本触到上限，统计基于截断后的数据 */
  truncated: boolean
}

export interface SiteGroupOption {
  name: string
  requests: number
}

export interface SiteSamples {
  siteId: string
  label: string
  kind: SiteKind
  /** false 表示该站成本无法折算成美元，成本类指标会留空 */
  costUsdKnown: boolean
  groups: SiteGroupOption[]
  error: string | null
}

export interface CompareResult {
  sites: SiteSamples[]
  columns: CompareColumn[]
  sampleCap: number
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; kind: 'auth' | 'network' | 'shape' | 'unknown'; status?: number } }
