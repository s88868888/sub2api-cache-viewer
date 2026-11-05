<script setup lang="ts">
import type { SiteState } from '../../../shared/contracts'

defineProps<{
  states: SiteState[]
  selected: string
  collapsed: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  add: []
  edit: [id: string]
  remove: [id: string]
  toggle: []
  openPanel: [id: string]
}>()

function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
</script>

<template>
  <aside class="rail" :class="{ mini: collapsed }">
    <div class="rail-head">
      <span v-if="!collapsed" class="title">站点</span>
      <button
        class="fold"
        :title="collapsed ? '展开侧栏' : '折叠侧栏'"
        @click="emit('toggle')"
      >
        {{ collapsed ? '»' : '«' }}
      </button>
    </div>

    <button
      class="all"
      :class="{ on: selected === 'all' }"
      title="全部站点（跨站合并汇总）"
      @click="emit('select', 'all')"
    >
      <span class="ico">Σ</span>
      <span v-if="!collapsed" class="txt">
        <b>全部站点</b>
        <small>{{ states.length }} 个已保存</small>
      </span>
    </button>

    <button
      class="all"
      :class="{ on: selected === 'compare' }"
      title="分组横向对比"
      @click="emit('select', 'compare')"
    >
      <span class="ico cmp">⇄</span>
      <span v-if="!collapsed" class="txt">
        <b>对比</b>
        <small>站点 / 分组横向比</small>
      </span>
    </button>

    <ul v-if="!collapsed" class="list">
      <li v-for="s in states" :key="s.profile.id">
        <div class="row">
          <button class="item" :class="{ on: selected === s.profile.id }" @click="emit('select', s.profile.id)">
            <span class="dot" :class="s.connected ? 'ok' : 'idle'" />
            <span class="txt">
              <b :title="s.profile.label">{{ s.profile.label }}</b>
              <small>{{ host(s.profile.baseUrl) }}</small>
            </span>
            <span class="kind">{{ s.profile.kind === 'sub2api' ? 'S2' : 'NA' }}</span>
          </button>
          <button class="panel" title="免登录打开官网面板" @click="emit('openPanel', s.profile.id)">
            面板
          </button>
        </div>
        <div class="ops">
          <button @click="emit('edit', s.profile.id)">编辑</button>
          <button class="del" @click="emit('remove', s.profile.id)">移除</button>
        </div>
      </li>
      <li v-if="!states.length" class="empty">还没有站点</li>
    </ul>

    <ul v-else class="mini-list">
      <li v-for="s in states" :key="s.profile.id">
        <button
          class="mini-item"
          :class="{ on: selected === s.profile.id }"
          :title="`${s.profile.label} · ${host(s.profile.baseUrl)}`"
          @click="emit('select', s.profile.id)"
        >
          <span class="dot" :class="s.connected ? 'ok' : 'idle'" />
          <span class="mini-kind">{{ s.profile.kind === 'sub2api' ? 'S2' : 'NA' }}</span>
        </button>
      </li>
    </ul>

    <button class="add" title="添加站点" @click="emit('add')">
      <span class="plus">+</span>
      <span v-if="!collapsed">添加站点</span>
    </button>
  </aside>
</template>

<style scoped>
.rail {
  width: 218px;
  flex: 0 0 218px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: var(--panel);
  border-right: 1px solid var(--border);
  overflow: auto;
  transition: width 0.15s ease, flex-basis 0.15s ease;
}

.rail.mini {
  width: 54px;
  flex-basis: 54px;
  padding: 8px 6px;
  align-items: stretch;
}

.rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  padding: 0 2px;
}

.title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.fold {
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
}

.fold:hover {
  border-color: var(--border-strong);
  color: var(--accent);
}

.all,
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  text-align: left;
}

.row {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.row .item {
  flex: 1;
  min-width: 0;
  width: auto;
}

.panel {
  flex: 0 0 auto;
  width: 34px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

/* 平时不打扰，鼠标移到这一行才出现，避免侧栏看起来一排按钮 */
li:hover .panel {
  opacity: 1;
}

.panel:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.all:hover,
.item:hover {
  background: var(--panel-alt);
}

.all.on,
.item.on {
  background: var(--accent-soft);
  border-color: var(--sel-border);
}

.ico {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 4px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 700;
}

/* 对比用次要色，避免和"全部站点"看起来像同一个入口 */
.ico.cmp {
  background: var(--good);
  color: var(--on-accent);
}

.txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.txt b {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.txt small {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list,
.mini-list {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mini-list {
  margin-top: 6px;
  gap: 4px;
}

li {
  position: relative;
}

.dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--border-strong);
}

.dot.ok {
  background: var(--good);
}

.kind {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--panel-alt);
  color: var(--text-faint);
  border: 1px solid var(--border);
}

.mini-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 6px 2px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
}

.mini-item:hover {
  background: var(--panel-alt);
}

.mini-item.on {
  background: var(--accent-soft);
  border-color: var(--sel-border);
}

.mini-kind {
  font-size: 9px;
  font-weight: 700;
  color: var(--text-faint);
}

.ops {
  display: none;
  gap: 8px;
  padding: 0 8px 6px;
}

li:hover .ops {
  display: flex;
}

.ops button {
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  padding: 0;
}

.ops button:hover {
  color: var(--accent);
}

.ops .del:hover {
  color: var(--bad);
}

.empty {
  padding: 12px 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.add {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
}

.add:hover {
  border-color: var(--accent);
  border-style: solid;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.plus {
  font-size: 15px;
  line-height: 1;
}
</style>
