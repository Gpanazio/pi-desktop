// Electron wiring of the browser panel's partition: user agent, permissions,
// downloads and pop-ups. The decisions themselves live in browser-guest.ts.
// Everything here is bound to the one `persist:pi-browser` session; the file
// previews' partitions are not touched.

import { app, BrowserWindow, dialog, Notification, session, shell, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BROWSER_PARTITION } from '../../shared/browser'
import { t } from '../../shared/i18n'
import { appLog } from '../app-log'
import { decideWindowOpen, uniqueDownloadName } from './browser-guest'
import { BrowserPermissionStore, createBrowserPermissions, permissionOrigin, type BrowserPermissions, type PermissionAnswer, type PermissionDetails } from './browser-permissions'
import { buildChromeUserAgent } from './browser-user-agent'

export function browserUserAgent(): string {
  return buildChromeUserAgent(process.versions.chrome, process.platform)
}

/** A same-panel open loads in `contents` itself: the panel's guest, or the popup that asked. */
export function installOpenHandler(contents: Pick<WebContents, 'setWindowOpenHandler' | 'loadURL'>): void {
  contents.setWindowOpenHandler((details) => {
    const decision = decideWindowOpen(details)
    if (decision === 'same-panel') {
      void contents.loadURL(details.url).catch(() => {})
      return { action: 'deny' }
    }
    if (decision === 'popup') {
      // A real child window in the opener's session keeps window.opener, which OAuth sign-in popups need.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      }
    }
    return { action: 'deny' }
  })
}

/**
 * A popup's first page is requested before webContents.setUserAgent takes
 * effect on it, so its navigator.userAgent would still say Electron. The CDP
 * override applies to that first navigation too.
 */
function overridePopupUserAgent(contents: WebContents): void {
  try {
    contents.debugger.attach('1.3')
    void contents.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent: browserUserAgent() }).catch(() => {})
  } catch (error) {
    appLog.warn('browser', 'Could not override a popup user agent', error)
  }
}

/** Names of downloads under way, so two with one name never write the same file. */
export function createDownloadNamer(exists: (name: string) => boolean): { reserve(filename: string): string; release(name: string): void } {
  const reserved = new Set<string>()
  return {
    reserve(filename) {
      const name = uniqueDownloadName(filename, (candidate) => reserved.has(candidate) || exists(candidate))
      reserved.add(name)
      return name
    },
    release(name) {
      reserved.delete(name)
    },
  }
}

type PermissionSession = {
  setPermissionRequestHandler(handler: (contents: WebContents | null, permission: string, callback: (granted: boolean) => void, details: PermissionDetails & { requestingUrl?: string }) => void): void
  setPermissionCheckHandler(handler: (contents: WebContents | null, permission: string, requestingOrigin: string) => boolean): void
}

/** Camera, microphone, location and clipboard reads ask once per origin; the rest follows `permissionPolicy`. */
export function installPermissionHandlers(ses: PermissionSession, permissions: BrowserPermissions): void {
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    void permissions.request(permission, { requestingUrl: details?.requestingUrl, mediaTypes: details?.mediaTypes }).then(callback)
  })
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissions.check(permission, requestingOrigin))
}

function whatIsAsked(permission: string, details: PermissionDetails): string {
  if (permission === 'geolocation') return t('browser.permission.what_location')
  if (permission === 'clipboard-read') return t('browser.permission.what_clipboard')
  const audio = details.mediaTypes?.includes('audio') ?? false
  const video = details.mediaTypes?.includes('video') ?? false
  if (audio && video) return t('browser.permission.what_camera_microphone')
  if (video) return t('browser.permission.what_camera')
  return t('browser.permission.what_microphone')
}

async function askPermission(contents: WebContents | null, origin: string, permission: string, details: PermissionDetails): Promise<PermissionAnswer> {
  const host = contents?.hostWebContents ?? contents
  const parent = host ? BrowserWindow.fromWebContents(host) : null
  const options = {
    type: 'question' as const,
    buttons: [t('browser.permission.allow'), t('browser.permission.block')],
    defaultId: 1,
    cancelId: 1,
    message: t('browser.permission.message', { origin, what: whatIsAsked(permission, details) }),
    checkboxLabel: t('browser.permission.remember'),
    checkboxChecked: true,
  }
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return { allow: result.response === 0, remember: result.checkboxChecked }
}

function notifyDownload(title: string, body: string, savePath?: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  if (savePath) notification.on('click', () => shell.showItemInFolder(savePath))
  notification.show()
}

/** Configure the browser partition. Call once, after the app is ready. */
export function setupBrowserSession(): void {
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setUserAgent(browserUserAgent())

  const permissionFile = join(app.getPath('userData'), 'browser-permissions.json')
  const store = new BrowserPermissionStore({
    read: () => (existsSync(permissionFile) ? readFileSync(permissionFile, 'utf8') : null),
    write: (text) => writeFileSync(permissionFile, text, { mode: 0o600 }),
  })
  // The prompt needs the page that asked, so the request handler keeps the contents of the latest request per origin.
  const askers = new Map<string, WebContents | null>()
  const permissions = createBrowserPermissions(store, (origin, permission, details) => askPermission(askers.get(origin) ?? null, origin, permission, details))
  installPermissionHandlers(
    {
      setPermissionRequestHandler: (handler) =>
        ses.setPermissionRequestHandler((contents, permission, callback, details) => {
          const origin = permissionOrigin(details?.requestingUrl) ?? ''
          askers.set(origin, contents)
          handler(contents, permission, callback, details)
        }),
      setPermissionCheckHandler: (handler) => ses.setPermissionCheckHandler(handler),
    },
    permissions,
  )

  const downloadNames = createDownloadNamer((candidate) => existsSync(join(app.getPath('downloads'), candidate)))
  ses.on('will-download', (_event, item) => {
    const directory = app.getPath('downloads')
    const name = downloadNames.reserve(item.getFilename())
    const savePath = join(directory, name)
    item.setSavePath(savePath)
    item.once('done', (_doneEvent, state) => {
      downloadNames.release(name)
      if (state === 'completed') notifyDownload(t('browser.download.done'), name, savePath)
      else if (state === 'interrupted') notifyDownload(t('browser.download.failed'), name)
      appLog.info('browser', `download ${state}: ${name}`)
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    // The guest, and every popup it opens (a popup shares the partition but not the user agent).
    const type = contents.getType()
    if ((type !== 'webview' && type !== 'window') || contents.session !== ses) return
    contents.setUserAgent(browserUserAgent())
    if (type === 'window') overridePopupUserAgent(contents)
    installOpenHandler(contents)
  })
}
