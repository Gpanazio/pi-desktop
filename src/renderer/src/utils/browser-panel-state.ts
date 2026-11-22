import { NO_BROWSER_SESSION_KEY, isNoBrowserSessionKey, noBrowserSessionKey, type BrowserViewport } from '../../../shared/browser'

export { NO_BROWSER_SESSION_KEY, isNoBrowserSessionKey, noBrowserSessionKey }

/** What the browser panel remembers for one session while the app runs. */
export interface BrowserPanelSession {
  /** The panel is the open side panel of this session. */
  open: boolean
  url: string
  /** Panel width in px; null = the default side-panel width. */
  width: number | null
  /** The viewport menu's choice: a preset id, 'custom', or null for the size of the panel. */
  presetId: string | null
  viewport: BrowserViewport | null
  scaleToFit: boolean
  /** Pending marks go with the next prompt. */
  attachMarks: boolean
  /**
   * The React key of the panel's <webview>. It stays when the session key changes (the first prompt of a
   * chat gives it a runtime id), so the live page is not reloaded. Unset: the session key itself.
   */
  panelId?: string
}

export const DEFAULT_BROWSER_PANEL_SESSION: BrowserPanelSession = {
  open: false,
  url: '',
  width: null,
  presetId: null,
  viewport: null,
  scaleToFit: true,
  attachMarks: true,
}

/** The session key the main-process controller and the agent tools use: the active session runtime id. */
export function browserSessionKey(activeSessionRuntimeId: string | null, workspaceId?: string | null): string {
  return activeSessionRuntimeId ?? noBrowserSessionKey(workspaceId)
}

export function patchBrowserSession(
  sessions: Record<string, BrowserPanelSession>,
  key: string,
  patch: Partial<BrowserPanelSession>,
): Record<string, BrowserPanelSession> {
  // The chat with no runtime yet reuses one key for every empty chat, so each panel it opens gets its own id.
  const fresh = sessions[key] === undefined && isNoBrowserSessionKey(key) ? { panelId: `${NO_BROWSER_SESSION_KEY}#${++panelCounter}` } : {}
  return { ...sessions, [key]: { ...DEFAULT_BROWSER_PANEL_SESSION, ...fresh, ...sessions[key], ...patch } }
}

let panelCounter = 0

/**
 * The first prompt of a chat with no runtime gives it a runtime id: the panel's state moves from
 * the workspace's no-session key to it, keeping its `panelId` so the page stays loaded. Nothing moves when
 * there is no state to move or the runtime already has a panel of its own.
 */
export function migrateBrowserSession(
  sessions: Record<string, BrowserPanelSession>,
  runtimeId: string,
  workspaceId?: string | null,
): Record<string, BrowserPanelSession> {
  const fromKey = noBrowserSessionKey(workspaceId)
  const from = sessions[fromKey]
  if (!from || isNoBrowserSessionKey(runtimeId) || sessions[runtimeId]?.open) return sessions
  const { [fromKey]: _moved, ...rest } = sessions
  return { ...rest, [runtimeId]: { ...from, panelId: from.panelId ?? NO_BROWSER_SESSION_KEY } }
}

/** The React key of the panel for a session key. */
export function browserPanelId(sessions: Record<string, BrowserPanelSession>, key: string): string {
  return sessions[key]?.panelId ?? key
}

/** Sessions whose browser page is kept alive (hidden) while another session is on screen. */
export const MAX_LIVE_BROWSER_SESSIONS = 3

/**
 * The sessions that keep a mounted browser panel. A session counts while its
 * panel is open; the one on screen is the most recent, and past `max` the
 * least recently shown goes (its page unloads and loads again when it returns).
 * Order: oldest first.
 *
 * The key of a chat with no runtime yet (`NO_BROWSER_SESSION_KEY`) is also what
 * the active key reads while any session is loading. It is kept (when open)
 * outside the count and always first, so passing through it never pushes a real
 * session out.
 */
export function nextLiveBrowserSessions(
  live: readonly string[],
  activeKey: string,
  openKeys: ReadonlySet<string>,
  max = MAX_LIVE_BROWSER_SESSIONS,
): string[] {
  const kept = live.filter((key) => !isNoBrowserSessionKey(key) && key !== activeKey && openKeys.has(key))
  if (!isNoBrowserSessionKey(activeKey) && openKeys.has(activeKey)) kept.push(activeKey)
  const real = kept.length > max ? kept.slice(kept.length - max) : kept
  const transient = [...new Set([...live, activeKey])].filter((key) => isNoBrowserSessionKey(key) && openKeys.has(key))
  return transient.length > 0 ? [...transient, ...real] : real
}

/**
 * The live sessions in the order their panels first mounted. React moves a
 * reordered keyed child in the DOM, and a moved <webview> reloads its page, so
 * the panels render in this order and never in LRU order.
 */
export function stableRenderOrder(previous: readonly string[], live: readonly string[]): string[] {
  return [...previous.filter((key) => live.includes(key)), ...live.filter((key) => !previous.includes(key))]
}
