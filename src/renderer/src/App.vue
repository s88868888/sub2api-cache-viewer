<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type {
  AggregateResult,
  ColumnKey,
  CompareResult,
  CompareTarget,
  GroupOption,
  Prefs,
  QueryResult,
  ScanResult,
  SiteProfile,
  SiteResult,
  SiteState,
  Theme
} from '../../shared/contracts'
import { createEmptySummary } from '../../shared/contracts'
import SiteList from './components/SiteList.vue'
import SiteEditor from './components/SiteEditor.vue'
import SiteBreakdown from './components/SiteBreakdown.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SummaryBar from './components/SummaryBar.vue'
import UsageTable from './components/UsageTable.vue'
import CompareView from './components/CompareView.vue'
import TrendChart from './components/TrendChart.vue'
import { toRows, type UsageRow } from './lib/rows'
import { annotate, countBySeverity, underSampledGroups, type AnomalyRow } from './lib/anomaly'
import { fmtInt } from './lib/format'

const states = ref<SiteState[]>([])
const selected = ref<string>('all')
const groups = ref<GroupOption[]>([])
const single = ref<QueryResult | null>(null)
const agg = ref<AggregateResult | null>(null)
const loading = ref(false)
/** 这一批数据是什么时候取到的，用来解释「为什么现在显示的不是最新几秒的」 */
const loadedAt = ref(0)
const error = ref('')
const notice = ref('')
const anomalyOnly = ref(false)

const collapsed = ref(false)
const hiddenColumns = ref<ColumnKey[]>([])
const settingsOpen = ref(false)
const tableRef = ref<{ resetScroll: () => void } | null>(null)

/** null 表示跟随系统，用户手动切过之后才落到 light/dark */
const themePref = ref<Theme | null>(null)
const theme = ref<Theme>('light')

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(): void {
  theme.value = themePref.value ?? systemTheme()
  document.documentElement.dataset.theme = theme.value
}

async function toggleTheme(): Promise<void> {
  themePref.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme()
  await persist({ theme: themePref.value })
}

function onSystemThemeChange(): void {
  if (themePref.value === null) applyTheme()
}

const editorOpen = ref(false)
const editing = ref<SiteProfile | null>(null)

const filters = reactive({
  page: 1,
  pageSize: 100,
  groupId: '',
  model: '',
  range: '7d' as 'today' | '7d' | '30d' | 'all'
})

/** sub2api 的 page_size 上限是 1000，超过会被服务端静默回落成默认值 */
const PAGE_MAX = 1000
const PAGE_PRESETS = [50, 100, 200, 500, 1000]
const pageSizeChoice = ref<number | 'custom'>(100)
const customSize = ref(300)

const INTERVALS = [15, 30, 60, 300]
const autoRefresh = ref(false)
const refreshSec = ref(60)
let timer: ReturnType<typeof setInterval> | null = null

const rangeDays: Record<typeof filters.range, number | null> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  all: null
}

const isAll = computed(() => selected.value === 'all')
const isCompare = computed(() => selected.value === 'compare')

const compareTargets = ref<CompareTarget[]>([])
const compareResult = ref<CompareResult | null>(null)
const compareLoading = ref(false)

/** 全量扫描的结果：顶部汇总与趋势图都改用它，明细表本身仍是分页的 */
const scan = ref<ScanResult | null>(null)
const scanLoading = ref(false)
const scanKey = ref('')
const trendOpen = ref(true)
const current = computed(() => states.value.find((s) => s.profile.id === selected.value) ?? null)

const scannedSummary = computed(() => {
  const s = scan.value
  if (!s) return null
  if (isAll.value) return s.merged
  return s.sites.find((x) => x.siteId === selected.value)?.summary ?? null
})

const summary = computed(
  () =>
    scannedSummary.value ??
    (isAll.value
      ? (agg.value?.merged ?? createEmptySummary())
      : (single.value?.summary ?? createEmptySummary()))
)

const scannedRequests = computed(() => {
  const s = scan.value
  if (!s) return 0
  return isAll.value
    ? s.sites.reduce((sum, x) => sum + x.sampled, 0)
    : (s.sites.find((x) => x.siteId === selected.value)?.sampled ?? 0)
})

/**
 * 徽章要说清这个数字到底覆盖了什么：没扫描时只有当前页，
 * 扫描后是整个时间范围，并且如实标出采样是否被上限截断。
 */
const scopeLabel = computed(() => {
  if (!scan.value) return isAll.value ? '全部站点 · 当前页' : '当前页'
  const truncated = scan.value.sites.some((x) => x.truncated)
  return `全量 ${fmtInt(scannedRequests.value)} 条${truncated ? ' · 已截断' : ''}`
})

/**
 * 分站小计跟着扫描口径走。顶部写「全量 130 条」而下面一行还停在当前页的 100 条，
 * 两个数字并排出现就是自相矛盾。
 */
const breakdownSites = computed<SiteResult[]>(() => {
  const list = agg.value?.sites ?? []
  const s = scan.value
  if (!s) return list
  return list.map((row) => {
    const scanned = s.sites.find((x) => x.siteId === row.siteId)
    if (!scanned || !row.result) return row
    return { ...row, result: { ...row.result, summary: scanned.summary ?? row.result.summary } }
  })
})

const rows = computed<AnomalyRow[]>(() => {
  const base: UsageRow[] = isAll.value
    ? (agg.value?.sites ?? [])
        .filter((s) => s.result)
        .flatMap((s) => toRows(s.result!.items, s.label, s.kind))
        .sort((a, b) => b.createdAt - a.createdAt)
    : current.value && single.value
      ? toRows(single.value.items, current.value.profile.label, current.value.profile.kind)
      : []
  return annotate(base)
})

/** 只看异常时也要用全量样本算中位数，否则基准会被筛掉的行带偏 */
const visibleRows = computed(() =>
  anomalyOnly.value ? rows.value.filter((r) => r.severity !== 'none') : rows.value
)

const anomalyCounts = computed(() => countBySeverity(rows.value))
const smallGroups = computed(() => underSampledGroups(rows.value))

const costMode = computed<'usd' | 'quota' | 'mixed'>(() => {
  if (!isAll.value) {
    return current.value?.profile.kind === 'newapi' ? 'quota' : 'usd'
  }
  const kinds = new Set((agg.value?.sites ?? []).filter((s) => s.result).map((s) => s.kind))
  if (kinds.size > 1) return 'mixed'
  return kinds.has('newapi') ? 'quota' : 'usd'
})

const total = computed(() =>
  isAll.value
    ? (agg.value?.sites ?? []).reduce((n, s) => n + (s.result?.total ?? 0), 0)
    : (single.value?.total ?? 0)
)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)))

/** 各站余额互不相通，合并视图没有"总余额"这个概念 */
const balance = computed(() => (isAll.value ? null : (single.value?.balance ?? null)))

const loadedLabel = computed(() =>
  loadedAt.value ? `更新于 ${new Date(loadedAt.value).toTimeString().slice(0, 8)}` : ''
)

onMounted(async () => {
  const saved = await window.apiShow.prefsGet()
  if (saved.ok) {
    collapsed.value = saved.data.sidebarCollapsed
    hiddenColumns.value = saved.data.hiddenColumns
    themePref.value = saved.data.theme
  }
  applyTheme()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onSystemThemeChange)

  await refreshList()
  if (states.value.length) await select(states.value[0].profile.id)
})

onBeforeUnmount(() => {
  stopAuto()
  window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', onSystemThemeChange)
})

/**
 * 过 IPC 的必须是纯数据：hiddenColumns 是 Vue 的 reactive Proxy，
 * 结构化克隆不接受 Proxy，直接传会抛 "An object could not be cloned" 并静默失败。
 * 也不能带 undefined 键，主进程按 patch 合并时会把原值覆盖掉。
 */
async function persist(
  patch: { sidebarCollapsed?: boolean; hiddenColumns?: ColumnKey[]; theme?: Theme | null }
) {
  const clean: Partial<Prefs> = {}
  if (patch.sidebarCollapsed !== undefined) clean.sidebarCollapsed = patch.sidebarCollapsed
  if (patch.hiddenColumns !== undefined) clean.hiddenColumns = [...patch.hiddenColumns]
  if (patch.theme !== undefined) clean.theme = patch.theme
  await window.apiShow.prefsSave(clean)
}

async function toggleSidebar(): Promise<void> {
  collapsed.value = !collapsed.value
  await persist({ sidebarCollapsed: collapsed.value })
}

function toggleColumn(key: ColumnKey): void {
  const on = hiddenColumns.value.includes(key)
  hiddenColumns.value = on
    ? hiddenColumns.value.filter((k) => k !== key)
    : [...hiddenColumns.value, key]
  void persist({ hiddenColumns: hiddenColumns.value })
}

function showAllColumns(): void {
  hiddenColumns.value = []
  void persist({ hiddenColumns: [] })
}

async function refreshList(): Promise<void> {
  const res = await window.apiShow.sitesList()
  if (res.ok) {
    states.value = res.data
    if (!states.value.some((s) => s.profile.id === selected.value) && selected.value !== 'all') {
      selected.value = 'all'
    }
  } else {
    error.value = res.error.message
  }
}

function rangeWindow(): { startMs: number | null; endMs: number | null } {
  const days = rangeDays[filters.range]
  if (days === null) return { startMs: null, endMs: null }
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  start.setHours(0, 0, 0, 0)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function queryFilters() {
  return {
    page: filters.page,
    pageSize: filters.pageSize,
    groupId: isAll.value ? null : filters.groupId || null,
    model: filters.model.trim() || null,
    keyword: null,
    ...rangeWindow()
  }
}

/** keepScroll：自动刷新时不劫持滚动位置，否则每分钟把用户视线拽回顶部 */
async function run(opts: { keepScroll?: boolean; force?: boolean } = {}): Promise<void> {
  if (!states.value.length || isCompare.value) return
  loading.value = true
  error.value = ''
  notice.value = ''
  if (!opts.keepScroll) tableRef.value?.resetScroll()

  if (isAll.value) {
    const res = await window.apiShow.aggregate({
      siteIds: states.value.map((s) => s.profile.id),
      filters: queryFilters(),
      force: opts.force
    })
    loading.value = false
    if (res.ok) {
      agg.value = res.data
      loadedAt.value = Date.now()
    } else fail(res.error.kind, res.error.message)
    return
  }

  const siteId = selected.value
  const res = await window.apiShow.query({ siteId, filters: queryFilters(), force: opts.force })
  loading.value = false
  if (res.ok) {
    single.value = res.data
    loadedAt.value = Date.now()
    // 查询会自动建立会话，这里补一次连接拿分组列表
    const info = await window.apiShow.connect(siteId)
    if (info.ok) groups.value = info.data.groups
    await refreshList()
  } else {
    fail(res.error.kind, res.error.message)
    single.value = null
  }
}

/** 扫描结果对应哪一套筛选条件；条件变了就该作废，不能拿旧范围的数据顶着 */
function currentKey(): string {
  return `${isAll.value ? 'all' : selected.value}|${filters.range}|${filters.groupId}|${filters.model.trim()}`
}

/** 下拉框选的是分组 id，而记录里只有名字，扫描要按名字过滤 */
function groupNameOf(id: string): string | null {
  if (!id) return null
  return groups.value.find((g) => g.id === id)?.name ?? null
}

async function runScan(): Promise<void> {
  if (!states.value.length || isCompare.value) return
  scanLoading.value = true
  const w = rangeWindow()
  const res = await window.apiShow.scan({
    siteIds: isAll.value ? states.value.map((s) => s.profile.id) : [selected.value],
    groupId: isAll.value ? null : groupNameOf(filters.groupId),
    model: filters.model.trim() || null,
    startMs: w.startMs,
    endMs: w.endMs
  })
  scanLoading.value = false
  if (res.ok) {
    scan.value = res.data
    scanKey.value = currentKey()
  } else {
    error.value = res.error.message
  }
}

/** 令牌过期时继续自动刷只会反复撞墙，直接停掉并说明原因 */
function fail(kind: string, message: string): void {
  error.value = message
  if (kind === 'auth' && autoRefresh.value) {
    autoRefresh.value = false
    error.value = `${message}（自动刷新已停止，请重新登录该站点）`
  }
}

function applyPageSize(): void {
  if (pageSizeChoice.value === 'custom') {
    // 钳制值写回输入框，否则填 5000 被压到 1000 后界面还显示 5000，看着像没生效
    customSize.value = Math.min(PAGE_MAX, Math.max(1, Math.round(Number(customSize.value) || 1)))
    filters.pageSize = customSize.value
  } else {
    filters.pageSize = pageSizeChoice.value
  }
  applyFilter()
}

function stopAuto(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function startAuto(): void {
  stopAuto()
  timer = setInterval(() => {
    // 上一轮还没回来就跳过这次，避免请求堆积
    if (loading.value || compareLoading.value || scanLoading.value) return
    if (isCompare.value) {
      void runCompare()
      return
    }
    void run({ keepScroll: true, force: true })
    // 已经扫过就让它跟着刷新继续有效；没扫过的不擅自变成全量
    if (scan.value && scanKey.value === currentKey()) void runScan()
  }, refreshSec.value * 1000)
}

watch([autoRefresh, refreshSec], ([on]) => (on ? startAuto() : stopAuto()))

async function select(id: string): Promise<void> {
  selected.value = id
  filters.page = 1
  filters.groupId = ''
  groups.value = []
  single.value = null
  agg.value = null
  scan.value = null
  if (id === 'compare') await runCompare()
  else await run()
}

/**
 * 对比要拉满时间范围，比单页查询重得多，所以独立走一条路径：
 * 目标列还没选定时也要调用，用空 targets 换回各站的可选分组。
 */
async function runCompare(): Promise<void> {
  if (!states.value.length) return
  compareLoading.value = true
  error.value = ''
  notice.value = ''
  const window_ = rangeWindow()
  // compareTargets 里的元素是 reactive Proxy，直接过 IPC 会 "could not be cloned"
  const targets = compareTargets.value
    .filter((t) => t.siteId && t.groupName)
    .map((t) => ({ siteId: t.siteId, groupName: t.groupName }))
  const res = await window.apiShow.compare({
    targets,
    startMs: window_.startMs,
    endMs: window_.endMs,
    model: filters.model.trim() || null
  })
  compareLoading.value = false
  if (res.ok) compareResult.value = res.data
  else error.value = res.error.message
}

async function updateCompareTargets(next: CompareTarget[]): Promise<void> {
  compareTargets.value = next
  await runCompare()
}

function applyFilter(opts: { force?: boolean } = {}): void {
  if (isCompare.value) {
    void runCompare()
    return
  }
  filters.page = 1
  if (scan.value && scanKey.value !== currentKey()) scan.value = null
  void run({ force: opts.force })
}

/** 「查询」是明确的刷新意图，不该拿 60 秒内的缓存答复 */
function refreshNow(): void {
  applyFilter({ force: true })
}

function goto(page: number): void {
  filters.page = Math.min(Math.max(1, page), totalPages.value)
  void run()
}

function openAdd(): void {
  editing.value = null
  editorOpen.value = true
}

function openEdit(id: string): void {
  editing.value = states.value.find((s) => s.profile.id === id)?.profile ?? null
  editorOpen.value = true
}

async function onSaved(profile: SiteProfile): Promise<void> {
  editorOpen.value = false
  await refreshList()
  await select(profile.id)
}

async function openPanel(id: string): Promise<void> {
  notice.value = ''
  const res = await window.apiShow.openPanel(id)
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  error.value = ''
  if (!res.data.seeded) {
    notice.value = '未能自动带入登录态（该站凭据不可用或需要重新登录），面板已打开，请在其中手动登录。'
  }
}

async function remove(id: string): Promise<void> {
  await window.apiShow.sitesRemove(id)
  await refreshList()
  if (selected.value === id) await select(states.value[0]?.profile.id ?? 'all')
  else void run()
}
</script>

<template>
  <div class="app">
    <SiteList
      :states="states"
      :selected="selected"
      :collapsed="collapsed"
      @select="select"
      @add="openAdd"
      @edit="openEdit"
      @remove="remove"
      @toggle="toggleSidebar"
      @open-panel="openPanel"
    />

    <div class="main">
      <header class="top">
        <div class="brand">
          <span class="mark">API</span>
          <span class="name">用量与缓存率</span>
        </div>
        <template v-if="isCompare">
          <span class="acct">分组横向对比 · 拉满时间范围后按 (站点, 分组) 聚合</span>
        </template>
        <template v-else-if="!isAll && current">
          <span class="tag" :class="current.profile.kind">
            {{ current.profile.kind === 'sub2api' ? 'sub2api' : 'new-api' }}
          </span>
          <span class="host num">{{ current.profile.baseUrl }}</span>
          <span class="acct">{{ current.profile.account }}</span>
        </template>
        <template v-else>
          <span class="acct">跨站合并 · 缓存率按 token 加权</span>
        </template>
        <div class="tools">
          <div class="tool-anchor">
            <button
              class="btn ghost sm"
              :class="{ active: settingsOpen }"
              :disabled="!states.length"
              @click="settingsOpen = !settingsOpen"
            >
              设置
            </button>
            <SettingsPanel
              v-if="settingsOpen"
              :hidden="hiddenColumns"
              @toggle="toggleColumn"
              @show-all="showAllColumns"
            />
          </div>
          <button
            class="btn ghost sm"
            :title="theme === 'dark' ? '切换回浅色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            {{ theme === 'dark' ? '浅色' : '深色' }}
          </button>
          <button class="btn ghost sm" :disabled="loading || !states.length" @click="run()">刷新</button>
        </div>
      </header>

      <div v-if="settingsOpen" class="backdrop" @click="settingsOpen = false" />

      <div v-if="!states.length" class="welcome">
        <h2>还没有站点</h2>
        <p>添加一个 sub2api 中转站点，工具会读取它的用量记录并算出每条与总体的缓存命中率。</p>
        <button class="btn" @click="openAdd">添加第一个站点</button>
      </div>

      <template v-else>
        <section class="filters">
          <div v-if="!isCompare" class="field">
            <label>分组</label>
            <select
              v-model="filters.groupId"
              :disabled="isAll || !groups.length"
              @change="applyFilter()"
            >
              <option value="">{{ isAll ? '合并视图不按分组' : '全部分组' }}</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
          <div class="field">
            <label>时间范围</label>
            <select v-model="filters.range" @change="applyFilter()">
              <option value="today">今天</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
              <option value="all">全部</option>
            </select>
          </div>
          <div class="field wide">
            <label>模型（精确匹配）</label>
            <input v-model="filters.model" placeholder="gpt-6-astra" @keyup.enter="applyFilter()" />
          </div>
          <!-- 对比是一次性拉满样本的聚合，没有分页概念 -->
          <template v-if="!isCompare">
            <div class="field">
              <label>每页</label>
              <select v-model="pageSizeChoice" @change="applyPageSize">
                <option v-for="n in PAGE_PRESETS" :key="n" :value="n">{{ n }}</option>
                <option value="custom">自定义…</option>
              </select>
            </div>
            <div v-if="pageSizeChoice === 'custom'" class="field narrow">
              <label>条数（1–{{ PAGE_MAX }}）</label>
              <input
                v-model.number="customSize"
                type="number"
                min="1"
                :max="PAGE_MAX"
                @keyup.enter="applyPageSize"
                @change="applyPageSize"
              />
            </div>
          </template>
          <div class="field auto-field">
            <label>自动刷新</label>
            <div class="auto">
              <label class="switch" :title="autoRefresh ? '关闭自动刷新' : '开启自动刷新'">
                <input v-model="autoRefresh" type="checkbox" />
                <span class="track" />
              </label>
              <select v-model.number="refreshSec" :disabled="!autoRefresh" class="interval">
                <option v-for="s in INTERVALS" :key="s" :value="s">
                  {{ s < 60 ? `${s} 秒` : `${s / 60} 分钟` }}
                </option>
              </select>
            </div>
          </div>
          <button
            class="btn"
            :disabled="loading || compareLoading"
            :title="isCompare ? '按当前时间范围重新拉取各站样本' : '忽略缓存重新拉取当前页'"
            @click="refreshNow"
          >
            {{ isCompare ? '重新采样' : '查询' }}
          </button>
          <button
            v-if="!isCompare"
            class="btn ghost"
            :disabled="loading || scanLoading || !states.length"
            :title="
              scan
                ? '按当前时间范围重新扫描全部记录'
                : '把时间范围内的记录全部拉完再汇总；默认的汇总只累加当前这一页'
            "
            @click="runScan"
          >
            {{ scanLoading ? '扫描中…' : scan ? '重新扫描' : '全量统计' }}
          </button>
        </section>

        <p v-if="error" class="err">{{ error }}</p>
        <p v-else-if="notice" class="notice">{{ notice }}</p>

        <CompareView
          v-if="isCompare"
          :sites="compareResult?.sites ?? []"
          :columns="compareResult?.columns ?? []"
          :targets="compareTargets"
          :sample-cap="compareResult?.sampleCap ?? 4000"
          :loading="compareLoading"
          @update:targets="updateCompareTargets"
        />

        <template v-else>
        <SummaryBar
          :summary="summary"
          :cost-mode="costMode"
          :scope-label="scopeLabel"
          :balance="balance"
          :show-balance="!isAll"
        />

        <template v-if="isAll">
          <div class="sec-head">
            <span>分站小计</span>
            <small v-if="agg" class="dim">
              {{ agg.okCount }} 个成功<span v-if="agg.failedCount"> · {{ agg.failedCount }} 个失败</span>
            </small>
          </div>
          <SiteBreakdown :sites="breakdownSites" />
        </template>

        <template v-if="scan">
          <div class="sec-head">
            <span>缓存率趋势</span>
            <small class="dim">
              {{ isAll ? '每个站点一条线' : '每个分组一条线' }} · 共 {{ scan.days.length }} 天
            </small>
            <small v-if="scan.failedCount" class="dim">
              {{ scan.failedCount }} 个站点没能扫描，未计入
            </small>
            <button class="btn ghost sm trend-fold" @click="trendOpen = !trendOpen">
              {{ trendOpen ? '收起' : '展开' }}
            </button>
          </div>
          <TrendChart v-if="trendOpen" :days="scan.days" :series="scan.series" />
        </template>

        <div class="sec-head">
          <span>明细</span>
          <span class="count num">
            {{ isAll ? '各站' : '第' }} {{ filters.page }} / {{ totalPages }} 页 · 共
            {{ fmtInt(total) }} 条
          </span>
          <span class="legend">
            <em class="lg bad">严重 {{ anomalyCounts.bad }}</em>
            <em class="lg warn">轻度 {{ anomalyCounts.warn }}</em>
          </span>
          <label class="only">
            <input v-model="anomalyOnly" type="checkbox" />
            只看异常
          </label>
          <small v-if="smallGroups" class="dim">{{ smallGroups }} 个分组样本不足 5 条，不参与判定</small>
          <span v-if="autoRefresh" class="auto-on">
            <i class="pulse" /> 自动刷新 · 每 {{ refreshSec < 60 ? `${refreshSec} 秒` : `${refreshSec / 60} 分钟` }}
          </span>
          <span v-if="loading" class="loading">加载中…</span>
          <small v-else-if="loadedLabel" class="dim">{{ loadedLabel }}</small>
        </div>

        <UsageTable
          ref="tableRef"
          :rows="visibleRows"
          :show-site="isAll"
          :hidden="hiddenColumns"
        />

        <nav class="pager">
          <button class="btn ghost sm" :disabled="loading || filters.page <= 1" @click="goto(1)">首页</button>
          <button class="btn ghost sm" :disabled="loading || filters.page <= 1" @click="goto(filters.page - 1)">
            上一页
          </button>
          <span class="num">{{ filters.page }} / {{ totalPages }}</span>
          <button
            class="btn ghost sm"
            :disabled="loading || filters.page >= totalPages"
            @click="goto(filters.page + 1)"
          >
            下一页
          </button>
          <button
            class="btn ghost sm"
            :disabled="loading || filters.page >= totalPages"
            @click="goto(totalPages)"
          >
            末页
          </button>
        </nav>
        </template>
      </template>
    </div>

    <SiteEditor
      v-if="editorOpen"
      :initial="editing"
      @close="editorOpen = false"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
}

.main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 不能设 overflow:hidden —— 那会把设置弹层一起剪掉，表格滚动由 .grid 自己负责 */
}

.main > *:not(.grid) {
  flex: 0 0 auto;
}

.main > .grid {
  margin: 0 14px;
}

.main > .cmp {
  flex: 1;
  min-height: 0;
  margin: 0 14px;
}

.main > .pager {
  padding-bottom: 12px;
}

.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.tool-anchor {
  position: relative;
}

.btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 15;
}

.top {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  padding: 0 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-right: 4px;
}

.mark {
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
}

.name {
  font-weight: 600;
}

.host {
  color: var(--text-dim);
  font-size: 12px;
}

.acct {
  color: var(--text-faint);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn.sm {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}

.welcome {
  margin: auto;
  max-width: 420px;
  text-align: center;
  color: var(--text-dim);
}

.welcome h2 {
  margin: 0 0 8px;
  font-size: 17px;
  color: var(--text);
}

.welcome p {
  margin: 0 0 16px;
  line-height: 1.6;
}

.pane-gap {
  flex: 1;
}

.filters {
  display: flex;
  align-items: flex-end;
  /* 自定义条数会多占一栏，宽度不够时整行换到第二行，而不是压扁按钮 */
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 14px 0;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  flex: 0 0 auto;
}

.filters .field {
  width: 150px;
  flex: 0 1 150px;
}

.filters .field.wide {
  width: 210px;
  flex: 0 1 210px;
}

.filters .field.narrow {
  width: 116px;
  flex: 0 0 116px;
}

/* 开关和间隔选择器是固定尺寸，不参与收缩 */
.filters .field.auto-field {
  width: auto;
  flex: 0 0 auto;
}

.err {
  margin: 10px 14px 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--tint-bad);
  color: var(--bad);
}

/* 提示而非报错：面板已经打开，只是没能自动带入登录态 */
.notice {
  margin: 10px 14px 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--warn-soft);
  color: var(--warn);
}

.main > * + * {
  margin-top: 10px;
}

.main > .filters + *,
.main > .err + * {
  margin-top: 10px;
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.trend-fold {
  margin-left: auto;
}

.count {
  font-weight: 400;
  color: var(--text-faint);
}

.loading {
  color: var(--accent);
}

.legend {
  display: inline-flex;
  gap: 8px;
}

.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-style: normal;
  font-size: 11.5px;
  color: var(--text-dim);
}

.lg::before {
  content: '';
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.lg.bad::before {
  background: var(--bad);
}

.lg.warn::before {
  background: var(--warn);
}

.only {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-dim);
  cursor: pointer;
}

.only input {
  margin: 0;
}

.dim {
  font-weight: 400;
  color: var(--text-faint);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 0 0 auto;
}

.auto {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
}

.switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 18px;
  flex: 0 0 34px;
  cursor: pointer;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.switch .track {
  position: absolute;
  inset: 0;
  border-radius: 9px;
  background: var(--border-strong);
  transition: background 0.15s ease;
}

.switch .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--knob);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.24);
  transition: transform 0.15s ease;
}

.switch input:checked + .track {
  background: var(--accent);
}

.switch input:checked + .track::after {
  transform: translateX(16px);
}

.switch input:focus-visible + .track {
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.interval {
  width: 74px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--panel);
}

.interval:disabled {
  opacity: 0.45;
}

.auto-on {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 400;
  font-size: 11.5px;
  color: var(--accent);
}

.pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
</style>
