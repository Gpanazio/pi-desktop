// The browser panel's guest as the main process sees it. The renderer registers
// the <webview>'s webContents when the panel opens and unregisters it when it
// closes. The panel's toolbar (through IPC), the marks and screenshots of F2,
// and the agent tools of F3 all drive the same handle, so they share one state.

import type { WebContents } from 'electron'
import {
  clampViewport,
  isBrowsableUrl,
  normalizeAddress,
  type BrowserCapture,
  type BrowserMark,
  type BrowserScreenshot,
  type BrowserScreenshotTile,
  type BrowserScreenshotOptions,
  type BrowserState,
  type BrowserViewport,
  type ConsoleEntry,
} from '../../shared/browser'
import { imageSize } from './image-size'
import { electronImageCodec, stitchStrips, type BitmapImage, type ImageCodec, type Strip } from './image-stitch'
import { getMarkStore, renameMarkStore, type MarkStore } from './browser-mark-store'
import { BrowserMarksOverlay } from './browser-marks-overlay'
import { shouldUsePng } from './image-format'
import { buildUserAgentOverride, deviceForViewport, type EmulatedDevice } from './browser-user-agent'

export type { BrowserMark, BrowserState, BrowserViewport, ConsoleEntry }

export interface BrowserHandle {
  readonly sessionKey: string
  readonly webContents: Electron.WebContents
  getState(): BrowserState
  navigate(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  setViewport(v: BrowserViewport | null): Promise<void>
  screenshot(opts?: ScreenshotRequest): Promise<BrowserScreenshot>
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  getMarks(): BrowserMark[]
  addMark(m: Omit<BrowserMark, 'id' | 'createdAt'>): BrowserMark
  removeMark(id: number): void
  clearMarks(): void
  /** The page highlights the element under the cursor and a click marks it instead of clicking it. */
  setMarkMode(on: boolean): void
  getMarkMode(): boolean
  /** A screenshot with the marks' current places, taken with the page overlay hidden. */
  capture(opts?: { fullPage?: boolean; markIds?: number[] }): Promise<BrowserCapture>
  getConsole(limit?: number): ConsoleEntry[]
}

export interface ScreenshotRequest extends BrowserScreenshotOptions {
  /** Longest side of the image in px. The image is scaled down to it; it is never enlarged. Default: no limit. */
  maxDimension?: number
  /** With fullPage: capture at most `maxWidth` px wide and cut the top of the page into tiles of at most `maxTileHeight` px (up to `maxTiles`). */
  tiles?: { maxWidth: number; maxTileHeight: number; maxTiles: number }
}

interface VisualViewport {
  pageX?: number
  pageY?: number
  clientWidth: number
  clientHeight: number
  scale?: number
}

interface LayoutMetrics {
  cssVisualViewport?: VisualViewport
  visualViewport: VisualViewport
  cssContentSize?: { width: number; height: number }
  contentSize: { width: number; height: number }
}

/** A full page is never longer than this in output px, whatever the caller asks. */
const MAX_FULL_PAGE_SIDE = 16384
const MAX_STRIPS = 400

let imageCodec: ImageCodec | null = null

/** Replace the codec that decodes and joins strips (tests, where Electron is absent). */
export function setImageCodecForTests(codec: ImageCodec | null): void {
  imageCodec = codec
}

async function getImageCodec(): Promise<ImageCodec> {
  imageCodec ??= await electronImageCodec()
  return imageCodec
}

export const CONSOLE_BUFFER_SIZE = 500
const CDP_VERSION = '1.3'
/** Longest wait for the reload a user agent change asks for. */
const UA_RELOAD_TIMEOUT_MS = 15000
const ERR_ABORTED = -3
const STATE_EVENTS = [
  'did-start-loading',
  'did-stop-loading',
  'did-navigate',
  'did-navigate-in-page',
  'page-title-updated',
  'did-fail-load',
] as const

type ChangeListener = (sessionKey: string, state: BrowserState | null) => void

const sessions = new Map<string, BrowserSession>()
const listeners = new Set<ChangeListener>()

function emit(sessionKey: string, state: BrowserState | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionKey, state)
    } catch {
      // A broken subscriber must not break the others or the guest.
    }
  }
}

interface RemoteObject {
  type?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

function remoteObjectText(object: RemoteObject): string {
  if (object.value !== undefined) return typeof object.value === 'string' ? object.value : JSON.stringify(object.value)
  return object.unserializableValue ?? object.description ?? object.type ?? ''
}

/** The page-side half of `setFloatingHidden`; the touched elements and their inline styles are kept on `window`. */
function floatingScript(hidden: boolean): string {
  return `(() => {
  var KEY = '__piFloating';
  var saved = window[KEY] || (window[KEY] = new Map());
  var settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!${hidden}) {
    saved.forEach((was, el) => {
      ['visibility', 'position'].forEach((prop) => {
        if (was[prop][0] === '') el.style.removeProperty(prop);
        else el.style.setProperty(prop, was[prop][0], was[prop][1]);
      });
    });
    saved.clear();
    return settle();
  }
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (saved.has(el)) continue;
    var position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    saved.set(el, {
      visibility: [el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')],
      position: [el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]
    });
    if (position === 'fixed') el.style.setProperty('visibility', 'hidden', 'important');
    else el.style.setProperty('position', 'static', 'important');
  }
  return settle();
})()`
}

class BrowserSession implements BrowserHandle {
  sessionKey: string
  readonly webContents: WebContents
  private viewport: BrowserViewport | null = null
  /** The last pane size the panel reported while it had one; a hidden panel reports 0x0, which is not kept. */
  private paneSize = { width: 0, height: 0 }
  /** The device whose user agent the page currently carries. A fresh guest runs the desktop one. */
  private device: EmulatedDevice = 'desktop'
  private readonly markStore: MarkStore
  private readonly overlay: BrowserMarksOverlay
  private consoleBuffer: ConsoleEntry[] = []
  private ready: Promise<void> | null = null
  private disposed = false
  private readonly cleanups: Array<() => void> = []

  constructor(sessionKey: string, webContents: WebContents) {
    this.sessionKey = sessionKey
    this.webContents = webContents
    this.markStore = getMarkStore(sessionKey)
    this.overlay = new BrowserMarksOverlay((method, params) => this.webContents.debugger.sendCommand(method, params), this.markStore)
    this.cleanups.push(this.markStore.subscribe(() => this.overlay.sync()))

    const notify = (): void => emit(this.sessionKey, this.getState())
    for (const name of STATE_EVENTS) {
      const on = webContents.on.bind(webContents) as (event: string, listener: () => void) => void
      const off = webContents.removeListener.bind(webContents) as (event: string, listener: () => void) => void
      on(name, notify)
      this.cleanups.push(() => off(name, notify))
    }
    const onDestroyed = (): void => unregisterBrowser(this.sessionKey, this)
    webContents.once('destroyed', onDestroyed)
    this.cleanups.push(() => webContents.removeListener('destroyed', onDestroyed))

    // A guest whose renderer crashed is no longer a browser the agent can drive.
    const onGone = (): void => unregisterBrowser(this.sessionKey, this)
    webContents.once('render-process-gone', onGone)
    this.cleanups.push(() => webContents.removeListener('render-process-gone', onGone))

    // The user's DevTools replace the CDP client; take the session back when they close.
    const onDevToolsClosed = (): void => {
      this.ready = null
      void this.ensureReady().catch(() => {})
    }
    webContents.on('devtools-closed', onDevToolsClosed)
    this.cleanups.push(() => webContents.removeListener('devtools-closed', onDevToolsClosed))

    const dbg = webContents.debugger
    const onDetach = (): void => {
      this.ready = null
    }
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      this.overlay.onCdpMessage(method, params)
      this.onCdpMessage(method, params)
    }
    dbg.on('detach', onDetach)
    dbg.on('message', onMessage)
    this.cleanups.push(() => {
      dbg.removeListener('detach', onDetach)
      dbg.removeListener('message', onMessage)
    })

    // Attach now so the console buffer covers the page from its first load.
    void this.ensureReady().catch(() => {})
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // The panel is closing: mark mode ends with it, the marks stay.
    this.markStore.setMode(false)
    for (const cleanup of this.cleanups) {
      try {
        cleanup()
      } catch {
        // The guest is already gone.
      }
    }
    try {
      if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) this.webContents.debugger.detach()
    } catch {
      // Detaching from a dead target is not an error.
    }
  }

  setPaneSize(width: number, height: number): void {
    const next = { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) }
    // A panel that is hidden measures 0x0. The last size it had stays, so the agent's screenshot keeps a real size.
    if (next.width === 0 || next.height === 0) return
    if (next.width === this.paneSize.width && next.height === this.paneSize.height) return
    this.paneSize = next
    emit(this.sessionKey, this.getState())
  }

  getState(): BrowserState {
    const wc = this.webContents
    const alive = !wc.isDestroyed()
    const history = alive ? wc.navigationHistory : null
    return {
      sessionKey: this.sessionKey,
      url: alive ? wc.getURL() : '',
      title: alive ? wc.getTitle() : '',
      loading: alive ? wc.isLoading() : false,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
      viewport: this.viewport,
      paneSize: { ...this.paneSize },
    }
  }

  async navigate(url: string): Promise<void> {
    const target = normalizeAddress(url).url
    if (!isBrowsableUrl(target)) throw new Error(`Cannot load ${url}`)
    try {
      await this.webContents.loadURL(target)
    } catch (error) {
      // A navigation replaced by a newer one reports ERR_ABORTED; the page is loading, not broken.
      if ((error as { errno?: number }).errno === ERR_ABORTED) return
      throw error
    }
  }

  goBack(): void {
    this.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    this.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.webContents.reload()
  }

  async setViewport(viewport: BrowserViewport | null): Promise<void> {
    // Read before ensureReady: a first attach already applies the new viewport, and its agent with it.
    const before = this.device
    this.viewport = viewport ? clampViewport(viewport) : null
    await this.ensureReady()
    await this.applyViewport()
    emit(this.sessionKey, this.getState())
    // Sites that pick their layout by user agent (m.wikipedia.org) answer the page that is already loaded
    // with the old one, so a changed agent reloads it.
    if (this.device !== before) await this.reloadForUserAgent()
  }

  private async reloadForUserAgent(): Promise<void> {
    const wc = this.webContents
    if (wc.isDestroyed()) return
    const url = wc.getURL()
    if (url === '' || url === 'about:blank' || !isBrowsableUrl(url)) return
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', finish)
        resolve()
      }
      const timer = setTimeout(finish, UA_RELOAD_TIMEOUT_MS)
      timer.unref?.()
      wc.once('did-stop-loading', finish)
      wc.reloadIgnoringCache()
    })
  }

  async screenshot(options: ScreenshotRequest = {}): Promise<BrowserScreenshot> {
    const auto = options.format === 'auto'
    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const quality = Math.min(Math.max(Math.round(options.quality ?? 80), 1), 100)
    await this.ensureReady()
    const dbg = this.webContents.debugger
    const metrics = await this.cdp<LayoutMetrics>('Page.getLayoutMetrics')
    const visual = metrics.cssVisualViewport ?? metrics.visualViewport
    const content = metrics.cssContentSize ?? metrics.contentSize
    // Under emulation the viewport is the emulated size; mobile emulation can zoom the page out,
    // which would make the visual viewport report more than the screen the person sees.
    const viewWidth = this.viewport?.width ?? Math.round(visual.clientWidth)
    const viewHeight = this.viewport?.height ?? Math.round(visual.clientHeight)
    // A panel that is hidden has no area of its own; it is captured at the size it last had.
    const hidden = viewWidth <= 0 || viewHeight <= 0
    if (hidden && (this.paneSize.width <= 0 || this.paneSize.height <= 0)) {
      throw new Error('The browser of this session has no visible area (its panel is hidden and has no size yet). Bring the panel back and try again.')
    }
    const captureWidth = hidden ? this.paneSize.width : viewWidth
    const captureHeight = hidden ? this.paneSize.height : viewHeight

    // The guest's surface is rasterized at the screen's real pixel ratio. A capture under an emulated
    // ratio above that asks for more pixels than the surface holds and comes back tiled. So the capture
    // runs with the ratio override dropped (0 = the screen's own), and the override is restored after.
    const needsOverride = this.viewport !== null || hidden
    const scrollBefore = options.fullPage ? await this.readScroll() : null
    let floatingHidden = false
    try {
      if (needsOverride) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: captureWidth,
          height: captureHeight,
          deviceScaleFactor: 0,
          mobile: this.viewport?.mobile ?? false,
        })
      }
      const ratio = await this.pixelRatio()

      if (!options.fullPage) {
        const live = await this.visualViewport()
        const scale = this.limitScale(live.scale ?? 1, Math.max(live.clientWidth, live.clientHeight) * (live.scale ?? 1) * ratio, options.maxDimension)
        const fallback = { width: live.clientWidth * scale * ratio, height: live.clientHeight * scale * ratio }
        if (!auto) return this.result(format, (await this.captureScreen(scale, format, quality)).data, fallback.width, fallback.height)
        const png = this.result('png', (await this.captureScreen(scale, 'png', 100)).data, fallback.width, fallback.height)
        if (shouldUsePng(png, png.data.length)) return png
        return this.result('jpeg', (await this.captureScreen(scale, 'jpeg', quality)).data, fallback.width, fallback.height)
      }

      // Full page: scroll through the page and join one screenful per strip.
      const totalCss = { width: Math.max(captureWidth, Math.round(content.width)), height: Math.max(captureHeight, Math.round(content.height)) }
      const pageScale = (await this.visualViewport()).scale ?? 1
      const tiling = options.tiles
      const scale = tiling
        ? this.limitScale(pageScale, captureWidth * pageScale * ratio, tiling.maxWidth)
        : this.limitScale(pageScale, Math.max(captureWidth, totalCss.height) * pageScale * ratio, options.maxDimension ?? MAX_FULL_PAGE_SIDE)
      const maxRows = tiling ? tiling.maxTileHeight * tiling.maxTiles : Infinity
      const codec = await getImageCodec()
      const strips: Strip[] = []
      let pxPerCss = 0
      let next = 0
      for (let count = 0; next < totalCss.height && count < MAX_STRIPS && !(pxPerCss > 0 && next * pxPerCss >= maxRows); count++) {
        await this.scrollTo(next)
        // Past the first strip a sticky or fixed element would repeat on top of the content under it.
        if (count > 0) {
          floatingHidden = true
          await this.setFloatingHidden(true)
        }
        const live = await this.visualViewport()
        const { data } = await this.captureScreen(scale, 'png', 100)
        const image = codec.decode(Buffer.from(data, 'base64'))
        pxPerCss = image.width / live.clientWidth
        strips.push({ image, top: Math.round((live.pageY ?? next) * pxPerCss) })
        const advanced = (live.pageY ?? next) + live.clientHeight
        if (advanced <= next) break
        next = advanced
      }
      if (strips.length === 0) throw new Error('The page could not be captured')
      const joined = stitchStrips(strips, Math.min(Math.round(totalCss.height * pxPerCss), maxRows))
      if (tiling) {
        const encodeTile = (rows: BitmapImage): BrowserScreenshotTile => {
          let mime = 'image/png'
          let encoded = codec.encode(rows, 'png', 100)
          if (!shouldUsePng(rows, encoded.toString('base64').length)) {
            mime = 'image/jpeg'
            encoded = codec.encode(rows, 'jpeg', quality)
          }
          return { mimeType: mime, data: encoded.toString('base64'), width: rows.width, height: rows.height }
        }
        const rowBytes = joined.width * 4
        const tiles: BrowserScreenshotTile[] = []
        for (let top = 0; top < joined.height && tiles.length < tiling.maxTiles; top += tiling.maxTileHeight) {
          const height = Math.min(tiling.maxTileHeight, joined.height - top)
          tiles.push(encodeTile({ width: joined.width, height, bitmap: joined.bitmap.subarray(top * rowBytes, (top + height) * rowBytes) }))
        }
        return { ...tiles[0], tiles, coveredCssHeight: Math.min(totalCss.height, Math.round(joined.height / pxPerCss)), totalCssHeight: totalCss.height }
      }
      let outFormat: 'png' | 'jpeg' = format
      let encoded = codec.encode(joined, outFormat, quality)
      if (auto && !shouldUsePng(joined, encoded.toString('base64').length)) {
        outFormat = 'jpeg'
        encoded = codec.encode(joined, outFormat, quality)
      }
      return {
        mimeType: outFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
        data: encoded.toString('base64'),
        width: joined.width,
        height: joined.height,
      }
    } finally {
      if (floatingHidden) await this.setFloatingHidden(false).catch(() => {})
      if (scrollBefore) await this.scrollTo(scrollBefore.y, scrollBefore.x).catch(() => {})
      if (needsOverride) await this.applyViewport().catch(() => {})
    }
  }

  private result(format: 'png' | 'jpeg', data: string, fallbackWidth: number, fallbackHeight: number): BrowserScreenshot {
    const size = imageSize(Buffer.from(data, 'base64'))
    return {
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      data,
      width: size?.width ?? Math.round(fallbackWidth),
      height: size?.height ?? Math.round(fallbackHeight),
    }
  }

  /** The clip scale that keeps the longest side (in output px) within `maxDimension`; never enlarges. */
  private limitScale(pageScale: number, longestSidePx: number, maxDimension: number | undefined): number {
    if (maxDimension === undefined || maxDimension <= 0 || longestSidePx <= maxDimension) return pageScale
    return pageScale * (maxDimension / longestSidePx)
  }

  private async visualViewport(): Promise<VisualViewport> {
    const live = (await this.webContents.debugger.sendCommand('Page.getLayoutMetrics')) as LayoutMetrics
    return live.cssVisualViewport ?? live.visualViewport
  }

  private async pixelRatio(): Promise<number> {
    const answer = (await this.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.devicePixelRatio',
      returnByValue: true,
    })) as { result?: { value?: number } }
    return answer.result?.value || 1
  }

  private async readScroll(): Promise<{ x: number; y: number }> {
    const answer = (await this.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: '({ x: window.scrollX, y: window.scrollY })',
      returnByValue: true,
    })) as { result?: { value?: { x: number; y: number } } }
    return answer.result?.value ?? { x: 0, y: 0 }
  }

  /**
   * While strips are stitched: fixed elements are hidden (they sit in the first strip, where they belong)
   * and sticky ones go back to their place in the flow, so none overlays the content of the next strip.
   * Safe to call on every strip: an element is touched once. `false` puts every inline style back.
   */
  private async setFloatingHidden(hidden: boolean): Promise<void> {
    await this.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: floatingScript(hidden),
      awaitPromise: true,
    })
  }

  /** Scroll and wait for the next frames to paint. */
  private async scrollTo(y: number, x = 0): Promise<void> {
    await this.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: `window.scrollTo(${x}, ${y}); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      awaitPromise: true,
    })
  }

  /** What is on screen now, as a PNG, `scale` times its CSS size per pixel of ratio. */
  private async captureScreen(scale: number, format: 'png' | 'jpeg', quality: number): Promise<{ data: string }> {
    const live = await this.visualViewport()
    const clip = { x: live.pageX ?? 0, y: live.pageY ?? 0, width: live.clientWidth, height: live.clientHeight, scale }
    const params: Record<string, unknown> = { format, fromSurface: true, clip }
    if (format === 'jpeg') params.quality = quality
    return (await this.webContents.debugger.sendCommand('Page.captureScreenshot', params)) as { data: string }
  }

  async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureReady()
    return (await this.webContents.debugger.sendCommand(method, params)) as T
  }

  getMarks(): BrowserMark[] {
    return this.markStore.list()
  }

  addMark(mark: Omit<BrowserMark, 'id' | 'createdAt'>): BrowserMark {
    return this.markStore.add(mark)
  }

  removeMark(id: number): void {
    this.markStore.remove(id)
  }

  clearMarks(): void {
    this.markStore.clear()
  }

  setMarkMode(on: boolean): void {
    this.markStore.setMode(on)
  }

  getMarkMode(): boolean {
    return this.markStore.markMode
  }

  async capture(options: { fullPage?: boolean; markIds?: number[] } = {}): Promise<BrowserCapture> {
    await this.ensureReady()
    const ids = options.markIds ?? []
    const fullPage = options.fullPage === true
    // The overlay (badges, hover outline) is out of the picture; the marks are drawn on the image afterwards.
    await this.overlay.setHidden(true)
    try {
      const layout = ids.length > 0 ? await this.overlay.measure(ids, fullPage) : null
      const screenshot = await this.screenshot({ fullPage })
      return { screenshot, layout: layout ?? { cssWidth: 0, cssHeight: 0, rects: [] } }
    } finally {
      await this.overlay.setHidden(false)
    }
  }

  getConsole(limit?: number): ConsoleEntry[] {
    if (limit === undefined) return [...this.consoleBuffer]
    return limit > 0 ? this.consoleBuffer.slice(-limit) : []
  }

  /** Attach once, enable the domains the buffer reads, and re-apply what a replaced client dropped. */
  private ensureReady(): Promise<void> {
    const dbg = this.webContents.debugger
    if (this.ready && dbg.isAttached()) return this.ready
    const ready = (async () => {
      if (this.webContents.isDestroyed()) throw new Error('The browser page is closed')
      if (!dbg.isAttached()) dbg.attach(CDP_VERSION)
      await dbg.sendCommand('Runtime.enable')
      await dbg.sendCommand('Log.enable')
      // Without the marks script the page still browses; only mark mode is lost.
      await this.overlay.install().catch(() => {})
      this.overlay.sync()
      await this.applyViewport()
    })()
    this.ready = ready
    ready.catch(() => {
      if (this.ready === ready) this.ready = null
    })
    return ready
  }

  private async applyViewport(): Promise<void> {
    const dbg = this.webContents.debugger
    const viewport = this.viewport
    // The override lives in this debugger session: it is sent again on every attach, and it outlasts navigations.
    const device = deviceForViewport(viewport)
    await dbg.sendCommand('Emulation.setUserAgentOverride', { ...buildUserAgentOverride(device, process.versions.chrome ?? '0', process.platform) })
    this.device = device
    if (!viewport) {
      await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
      await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
      return
    }
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
    })
    // maxTouchPoints must be 1..16 when given, so a viewport without touch sends only `enabled`.
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', viewport.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleBuffer.push(entry)
    if (this.consoleBuffer.length > CONSOLE_BUFFER_SIZE) this.consoleBuffer.splice(0, this.consoleBuffer.length - CONSOLE_BUFFER_SIZE)
  }

  private onCdpMessage(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(p.args) ? (p.args as RemoteObject[]) : []
      const frame = (p.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined)?.callFrames?.[0]
      this.pushConsole({
        level: String(p.type ?? 'log'),
        text: args.map(remoteObjectText).join(' '),
        ...(frame?.url ? { url: frame.url } : {}),
        ...(typeof frame?.lineNumber === 'number' ? { line: frame.lineNumber + 1 } : {}),
        ts: Date.now(),
      })
    } else if (method === 'Log.entryAdded') {
      const entry = (p.entry ?? {}) as { level?: string; text?: string; url?: string; lineNumber?: number }
      this.pushConsole({
        level: entry.level ?? 'info',
        text: entry.text ?? '',
        ...(entry.url ? { url: entry.url } : {}),
        ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber + 1 } : {}),
        ts: Date.now(),
      })
    } else if (method === 'Runtime.exceptionThrown') {
      const details = (p.exceptionDetails ?? {}) as { text?: string; url?: string; lineNumber?: number; exception?: RemoteObject }
      this.pushConsole({
        level: 'error',
        text: details.exception?.description ?? details.text ?? '',
        ...(details.url ? { url: details.url } : {}),
        ...(typeof details.lineNumber === 'number' ? { line: details.lineNumber + 1 } : {}),
        ts: Date.now(),
      })
    }
  }
}

/** The browser the panel of this session has open, or null when the panel is closed. */
export function getBrowser(sessionKey: string): BrowserHandle | null {
  return sessions.get(sessionKey) ?? null
}

export function isBrowserOpen(sessionKey: string): boolean {
  return sessions.has(sessionKey)
}

/** Called on every state change of any open browser, and with null when its panel closes. */
export function onBrowserChange(cb: (sessionKey: string, state: BrowserState | null) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Register the panel's guest for a session. A guest already registered for that session is replaced. */
export function registerBrowser(sessionKey: string, webContents: WebContents): BrowserHandle {
  const previous = sessions.get(sessionKey)
  if (previous?.webContents === webContents) return previous
  previous?.dispose()
  const session = new BrowserSession(sessionKey, webContents)
  sessions.set(sessionKey, session)
  emit(sessionKey, session.getState())
  return session
}

/** Drop a session's browser. With `only`, drops it only while that session is still the registered one. */
export function unregisterBrowser(sessionKey: string, only?: BrowserHandle): void {
  const current = sessions.get(sessionKey)
  if (!current || (only && current !== only)) return
  sessions.delete(sessionKey)
  current.dispose()
  emit(sessionKey, null)
}

/**
 * A chat with no runtime yet gets its runtime id: the guest, its marks and its state move to the new key
 * as they are, without reloading the page. Does nothing when `from` has no browser or `to` already has one.
 */
export function rekeyBrowser(from: string, to: string): boolean {
  if (from === to) return false
  const current = sessions.get(from)
  if (!current || sessions.has(to)) return false
  if (!renameMarkStore(from, to)) return false
  sessions.delete(from)
  sessions.set(to, current)
  current.sessionKey = to
  emit(to, current.getState())
  return true
}

export function setBrowserPaneSize(sessionKey: string, width: number, height: number): void {
  sessions.get(sessionKey)?.setPaneSize(width, height)
}
