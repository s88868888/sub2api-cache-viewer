import type { CompareColumn } from '../../../shared/contracts'

export type Direction = 'high' | 'low' | 'none'

export interface MetricRow {
  key: string
  label: string
  hint?: string
  /** high = 越大越好，low = 越小越好，none = 仅陈述不参与判定 */
  direction: Direction
  value: (c: CompareColumn) => number | null
  format: (c: CompareColumn) => string
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
const usd = (v: number | null, digits = 4): string => (v === null ? '—' : `$${v.toFixed(digits)}`)

export const METRICS: MetricRow[] = [
  {
    key: 'requests',
    label: '样本请求数',
    hint: '统计基于多少条记录，太小则下面的比率类指标不可信',
    direction: 'none',
    value: (c) => c.requests,
    format: (c) => c.requests.toLocaleString('zh-CN')
  },
  {
    key: 'totalTokens',
    label: '总 Token',
    direction: 'none',
    value: (c) => c.totalTokens,
    format: (c) => `${(c.totalTokens / 1e6).toFixed(2)}M`
  },
  {
    key: 'cacheRate',
    label: '缓存命中率',
    hint: '缓存读取 ÷ (未命中输入 + 缓存写 + 缓存读)',
    direction: 'high',
    value: (c) => c.cacheRate,
    format: (c) => pct(c.cacheRate)
  },
  {
    key: 'uncachedShare',
    label: '未命中输入占比',
    hint: '缓存命中率的另一面，用来说明命中率低时钱花在哪',
    direction: 'none',
    value: (c) => c.uncachedShare,
    format: (c) => pct(c.uncachedShare)
  },
  {
    key: 'price',
    label: '有效单价',
    hint: '实际花费 ÷ 总 token，折算成每百万 token 的美元价 —— 跨站比较成本只能用这个，比"总花费"公平',
    direction: 'low',
    value: (c) => c.pricePerMTokens,
    format: (c) => (c.pricePerMTokens === null ? '不可换算' : `$${c.pricePerMTokens.toFixed(2)}/M`)
  },
  {
    key: 'costPerRequest',
    label: '每请求平均成本',
    hint: '受单次请求体量影响，只作陈述不参与判定',
    direction: 'none',
    value: (c) => c.costPerRequest,
    format: (c) => usd(c.costPerRequest, 5)
  },
  {
    key: 'tokensPerRequest',
    label: '每请求平均 Token',
    hint: '用来解释上面的成本差异：活儿多的请求本来就更贵',
    direction: 'none',
    value: (c) => c.tokensPerRequest,
    format: (c) => Math.round(c.tokensPerRequest).toLocaleString('zh-CN')
  },
  {
    key: 'totalCost',
    label: '区间总花费',
    hint: '取决于用了多少，不代表谁更划算，不参与判定',
    direction: 'none',
    value: (c) => c.costUsd,
    format: (c) => usd(c.costUsd, 4)
  },
  {
    key: 'tps',
    label: '输出吞吐（中位）',
    hint: 'tok/s，仅统计输出 ≥300 token 的请求',
    direction: 'high',
    value: (c) => c.medianTps,
    format: (c) => (c.medianTps === null ? '样本不足' : `${c.medianTps.toFixed(1)} tok/s`)
  },
  {
    key: 'ttft',
    label: '首字耗时（中位）',
    direction: 'low',
    value: (c) => c.medianTtftMs,
    format: (c) => (c.medianTtftMs === null ? '—' : `${(c.medianTtftMs / 1000).toFixed(2)}s`)
  }
]

/** 参与"综合更优"判定的行 */
export const SCORED_KEYS = METRICS.filter((m) => m.direction !== 'none').map((m) => m.key)

export interface RowRanking {
  metric: MetricRow
  /** 并列最优时会有多个 */
  best: Set<number>
}

/**
 * 每行取最优列。null（缺数据）不参与，也不会被判为最差 ——
 * 否则一个换算不出美元的站点会因为"没有值"而输掉整行。
 */
export function rankRows(columns: CompareColumn[]): RowRanking[] {
  return METRICS.map((metric) => {
    const best = new Set<number>()
    if (metric.direction === 'none' || !columns.length) return { metric, best }

    const values = columns.map((c) => metric.value(c))
    const usable = values.filter((v): v is number => v !== null)
    if (!usable.length) return { metric, best }

    const target = metric.direction === 'high' ? Math.max(...usable) : Math.min(...usable)
    values.forEach((v, index) => {
      if (v !== null && v === target) best.add(index)
    })
    return { metric, best }
  })
}

export interface Verdict {
  winnerIndexes: number[]
  wins: number[]
  /** 有并列第一 */
  tied: boolean
}

/**
 * 综合判定：只数"在这行拿到最优"的次数。
 * 它不是加权评分，因为不同人更在意价格还是速度 —— 所以界面同时保留每行的最优标记，
 * 让用户按自己的偏好读，而不是给一个假装客观的总分。
 */
export function verdict(columns: CompareColumn[]): Verdict {
  const scored = rankRows(columns).filter((r) => r.metric.direction !== 'none')
  const wins = columns.map(() => 0)

  for (const row of scored) {
    // 全部并列（比如两列数值完全相同）不算任何一列"赢"
    if (row.best.size === columns.length && columns.length > 1) continue
    for (const index of row.best) wins[index] += 1
  }

  const max = Math.max(...wins)
  const winnerIndexes = wins.map((w, i) => (w === max && w > 0 ? i : -1)).filter((i) => i >= 0)

  return { winnerIndexes, wins, tied: winnerIndexes.length > 1 }
}
