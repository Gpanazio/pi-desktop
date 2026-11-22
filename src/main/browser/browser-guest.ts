// Pure decisions for the browser panel's <webview> guest. Kept free of any
// `electron` import so they run under plain Node in tests; index.ts and
// browser-session.ts apply them.

import { BROWSER_PARTITION, isBrowsableUrl } from '../../shared/browser'

/** Which rule set a <webview> guest falls under, by its partition attribute. */
export type WebviewGuestKind = 'browser' | 'preview'

/** The browser panel's partition gets the browser rules; any other partition keeps the file-preview rules. */
export function webviewGuestKind(partition: string | undefined): WebviewGuestKind {
  return partition === BROWSER_PARTITION ? 'browser' : 'preview'
}

/**
 * Whether the app-wide will-navigate guard stops a <webview> guest. It exists for file previews (an
 * untrusted preview may not leave its local file); the browser panel's guest navigates freely, since
 * links, forms and OAuth redirects are its job.
 */
export function shouldBlockGuestNavigation(input: { isBrowserGuest: boolean; url: string; workspaceTrusted: boolean }): boolean {
  if (input.isBrowserGuest) return false
  return !input.url.startsWith('file://') && !input.workspaceTrusted
}

/** A browser guest loads web pages only, never local files. */
export function isBrowserGuestSrcAllowed(src: string): boolean {
  return src === '' || isBrowsableUrl(src)
}

export interface BrowserGuestWebPreferences {
  preload?: string
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  contextIsolation?: boolean
  sandbox?: boolean
  webSecurity?: boolean
  allowRunningInsecureContent?: boolean
  plugins?: boolean
  javascript?: boolean
}

/** Chromium sandbox on, no Node, no preload; scripts stay on, with none of the preview's locks. */
export function applyBrowserGuestPreferences(webPreferences: BrowserGuestWebPreferences): void {
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.plugins = false
  webPreferences.javascript = true
}

export type WindowOpenDecision = 'same-panel' | 'popup' | 'deny'

/**
 * What a guest's window.open or target=_blank does. A call with window
 * features (disposition "new-window") is a real popup: OAuth sign-in flows
 * need window.opener, so it opens as a child window in the same session. A
 * plain tab-like open loads in the panel. Anything that is not http(s) is
 * dropped.
 */
export function decideWindowOpen(details: { url: string; disposition: string }): WindowOpenDecision {
  const popup = details.disposition === 'new-window'
  // A blank popup is navigated by the opener afterwards (common in OAuth libraries).
  if (details.url === '' || details.url === 'about:blank') return popup ? 'popup' : 'deny'
  if (!isBrowsableUrl(details.url)) return 'deny'
  return popup ? 'popup' : 'same-panel'
}

const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'notifications',
  'geolocation',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
])

/** Camera, microphone, notifications, location, clipboard and fullscreen are granted; the rest is refused. */
export function isBrowserPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

/** `name`, or `name (1)`, `name (2)` ... before the extension, the first one `exists` does not report. */
export function uniqueDownloadName(name: string, exists: (candidate: string) => boolean): string {
  const safe = name.replace(/[\\/]/g, '_').replace(/^\.+/, '') || 'download'
  if (!exists(safe)) return safe
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${extension}`
    if (!exists(candidate)) return candidate
  }
}
