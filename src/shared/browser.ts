// Pure pieces of the built-in browser panel, shared by main and renderer: the
// <webview> partition, the state types the controller and the UI exchange,
// viewport presets and clamping, and address-bar normalization.

/** The browser panel's <webview> partition. Persistent, so logins survive restarts. */
export const BROWSER_PARTITION = 'persist:pi-browser'

export interface BrowserViewport {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  touch: boolean
}

export interface BrowserState {
  sessionKey: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** null = the size of the panel */
  viewport: BrowserViewport | null
  paneSize: { width: number; height: number }
}

export interface BrowserMark {
  id: number
  selector: string
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
  note?: string
  url: string
  createdAt: number
  /** Sent to the agent with a prompt: shown dimmed, never sent again. */
  sent?: boolean
}

/** What the page reports for an element the person picked. */
export type BrowserMarkDraft = Pick<BrowserMark, 'selector' | 'text' | 'html' | 'rect' | 'url'>

/** The marks of a session and whether the panel is in mark mode. */
export interface BrowserMarksSnapshot {
  marks: BrowserMark[]
  markMode: boolean
}

/** An element picked in mark mode, waiting for its note. `keepMode`: Shift was held. */
export interface BrowserMarkPick {
  draft: BrowserMarkDraft
  keepMode: boolean
}

export interface BrowserCaptureOptions {
  fullPage?: boolean
  /** Marks to measure for drawing on the image; none = a plain capture. */
  markIds?: number[]
}

/** Where the marks sit on a capture: CSS px of the image's page area (viewport, or the whole page). */
export interface BrowserCaptureLayout {
  cssWidth: number
  cssHeight: number
  rects: Array<{ id: number; x: number; y: number; width: number; height: number }>
}

export interface BrowserCapture {
  screenshot: BrowserScreenshot
  layout: BrowserCaptureLayout
}

export interface ConsoleEntry {
  level: string
  text: string
  url?: string
  line?: number
  ts: number
}

export interface BrowserScreenshotOptions {
  fullPage?: boolean
  /** 'auto': PNG while the image that comes back is small and light, JPEG otherwise. */
  format?: 'png' | 'jpeg' | 'auto'
  quality?: number
}

/** The session key prefix of a chat that has no runtime yet; its browser panel moves to the runtime id when the first prompt creates it. */
export const NO_BROWSER_SESSION_KEY = 'no-session'

/** The transient key of a workspace's empty chat: one per workspace, so a panel never migrates into another workspace's runtime. */
export function noBrowserSessionKey(workspaceId: string | null | undefined): string {
  return workspaceId ? `${NO_BROWSER_SESSION_KEY}:${workspaceId}` : NO_BROWSER_SESSION_KEY
}

/** Whether a key is a transient empty-chat key (never counted by the LRU, never reachable by the bridge). */
export function isNoBrowserSessionKey(key: string): boolean {
  return key === NO_BROWSER_SESSION_KEY || key.startsWith(`${NO_BROWSER_SESSION_KEY}:`)
}

export interface BrowserScreenshot {
  mimeType: string
  /** base64 */
  data: string
  width: number
  height: number
  /** Set when the capture was asked as vertical tiles: the page's top, cut into pieces from the top down. `data` is then the first one. */
  tiles?: BrowserScreenshotTile[]
  /** With `tiles`: how far down the page (CSS px) the tiles reach, and the page's whole height. */
  coveredCssHeight?: number
  totalCssHeight?: number
}

export interface BrowserScreenshotTile {
  mimeType: string
  /** base64 */
  data: string
  width: number
  height: number
}

// ─── Viewport ────────────────────────────────────────────────────────────────

export const VIEWPORT_MIN_SIZE = 200
export const VIEWPORT_MAX_SIZE = 4000
export const VIEWPORT_MIN_DPR = 1
export const VIEWPORT_MAX_DPR = 4

export interface BrowserViewportPreset extends BrowserViewport {
  id: string
  /** A device name, not interface text. */
  label: string
}

export const BROWSER_VIEWPORT_PRESETS: readonly BrowserViewportPreset[] = [
  { id: 'iphone-15', label: 'iPhone 15', width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
  { id: 'ipad', label: 'iPad', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
  { id: 'laptop', label: 'Laptop', width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, touch: false },
  { id: 'desktop', label: 'Desktop', width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
]

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** Sizes are whole pixels in 200..4000, the pixel ratio is 1..4 (three decimals, so 2.625 stays). */
export function clampViewport(viewport: BrowserViewport): BrowserViewport {
  return {
    width: Math.round(clampNumber(viewport.width, VIEWPORT_MIN_SIZE, VIEWPORT_MAX_SIZE)),
    height: Math.round(clampNumber(viewport.height, VIEWPORT_MIN_SIZE, VIEWPORT_MAX_SIZE)),
    deviceScaleFactor: Math.round(clampNumber(viewport.deviceScaleFactor, VIEWPORT_MIN_DPR, VIEWPORT_MAX_DPR) * 1000) / 1000,
    mobile: viewport.mobile === true,
    touch: viewport.touch === true,
  }
}

/** The factor that makes an emulated viewport fit the pane, never above 1. */
export function scaleToFit(viewport: Pick<BrowserViewport, 'width' | 'height'>, pane: { width: number; height: number }): number {
  if (pane.width <= 0 || pane.height <= 0) return 1
  return Math.min(1, pane.width / viewport.width, pane.height / viewport.height)
}

// ─── Address bar ─────────────────────────────────────────────────────────────

export interface NormalizedAddress {
  kind: 'url' | 'search'
  url: string
}

export const SEARCH_URL_PREFIX = 'https://www.google.com/search?q='

const BLOCKED_SCHEME = /^(javascript|data|file|vbscript|blob|chrome|chrome-extension|devtools|view-source):/i
const OTHER_SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|\[[0-9a-f:]+\])(?=$|[:/?#])/i
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(?=$|[:/?#])/
const DOMAIN_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?=$|[/?#])/i

/**
 * What the address bar does with typed text. A full http(s) URL loads as is.
 * Text that looks like a host (a domain, localhost, an IP, with an optional
 * port and path) gets a scheme: https, or http for localhost and local
 * addresses, where a dev server rarely speaks TLS. Anything else is a search.
 * Schemes the panel must not load (javascript:, file:, data:, ...) are never a
 * URL: they become a search.
 */
export function normalizeAddress(input: string): NormalizedAddress {
  const text = input.trim()
  const search = (): NormalizedAddress => ({ kind: 'search', url: `${SEARCH_URL_PREFIX}${encodeURIComponent(text)}` })
  if (text === '') return { kind: 'url', url: 'about:blank' }
  if (text.toLowerCase() === 'about:blank') return { kind: 'url', url: 'about:blank' }
  if (BLOCKED_SCHEME.test(text)) return search()
  if (/^https?:\/\//i.test(text)) {
    const parsed = URL.parse(text)
    return parsed && parsed.hostname !== '' ? { kind: 'url', url: parsed.href } : search()
  }
  if (OTHER_SCHEME_WITH_SLASHES.test(text) || /\s/.test(text)) return search()
  if (LOCAL_HOST.test(text)) return urlOrSearch(`http://${text}`, search)
  if (IPV4_HOST.test(text) || DOMAIN_HOST.test(text)) return urlOrSearch(`https://${text}`, search)
  return search()
}

function urlOrSearch(candidate: string, search: () => NormalizedAddress): NormalizedAddress {
  const parsed = URL.parse(candidate)
  return parsed ? { kind: 'url', url: parsed.href } : search()
}

/** Whether the main process lets a guest or an agent load this URL. */
export function isBrowsableUrl(url: string): boolean {
  if (url === 'about:blank') return true
  const parsed = URL.parse(url)
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
}
