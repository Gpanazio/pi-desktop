// The loopback door the agent's browser tools use. Pi runs as a child process
// with no IPC to the app, so the bundled extension (resources/pi-desktop-browser.ts)
// talks HTTP to this server: GET /state tells it whether the panel is open,
// POST /action drives it. The server listens on 127.0.0.1 only, on an ephemeral
// port, and every request needs a bearer token minted for one session:
// `<base64url(sessionKey)>.<HMAC-SHA256(process secret, sessionKey)>`. The
// token names the session, so a Pi process can act on its own browser only. A request whose
// Host or Origin is not ours is refused first, so a web page cannot reach it by
// DNS rebinding or a cross-origin fetch.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isNoBrowserSessionKey } from '../../shared/browser'
import { getBrowser } from './browser-controller'
import { runBrowserAction, type ActionHandle, type ActionParams, type ActionResult } from './browser-actions'

export const BROWSER_URL_ENV = 'PI_DESKTOP_BROWSER_URL'
export const BROWSER_TOKEN_ENV = 'PI_DESKTOP_BROWSER_TOKEN'
export const BROWSER_SESSION_ENV = 'PI_DESKTOP_SESSION_KEY'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_SESSION_KEY_LENGTH = 512

export interface BrowserBridgeOptions {
  /** Where the bridge finds a session's browser. Tests pass a fake. */
  getBrowser?: (sessionKey: string) => ActionHandle | null
  /** The process secret the per-session tokens are derived from. Tests pass a fixed one. */
  secret?: string
}

export interface BrowserBridge {
  readonly port: number
  readonly url: string
  /** The token that lets a Pi process act on `sessionKey`'s browser, and on nothing else. */
  tokenFor(sessionKey: string): string
  /** The environment a Pi process of this session needs to reach the bridge. */
  envFor(sessionKey: string): Record<string, string>
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function mint(secret: string, sessionKey: string): string {
  const mac = createHmac('sha256', secret).update(sessionKey).digest('hex')
  return `${Buffer.from(sessionKey, 'utf8').toString('base64url')}.${mac}`
}

/** The session a valid bearer token was minted for, or null for a missing, malformed or forged one. */
function sessionOfToken(header: string | undefined, secret: string): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(header ?? '')
  if (!match) return null
  const sessionKey = parseSessionKey(Buffer.from(match[1], 'base64url').toString('utf8'))
  if (!sessionKey) return null
  const given = Buffer.from(match[2])
  const wanted = Buffer.from(mint(secret, sessionKey).split('.')[1])
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? sessionKey : null
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseSessionKey(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= MAX_SESSION_KEY_LENGTH ? value : null
}

export async function startBrowserBridge(options: BrowserBridgeOptions = {}): Promise<BrowserBridge> {
  const lookup = options.getBrowser ?? getBrowser
  const secret = options.secret ?? randomBytes(32).toString('hex')
  // One action at a time per session: the page is a single shared surface, and
  // a model may issue tool calls in parallel.
  const queues = new Map<string, Promise<unknown>>()
  let allowedHosts = new Set<string>()

  const runQueued = (sessionKey: string, job: () => Promise<ActionResult>): Promise<ActionResult> => {
    const previous = queues.get(sessionKey) ?? Promise.resolve()
    const next = previous.then(job, job)
    const tail = next.catch(() => {})
    queues.set(sessionKey, tail)
    void tail.then(() => {
      if (queues.get(sessionKey) === tail) queues.delete(sessionKey)
    })
    return next
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Anti-DNS-rebinding comes before authentication: a foreign Host or any
    // Origin header (browsers send one on cross-origin requests; Node's fetch
    // does not) never reaches the handlers.
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase()) || req.headers.origin !== undefined) {
      sendJson(res, 403, { error: 'Forbidden' })
      return
    }
    const sessionKey = sessionOfToken(req.headers.authorization, secret)
    if (!sessionKey) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    // An empty chat's transient key is the app's, never an agent's.
    if (isNoBrowserSessionKey(sessionKey)) {
      sendJson(res, 403, { error: 'Forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`)

    if (url.pathname === '/state') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
      // The token decides the session; a query that names another one is refused.
      const asked = url.searchParams.get('session')
      if (asked !== null && asked !== sessionKey) return sendJson(res, 403, { error: 'Forbidden' })
      const browser = lookup(sessionKey)
      if (!browser) return sendJson(res, 200, { open: false, marks: 0 })
      return sendJson(res, 200, { open: true, state: browser.getState(), marks: browser.getMarks().length })
    }

    if (url.pathname === '/action') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'Body must be JSON' })
      }
      const input = (typeof body === 'object' && body !== null ? body : {}) as { session?: unknown; action?: unknown; params?: unknown }
      if (input.session !== undefined && input.session !== sessionKey) return sendJson(res, 403, { error: 'Forbidden' })
      if (typeof input.action !== 'string') return sendJson(res, 400, { error: 'action is required' })
      const params: ActionParams = typeof input.params === 'object' && input.params !== null && !Array.isArray(input.params) ? (input.params as ActionParams) : {}
      const browser = lookup(sessionKey)
      if (!browser) {
        const closed: ActionResult = { ok: false, text: 'The browser panel is closed for this session. Ask the user to open it.' }
        return sendJson(res, 200, closed)
      }
      const action = input.action
      return sendJson(res, 200, await runQueued(sessionKey, () => runBrowserAction(browser, action, params)))
    }

    sendJson(res, 404, { error: 'Not found' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal error' })
      else res.end()
    })
  })
  server.requestTimeout = 120_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // A listening server must never be what keeps the app alive.
  server.unref()
  const port = (server.address() as AddressInfo).port
  allowedHosts = new Set([`${LOOPBACK_HOST}:${port}`, `localhost:${port}`])
  const baseUrl = `http://${LOOPBACK_HOST}:${port}`

  return {
    port,
    url: baseUrl,
    tokenFor: (sessionKey) => mint(secret, sessionKey),
    envFor: (sessionKey) => ({
      [BROWSER_URL_ENV]: baseUrl,
      [BROWSER_TOKEN_ENV]: mint(secret, sessionKey),
      [BROWSER_SESSION_ENV]: sessionKey,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

// ─── The app's one bridge ────────────────────────────────────────────────────

let appBridge: BrowserBridge | null = null

/** Start the app's bridge once, at boot. A failure leaves the agent without browser tools. */
export async function startAppBrowserBridge(): Promise<BrowserBridge> {
  appBridge ??= await startBrowserBridge()
  return appBridge
}

export async function stopAppBrowserBridge(): Promise<void> {
  const bridge = appBridge
  appBridge = null
  await bridge?.close()
}

/** The environment that lets a Pi process of `sessionKey` reach the bridge, or null while it is not running. */
export function browserBridgeEnv(sessionKey: string): Record<string, string> | null {
  return appBridge ? appBridge.envFor(sessionKey) : null
}
