<script setup lang="ts">
import { computed } from 'vue'
import type { SiteBalance, UsageSummary } from '../../../shared/contracts'
import { balanceTitle, fmtBalance, fmtCompact, fmtInt, fmtPct } from '../lib/format'

const props = defineProps<{
  summary: UsageSummary
  /** 跨站混合时费用不可相加：sub2api 是美元，new-api 是 quota */
  costMode: 'usd' | 'quota' | 'mixed'
  scopeLabel: string
  /** 合并视图下各站余额互不相通，用 showBalance=false 隐藏 */
  balance?: SiteBalance | null
  showBalance?: boolean
}>()

const inputSide = computed(
  () =>
    props.summary.inputTokens +
    props.summary.cacheCreationTokens +
    props.summary.cacheReadTokens
)

const costText = computed(() => {
  if (props.costMode === 'mixed') return '—'
  const v = props.summary.actualCost
  return props.costMode === 'usd' ? `$${v.toFixed(6)}` : fmtInt(v)
})

const costTitle = computed(() =>
  props.costMode === 'mixed' ? '各站点费用单位不同，请看下方分站小计' : ''
)
</script>

<template>
  <div class="bar">
    <div class="hero">
      <div class="hero-label">
        总缓存率
        <span class="scope">{{ scopeLabel }}</span>
      </div>
      <div class="hero-value num">{{ fmtPct(summary.cacheRate) }}</div>
      <div class="hero-sub num">
        缓存读取 {{ fmtCompact(summary.cacheReadTokens) }} / 输入侧 {{ fmtCompact(inputSide) }}
      </div>
      <div class="meter">
        <div class="meter-fill" :style="{ width: `${Math.min(100, summary.cacheRate * 100)}%` }" />
      </div>
    </div>

    <div class="cells">
      <div class="cell">
        <span class="k">请求数</span>
        <span class="v num">{{ fmtInt(summary.requests) }}</span>
      </div>
      <div class="cell">
        <span class="k">未命中输入</span>
        <span class="v num">{{ fmtInt(summary.inputTokens) }}</span>
      </div>
      <div class="cell hl-read">
        <span class="k">缓存读取</span>
        <span class="v num">{{ fmtInt(summary.cacheReadTokens) }}</span>
      </div>
      <div class="cell hl-write">
        <span class="k">缓存写入</span>
        <span class="v num">{{ fmtInt(summary.cacheCreationTokens) }}</span>
      </div>
      <div class="cell">
        <span class="k">输出</span>
        <span class="v num">{{ fmtInt(summary.outputTokens) }}</span>
      </div>
      <div class="cell">
        <span class="k">总 Token</span>
        <span class="v num">{{ fmtCompact(summary.totalTokens) }}</span>
      </div>
      <div class="cell" :title="costTitle">
        <span class="k">{{ costMode === 'quota' ? '费用 (quota)' : '费用' }}</span>
        <span class="v num" :class="{ muted: costMode === 'mixed' }">{{ costText }}</span>
      </div>
      <div v-if="showBalance" class="cell hl-balance" :title="balanceTitle(balance ?? null)">
        <span class="k">余额</span>
        <span class="v num" :class="{ muted: !balance }">{{ fmtBalance(balance ?? null) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.hero {
  flex: 0 0 232px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.hero-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}

.scope {
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
}

.hero-value {
  font-size: 30px;
  font-weight: 650;
  line-height: 1.15;
  color: var(--good);
}

.hero-sub {
  font-size: 11px;
  color: var(--text-faint);
}

.meter {
  height: 4px;
  margin-top: 7px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  background: var(--good);
  transition: width 0.18s ease;
}

.cells {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.cell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 8px 10px;
  background: var(--panel);
}

.cell .k {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}

.cell .v {
  font-size: 15px;
  font-weight: 600;
}

.v.muted {
  color: var(--text-faint);
  font-weight: 400;
}

.hl-read .v {
  color: var(--accent);
}

.hl-write .v {
  color: var(--warn);
}

.hl-balance .v {
  color: var(--good);
}
</style>
