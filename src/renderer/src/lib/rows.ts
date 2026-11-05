import type { SiteKind, UsageRecord } from '../../../shared/contracts'

/** 表格行：明细本身 + 归属站点（合并视图才用得上） */
export type UsageRow = UsageRecord & { siteLabel: string; siteKind: SiteKind }

export function toRows(
  records: UsageRecord[],
  siteLabel: string,
  siteKind: SiteKind
): UsageRow[] {
  return records.map((r) => ({ ...r, siteLabel, siteKind }))
}
