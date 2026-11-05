import { contextBridge, ipcRenderer } from 'electron'
import type {
  AggregateResult,
  CompareResult,
  CompareTarget,
  ConnectionInfo,
  IpcResult,
  Prefs,
  QueryFilters,
  QueryResult,
  SiteDraft,
  SiteKind,
  SiteProfile,
  SiteState
} from '../shared/contracts'

// 渲染层没有 nodeIntegration，启动参数只能由 preload 读出来再递过去
const initialThemeArg = process.argv.find((a) => a.startsWith('--initial-theme='))
const initialTheme = initialThemeArg ? initialThemeArg.slice('--initial-theme='.length) : null

const api = {
  initialTheme: (): string | null => initialTheme,

  meta: (): Promise<IpcResult<{ canEncrypt: boolean }>> => ipcRenderer.invoke('app:meta'),

  detect: (baseUrl: string): Promise<IpcResult<SiteKind | null>> =>
    ipcRenderer.invoke('site:detect', baseUrl),

  sitesList: (): Promise<IpcResult<SiteState[]>> => ipcRenderer.invoke('sites:list'),

  sitesSave: (draft: SiteDraft): Promise<IpcResult<SiteProfile>> =>
    ipcRenderer.invoke('sites:save', draft),

  sitesRemove: (id: string): Promise<IpcResult<void>> => ipcRenderer.invoke('sites:remove', id),

  connect: (id: string): Promise<IpcResult<ConnectionInfo>> =>
    ipcRenderer.invoke('site:connect', id),

  capture: (arg: {
    id?: string
    baseUrl: string
    label?: string
  }): Promise<IpcResult<SiteProfile>> => ipcRenderer.invoke('site:capture', arg),

  logout: (id: string): Promise<IpcResult<void>> => ipcRenderer.invoke('site:logout', id),

  query: (arg: {
    siteId: string
    filters: QueryFilters
  }): Promise<IpcResult<QueryResult>> => ipcRenderer.invoke('site:query', arg),

  aggregate: (arg: {
    siteIds: string[]
    filters: QueryFilters
  }): Promise<IpcResult<AggregateResult>> => ipcRenderer.invoke('site:aggregate', arg),

  compare: (arg: {
    targets: CompareTarget[]
    startMs: number | null
    endMs: number | null
    model: string | null
  }): Promise<IpcResult<CompareResult>> => ipcRenderer.invoke('site:compare', arg),

  openPanel: (
    siteId: string
  ): Promise<IpcResult<{ kind: SiteKind; seeded: boolean }>> =>
    ipcRenderer.invoke('site:open-panel', siteId),

  prefsGet: (): Promise<IpcResult<Prefs>> => ipcRenderer.invoke('prefs:get'),

  prefsSave: (patch: Partial<Prefs>): Promise<IpcResult<Prefs>> =>
    ipcRenderer.invoke('prefs:save', patch)
}

contextBridge.exposeInMainWorld('apiShow', api)

export type ApiShowBridge = typeof api
