import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { GatewayService, CompareSiteInput, PanelCredential, Target } from './service'
import { openSitePanel } from './panel'
import { SiteError, detectSite } from './adapters'
import {
  AggregateResult,
  CompareTarget,
  LoginParams,
  Prefs,
  QueryFilters,
  SiteDraft,
  SiteProfile,
  SiteState
} from '../shared/contracts'
import { normalizeBaseUrl } from './http'
import { captureJwtWithBrowser } from './capture'
import {
  PrefsStore,
  StoredSite,
  SiteStore,
  decryptSecret,
  encryptionAvailable,
  toProfile
} from './store'

let win: BrowserWindow | null = null
const service = new GatewayService()
const store = new SiteStore(app.getPath('userData'))
const prefs = new PrefsStore(app.getPath('userData'))

const IPC = {
  detect: 'site:detect',
  capture: 'site:capture',
  connect: 'site:connect',
  query: 'site:query',
  aggregate: 'site:aggregate',
  logout: 'site:logout',
  sitesList: 'sites:list',
  sitesSave: 'sites:save',
  sitesRemove: 'sites:remove',
  prefsGet: 'prefs:get',
  prefsSave: 'prefs:save',
  compare: 'site:compare',
  scan: 'site:scan',
  openPanel: 'site:open-panel',
  appMeta: 'app:meta'
} as const

/**
 * 主题走启动参数而不是等渲染层发 IPC 去问：
 * 后者必然先画出浅色再切深色，暗色用户每次开都闪一下。
 */
function initialTheme(): string {
  const saved = prefs.load().theme
  return saved ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1120,
    minHeight: 660,
    show: false,
    autoHideMenuBar: true,
    title: 'API Show · 用量与缓存率',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--initial-theme=${initialTheme()}`]
    }
  })

  win.on('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * 所有 IPC 走统一包装：把 SiteError 转成可序列化的错误对象给渲染层。
 * arg 是 IPC 边界上的入参，类型由各个 handler 自己收窄。
 */
function handle(channel: string, fn: (arg: any) => unknown): void {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, data: await fn(arg) }
    } catch (err) {
      if (err instanceof SiteError) {
        return { ok: false, error: { message: err.message, kind: err.kind, status: err.status } }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { message, kind: 'unknown' as const } }
    }
  })
}

function mustGet(id: string): StoredSite {
  const site = store.find(id)
  if (!site) throw new SiteError('这个站点已被删除或不存在', 'shape')
  return site
}

async function paramsFor(site: StoredSite): Promise<LoginParams> {
  if (site.loginMode === 'jwt') {
    if (!site.jwt) throw new SiteError('该站点没有可用令牌，请重新登录', 'auth')
    return {
      baseUrl: site.baseUrl,
      username: '',
      password: '',
      mode: 'jwt',
      jwt: site.jwt,
      kind: site.kind
    }
  }
  const password = await decryptSecret(site.passwordCipher)
  if (!password) {
    throw new SiteError('本机没有该站点的可用密码，请重新填写', 'auth')
  }
  return {
    baseUrl: site.baseUrl,
    username: site.username,
    password,
    mode: 'password',
    kind: site.kind
  }
}

/**
 * 组装参与对比/扫描的站点。凭据不可用的站点带着原因返回，
 * 而不是让整批请求一起失败 —— 界面需要照常列出这一站并说明它为什么缺席。
 */
async function siteInputs(ids: string[]): Promise<CompareSiteInput[]> {
  const out: CompareSiteInput[] = []
  for (const site of ids.map(mustGet)) {
    try {
      out.push({ siteId: site.id, label: site.label, params: await paramsFor(site) })
    } catch (err) {
      out.push({
        siteId: site.id,
        label: site.label,
        params: { baseUrl: site.baseUrl, username: '', password: '', mode: 'password' },
        paramsError: err instanceof SiteError ? err.message : String(err)
      })
    }
  }
  return out
}

function registerIpc(): void {
  handle(IPC.appMeta, async () => ({ canEncrypt: await encryptionAvailable() }))

  handle(IPC.detect, (baseUrl: string) => detectSite(normalizeBaseUrl(baseUrl)))

  handle(IPC.sitesList, (): SiteState[] =>
    store.load().map((site) => ({ profile: toProfile(site), connected: service.isConnected(site.id) }))
  )

  handle(IPC.sitesSave, async (draft: SiteDraft): Promise<SiteProfile> => {
    const next: SiteDraft = { ...draft, baseUrl: normalizeBaseUrl(draft.baseUrl) }
    const saved = await store.upsert(next)
    service.disconnect(saved.id)
    return toProfile(saved)
  })

  handle(IPC.sitesRemove, (id: string) => {
    service.disconnect(id)
    store.remove(id)
  })

  handle(IPC.prefsGet, () => prefs.load())

  handle(IPC.prefsSave, (patch: Partial<Prefs>) => prefs.save(patch))

  handle(IPC.connect, async (id: string) => {
    const site = mustGet(id)
    const info = await service.connect(site.id, await paramsFor(site))
    store.markUsed(site.id)
    return info
  })

  handle(
    IPC.capture,
    async (arg: { id?: string; baseUrl: string; label?: string }): Promise<SiteProfile> => {
      const baseUrl = normalizeBaseUrl(arg.baseUrl)
      const kind = (await detectSite(baseUrl)) ?? null
      if (kind !== 'sub2api') {
        throw new SiteError('内置浏览器登录目前只支持 sub2api 站点', 'shape')
      }

      const jwt = await captureJwtWithBrowser(baseUrl)
      const saved = await store.upsert({
        id: arg.id,
        label: arg.label ?? '',
        baseUrl,
        kind,
        account: '',
        username: '',
        loginMode: 'jwt',
        jwt
      })

      const info = await service.connect(saved.id, {
        baseUrl,
        username: '',
        password: '',
        mode: 'jwt',
        jwt,
        kind
      })
      store.applyCred(saved.id, jwt, info.account)
      return toProfile({ ...saved, account: info.account })
    }
  )

  handle(IPC.logout, (id: string) => service.disconnect(id))

  /**
   * 免登录打开官网面板。拿不到凭据时不报错，退回成普通打开 ——
   * 用户仍然可以自己在里面登录，比弹一个错误有用。
   */
  handle(IPC.openPanel, async (siteId: string) => {
    const site = mustGet(siteId)
    let cred: PanelCredential
    try {
      cred = await service.panelCredential(site.id, await paramsFor(site))
    } catch {
      cred = { kind: site.kind, baseUrl: site.baseUrl, seed: null, cookies: [] }
    }
    await openSitePanel(cred)
    return { kind: cred.kind, seeded: Boolean(cred.seed || cred.cookies.length) }
  })

  handle(IPC.query, async (arg: { siteId: string; filters: QueryFilters }) => {
    const site = mustGet(arg.siteId)
    await service.connect(site.id, await paramsFor(site))
    store.markUsed(site.id)
    return service.query(site.id, arg.filters)
  })

  handle(IPC.aggregate, async (arg: { siteIds: string[]; filters: QueryFilters }) => {
    const sites = arg.siteIds.map(mustGet)
    const targets: Target[] = []
    for (const site of sites) {
      targets.push({
        siteId: site.id,
        label: site.label,
        params: await paramsFor(site)
      })
    }
    return service.aggregate(targets, arg.filters)
  })

  /**
   * 对比要列出所有站点的可选分组，所以入参只有已选列和时间范围，
   * 站点集合由主进程自己从已保存的站点取。
   */
  handle(
    IPC.compare,
    async (arg: {
      targets: CompareTarget[]
      startMs: number | null
      endMs: number | null
      model: string | null
    }) => {
      const sites = await siteInputs(store.load().map((s) => s.id))
      return service.compare({
        sites,
        targets: arg.targets,
        startMs: arg.startMs,
        endMs: arg.endMs,
        model: arg.model
      })
    }
  )

  handle(
    IPC.scan,
    async (arg: {
      siteIds: string[]
      groupId: string | null
      model: string | null
      startMs: number | null
      endMs: number | null
    }) => {
      const sites = await siteInputs(arg.siteIds)
      return service.scan({
        sites,
        groupId: arg.groupId,
        model: arg.model,
        startMs: arg.startMs,
        endMs: arg.endMs
      })
    }
  )
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.apishow.desktop')
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
