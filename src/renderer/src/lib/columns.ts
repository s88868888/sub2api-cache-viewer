import type { ColumnKey } from '../../../shared/contracts'

export interface ColumnDef {
  key: ColumnKey
  label: string
  /** 表头悬浮说明 */
  hint?: string
  numeric: boolean
}

/**
 * 顺序即表格列序。时间列不在其中 —— 它是行的锚点，
 * 允许隐藏会得到一张无法解读的空表。
 */
export const COLUMNS: ColumnDef[] = [
  { key: 'site', label: '站点', numeric: false },
  { key: 'model', label: '模型', numeric: false },
  { key: 'group', label: '分组', numeric: false },
  { key: 'input', label: '输入', hint: '未命中缓存的输入 token', numeric: true },
  { key: 'output', label: '输出', hint: '输出 token', numeric: true },
  {
    key: 'cacheWrite',
    label: '缓存写',
    hint: '写入缓存的 token，按写缓存单价计费；OpenAI 兼容上游不上报该字段',
    numeric: true
  },
  { key: 'cacheRead', label: '缓存读', hint: '命中缓存读取的 token', numeric: true },
  { key: 'cacheRate', label: '缓存率', numeric: true },
  { key: 'total', label: '总 Token', numeric: true },
  { key: 'cost', label: '费用', numeric: true },
  { key: 'ttft', label: 'TTFT', hint: '首字耗时', numeric: true },
  { key: 'tps', label: 'TPS', hint: '输出 token / 秒，已排除输出量差异', numeric: true },
  { key: 'duration', label: '耗时', hint: '总耗时', numeric: true }
]

export const COLUMN_LABELS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])) as Record<
  ColumnKey,
  string
>
