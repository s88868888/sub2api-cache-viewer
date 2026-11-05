<script setup lang="ts">
import { computed } from 'vue'
import type { TrendSeries } from '../../../shared/contracts'

const props = defineProps<{
  days: string[]
  series: TrendSeries[]
}>()

/** 超过这个天数就不画数据点了，120 天 × 6 条线的圆点会把折线糊成一团 */
const MAX_DOTS_DAYS = 45
/** 图例最多几条，再多只是色块噪声 */
const MAX_LINES = 6

const W = 1000
const H = 168
const PAD_L = 38
const PAD_R = 10
const PAD_T = 10
const PAD_B = 20

const GRID_COUNT = 4

const xOf = (index: number): number =>
  props.days.length < 2 ? PAD_L : PAD_L + (index * (W - PAD_L - PAD_R)) / (props.days.length - 1)

/**
 * 纵轴跟着数据走。缓存率常年在 60~75% 之间晃，
 * 固定 0~100 会把 15 个百分点的真实下滑压成一条直线，等于白画。
 * 但跨度不足 20 个百分点时不进一步放大，否则只是把噪声画成趋势。
 */
const domain = computed(() => {
  const values = props.series.flatMap((s) =>
    s.points.filter((p) => p.requests > 0).map((p) => p.cacheRate)
  )
  if (!values.length) return { lo: 0, hi: 1 }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = Math.max((max - min) * 0.25, 0.03)
  const lo = Math.max(0, Math.floor((min - pad) * 20) / 20)
  const hi = Math.min(1, Math.ceil((max + pad) * 20) / 20)
  return hi - lo < 0.2 ? { lo, hi: Math.min(1, lo + 0.2) } : { lo, hi: Math.max(hi, lo + 0.2) }
})

const yOf = (rate: number): number => {
  const { lo, hi } = domain.value
  const clamped = Math.min(hi, Math.max(lo, rate))
  return PAD_T + ((hi - clamped) / (hi - lo)) * (H - PAD_T - PAD_B)
}

const grid = computed(() => {
  const { lo, hi } = domain.value
  return Array.from({ length: GRID_COUNT + 1 }, (_, i) => lo + ((hi - lo) * i) / GRID_COUNT)
})

/**
 * 没有数据的日期断线，而不是连过去。
 * 空档日连上线等于把「停用了一周」画成「缓存崩了」。
 */
function segmentsOf(series: TrendSeries): number[][][] {
  const out: number[][][] = []
  let current: number[][] = []
  series.points.forEach((point, index) => {
    if (point.requests > 0) {
      current.push([xOf(index), yOf(point.cacheRate), index])
    } else if (current.length) {
      out.push(current)
      current = []
    }
  })
  if (current.length) out.push(current)
  return out
}

const lines = computed(() =>
  props.series
    .map((s) => ({
      series: s,
      total: s.points.reduce((sum, p) => sum + p.requests, 0),
      last: [...s.points].reverse().find((p) => p.requests > 0) ?? null
    }))
    .sort((a, b) => b.total - a.total)
)

const shown = computed(() =>
  lines.value.slice(0, MAX_LINES).map((line, index) => ({
    ...line,
    color: `var(--c${(index % 6) + 1})`,
    segments: segmentsOf(line.series)
  }))
)

const hidden = computed(() => Math.max(0, lines.value.length - shown.value.length))

const xTicks = computed(() => {
  const n = props.days.length
  if (n < 2) return []
  const indexes = n <= 8 ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1]
  return indexes.map((i) => ({ x: xOf(i), label: props.days[i].slice(5) }))
})

const hasData = computed(() => props.days.length > 1 && shown.value.some((l) => l.total > 0))
const drawDots = computed(() => props.days.length <= MAX_DOTS_DAYS)
</script>

<template>
  <section class="trend">
    <div v-if="!hasData" class="empty">
      趋势至少要有两天、且这两天都有记录才画得出来。把时间范围拉到「近 7 天」以上，或者先跑一次全量。
    </div>

    <template v-else>
      <p class="chart-head">
        纵轴自动取 {{ (domain.lo * 100).toFixed(0) }}% – {{ (domain.hi * 100).toFixed(0) }}%，不是从 0 起
      </p>
      <div class="chart">
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        preserveAspectRatio="none"
        role="img"
        aria-label="缓存率随时间的变化"
      >
        <g class="grid">
          <template v-for="g in grid" :key="g">
            <line :x1="PAD_L" :x2="W - PAD_R" :y1="yOf(g)" :y2="yOf(g)" />
            <text :x="PAD_L - 6" :y="yOf(g) + 3" class="axis">{{ (g * 100).toFixed(0) }}</text>
          </template>
        </g>

        <g v-for="line in shown" :key="line.series.key">
          <polyline
            v-for="(seg, si) in line.segments"
            :key="si"
            :points="seg.map((p) => `${p[0]},${p[1]}`).join(' ')"
            :stroke="line.color"
            fill="none"
            stroke-width="1.8"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <g v-if="drawDots" class="dots">
          <template v-for="line in shown" :key="`p${line.series.key}`">
            <template v-for="(seg, si) in line.segments" :key="`s${si}`">
              <circle
                v-for="p in seg"
                :key="p[2]"
                :cx="p[0]"
                :cy="p[1]"
                r="2.6"
                :fill="line.color"
              >
                <title>
                  {{ days[p[2]] }} · {{ line.series.label }} ·
                  {{ (line.series.points[p[2]].cacheRate * 100).toFixed(1) }}%（{{
                    line.series.points[p[2]].requests
                  }}
                  条）
                </title>
              </circle>
            </template>
          </template>
        </g>

        <g class="x-axis">
          <text v-for="t in xTicks" :key="t.label" :x="t.x" :y="H - 5" class="axis">
            {{ t.label }}
          </text>
        </g>
      </svg>

      <ul class="legend">
        <li v-for="line in shown" :key="line.series.key">
          <i :style="{ background: line.color }" />
          <span class="name">{{ line.series.label }}</span>
          <span class="num latest">{{
            line.last ? `${(line.last.cacheRate * 100).toFixed(1)}%` : '—'
          }}</span>
          <span class="num count">{{ line.total.toLocaleString('zh-CN') }} 条</span>
        </li>
        <li v-if="hidden > 0" class="more">
          另有 {{ hidden }} 条未画（按请求数取前 {{ MAX_LINES }}）
        </li>
      </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.trend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.empty {
  font-size: 12px;
  color: var(--text-faint);
}

.chart-head {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}

.chart {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

svg {
  flex: 1;
  min-width: 0;
  height: 168px;
}

.grid line {
  stroke: var(--border);
  stroke-width: 1;
}

.axis {
  fill: var(--text-faint);
  font-size: 10px;
  text-anchor: end;
}

.x-axis .axis {
  text-anchor: middle;
}

.legend {
  flex: 0 0 186px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 2px 0 0;
  font-size: 11px;
}

.legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.legend i {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.num {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.latest {
  color: var(--text-dim);
  font-weight: 600;
}

.count,
.more {
  color: var(--text-faint);
}
</style>
