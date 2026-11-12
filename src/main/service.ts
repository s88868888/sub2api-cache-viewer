import {
  buildColumn,
  collectSample,
  groupsOf,
  SAMPLE_CAP,
  type Sample
} from './compare'
import {
  AggregateResult,
  CompareColumn,
  CompareResult,
  CompareTarget,
  ConnectionInfo,
  GroupOption,
  LoginParams,
  QueryFilters,
  QueryResult,
  ScanResult,
  SiteError,
  SiteKind,
  SiteResult,
  SiteSamples,
  SiteScan,
  SiteSession,
  UsageRecord,
  UsageSummary,
  cacheRateOf,
  detectSite,
  emptySummary,
  summarize,
  sub2apiLoginWithToken,
  sub2apiPanelSeed,
  sub2apiQuery,
  type PanelSeed
} from './adapters'
import { buildSeries, dayAxis } from './trend'

export interface PanelCredential {
  baseUrl: string
  seed: PanelSeed | null
}

export interface Target {
  siteId: string
  label: string
  params: LoginParams
}

export interface CompareSiteInput {
  siteId: string
  label: string
  params: LoginParams
  /**
   * 该站凭据不可用时由调用方填这里，而不是抛错打断整次对比 ——
   * 界面需要照常列出这一站并说明它为什么缺席。
   */
  paramsError?: string
}

export interface CompareInput {
  sites: CompareSiteInput[]
  targets: CompareTarget[]
  startMs: number | null
  endMs: number | null
  model: string | null
}

/** 全量扫描的入参：站点集合 + 一份筛选条件（分页字段在这里没有意义） */
export interface ScanInput {
  sites: CompareSiteInput[]
  groupId: string | null
  model: string | null
  startMs: number | null
  endMs: number | null
}

/** 采样缓存寿命：改选择项时不该重新打接口，但也不能拿着一小时前的数据对比 */
const SAMPLE_TTL_MS = 60_000

interface Active {
  session: SiteSession
  params: LoginParams
}

export class GatewayService {
  private readonly actives = new Map<string, Active>()
  private readonly samples = new Map<string, { at: number; data: Sample }>()

  isConnected(siteId: string): boolean {
    return this.actives.has(siteId)
  }

  connectedIds(): string[] {
    return [...this.actives.keys()]
  }

  groupsOf(siteId: string): GroupOption[] {
    return this.actives.get(siteId)?.session.groups ?? []
  }

  kindOf(siteId: string): SiteKind | null {
    return this.actives.get(siteId)?.session.kind ?? null
  }

  disconnect(siteId: string): void {
    this.actives.delete(siteId)
  }

  disconnectAll(): void {
    this.actives.clear()
  }

  /** 建立（或复用）某个站点的会话。凭据没变时直接返回缓存信息。 */
  async connect(siteId: string, params: LoginParams): Promise<ConnectionInfo> {
    const existing = this.actives.get(siteId)
    // 令牌换过就必须重开，否则新令牌只是落进了磁盘，内存里还在拿上一枚查询
    if (existing && existing.params.token === params.token) return this.infoOf(existing.session)

    const active = await this.open(params)
    this.actives.set(siteId, active)
    return this.infoOf(active.session)
  }

  private async open(params: LoginParams): Promise<Active> {
    const token = params.token.trim()
    if (!token) {
      throw new SiteError('该站点还没有可用令牌，请用内置浏览器登录一次', 'auth')
    }

    const kind = params.kind ?? (await detectSite(params.baseUrl))
    if (kind === 'newapi') {
      throw new SiteError('new-api 站点已不再支持，请添加 sub2api 站点', 'shape')
    }
    if (kind !== 'sub2api') {
      throw new SiteError('无法识别站点类型，请检查地址是否为 sub2api 站点', 'shape')
    }

    return { session: await sub2apiLoginWithToken(params.baseUrl, token), params }
  }

  private infoOf(session: SiteSession): ConnectionInfo {
    return {
      kind: session.kind,
      baseUrl: session.baseUrl,
      account: session.account,
      groups: session.groups
    }
  }

  async query(siteId: string, filters: QueryFilters): Promise<QueryResult> {
    const active = this.actives.get(siteId)
    if (!active) throw new SiteError('该站点尚未连接', 'auth')
    try {
      return await this.runQuery(active, filters)
    } catch (err) {
      // 会话过期时用原凭据静默重登一次，避免用户每次都要重新点连接
      if (err instanceof SiteError && err.kind === 'auth') {
        const reopened = await this.open(active.params)
        this.actives.set(siteId, reopened)
        return await this.runQuery(reopened, filters)
      }
      throw err
    }
  }

  private async runQuery(active: Active, filters: QueryFilters): Promise<QueryResult> {
    return sub2apiQuery(active.session, filters)
  }

  /**
   * 并发拉取多个站点。单个站点失败不影响其余站点，
   * 失败原因如实带在结果里，由界面显示而不是静默吞掉。
   */
  async aggregate(targets: Target[], filters: QueryFilters): Promise<AggregateResult> {
    const settled = await Promise.allSettled(
      targets.map(async (target) => {
        await this.connect(target.siteId, target.params)
        const result = await this.query(target.siteId, filters)
        const session = this.actives.get(target.siteId)!.session
        return {
          siteId: target.siteId,
          label: target.label,
          kind: session.kind,
          error: null,
          result
        } satisfies SiteResult
      })
    )

    const sites: SiteResult[] = settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            siteId: targets[index].siteId,
            label: targets[index].label,
            kind: targets[index].params.kind ?? 'sub2api',
            error:
              outcome.reason instanceof SiteError
                ? outcome.reason.message
                : String(outcome.reason),
            result: null
          }
    )

    const ok = sites.filter((s) => s.result)
    return {
      sites,
      merged: mergeSummaries(
        ok.map((s) => ({ kind: s.kind, summary: s.result?.summary ?? null }))
      ),
      okCount: ok.length,
      failedCount: sites.length - ok.length
    }
  }

  /**
   * 对比：按站点拉满时间范围的样本，再按 (站点, 分组) 聚合成列。
   * 采样按「站点+时间范围+模型」缓存 60 秒，调整选择项不会重复打接口。
   */
  async compare(input: CompareInput): Promise<CompareResult> {
    type Outcome = { ok: true; data: Sample } | { ok: false; error: string }

    const outcomes: Outcome[] = await Promise.all(
      input.sites.map(async (site): Promise<Outcome> => {
        if (site.paramsError) return { ok: false, error: site.paramsError }
        try {
          return { ok: true, data: await this.sampleOf(site, input) }
        } catch (err) {
          return { ok: false, error: err instanceof SiteError ? err.message : String(err) }
        }
      })
    )

    const sites: SiteSamples[] = outcomes.map((outcome, index) => {
      const site = input.sites[index]
      if (!outcome.ok) {
        return {
          siteId: site.siteId,
          label: site.label,
          kind: site.params.kind ?? 'sub2api',
          costUsdKnown: false,
          groups: [],
          error: outcome.error
        }
      }
      const sample = outcome.data
      return {
        siteId: sample.siteId,
        label: sample.label,
        kind: sample.kind,
        costUsdKnown: sample.costUsdKnown,
        groups: groupsOf(sample),
        error: null
      }
    })

    const columns: CompareColumn[] = []
    for (const target of input.targets) {
      const index = input.sites.findIndex((s) => s.siteId === target.siteId)
      if (index < 0) continue
      const outcome = outcomes[index]
      if (!outcome.ok) continue
      const column = buildColumn(outcome.data, target)
      if (column) columns.push(column)
    }

    return { sites, columns, sampleCap: SAMPLE_CAP }
  }

  /**
   * 逐页拉满时间范围。对比和全量扫描用同一把 key 缓存，
   * 所以在对比里已经拉过的站点，切回明细看全量时不会再打一遍接口。
   */
  private async sampleOf(
    site: CompareSiteInput,
    window: { startMs: number | null; endMs: number | null; model: string | null }
  ): Promise<Sample> {
    const key = `${site.siteId}|${window.startMs ?? 'all'}|${window.endMs ?? 'now'}|${window.model ?? ''}`
    const cached = this.samples.get(key)
    if (cached && Date.now() - cached.at < SAMPLE_TTL_MS) return cached.data

    await this.connect(site.siteId, site.params)
    const kind = this.kindOf(site.siteId) ?? site.params.kind ?? 'sub2api'

    // 采样器只认「累计条数 >= total 就算取完」，所以把分页结果原样交给它
    const sample = await collectSample(
      { siteId: site.siteId, label: site.label, kind },
      (page, pageSize) =>
        this.query(site.siteId, {
          page,
          pageSize,
          groupId: null,
          model: window.model,
          keyword: null,
          startMs: window.startMs,
          endMs: window.endMs,
          skipBalance: true
        })
    )

    this.samples.set(key, { at: Date.now(), data: sample })
    return sample
  }

  /**
   * 全量扫描：把时间范围内的记录拉完再汇总，用来替掉「只累加当前页」的汇总。
   * 明细表本身还是分页的，这里只负责让顶部那个数字覆盖整个区间。
   */
  async scan(input: ScanInput): Promise<ScanResult> {
    type Outcome = { ok: true; data: Sample } | { ok: false; error: string }

    const outcomes: Outcome[] = await Promise.all(
      input.sites.map(async (site): Promise<Outcome> => {
        if (site.paramsError) return { ok: false, error: site.paramsError }
        try {
          return { ok: true, data: await this.sampleOf(site, input) }
        } catch (err) {
          return { ok: false, error: err instanceof SiteError ? err.message : String(err) }
        }
      })
    )

    const sites: SiteScan[] = outcomes.map((outcome, index) => {
      const site = input.sites[index]
      if (!outcome.ok) {
        return {
          siteId: site.siteId,
          label: site.label,
          kind: site.params.kind ?? 'sub2api',
          error: outcome.error,
          summary: null,
          sampled: 0,
          truncated: false
        }
      }
      const records = input.groupId
        ? outcome.data.records.filter((r) => r.groupName === input.groupId)
        : outcome.data.records
      return {
        siteId: site.siteId,
        label: site.label,
        kind: outcome.data.kind,
        error: null,
        summary: summarize(records),
        sampled: records.length,
        truncated: outcome.data.truncated
      }
    })

    const ok = sites.filter((s) => s.summary)
    const recordsOf = (siteId: string): UsageRecord[] => {
      const index = input.sites.findIndex((s) => s.siteId === siteId)
      const outcome = index < 0 ? undefined : outcomes[index]
      if (!outcome || !outcome.ok) return []
      const list = outcome.data.records
      return input.groupId ? list.filter((r) => r.groupName === input.groupId) : list
    }

    const flat = ok.flatMap((s) => recordsOf(s.siteId))
    const days = dayAxis(flat)
    // 单站点时按分组分线才有意义；合并视图下每个站点一条线
    const series = buildSeries(
      input.sites.length === 1
        ? topGroups(ok[0] ? recordsOf(ok[0].siteId) : []).map((g) => ({
            key: g.name,
            label: g.name,
            records: g.records
          }))
        : ok.map((s) => ({ key: s.siteId, label: s.label, records: recordsOf(s.siteId) })),
      days
    )

    return {
      sites,
      merged: mergeSummaries(
        ok.map((s) => ({ kind: s.kind, summary: s.summary }))
      ),
      okCount: ok.length,
      failedCount: sites.length - ok.length,
      days,
      series,
      sampleCap: SAMPLE_CAP
    }
  }

  /** 免登录打开官网面板所需的凭据（往面板的 localStorage 里种令牌）。 */
  async panelCredential(siteId: string, params: LoginParams): Promise<PanelCredential> {
    await this.connect(siteId, params)
    const active = this.actives.get(siteId)
    if (!active) throw new SiteError('该站点未能建立会话', 'auth')

    return { baseUrl: active.session.baseUrl, seed: await sub2apiPanelSeed(active.session) }
  }
}

/**
 * 跨站合并。token 是同一量纲可以直接相加，缓存率按 token 加权重算；
 * 费用在 sub2api 是美元、new-api 是 quota，混站时不合并，避免得出无意义的数字。
 * 分页汇总和全量扫描都走这里，两条路径的合并口径必须一致。
 */
function mergeSummaries(entries: Array<{ kind: SiteKind; summary: UsageSummary | null }>): UsageSummary {
  const merged = emptySummary()
  for (const entry of entries) {
    const s = entry.summary
    if (!s) continue
    merged.requests += s.requests
    merged.inputTokens += s.inputTokens
    merged.outputTokens += s.outputTokens
    merged.cacheCreationTokens += s.cacheCreationTokens
    merged.cacheReadTokens += s.cacheReadTokens
    merged.totalTokens += s.totalTokens
  }

  merged.cacheRate = cacheRateOf(
    merged.inputTokens,
    merged.cacheCreationTokens,
    merged.cacheReadTokens
  )

  const kinds = new Set(entries.map((e) => e.kind))
  if (kinds.size === 1) {
    for (const entry of entries) {
      merged.cost += entry.summary?.cost ?? 0
      merged.actualCost += entry.summary?.actualCost ?? 0
    }
  }

  return merged
}

/** 按请求数排序的分组记录，用来决定趋势图画哪几条线 */
function topGroups(records: UsageRecord[]): Array<{ name: string; records: UsageRecord[] }> {
  const buckets = new Map<string, UsageRecord[]>()
  for (const r of records) {
    const list = buckets.get(r.groupName)
    if (list) list.push(r)
    else buckets.set(r.groupName, [r])
  }
  return [...buckets.entries()]
    .map(([name, list]) => ({ name, records: list }))
    .sort((a, b) => b.records.length - a.records.length)
}
