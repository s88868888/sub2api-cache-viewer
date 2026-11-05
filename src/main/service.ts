import { CookieJar } from './http'
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
  SiteError,
  SiteKind,
  SiteResult,
  SiteSamples,
  SiteSession,
  UsageSummary,
  cacheRateOf,
  detectSite,
  emptySummary,
  newapiLogin,
  newapiQuery,
  sub2apiLogin,
  sub2apiLoginWithJwt,
  sub2apiPanelSeed,
  sub2apiQuery,
  type PanelSeed
} from './adapters'

export interface PanelCredential {
  kind: SiteKind
  baseUrl: string
  seed: PanelSeed | null
  cookies: Array<{ name: string; value: string }>
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

/** 采样缓存寿命：改选择项时不该重新打接口，但也不能拿着一小时前的数据对比 */
const SAMPLE_TTL_MS = 60_000

interface Active {
  session: SiteSession
  jar: CookieJar | null
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

  /** 建立（或复用）某个站点的会话。已连接时直接返回缓存信息。 */
  async connect(siteId: string, params: LoginParams): Promise<ConnectionInfo> {
    const existing = this.actives.get(siteId)
    if (existing) return this.infoOf(existing.session)

    const active = await this.open(params)
    this.actives.set(siteId, active)
    return this.infoOf(active.session)
  }

  private async open(params: LoginParams): Promise<Active> {
    if (params.mode === 'browser') {
      throw new SiteError('内置浏览器登录请走 capture 通道，由主进程截获令牌', 'shape')
    }

    const kind = params.kind ?? (await detectSite(params.baseUrl))
    if (!kind) {
      throw new SiteError(
        '无法识别站点类型：既不是 sub2api 也不是 new-api/one-api，请检查地址是否正确',
        'shape'
      )
    }

    if (params.mode === 'jwt' || kind === 'sub2api') {
      const session =
        params.mode === 'jwt'
          ? await sub2apiLoginWithJwt(params.baseUrl, (params.jwt ?? '').trim())
          : await sub2apiLogin(params.baseUrl, params.username.trim(), params.password, params.totp)
      return { session, jar: null, params }
    }

    const { session, jar } = await newapiLogin(params.baseUrl, params.username.trim(), params.password)
    return { session, jar, params }
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
    const { session, jar } = active
    return session.kind === 'sub2api'
      ? sub2apiQuery(session, filters)
      : newapiQuery(session, jar!, filters)
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
      merged: mergeSummaries(ok),
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
          return { ok: true, data: await this.sampleFor(site, input) }
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

  private async sampleFor(site: CompareSiteInput, input: CompareInput): Promise<Sample> {
    const key = `${site.siteId}|${input.startMs ?? 'all'}|${input.endMs ?? 'now'}|${input.model ?? ''}`
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
          model: input.model,
          keyword: null,
          startMs: input.startMs,
          endMs: input.endMs,
          skipBalance: true
        })
    )

    this.samples.set(key, { at: Date.now(), data: sample })
    return sample
  }

  /**
   * 免登录打开官网面板所需的凭据。
   * sub2api 走 localStorage 注入，new-api 走会话 cookie 注入 —— 两套前端机制不同。
   */
  async panelCredential(siteId: string, params: LoginParams): Promise<PanelCredential> {
    await this.connect(siteId, params)
    const active = this.actives.get(siteId)
    if (!active) throw new SiteError('该站点未能建立会话', 'auth')

    if (active.session.kind === 'sub2api') {
      return {
        kind: 'sub2api',
        baseUrl: active.session.baseUrl,
        seed: await sub2apiPanelSeed(active.session),
        cookies: []
      }
    }

    return {
      kind: 'newapi',
      baseUrl: active.session.baseUrl,
      seed: null,
      cookies: active.jar?.entries() ?? []
    }
  }
}

/**
 * 跨站合并。token 是同一量纲可以直接相加，缓存率按 token 加权重算；
 * 费用在 sub2api 是美元、new-api 是 quota，混站时不合并，避免得出无意义的数字。
 */
function mergeSummaries(sites: SiteResult[]): UsageSummary {
  const merged = emptySummary()
  for (const site of sites) {
    const s = site.result?.summary
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

  const kinds = new Set(sites.map((s) => s.kind))
  if (kinds.size === 1) {
    for (const site of sites) {
      merged.cost += site.result?.summary.cost ?? 0
      merged.actualCost += site.result?.summary.actualCost ?? 0
    }
  }

  return merged
}
