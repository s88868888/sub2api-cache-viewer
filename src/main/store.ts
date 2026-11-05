import { safeStorage } from 'electron'
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
  loginMode: 'password' | 'jwt'
  username: string
  /** base64(safeStorage 加密后的密码)；系统不支持加密时不保存 */
  passwordCipher: string | null
  jwt: string | null
  lastUsedAt: number | null
}

/** Electron 45 起同步探测被弃用，优先走异步版本。 */
export async function encryptionAvailable(): Promise<boolean> {
  try {
    const asyncProbe = (
      safeStorage as { isAsyncEncryptionAvailable?: () => Promise<boolean> }
    ).isAsyncEncryptionAvailable
    if (typeof asyncProbe === 'function') return await asyncProbe.call(safeStorage)
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export async function encryptSecret(plain: string): Promise<string | null> {
  if (!plain || !(await encryptionAvailable())) return null
  return Buffer.from(safeStorage.encryptString(plain)).toString('base64')
}

export async function decryptSecret(cipher: string | null): Promise<string> {
  if (!cipher || !(await encryptionAvailable())) return ''
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    return ''
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
      return Array.isArray(raw) ? (raw as StoredSite[]) : []
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

  /** 新增或更新。password / jwt 未下发时保留原值，空串表示清除。 */
  async upsert(draft: SiteDraft): Promise<StoredSite> {
    const list = this.load()
    const existing = draft.id ? list.find((s) => s.id === draft.id) : undefined

    const site: StoredSite = {
      id: existing?.id ?? randomUUID(),
      label: draft.label.trim() || hostOf(draft.baseUrl),
      baseUrl: draft.baseUrl,
      kind: draft.kind,
      account: draft.account.trim() || draft.username.trim() || hostOf(draft.baseUrl),
      loginMode: draft.loginMode,
      username: draft.username,
      passwordCipher:
        draft.password === undefined
          ? (existing?.passwordCipher ?? null)
          : ((await encryptSecret(draft.password)) ?? null),
      jwt: draft.jwt === undefined ? (existing?.jwt ?? null) : draft.jwt || null,
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

  /** 更新登录方式（内置浏览器截获令牌后走 jwt）。 */
  applyCred(id: string, jwt: string, account: string): void {
    const list = this.load()
    this.saveAll(
      list.map((s) =>
        s.id === id ? { ...s, jwt, loginMode: 'jwt' as const, account, lastUsedAt: Date.now() } : s
      )
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
    loginMode: site.loginMode,
    username: site.username,
    hasPassword: Boolean(site.passwordCipher),
    hasJwt: Boolean(site.jwt),
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
