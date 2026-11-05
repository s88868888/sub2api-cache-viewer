import type { TrendPoint, TrendSeries } from '../shared/contracts'
import { cacheRateOf, type UsageRecord } from './adapters'

const DAY_MS = 86_400_000

/**
 * 横轴最多这么多天。「全部时间」的账号可能跨几年，
 * 不封顶的话画出来是一条压扁到看不出差别的线。
 */
const MAX_DAYS = 120

/** 用本地日期而不是 UTC：用户关心的是自己账上的自然日 */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * 补齐成连续的日历日。
 *
 * 服务端只按「最近 N 条」返回，中间停用的日子会整段缺席，
 * 直接拿出现过的日期当轴会让相邻两天其实隔了三周。
 */
export function dayAxis(records: UsageRecord[]): string[] {
  if (!records.length) return []
  const present = new Set(records.map((r) => localDay(r.createdAt)))
  const sorted = [...present].sort()
  const start = Date.parse(`${sorted[0]}T00:00:00`)
  const end = Date.parse(`${sorted[sorted.length - 1]}T00:00:00`)
  if (Number.isNaN(start) || Number.isNaN(end)) return sorted

  const days: string[] = []
  for (let t = start; t <= end && days.length < MAX_DAYS; t += DAY_MS) {
    days.push(localDay(t))
  }
  // 跨度超过上限时保留最近的 MAX_DAYS 天，早段直接舍弃
  return days.slice(-MAX_DAYS)
}

export function bucketPoints(records: UsageRecord[], days: string[]): TrendPoint[] {
  const acc = new Map<string, { requests: number; input: number; creation: number; read: number }>()
  for (const r of records) {
    const key = localDay(r.createdAt)
    const slot = acc.get(key) ?? { requests: 0, input: 0, creation: 0, read: 0 }
    slot.requests += 1
    slot.input += r.inputTokens
    slot.creation += r.cacheCreationTokens
    slot.read += r.cacheReadTokens
    acc.set(key, slot)
  }

  return days.map((day) => {
    const slot = acc.get(day)
    return {
      day,
      requests: slot?.requests ?? 0,
      // 没有数据的日子留 0 并由界面断线，不能算成一个真实的 0%
      cacheRate: slot ? cacheRateOf(slot.input, slot.creation, slot.read) : 0
    }
  })
}

export function buildSeries(
  groups: Array<{ key: string; label: string; records: UsageRecord[] }>,
  days: string[]
): TrendSeries[] {
  return groups.map((g) => ({
    key: g.key,
    label: g.label,
    points: bucketPoints(g.records, days)
  }))
}
