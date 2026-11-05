<script setup lang="ts">
import type { ColumnKey } from '../../../shared/contracts'
import { COLUMNS } from '../lib/columns'

const props = defineProps<{ hidden: ColumnKey[] }>()
const emit = defineEmits<{ toggle: [key: ColumnKey]; showAll: [] }>()

const visible = (key: ColumnKey): boolean => !props.hidden.includes(key)

// 只上报"用户动了哪一列"，由父组件去改状态：
// 面板自己算数组的话，连续快速点两个框会都基于同一份旧 props，后一次覆盖前一次
function toggle(key: ColumnKey): void {
  emit('toggle', key)
}

const NOTE: Partial<Record<ColumnKey, string>> = {
  site: '仅合并视图出现',
  cacheWrite: '全为 0 时自动隐藏'
}
</script>

<template>
  <div class="pop">
    <header>
      <b>显示字段</b>
      <span class="count">{{ COLUMNS.length - hidden.length }}/{{ COLUMNS.length }}</span>
      <button class="link" @click="emit('showAll')">全部显示</button>
    </header>

    <ul>
      <li v-for="col in COLUMNS" :key="col.key">
        <label>
          <input type="checkbox" :checked="visible(col.key)" @change="toggle(col.key)" />
          <span class="name">{{ col.label }}</span>
          <small v-if="NOTE[col.key]" class="note">{{ NOTE[col.key] }}</small>
        </label>
      </li>
    </ul>

    <p class="hint">时间列固定显示，否则表格无法定位到具体记录。配置会存到本机。</p>
  </div>
</template>

<style scoped>
.pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: 236px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  box-shadow: var(--shadow-pop);
  text-align: left;
}

header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

b {
  font-size: 12px;
}

.count {
  margin-right: auto;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.link {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  padding: 0;
}

.link:hover {
  text-decoration: underline;
}

ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 10px;
}

label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
  min-width: 0;
}

input {
  margin: 0;
  flex: 0 0 auto;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.hint {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}
</style>
