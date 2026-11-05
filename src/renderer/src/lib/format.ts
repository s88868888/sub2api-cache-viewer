import type { SiteBalance } from '../../../shared/contracts'

const intFormatter = new Intl.NumberFormat('zh-CN')

export function fmtInt(value: number): string {
  return intFormatter.format(Math.round(value || 0))
}

export function fmtBalance(balance: SiteBalance | null): string {
  if (!balance) return '—'
  if (balance.usd !== null) return `$${balance.usd.toFixed(2)}`
  return `${fmtInt(balance.raw)} quota`
}

/** 能换算成美元时，悬浮显示原生 quota，便于核对站点计费单位 */
export function balanceTitle(balance: SiteBalance | null): string {
  if (!balance) return ''
  return balance.usd !== null && balance.unit === 'quota'
    ? `原生 quota：${fmtInt(balance.raw)}`
    : ''
}

/** 159415 -> 159.4K，与站点表格的紧凑显示保持一致 */
export function fmtCompact(value: number): string {
  const n = Math.round(value || 0)
  if (Math.abs(n) < 1000) return String(n)
  if (Math.abs(n) < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}K`
  return `${trimZero((n / 1_000_000).toFixed(2))}M`
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, '')
}

export function fmtPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0.0%'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function fmtCost(value: number, kind: 'sub2api' | 'newapi'): string {
  if (kind === 'newapi') return fmtInt(value)
  return `$${(value || 0).toFixed(6)}`
}

export function fmtTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '-'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

/** 输出太少时不显示 TPS —— 首字耗时会让这个比值失真 */
export function fmtTps(tps: number | null): string {
  return tps === null ? '—' : tps.toFixed(0)
}
