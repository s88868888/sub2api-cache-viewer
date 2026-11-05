<script setup lang="ts">
import { computed } from 'vue'
import type { CompareColumn, CompareTarget, SiteSamples } from '../../../shared/contracts'
import { METRICS, rankRows, verdict } from '../lib/compare'

const props = defineProps<{
  sites: SiteSamples[]
  columns: CompareColumn[]
  targets: CompareTarget[]
  sampleCap: number
  loading: boolean
}>()

const emit = defineEmits<{ 'update:targets': [CompareTarget[]] }>()

const MAX_COLUMNS = 4

const usableSites = computed(() => props.sites.filter((s) => !s.error))

function groupsFor(siteId: string) {
  return props.sites.find((s) => s.siteId === siteId)?.groups ?? []
}

function patchTarget(index: number, patch: Partial<CompareTarget>): void {
  const next = props.targets.map((t, i) => (i === index ? { ...t, ...patch } : t))
  // 换站点后原来选的分组多半不存在，清空让用户重选，而不是留一个查不到数据的列
  if (patch.siteId !== undefined) next[index].groupName = ''
  emit('update:targets', next.filter((t) => t.siteId))
}

function addTarget(): void {
  const first = usableSites.value[0]
  if (!first || props.targets.length >= MAX_COLUMNS) return
  emit('update:targets', [...props.targets, { siteId: first.siteId, groupName: '' }])
}

function removeTarget(index: number): void {
  emit('update:targets', props.targets.filter((_, i) => i !== index))
}

const rankings = computed(() => rankRows(props.columns))
const result = computed(() => verdict(props.columns))

/** 表头里给出这一列的关键身份：站点、分组、样本量、以及数据缺陷标记 */
function flagsOf(c: CompareColumn): string[] {
  const flags: string[] = []
  if (c.truncated) flags.push(`样本截断于 ${props.sampleCap.toLocaleString('zh-CN')}`)
  if (c.costUsd === null) flags.push('成本无法折算美元')
  if (c.tpsSamples < 5) flags.push('TPS 样本偏少')
  return flags
}
</script>

<template>
  <section class="cmp">
    <div class="picker">
      <div v-for="(t, i) in targets" :key="i" class="col-pick">
        <span class="idx">{{ i + 1 }}</span>
        <select
          class="site"
          :value="t.siteId"
          @change="patchTarget(i, { siteId: ($event.target as HTMLSelectElement).value })"
        >
          <option value="" disabled>选站点</option>
          <option v-for="s in usableSites" :key="s.siteId" :value="s.siteId">{{ s.label }}</option>
        </select>
        <select
          class="group"
          :value="t.groupName"
          :disabled="!t.siteId"
          @change="patchTarget(i, { groupName: ($event.target as HTMLSelectElement).value })"
        >
          <option value="" disabled>选分组</option>
          <option v-for="g in groupsFor(t.siteId)" :key="g.name" :value="g.name">
            {{ g.name }}（{{ g.requests.toLocaleString('zh-CN') }}）
          </option>
        </select>
        <button class="rm" title="移除这一列" @click="removeTarget(i)">×</button>
      </div>

      <button
        class="btn ghost sm add"
        :disabled="targets.length >= MAX_COLUMNS || !usableSites.length || loading"
        @click="addTarget"
      >
        ＋ 加一列（最多 {{ MAX_COLUMNS }}）
      </button>

      <p v-if="!usableSites.length" class="warn-text">
        没有可用站点 —— 每个站点都需要能取到用量记录才能参与对比。
      </p>
    </div>

    <div v-if="columns.length" class="table-wrap">
      <table class="cmp-table">
        <thead>
          <tr>
            <th class="metric-col">指标</th>
            <th v-for="c in columns" :key="`${c.siteId}-${c.groupName}`" class="target-col">
              <div class="th-top">
                <b>{{ c.groupName }}</b>
                <span v-if="result.winnerIndexes.length && result.winnerIndexes.includes(columns.indexOf(c))" class="crown">
                  综合更优
                </span>
              </div>
              <div class="th-site">
                <span class="kind" :class="c.kind">{{ c.kind === 'sub2api' ? 'sub2api' : 'new-api' }}</span>
                <span class="host">{{ c.siteLabel }}</span>
              </div>
              <div v-if="flagsOf(c).length" class="th-flags">
                <span v-for="f in flagsOf(c)" :key="f" class="flag">{{ f }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in rankings" :key="row.metric.key">
            <th class="metric-col">
              <span class="m-label">{{ row.metric.label }}</span>
              <small v-if="row.metric.hint" class="m-hint">{{ row.metric.hint }}</small>
              <small v-else-if="row.metric.direction === 'none'" class="m-plain">仅陈述</small>
            </th>
            <td
              v-for="(c, ci) in columns"
              :key="c.groupName + c.siteId"
              class="num"
              :class="{ best: row.best.has(ci) && row.metric.direction !== 'none' }"
            >
              {{ row.metric.format(c) }}
              <em v-if="row.best.has(ci) && row.metric.direction !== 'none'" class="tick">最优</em>
            </td>
          </tr>
          <tr class="wins">
            <th class="metric-col">
              <span class="m-label">最优项数</span>
              <small class="m-hint">{{ rankings.filter(r => r.metric.direction !== 'none').length }} 项参与判定</small>
            </th>
            <td v-for="(c, ci) in columns" :key="`w-${c.groupName}`" class="num" :class="{ best: result.winnerIndexes.includes(ci) }">
              {{ result.wins[ci] }}
            </td>
          </tr>
        </tbody>
      </table>

      <p class="note">
        判定只数"哪一列在该行取到最优"，不做加权总分 —— 有人更在意单价、有人更在意速度。
        灰底行是陈述性指标，不参与判定；<b>有效单价</b>是跨站比成本唯一公平的口径，
        比总花费会被用量差异带偏。
      </p>
    </div>

    <p v-else-if="!loading" class="empty">
      选好至少两列（站点 + 分组）后开始对比。同一站点选不同分组，或不同站点选同名分组，都可以。
    </p>
  </section>
</template>

<style scoped>
.cmp {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.col-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--panel-alt);
}

.idx {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 700;
}

.col-pick select {
  height: 24px;
  max-width: 240px;
  padding: 0 4px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
}

.rm {
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--text-faint);
  font-size: 14px;
  line-height: 1;
}

.rm:hover {
  background: var(--tint-bad);
  color: var(--bad);
}

.warn-text {
  margin: 0;
  font-size: 12px;
  color: var(--bad);
}

.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.cmp-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12.5px;
}

.cmp-table th.metric-col {
  position: sticky;
  left: 0;
  top: 0;
  z-index: 2;
  width: 210px;
  min-width: 210px;
  padding: 8px 10px;
  text-align: left;
  font-weight: 400;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
}

.m-label {
  display: block;
  font-weight: 600;
  color: var(--text);
}

.m-hint {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-faint);
}

.m-plain {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-faint);
}

thead th.target-col {
  position: sticky;
  top: 0;
  z-index: 1;
  min-width: 168px;
  padding: 8px 10px;
  text-align: left;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border-strong);
}

.th-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.th-top b {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crown {
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--good-soft);
  color: var(--good);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.th-site {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}

.kind {
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--border);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-faint);
}

.host {
  font-size: 11px;
  color: var(--text-dim);
}

.th-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.flag {
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10px;
}

tbody td.num {
  padding: 8px 10px;
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
  font-family: 'Cascadia Mono', 'Consolas', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

tbody td.num.best {
  background: var(--good-soft);
  color: var(--good);
  font-weight: 700;
}

.tick {
  margin-left: 6px;
  font-style: normal;
  font-size: 10px;
  font-weight: 700;
  font-family: inherit;
}

tr.wins td.num,
tr.wins th.metric-col {
  background: var(--panel-alt);
}

.note {
  margin: 0;
  padding: 8px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-faint);
}

.empty {
  padding: 28px;
  text-align: center;
  color: var(--text-faint);
  background: var(--panel);
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
}
</style>
