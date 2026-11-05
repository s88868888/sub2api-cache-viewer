import type {
  CompareColumn,
  CompareTarget,
  QueryResult,
  SiteGroupOption,
  SiteKind,
  SiteSamples,
  UsageRecord
} from './adapters'
import { cacheRateOf } from './adapters'

/**
 * 每站最多拉这么多条再聚合。对比要样本够才有意义，
 * 但全量拉一个重度账号可能上万条会把界面卡住 —— 所以拉满并如实标注截断。
 */
export const SAMPLE_CAP = 4000
const SAMPLE_PAGE = 1000

/** 与明细表同一口径：输出太小的请求算出的 TPS 没有统计意义 */
const MIN_OUTPUT_FOR_TPS = 300

export interface Sample {
  siteId: string
  label: string
  kind: SiteKind
  records: UsageRecord[]
  truncated: boolean
  /** 只要有任意一条拿不到美元成本，就不能宣称该站的成本列可比较 */
  costUsdKnown: boolean
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function tpsOf(record: UsageRecord): number | null {
  if (!record.durationMs || record.durationMs <= 0) return null
  if (record.outputTokens < MIN_OUTPUT_FOR_TPS) return null
  return record.outputTokens / (record.durationMs / 1000)
}

/**
 * 逐页拉取直到拉满或取完。
 * kind 由调用方给出：UsageRecord 本身不带站点类型，跨站对比时不能从记录里猜。
 */
export async function collectSample(
  site: { siteId: string; label: string; kind: SiteKind },
  fetchPage: (page: number, pageSize: number) => Promise<QueryResult>
): Promise<Sample> {
  const records: UsageRecord[] = []
  let page = 1
  let truncated = false

  for (;;) {
    const res = await fetchPage(page, SAMPLE_PAGE)
    records.push(...res.items)
    if (res.items.length === 0 || records.length >= res.total) break
    if (records.length >= SAMPLE_CAP) {
      truncated = true
      break
    }
    page += 1
  }

  const kept = records.slice(0, SAMPLE_CAP)

  return {
    siteId: site.siteId,
    label: site.label,
    kind: site.kind,
    records: kept,
    truncated,
    costUsdKnown: kept.length > 0 && kept.every((r) => r.costUsd !== null)
  }
}

/** 只列出真实有数据的分组，避免选到一个空列 */
export function groupsOf(sample: Sample): SiteGroupOption[] {
  const counts = new Map<string, number>()
  for (const record of sample.records) {
    counts.set(record.groupName, (counts.get(record.groupName) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, requests]) => ({ name, requests }))
    .sort((a, b) => b.requests - a.requests)
}

export function buildColumn(sample: Sample, target: CompareTarget): CompareColumn | null {
  const rows = sample.records.filter((r) => r.groupName === target.groupName)
  if (!rows.length) return null

  let input = 0
  let creation = 0
  let read = 0
  let output = 0
  let totalTokens = 0
  let costUsd = 0
  let costKnown = true

  for (const r of rows) {
    input += r.inputTokens
    creation += r.cacheCreationTokens
    read += r.cacheReadTokens
    output += r.outputTokens
    totalTokens += r.totalTokens
    if (r.costUsd === null) costKnown = false
    else costUsd += r.costUsd
  }

  const inputSide = input + creation + read
  const tpsValues = rows.map(tpsOf).filter((v): v is number => v !== null)
  const ttftValues = rows
    .map((r) => r.firstTokenMs)
    .filter((v): v is number => v !== null && v > 0)

  return {
    siteId: sample.siteId,
    siteLabel: sample.label,
    groupName: target.groupName,
    kind: sample.kind,
    requests: rows.length,
    totalTokens,
    cacheRate: cacheRateOf(input, creation, read),
    uncachedShare: inputSide > 0 ? (input + creation) / inputSide : 0,
    costUsd: costKnown ? costUsd : null,
    pricePerMTokens: costKnown && totalTokens > 0 ? (costUsd / totalTokens) * 1e6 : null,
    costPerRequest: costKnown && rows.length > 0 ? costUsd / rows.length : null,
    tokensPerRequest: rows.length ? totalTokens / rows.length : 0,
    medianTps: median(tpsValues),
    tpsSamples: tpsValues.length,
    medianTtftMs: median(ttftValues),
    truncated: sample.truncated
  }
}

export function toSiteSample(sample: Sample): SiteSamples {
  return {
    siteId: sample.siteId,
    label: sample.label,
    kind: sample.kind,
    costUsdKnown: sample.costUsdKnown,
    groups: groupsOf(sample),
    error: null
  }
}
