// Electron wiring of the browser panel's partition: user agent, permissions,
// downloads and pop-ups. The decisions themselves live in browser-guest.ts.
// Everything here is bound to the one `persist:pi-browser` session; the file
// previews' partitions are not touched.

import { app, Notification, session, shell, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BROWSER_PARTITION } from '../../shared/browser'
import { t } from '../../shared/i18n'
import { appLog } from '../app-log'
import { decideWindowOpen, isBrowserPermissionAllowed, uniqueDownloadName } from './browser-guest'
import { buildChromeUserAgent } from './browser-user-agent'

export function browserUserAgent(): string {
  return buildChromeUserAgent(process.versions.chrome, process.platform)
}

/** A same-panel open loads in `contents` itself: the panel's guest, or the popup that asked. */
function installOpenHandler(contents: WebContents): void {
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

  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(isBrowserPermissionAllowed(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => isBrowserPermissionAllowed(permission))

  ses.on('will-download', (_event, item) => {
    const directory = app.getPath('downloads')
    const name = uniqueDownloadName(item.getFilename(), (candidate) => existsSync(join(directory, candidate)))
    const savePath = join(directory, name)
    item.setSavePath(savePath)
    item.once('done', (_doneEvent, state) => {
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
