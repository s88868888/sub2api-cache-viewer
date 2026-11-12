import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PREFS, type Prefs, type SiteDraft, type SiteKind, type SiteProfile } from '../shared/contracts'

export interface StoredSite {
  id: string
  label: string
  baseUrl: string
  kind: SiteKind
  account: string
  /** 内置浏览器登录后截获的面板令牌 */
  token: string | null
  lastUsedAt: number | null
}

/**
 * 旧版本按 loginMode + 密文密码 + jwt 三个字段存，读到时收敛成单一令牌。
 * 不做这层转换，升级后每个站点都会掉成「没有令牌」，得重新登录一遍。
 */
function toStoredSite(raw: Record<string, unknown>): StoredSite {
  const token = raw.token ?? raw.jwt
  return {
    id: String(raw.id ?? randomUUID()),
    label: String(raw.label ?? ''),
    baseUrl: String(raw.baseUrl ?? ''),
    kind: raw.kind === 'newapi' ? 'newapi' : 'sub2api',
    account: String(raw.account ?? ''),
    token: typeof token === 'string' && token ? token : null,
    lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : null
  }
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export class SiteStore {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'sites.json')
  }

  load(): StoredSite[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown
      return Array.isArray(raw) ? raw.map((s) => toStoredSite(s as Record<string, unknown>)) : []
    } catch {
      return []
    }
  }

  private saveAll(list: StoredSite[]): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(list, null, 2), 'utf-8')
  }

  find(id: string): StoredSite | undefined {
    return this.load().find((s) => s.id === id)
  }

  /** 新增或更新。token 未下发时保留原值，空串表示清除。 */
  upsert(draft: SiteDraft): StoredSite {
    const list = this.load()
    const existing = draft.id ? list.find((s) => s.id === draft.id) : undefined

    const site: StoredSite = {
      id: existing?.id ?? randomUUID(),
      label: draft.label.trim() || hostOf(draft.baseUrl),
      baseUrl: draft.baseUrl,
      kind: draft.kind,
      account: draft.account.trim() || hostOf(draft.baseUrl),
      token: draft.token === undefined ? (existing?.token ?? null) : draft.token || null,
      lastUsedAt: existing?.lastUsedAt ?? null
    }

    this.saveAll(existing ? list.map((s) => (s.id === site.id ? site : s)) : [...list, site])
    return site
  }

  remove(id: string): void {
    this.saveAll(this.load().filter((s) => s.id !== id))
  }

  markUsed(id: string): void {
    const list = this.load()
    this.saveAll(list.map((s) => (s.id === id ? { ...s, lastUsedAt: Date.now() } : s)))
  }

  /** 建立会话后回填面板账号名，并记一次使用时间。 */
  applyLogin(id: string, account: string): void {
    const list = this.load()
    this.saveAll(
      list.map((s) => (s.id === id ? { ...s, account, lastUsedAt: Date.now() } : s))
    )
  }
}

export function toProfile(site: StoredSite): SiteProfile {
  return {
    id: site.id,
    label: site.label,
    baseUrl: site.baseUrl,
    kind: site.kind,
    account: site.account,
    hasToken: Boolean(site.token),
    lastUsedAt: site.lastUsedAt
  }
}

export class PrefsStore {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'prefs.json')
  }

  load(): Prefs {
    try {
      return { ...DEFAULT_PREFS, ...(JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<Prefs>) }
    } catch {
      return { ...DEFAULT_PREFS }
    }
  }

  save(patch: Partial<Prefs>): Prefs {
    const next = { ...this.load(), ...patch }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf-8')
    return next
  }
}
