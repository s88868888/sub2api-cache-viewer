import type { UsageRow } from './rows'

export type Severity = 'none' | 'warn' | 'bad'

/** 分项标记，让具体越界的数字变色，而不是整行泛一层底色 */
export interface AnomalyFlags {
  cacheRate: Severity
  throughput: Severity
}

export interface AnomalyRow extends UsageRow {
  severity: Severity
  flags: AnomalyFlags
  /** 触发原因，用于悬浮提示 */
  reasons: string[]
}

/**
 * 同组样本少于这个数量时，中位数本身没有代表性，不做判定。
 * 界面会明确说明「样本不足不判定」，避免把「没标色」误读成「没异常」。
 */
const MIN_SAMPLES = 5

const CACHE_GAP_WARN = 0.15
const CACHE_GAP_BAD = 0.4

/**
 * 输出太少时 TPS 没有统计意义：首字耗时（几秒）会主导整个比值，
 * 46 token 的请求算出 11 TPS 只是分母太小，不是真的慢。
 */
const MIN_OUTPUT_FOR_TPS = 300

const TPS_RATIO_WARN = 1.8
const TPS_RATIO_BAD = 2.8

interface Baseline {
  count: number
  medianCacheRate: number
  medianTps: number
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 站点 + 模型 + 分组：倍率和单价都挂在分组上，跨分组比会失真 */
function groupKey(row: UsageRow): string {
  return `${row.siteLabel}||${row.model}||${row.groupName}`
}

/** 输出 token / 秒。原始耗时随输出量线性增长，直接比耗时等于比谁活儿多 */
export function tpsOf(row: UsageRow): number | null {
  if (!row.durationMs || row.durationMs <= 0) return null
  if (row.outputTokens < MIN_OUTPUT_FOR_TPS) return null
  return row.outputTokens / (row.durationMs / 1000)
}


function baselines(rows: UsageRow[]): Map<string, Baseline> {
  const buckets = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const key = groupKey(row)
    const list = buckets.get(key)
    if (list) list.push(row)
    else buckets.set(key, [row])
  }

  const result = new Map<string, Baseline>()
  for (const [key, list] of buckets) {
    result.set(key, {
      count: list.length,
      medianCacheRate: median(list.map((r) => r.cacheRate)),
      medianTps: median(list.map(tpsOf).filter((v): v is number => v !== null))
    })
  }
  return result
}

function pct(points: number): string {
  return `${(points * 100).toFixed(0)} 个百分点`
}

function worse(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { none: 0, warn: 1, bad: 2 }
  return rank[a] >= rank[b] ? a : b
}

function grade(value: number, warnAt: number, badAt: number): Severity {
  if (value >= badAt) return 'bad'
  if (value >= warnAt) return 'warn'
  return 'none'
}

function evaluate(
  row: UsageRow,
  base: Baseline
): { severity: Severity; flags: AnomalyFlags; reasons: string[] } {
  const none = {
    severity: 'none' as Severity,
    flags: { cacheRate: 'none' as Severity, throughput: 'none' as Severity },
    reasons: [] as string[]
  }
  if (base.count < MIN_SAMPLES) return none

  const flags: AnomalyFlags = { cacheRate: 'none', throughput: 'none' }
  const reasons: string[] = []

  // 缓存率只有「偏低」才是异常，偏高是好事
  const cacheGap = base.medianCacheRate - row.cacheRate
  flags.cacheRate = grade(cacheGap, CACHE_GAP_WARN, CACHE_GAP_BAD)
  if (flags.cacheRate !== 'none') {
    reasons.push(`缓存率比同组中位数低 ${pct(cacheGap)}`)
  }

  // 吞吐只有「偏低」才是异常，比同组快是好事
  const tps = tpsOf(row)
  if (tps !== null && base.medianTps > 0) {
    // 倒数比：吞吐是中位数的 1/3，慢的程度就是 3 倍
    const slowFactor = base.medianTps / tps
    flags.throughput = grade(slowFactor, TPS_RATIO_WARN, TPS_RATIO_BAD)
    if (flags.throughput !== 'none') {
      reasons.push(
        `输出吞吐 ${tps.toFixed(0)} tok/s，只有同组中位数 ${base.medianTps.toFixed(0)} 的 1/${slowFactor.toFixed(1)}`
      )
    }
  }

  const severity = worse(flags.cacheRate, flags.throughput)
  return { severity, flags, reasons }
}

export function annotate(rows: UsageRow[]): AnomalyRow[] {
  const bases = baselines(rows)
  return rows.map((row) => ({ ...row, ...evaluate(row, bases.get(groupKey(row))!) }))
}

export function countBySeverity(rows: AnomalyRow[]): { bad: number; warn: number } {
  let bad = 0
  let warn = 0
  for (const row of rows) {
    if (row.severity === 'bad') bad++
    else if (row.severity === 'warn') warn++
  }
  return { bad, warn }
}

/** 样本不足的分组数量，用于图例里说明「为什么有些行没标色」 */
export function underSampledGroups(rows: UsageRow[]): number {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = groupKey(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let small = 0
  for (const count of counts.values()) if (count < MIN_SAMPLES) small++
  return small
}
