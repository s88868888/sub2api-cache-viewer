<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ColumnKey } from '../../../shared/contracts'
import type { AnomalyRow } from '../lib/anomaly'
import { tpsOf } from '../lib/anomaly'
import { COLUMNS } from '../lib/columns'
import { fmtCompact, fmtCost, fmtDuration, fmtInt, fmtPct, fmtTime, fmtTps } from '../lib/format'

const props = defineProps<{
  rows: AnomalyRow[]
  /** 合并视图里才显示归属站点 */
  showSite?: boolean
  hidden: ColumnKey[]
}>()

const scroller = ref<HTMLElement | null>(null)
const canScroll = ref(false)
const atBottom = ref(true)
const EDGE = 24

/**
 * 有效列在这里一次算清：用户配置、合并视图、以及"缓存写全为 0 就不占一列"，
 * 三处条件混在一个地方，避免表头和单元格各判一次导致错位。
 */
const shown = computed(() => {
  const hasCacheWrite = props.rows.some((r) => r.cacheCreationTokens > 0)
  const set = new Set<ColumnKey>()
  for (const col of COLUMNS) {
    if (props.hidden.includes(col.key)) continue
    if (col.key === 'site' && !props.showSite) continue
    if (col.key === 'cacheWrite' && !hasCacheWrite) continue
    set.add(col.key)
  }
  return set
})

const on = (key: ColumnKey): boolean => shown.value.has(key)
const colCount = computed(() => 1 + shown.value.size)

function rowTitle(row: AnomalyRow): string {
  if (!row.reasons.length) return ''
  return `${row.severity === 'bad' ? '严重异常' : '轻度异常'}：${row.reasons.join('；')}`
}

function rateTone(ratio: number): string {
  if (ratio >= 0.8) return 'hi'
  if (ratio >= 0.3) return 'mid'
  if (ratio > 0) return 'low'
  return 'none'
}

function measure(): void {
  const el = scroller.value
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  canScroll.value = max > EDGE
  atBottom.value = el.scrollTop >= max - EDGE
}

function jump(): void {
  const el = scroller.value
  if (!el) return
  // 直接赋值而非 smooth：窗口未聚焦时平滑动画会被挂起，按钮就"点了没反应"
  el.scrollTop = atBottom.value ? 0 : el.scrollHeight
}

/** 供父组件在手动查询/翻页后把表格拉回顶部 */
function resetScroll(): void {
  if (scroller.value) scroller.value.scrollTop = 0
  void nextTick(measure)
}

defineExpose({ resetScroll })

onMounted(() => {
  window.addEventListener('resize', measure)
  void nextTick(measure)
})

onBeforeUnmount(() => window.removeEventListener('resize', measure))

// 数据换了但滚动位置没变时，按钮状态会停在旧值上
watch(() => props.rows, () => void nextTick(measure))
</script>

<template>
  <div class="grid">
    <div ref="scroller" class="wrap" @scroll.passive="measure">
      <table>
        <thead>
          <tr>
            <th class="c-time">时间</th>
            <th v-if="on('site')" class="c-site">站点</th>
            <th v-if="on('model')" class="c-model">模型</th>
            <th v-if="on('group')" class="c-group">分组</th>
            <th v-if="on('input')" class="c-num" title="未命中缓存的输入 token">输入</th>
            <th v-if="on('output')" class="c-num" title="输出 token">输出</th>
            <th
              v-if="on('cacheWrite')"
              class="c-num warn"
              title="写入缓存的 token，按写缓存单价计费；OpenAI 兼容上游不上报该字段"
            >
              缓存写
            </th>
            <th v-if="on('cacheRead')" class="c-num acc" title="命中缓存读取的 token">缓存读</th>
            <th v-if="on('cacheRate')" class="c-rate">缓存率</th>
            <th v-if="on('total')" class="c-num">总 Token</th>
            <th v-if="on('cost')" class="c-num">费用</th>
            <th v-if="on('ttft')" class="c-num" title="首字耗时">TTFT</th>
            <th v-if="on('tps')" class="c-num" title="输出 token / 秒，已排除输出量差异">TPS</th>
            <th v-if="on('duration')" class="c-num" title="总耗时">耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="`${row.siteLabel}-${row.id}`"
            :class="[row.severity, { flagged: row.severity !== 'none' }]"
            :title="rowTitle(row)"
          >
            <td class="c-time dim">{{ fmtTime(row.createdAt) }}</td>
            <td v-if="on('site')" class="c-site" :title="row.siteLabel">{{ row.siteLabel }}</td>
            <td v-if="on('model')" class="c-model" :title="row.model">{{ row.model || '-' }}</td>
            <td v-if="on('group')" class="c-group" :title="row.groupName">{{ row.groupName }}</td>
            <td v-if="on('input')" class="c-num">{{ fmtInt(row.inputTokens) }}</td>
            <td v-if="on('output')" class="c-num">{{ fmtInt(row.outputTokens) }}</td>
            <td v-if="on('cacheWrite')" class="c-num warn">
              {{ row.cacheCreationTokens ? fmtInt(row.cacheCreationTokens) : '-' }}
            </td>
            <td v-if="on('cacheRead')" class="c-num acc">
              {{ row.cacheReadTokens ? fmtInt(row.cacheReadTokens) : '-' }}
            </td>
            <td v-if="on('cacheRate')" class="c-rate" :class="row.flags.cacheRate">
              <div class="rate" :class="rateTone(row.cacheRate)">
                <span class="num">{{ fmtPct(row.cacheRate) }}</span>
                <span class="track">
                  <span class="fill" :style="{ width: `${row.cacheRate * 100}%` }" />
                </span>
              </div>
            </td>
            <td v-if="on('total')" class="c-num strong">{{ fmtCompact(row.totalTokens) }}</td>
            <td v-if="on('cost')" class="c-num">{{ fmtCost(row.actualCost, row.siteKind) }}</td>
            <td v-if="on('ttft')" class="c-num dim">{{ fmtDuration(row.firstTokenMs) }}</td>
            <td v-if="on('tps')" class="c-num c-tps" :class="row.flags.throughput">
              {{ fmtTps(tpsOf(row)) }}
            </td>
            <td v-if="on('duration')" class="c-num dim">{{ fmtDuration(row.durationMs) }}</td>
          </tr>
          <tr v-if="!rows.length" class="empty">
            <td :colspan="colCount">没有匹配的记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <button
      v-if="canScroll"
      class="jump"
      :class="{ up: atBottom }"
      :title="atBottom ? '回到表格顶部' : '一键到表格底部'"
      @click="jump"
    >
      {{ atBottom ? '↑' : '↓' }}
    </button>
  </div>
</template>

<style scoped>
.grid {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.wrap {
  flex: 1;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  /* 表格自己纵向滚动，横向滚动条就常驻在可视区底部，不用翻到整页末尾才拖 */
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}

thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 28px;
  padding: 0 8px;
  text-align: right;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border-strong);
}

thead th.c-time,
thead th.c-site,
thead th.c-model,
thead th.c-group {
  text-align: left;
}

tbody td {
  height: var(--row-h);
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

tbody td.c-num {
  text-align: right;
  font-family: 'Cascadia Mono', 'Consolas', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

tbody tr:hover td {
  background: var(--row-hover);
}

tbody tr.warn > td {
  background: var(--tint-warn);
}

tbody tr.bad > td {
  background: var(--tint-bad);
}

tbody tr.warn:hover > td {
  background: var(--tint-warn-hover);
}

tbody tr.bad:hover > td {
  background: var(--tint-bad-hover);
}

tbody tr.warn > td:first-child {
  box-shadow: inset 3px 0 0 var(--warn);
}

tbody tr.bad > td:first-child {
  box-shadow: inset 3px 0 0 var(--bad);
}

.c-time {
  width: 148px;
  color: var(--text-faint);
}

.c-site {
  width: 116px;
  max-width: 116px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-dim);
}

.c-model {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.c-group {
  width: 160px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.c-rate {
  width: 96px;
}

.dim {
  color: var(--text-faint);
}

.acc {
  color: var(--accent);
}

.warn {
  color: var(--warn);
}

.strong {
  font-weight: 600;
}

.rate {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.rate .num {
  width: 44px;
  text-align: right;
  font-weight: 600;
}

.rate.hi .num {
  color: var(--good);
}

.rate.mid .num {
  color: var(--accent);
}

.rate.low .num {
  color: var(--warn);
}

.rate.none .num {
  color: var(--text-faint);
}

.track {
  width: 30px;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
}

.rate.hi .fill {
  background: var(--good);
}

.rate.mid .fill {
  background: var(--accent);
}

.rate.low .fill {
  background: var(--warn);
}

td.c-tps.warn {
  color: var(--warn);
  font-weight: 700;
}

td.c-tps.bad {
  color: var(--bad);
  font-weight: 700;
}

td.c-rate.warn .num {
  color: var(--warn);
  font-weight: 700;
}

td.c-rate.bad .num {
  color: var(--bad);
  font-weight: 700;
}

.empty td {
  height: 64px;
  text-align: center;
  color: var(--text-faint);
}

.jump {
  position: absolute;
  right: 14px;
  bottom: 26px;
  z-index: 3;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--panel);
  color: var(--accent);
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  box-shadow: var(--shadow-jump);
  opacity: 0.7;
  transition: transform 0.14s ease, box-shadow 0.14s ease, opacity 0.14s ease;
}

.jump:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-jump-hover);
  opacity: 1;
}

.jump.up {
  color: var(--text-dim);
}
</style>
