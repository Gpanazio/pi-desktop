// Site permissions of the browser panel, decided the way Chrome does: a few are
// always on, the sensitive ones ask once per origin and remember the answer,
// the rest are refused. Free of any `electron` import so tests run under plain
// Node; browser-session.ts supplies the prompt and the file.

export type PermissionPolicy = 'allow' | 'ask' | 'deny'
export type PermissionDecision = 'allow' | 'deny'

const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write'])
const ASKED: ReadonlySet<string> = new Set(['media', 'geolocation', 'clipboard-read'])

export function permissionPolicy(permission: string): PermissionPolicy {
  if (ALWAYS_ALLOWED.has(permission)) return 'allow'
  return ASKED.has(permission) ? 'ask' : 'deny'
}

/** The origin a decision is kept under; only http(s) pages have one. */
export function permissionOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export interface PermissionFileIo {
  read(): string | null
  write(text: string): void
}

type DecisionMap = Record<string, Record<string, PermissionDecision>>

/** Decisions per origin and permission: in memory, and in a file for the ones the person asked to remember. */
export class BrowserPermissionStore {
  private readonly session = new Map<string, PermissionDecision>()
  private readonly saved = new Map<string, PermissionDecision>()

  constructor(private readonly io: PermissionFileIo | null = null) {
    this.load()
  }

  get(origin: string, permission: string): PermissionDecision | undefined {
    const key = `${origin}\n${permission}`
    return this.session.get(key) ?? this.saved.get(key)
  }

  set(origin: string, permission: string, decision: PermissionDecision, remember: boolean): void {
    const key = `${origin}\n${permission}`
    if (!remember) {
      this.session.set(key, decision)
      return
    }
    this.session.delete(key)
    this.saved.set(key, decision)
    this.persist()
  }

  private load(): void {
    try {
      const text = this.io?.read()
      if (!text) return
      const data = JSON.parse(text) as DecisionMap
      for (const [origin, permissions] of Object.entries(data)) {
        if (typeof permissions !== 'object' || permissions === null) continue
        for (const [permission, decision] of Object.entries(permissions)) {
          if (decision === 'allow' || decision === 'deny') this.saved.set(`${origin}\n${permission}`, decision)
        }
      }
    } catch {
      // A damaged file asks again.
    }
  }

  private persist(): void {
    const data: DecisionMap = {}
    for (const [key, decision] of this.saved) {
      const [origin, permission] = key.split('\n')
      ;(data[origin] ??= {})[permission] = decision
    }
    try {
      this.io?.write(JSON.stringify(data, null, 2))
    } catch {
      // The decision still holds for this run.
    }
  }
}

export interface PermissionAnswer {
  allow: boolean
  remember: boolean
}

export interface PermissionDetails {
  /** Page asking, as Electron reports it. */
  requestingUrl?: string
  /** For `media`: 'audio' and/or 'video'. */
  mediaTypes?: string[]
}

export interface BrowserPermissions {
  /** The answer to a request: policy, then the saved decision, then the person. */
  request(permission: string, details: PermissionDetails): Promise<boolean>
  /** A synchronous check: only a saved "allow" counts for the asked permissions. */
  check(permission: string, requestingOrigin: string | undefined): boolean
}

export function createBrowserPermissions(store: BrowserPermissionStore, ask: (origin: string, permission: string, details: PermissionDetails) => Promise<PermissionAnswer>): BrowserPermissions {
  // The same page asking twice at once is asked about once.
  const pending = new Map<string, Promise<boolean>>()
  return {
    async request(permission, details) {
      const policy = permissionPolicy(permission)
      if (policy !== 'ask') return policy === 'allow'
      const origin = permissionOrigin(details.requestingUrl)
      if (!origin) return false
      const saved = store.get(origin, permission)
      if (saved) return saved === 'allow'
      const key = `${origin}\n${permission}`
      const running = pending.get(key)
      if (running) return running
      const asking = ask(origin, permission, details)
        .then((answer) => {
          store.set(origin, permission, answer.allow ? 'allow' : 'deny', answer.remember)
          return answer.allow
        })
        .catch(() => false)
        .finally(() => pending.delete(key))
      pending.set(key, asking)
      return asking
    },
    check(permission, requestingOrigin) {
      const policy = permissionPolicy(permission)
      if (policy !== 'ask') return policy === 'allow'
      const origin = permissionOrigin(requestingOrigin)
      return origin !== null && store.get(origin, permission) === 'allow'
    },
  }
}
