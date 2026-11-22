import { ipcMain, session, webContents, type IpcMainInvokeEvent } from 'electron'
import { BROWSER_PARTITION, SCREENSHOT_MAX_DIMENSION_LIMIT, clampViewport, validMaxDimension, type BrowserMarkDraft, type BrowserScreenshotOptions, type BrowserViewport } from '../../shared/browser'
import { IPC_CHANNELS, type BrowserMarksEvent, type BrowserStateEvent } from '../../shared/ipc-contracts'
import { getMarkStore, onMarkPick, onMarksChange } from '../browser/browser-mark-store'
import { getBrowser, onBrowserChange, registerBrowser, setBrowserPaneSize, unregisterBrowser } from '../browser/browser-controller'
import { assertTrustedSender, isObject, isString } from './validation'
import type { IpcContext } from './context'

const MAX_SESSION_KEY_LENGTH = 512

function parseSessionKey(value: unknown): string {
  if (!isString(value) || value === '' || value.length > MAX_SESSION_KEY_LENGTH) throw new Error('sessionKey must be a non-empty string')
  return value
}

function parseViewport(value: unknown): BrowserViewport | null {
  if (value === null) return null
  if (
    !isObject(value) ||
    typeof value.width !== 'number' ||
    typeof value.height !== 'number' ||
    typeof value.deviceScaleFactor !== 'number' ||
    typeof value.mobile !== 'boolean' ||
    typeof value.touch !== 'boolean'
  ) {
    throw new Error('viewport must be null or { width, height, deviceScaleFactor, mobile, touch }')
  }
  return clampViewport({
    width: value.width,
    height: value.height,
    deviceScaleFactor: value.deviceScaleFactor,
    mobile: value.mobile,
    touch: value.touch,
  })
}

function parseMaxDimension(value: unknown): number {
  const valid = validMaxDimension(value)
  if (valid === undefined) throw new Error(`maxDimension must be a number above 0 and at most ${SCREENSHOT_MAX_DIMENSION_LIMIT}`)
  return valid
}

export function parseScreenshotOptions(value: unknown): BrowserScreenshotOptions & { maxDimension?: number } {
  if (value === undefined || value === null) return {}
  if (!isObject(value)) throw new Error('screenshot options must be an object')
  return {
    ...(typeof value.fullPage === 'boolean' && { fullPage: value.fullPage }),
    ...((value.format === 'png' || value.format === 'jpeg' || value.format === 'auto') && { format: value.format }),
    ...(typeof value.quality === 'number' && { quality: value.quality }),
    ...(value.maxDimension !== undefined && { maxDimension: parseMaxDimension(value.maxDimension) }),
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseMarkDraft(value: unknown): BrowserMarkDraft {
  if (
    !isObject(value) ||
    !isString(value.selector) ||
    !isString(value.text) ||
    !isString(value.html) ||
    !isString(value.url) ||
    !isObject(value.rect) ||
    !isFiniteNumber(value.rect.x) ||
    !isFiniteNumber(value.rect.y) ||
    !isFiniteNumber(value.rect.width) ||
    !isFiniteNumber(value.rect.height)
  ) {
    throw new Error('mark must be { selector, text, html, rect: { x, y, width, height }, url }')
  }
  return {
    selector: value.selector,
    text: value.text,
    html: value.html,
    url: value.url,
    rect: { x: value.rect.x, y: value.rect.y, width: value.rect.width, height: value.rect.height },
  }
}

function parseMarkId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('mark id must be an integer')
  return value
}

function parseCaptureOptions(value: unknown): { fullPage: boolean; markIds: number[] } {
  if (value === undefined || value === null) return { fullPage: false, markIds: [] }
  if (!isObject(value)) throw new Error('capture options must be an object')
  const ids = Array.isArray(value.markIds) ? value.markIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id)) : []
  return { fullPage: value.fullPage === true, markIds: ids.slice(0, 200) }
}

/** The session's browser, only when its guest belongs to the window that asks. */
function ownBrowser(event: IpcMainInvokeEvent, sessionKey: string) {
  const handle = getBrowser(sessionKey)
  if (!handle || handle.webContents.hostWebContents?.id !== event.sender.id) return null
  return handle
}

export function registerBrowserHandlers(ctx: IpcContext): void {
  onBrowserChange((sessionKey, state) => {
    const payload: BrowserStateEvent = { sessionKey, state }
    ctx.broadcast(IPC_CHANNELS.EVENT_BROWSER_STATE, payload)
  })

  onMarksChange((sessionKey, snapshot) => {
    const payload: BrowserMarksEvent = { kind: 'marks', sessionKey, ...snapshot }
    ctx.broadcast(IPC_CHANNELS.EVENT_BROWSER_MARKS, payload)
  })
  onMarkPick((sessionKey, pick) => {
    const payload: BrowserMarksEvent = { kind: 'pick', sessionKey, pick }
    ctx.broadcast(IPC_CHANNELS.EVENT_BROWSER_MARKS, payload)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_REGISTER, (event: IpcMainInvokeEvent, sessionKey: unknown, webContentsId: unknown) => {
    assertTrustedSender(event)
    const key = parseSessionKey(sessionKey)
    if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId)) throw new Error('webContentsId must be an integer')
    const guest = webContents.fromId(webContentsId)
    // Only a browser-partition <webview> of the asking window can be driven.
    if (
      !guest ||
      guest.getType() !== 'webview' ||
      guest.hostWebContents?.id !== event.sender.id ||
      guest.session !== session.fromPartition(BROWSER_PARTITION)
    ) {
      throw new Error('webContentsId is not a browser panel guest of this window')
    }
    return registerBrowser(key, guest).getState()
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_UNREGISTER, (event: IpcMainInvokeEvent, sessionKey: unknown) => {
    assertTrustedSender(event)
    const key = parseSessionKey(sessionKey)
    const handle = ownBrowser(event, key)
    if (handle) unregisterBrowser(key, handle)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_VIEWPORT, async (event: IpcMainInvokeEvent, sessionKey: unknown, viewport: unknown) => {
    assertTrustedSender(event)
    const handle = ownBrowser(event, parseSessionKey(sessionKey))
    if (!handle) return null
    await handle.setViewport(parseViewport(viewport))
    return handle.getState()
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_PANE_SIZE, (event: IpcMainInvokeEvent, sessionKey: unknown, width: unknown, height: unknown) => {
    assertTrustedSender(event)
    const key = parseSessionKey(sessionKey)
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('width and height must be numbers')
    }
    if (ownBrowser(event, key)) setBrowserPaneSize(key, width, height)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SCREENSHOT, async (event: IpcMainInvokeEvent, sessionKey: unknown, options: unknown) => {
    assertTrustedSender(event)
    const handle = ownBrowser(event, parseSessionKey(sessionKey))
    if (!handle) throw new Error('The browser panel is not open for this session')
    return handle.screenshot(parseScreenshotOptions(options))
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_GET_STATE, (event: IpcMainInvokeEvent, sessionKey: unknown) => {
    assertTrustedSender(event)
    return ownBrowser(event, parseSessionKey(sessionKey))?.getState() ?? null
  })
  // Marks belong to the session and survive its panel; mark mode needs the open guest.
  ipcMain.handle(IPC_CHANNELS.BROWSER_MARKS_LIST, (event: IpcMainInvokeEvent, sessionKey: unknown) => {
    assertTrustedSender(event)
    return getMarkStore(parseSessionKey(sessionKey)).snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_MARK_MODE, (event: IpcMainInvokeEvent, sessionKey: unknown, on: unknown) => {
    assertTrustedSender(event)
    const handle = ownBrowser(event, parseSessionKey(sessionKey))
    if (!handle) return false
    handle.setMarkMode(on === true)
    return handle.getMarkMode()
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_ADD_MARK, (event: IpcMainInvokeEvent, sessionKey: unknown, draft: unknown, note: unknown) => {
    assertTrustedSender(event)
    return getMarkStore(parseSessionKey(sessionKey)).add({ ...parseMarkDraft(draft), ...(isString(note) && { note }) })
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_UPDATE_MARK_NOTE, (event: IpcMainInvokeEvent, sessionKey: unknown, id: unknown, note: unknown) => {
    assertTrustedSender(event)
    if (note !== null && !isString(note)) throw new Error('note must be a string or null')
    getMarkStore(parseSessionKey(sessionKey)).updateNote(parseMarkId(id), note)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_REMOVE_MARK, (event: IpcMainInvokeEvent, sessionKey: unknown, id: unknown) => {
    assertTrustedSender(event)
    getMarkStore(parseSessionKey(sessionKey)).remove(parseMarkId(id))
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_MARKS, (event: IpcMainInvokeEvent, sessionKey: unknown) => {
    assertTrustedSender(event)
    getMarkStore(parseSessionKey(sessionKey)).clear()
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_MARKS_SENT, (event: IpcMainInvokeEvent, sessionKey: unknown, ids: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(ids)) throw new Error('ids must be an array')
    getMarkStore(parseSessionKey(sessionKey)).markSent(ids.map(parseMarkId))
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CAPTURE, async (event: IpcMainInvokeEvent, sessionKey: unknown, options: unknown) => {
    assertTrustedSender(event)
    const handle = ownBrowser(event, parseSessionKey(sessionKey))
    if (!handle) throw new Error('The browser panel is not open for this session')
    return handle.capture(parseCaptureOptions(options))
  })
}
