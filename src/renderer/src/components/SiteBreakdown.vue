<script setup lang="ts">
import type { SiteResult } from '../../../shared/contracts'
import { fmtBalance, fmtCompact, fmtCost, fmtInt, fmtPct } from '../lib/format'

defineProps<{ sites: SiteResult[] }>()
</script>

<template>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="c-name">站点</th>
          <th class="c-num">请求</th>
          <th class="c-num">未命中输入</th>
          <th class="c-num acc">缓存读取</th>
          <th class="c-num warn">缓存写入</th>
          <th class="c-rate">缓存率</th>
          <th class="c-num">总 Token</th>
          <th class="c-num">费用</th>
          <th class="c-num">余额</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sites" :key="s.siteId">
          <td v-if="s.result" class="c-name">
            <b>{{ s.label }}</b>
            <span class="kind" :class="s.kind">{{ s.kind === 'sub2api' ? 'sub2api' : 'new-api' }}</span>
          </td>
          <td v-else class="c-name err" colspan="9" :title="s.error ?? ''">
            {{ s.label }} · {{ s.error || '查询失败' }}
          </td>

          <template v-if="s.result">
            <td class="c-num">{{ fmtInt(s.result.summary.requests) }}</td>
            <td class="c-num">{{ fmtInt(s.result.summary.inputTokens) }}</td>
            <td class="c-num acc">{{ fmtInt(s.result.summary.cacheReadTokens) }}</td>
            <td class="c-num warn">{{ fmtInt(s.result.summary.cacheCreationTokens) }}</td>
            <td class="c-rate num">{{ fmtPct(s.result.summary.cacheRate) }}</td>
            <td class="c-num">{{ fmtCompact(s.result.summary.totalTokens) }}</td>
            <td class="c-num">{{ fmtCost(s.result.summary.actualCost, s.kind) }}</td>
            <td class="c-num bal">{{ fmtBalance(s.result.balance) }}</td>
          </template>
        </tr>
        <tr v-if="!sites.length" class="blank">
          <td colspan="9">还没有可对比的站点</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.wrap {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

thead th {
  height: 28px;
  padding: 0 10px;
  text-align: right;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border-strong);
}

thead th.c-name {
  text-align: left;
}

tbody td {
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody td.c-num {
  text-align: right;
  font-family: 'Cascadia Mono', 'Consolas', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

tbody tr:hover td {
  background: var(--row-hover);
}

.c-name {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
  overflow: hidden;
}

.c-name b {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}

.c-name.err {
  color: var(--bad);
  text-overflow: ellipsis;
}

.kind {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  color: var(--text-faint);
}

.c-rate {
  width: 84px;
  text-align: right;
  font-weight: 600;
  color: var(--good);
}

.acc {
  color: var(--accent);
}

.warn {
  color: var(--warn);
}

.bal {
  color: var(--good);
  font-weight: 600;
}

.blank td {
  height: 48px;
  text-align: center;
  color: var(--text-faint);
}
</style>
