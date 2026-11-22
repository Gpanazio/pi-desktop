import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import {
  CONSOLE_BUFFER_SIZE,
  getBrowser,
  isBrowserOpen,
  onBrowserChange,
  registerBrowser,
  rekeyBrowser,
  setBrowserPaneSize,
  setImageCodecForTests,
  unregisterBrowser,
} from './browser-controller'
import { noBrowserSessionKey, type BrowserState } from '../../shared/browser'
import { getMarkStore } from './browser-mark-store'

class FakeDebugger extends EventEmitter {
  attached = false
  attachCount = 0
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  results: Record<string, unknown> = {}
  respond: ((method: string, params?: Record<string, unknown>) => unknown) | null = null
  attach(): void {
    this.attached = true
    this.attachCount += 1
  }
  isAttached(): boolean {
    return this.attached
  }
  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params })
    if (this.respond) {
      const answer = this.respond(method, params)
      if (answer !== undefined) return answer
    }
    return this.results[method] ?? {}
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  destroyed = false
  url = 'about:blank'
  title = ''
  loading = false
  history = { canGoBack: () => false, canGoForward: () => false }
  readonly navigationHistory = {
    canGoBack: () => this.history.canGoBack(),
    canGoForward: () => this.history.canGoForward(),
    goBack: () => {
      this.calls.push('back')
    },
    goForward: () => {
      this.calls.push('forward')
    },
  }
  calls: string[] = []
  loaded: string[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return this.title
  }
  isLoading(): boolean {
    return this.loading
  }
  reload(): void {
    this.calls.push('reload')
  }
  reloadIgnoringCache(): void {
    this.calls.push('reloadIgnoringCache')
    setImmediate(() => this.emit('did-stop-loading'))
  }
  async loadURL(url: string): Promise<void> {
    this.loaded.push(url)
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function fake(): FakeWebContents {
  return new FakeWebContents()
}

function asContents(wc: FakeWebContents): WebContents {
  return wc as unknown as WebContents
}

/** Let the fire-and-forget attach at registration settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

let counter = 0
const key = (): string => `session-${++counter}`

test('a session has no browser until its panel registers one', () => {
  const sessionKey = key()
  assert.equal(getBrowser(sessionKey), null)
  assert.equal(isBrowserOpen(sessionKey), false)
})

test('registering makes the browser available, unregistering takes it away', async () => {
  const sessionKey = key()
  const wc = fake()
  const handle = registerBrowser(sessionKey, asContents(wc))
  await settle()
  assert.equal(getBrowser(sessionKey), handle)
  assert.equal(isBrowserOpen(sessionKey), true)
  assert.equal(handle.sessionKey, sessionKey)
  assert.equal(handle.webContents as unknown, wc)

  unregisterBrowser(sessionKey)
  assert.equal(getBrowser(sessionKey), null)
  assert.equal(isBrowserOpen(sessionKey), false)
  assert.equal(wc.debugger.attached, false, 'the debugger is released with the panel')
})

test('sessions are independent of each other', () => {
  const a = key()
  const b = key()
  registerBrowser(a, asContents(fake()))
  assert.equal(isBrowserOpen(a), true)
  assert.equal(isBrowserOpen(b), false)
  unregisterBrowser(a)
})

test('a guest that dies takes the session browser with it', async () => {
  const sessionKey = key()
  const wc = fake()
  registerBrowser(sessionKey, asContents(wc))
  await settle()
  wc.destroy()
  assert.equal(getBrowser(sessionKey), null)
})

test('a guest whose renderer crashed is no longer a browser', () => {
  const sessionKey = key()
  const wc = fake()
  registerBrowser(sessionKey, asContents(wc))
  wc.emit('render-process-gone')
  assert.equal(getBrowser(sessionKey), null)
})

test('registering the same session again replaces the old guest', async () => {
  const sessionKey = key()
  const first = fake()
  const second = fake()
  registerBrowser(sessionKey, asContents(first))
  await settle()
  const handle = registerBrowser(sessionKey, asContents(second))
  assert.equal(getBrowser(sessionKey), handle)
  assert.equal(handle.webContents as unknown, second)
  assert.equal(first.debugger.attached, false)
  // The replaced guest dying must not drop the new one.
  first.destroy()
  assert.equal(getBrowser(sessionKey), handle)
  unregisterBrowser(sessionKey)
})

test('registering the same guest twice keeps one handle', () => {
  const sessionKey = key()
  const wc = fake()
  const first = registerBrowser(sessionKey, asContents(wc))
  assert.equal(registerBrowser(sessionKey, asContents(wc)), first)
  unregisterBrowser(sessionKey)
})

test('onBrowserChange reports state while open and null once closed, and stops after unsubscribe', async () => {
  const sessionKey = key()
  const seen: Array<BrowserState | null> = []
  const off = onBrowserChange((changedKey, state) => {
    if (changedKey === sessionKey) seen.push(state)
  })
  const wc = fake()
  registerBrowser(sessionKey, asContents(wc))
  await settle()
  wc.url = 'https://example.com/'
  wc.title = 'Example'
  wc.emit('did-navigate')
  assert.equal(seen.at(-1)?.url, 'https://example.com/')
  assert.equal(seen.at(-1)?.title, 'Example')

  unregisterBrowser(sessionKey)
  assert.equal(seen.at(-1), null)

  off()
  const count = seen.length
  registerBrowser(sessionKey, asContents(fake()))
  assert.equal(seen.length, count)
  unregisterBrowser(sessionKey)
})

test('getState reflects the page, the history and the pane size', () => {
  const sessionKey = key()
  const wc = fake()
  wc.url = 'https://example.com/'
  wc.loading = true
  wc.history = { canGoBack: () => true, canGoForward: () => false }
  const handle = registerBrowser(sessionKey, asContents(wc))
  setBrowserPaneSize(sessionKey, 640.4, 480)
  assert.deepEqual(handle.getState(), {
    sessionKey,
    url: 'https://example.com/',
    title: '',
    loading: true,
    canGoBack: true,
    canGoForward: false,
    viewport: null,
    paneSize: { width: 640, height: 480 },
  })
  unregisterBrowser(sessionKey)
})

test('navigation goes through the guest, with the address normalized and a local file never loaded', async () => {
  const sessionKey = key()
  const wc = fake()
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.navigate('example.com')
  assert.deepEqual(wc.loaded, ['https://example.com/'])
  // A file: address is turned into a search: the guest never loads the file.
  await handle.navigate('file:///etc/passwd')
  assert.ok(wc.loaded.at(-1)?.startsWith('https://www.google.com/search?q='))
  handle.goBack()
  handle.goForward()
  handle.reload()
  assert.deepEqual(wc.calls, ['back', 'forward', 'reload'])
  unregisterBrowser(sessionKey)
})

test('an aborted navigation is not an error', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.loadURL = async () => {
    throw Object.assign(new Error('ERR_ABORTED'), { errno: -3 })
  }
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.navigate('https://example.com')
  unregisterBrowser(sessionKey)
})

test('setViewport emulates the device and touch through CDP, and null clears both', async () => {
  const sessionKey = key()
  const wc = fake()
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.setViewport({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true })
  const emulation = wc.debugger.commands.filter((c) => c.method.startsWith('Emulation.'))
  assert.deepEqual(emulation.at(-2), {
    method: 'Emulation.setDeviceMetricsOverride',
    params: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
  })
  assert.deepEqual(emulation.at(-1), { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true, maxTouchPoints: 5 } })
  assert.equal(handle.getState().viewport?.width, 393)

  await handle.setViewport(null)
  const cleared = wc.debugger.commands.filter((c) => c.method.startsWith('Emulation.'))
  assert.equal(cleared.at(-2)?.method, 'Emulation.clearDeviceMetricsOverride')
  assert.deepEqual(cleared.at(-1), { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } })
  assert.equal(handle.getState().viewport, null)
  unregisterBrowser(sessionKey)
})

test('setViewport clamps what an agent or the UI asks for', async () => {
  const sessionKey = key()
  const handle = registerBrowser(sessionKey, asContents(fake()))
  await handle.setViewport({ width: 10, height: 99999, deviceScaleFactor: 12, mobile: false, touch: false })
  assert.deepEqual(handle.getState().viewport, { width: 200, height: 4000, deviceScaleFactor: 4, mobile: false, touch: false })
  unregisterBrowser(sessionKey)
})

test('the debugger attaches once and re-attaches, with the viewport, after a replaced client', async () => {
  const sessionKey = key()
  const wc = fake()
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.setViewport({ width: 500, height: 600, deviceScaleFactor: 2, mobile: false, touch: false })
  await handle.cdp('Page.enable')
  assert.equal(wc.debugger.attachCount, 1)

  // The user's DevTools take over, then close.
  wc.debugger.attached = false
  wc.debugger.emit('detach', {}, 'replaced_with_devtools')
  wc.debugger.commands = []
  wc.emit('devtools-closed')
  await settle()
  assert.equal(wc.debugger.attachCount, 2)
  assert.ok(wc.debugger.commands.some((c) => c.method === 'Emulation.setDeviceMetricsOverride' && c.params?.width === 500))

  // A CDP call after a silent detach attaches again too.
  wc.debugger.attached = false
  wc.debugger.emit('detach', {}, 'replaced_with_devtools')
  await handle.cdp('Page.enable')
  assert.equal(wc.debugger.attachCount, 3)
  unregisterBrowser(sessionKey)
})

test('cdp passes the method and params to the debugger and returns its answer', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.debugger.results['Runtime.evaluate'] = { result: { value: 4 } }
  const handle = registerBrowser(sessionKey, asContents(wc))
  const answer = await handle.cdp<{ result: { value: number } }>('Runtime.evaluate', { expression: '2+2' })
  assert.equal(answer.result.value, 4)
  assert.deepEqual(wc.debugger.commands.at(-1), { method: 'Runtime.evaluate', params: { expression: '2+2' } })
  unregisterBrowser(sessionKey)
})

/** A PNG-looking buffer of the given pixel size; byte 40 carries a fill value the fake codec reads back. */
function fakePng(width: number, height: number, fill = 0): Buffer {
  const png = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  png[40] = fill
  return png
}

const fakeCodec = {
  decode: (png: Buffer) => {
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    return { width, height, bitmap: Buffer.alloc(width * height * 4, png[40]) }
  },
  encode: (image: { width: number; height: number; bitmap: Buffer }, format: string, quality: number) => {
    const png = fakePng(image.width, image.height)
    // Rows are kept in the body so the test can read the joined image back.
    return Buffer.concat([png, Buffer.from(JSON.stringify({ format, quality, firstBytes: [...image.bitmap.subarray(0, 4)], rows: Array.from({ length: image.height }, (_, row) => image.bitmap[row * image.width * 4]) }))])
  },
}

test('a viewport screenshot clips to the visible screen and drops the emulated pixel ratio while it captures', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.debugger.respond = (method) => {
    if (method === 'Page.getLayoutMetrics') {
      return { cssVisualViewport: { pageX: 0, pageY: 40, clientWidth: 393, clientHeight: 852, scale: 1 }, cssContentSize: { width: 393, height: 3000 }, contentSize: { width: 1, height: 1 } }
    }
    if (method === 'Runtime.evaluate') return { result: { value: 2 } }
    if (method === 'Page.captureScreenshot') return { data: fakePng(786, 1704).toString('base64') }
    return undefined
  }
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.setViewport({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true })
  wc.debugger.commands = []

  const shot = await handle.screenshot()
  assert.equal(shot.mimeType, 'image/png')
  assert.deepEqual([shot.width, shot.height], [786, 1704])
  const methods = wc.debugger.commands.map((c) => c.method)
  const capture = wc.debugger.commands.find((c) => c.method === 'Page.captureScreenshot')
  assert.deepEqual(capture?.params, {
    format: 'png',
    fromSurface: true,
    clip: { x: 0, y: 40, width: 393, height: 852, scale: 1 },
  })
  assert.ok(!('captureBeyondViewport' in (capture?.params ?? {})), 'beyond-viewport capture repeats a guest surface')
  // The ratio override is dropped (0 = the screen's own) for the capture and the emulation is restored after.
  const overrides = wc.debugger.commands.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride')
  assert.deepEqual(overrides.map((c) => c.params?.deviceScaleFactor), [0, 3])
  assert.ok(methods.indexOf('Page.captureScreenshot') > methods.indexOf('Emulation.setDeviceMetricsOverride'))
  unregisterBrowser(sessionKey)
})

test('screenshot honors format, quality and maxDimension', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.debugger.respond = (method) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 2000, scale: 1 }, cssContentSize: { width: 1000, height: 2000 }, contentSize: { width: 1, height: 1 } }
    if (method === 'Runtime.evaluate') return { result: { value: 2 } }
    if (method === 'Page.captureScreenshot') return { data: fakePng(500, 1000).toString('base64') }
    return undefined
  }
  const handle = registerBrowser(sessionKey, asContents(wc))
  const shot = await handle.screenshot({ format: 'jpeg', quality: 500, maxDimension: 1000 })
  assert.equal(shot.mimeType, 'image/jpeg')
  const capture = wc.debugger.commands.find((c) => c.method === 'Page.captureScreenshot')
  // 2000 css px at ratio 2 is 4000 px; capped at 1000 px the scale is 0.25.
  assert.deepEqual(capture?.params, { format: 'jpeg', fromSurface: true, quality: 100, clip: { x: 0, y: 0, width: 1000, height: 2000, scale: 0.25 } })
  // No emulation is active, so no override is touched.
  assert.ok(!wc.debugger.commands.some((c) => c.method === 'Emulation.setDeviceMetricsOverride' && c.params?.deviceScaleFactor === 0))
  unregisterBrowser(sessionKey)
})

test('a full page is scrolled and joined from screenfuls, never captured beyond the viewport, and the scroll is restored', async () => {
  setImageCodecForTests(fakeCodec)
  try {
    const sessionKey = key()
    const wc = fake()
    const viewHeight = 100
    const contentHeight = 250
    let scrollY = 30
    wc.debugger.respond = (method, params) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: scrollY, clientWidth: 50, clientHeight: viewHeight, scale: 1 }, cssContentSize: { width: 50, height: contentHeight }, contentSize: { width: 1, height: 1 } }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression)
        const to = /scrollTo\(\d+, (\d+)\)/.exec(expression)
        if (to) scrollY = Math.min(Number(to[1]), contentHeight - viewHeight)
        if (expression.includes('scrollX')) return { result: { value: { x: 0, y: scrollY } } }
        return { result: { value: 1 } }
      }
      if (method === 'Page.captureScreenshot') return { data: fakePng(50, viewHeight, scrollY / 10).toString('base64') }
      return undefined
    }
    const handle = registerBrowser(sessionKey, asContents(wc))
    const shot = await handle.screenshot({ fullPage: true })
    assert.deepEqual([shot.width, shot.height], [50, contentHeight])
    const body = JSON.parse(Buffer.from(shot.data, 'base64').subarray(64).toString()) as { rows: number[] }
    // Strips were taken at scroll 0, 100 and (clamped) 150: a row shows the last strip that covers it.
    assert.equal(body.rows[0], 0)
    assert.equal(body.rows[99], 0)
    assert.equal(body.rows[100], 10)
    assert.equal(body.rows[149], 10)
    assert.equal(body.rows[150], 15)
    assert.equal(body.rows[249], 15)
    const captures = wc.debugger.commands.filter((c) => c.method === 'Page.captureScreenshot')
    assert.equal(captures.length, 3)
    for (const capture of captures) assert.ok(!('captureBeyondViewport' in (capture.params ?? {})))
    assert.equal(scrollY, 30, 'the page is scrolled back to where it was')
    unregisterBrowser(sessionKey)
  } finally {
    setImageCodecForTests(null)
  }
})

test('a full page keeps the first strip as it is, hides fixed and sticky elements for the rest, and puts them back', async () => {
  setImageCodecForTests(fakeCodec)
  try {
    const sessionKey = key()
    const wc = fake()
    const viewHeight = 100
    const contentHeight = 250
    let scrollY = 0
    wc.debugger.respond = (method, params) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: scrollY, clientWidth: 50, clientHeight: viewHeight, scale: 1 }, cssContentSize: { width: 50, height: contentHeight }, contentSize: { width: 1, height: 1 } }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression)
        const to = /scrollTo\(\d+, (\d+)\)/.exec(expression)
        if (to) scrollY = Math.min(Number(to[1]), contentHeight - viewHeight)
        if (expression.includes('scrollX')) return { result: { value: { x: 0, y: scrollY } } }
        return { result: { value: 1 } }
      }
      if (method === 'Page.captureScreenshot') return { data: fakePng(50, viewHeight, scrollY / 10).toString('base64') }
      return undefined
    }
    const handle = registerBrowser(sessionKey, asContents(wc))
    await handle.screenshot({ fullPage: true })
    // The order of what reached the page: capture, hide, capture, hide, capture, restore.
    const steps = wc.debugger.commands
      .filter((c) => c.method === 'Page.captureScreenshot' || (c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('__piFloating')))
      .map((c) => (c.method === 'Page.captureScreenshot' ? 'capture' : String(c.params?.expression).includes('if (!true)') ? 'hide' : 'restore'))
    assert.deepEqual(steps, ['capture', 'hide', 'capture', 'hide', 'capture', 'restore'])
    unregisterBrowser(sessionKey)
  } finally {
    setImageCodecForTests(null)
  }
})

test('a tiled full page is captured at most 1280 px wide, cut from the top in tiles, and stops once the tiles are covered', async () => {
  setImageCodecForTests(fakeCodec)
  try {
    const sessionKey = key()
    const wc = fake()
    const viewHeight = 100
    const contentHeight = 1000
    let scrollY = 0
    wc.debugger.respond = (method, params) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: scrollY, clientWidth: 50, clientHeight: viewHeight, scale: 1 }, cssContentSize: { width: 50, height: contentHeight }, contentSize: { width: 1, height: 1 } }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression)
        const to = /scrollTo\(\d+, (\d+)\)/.exec(expression)
        if (to) scrollY = Math.min(Number(to[1]), contentHeight - viewHeight)
        if (expression.includes('scrollX')) return { result: { value: { x: 0, y: scrollY } } }
        return { result: { value: 1 } }
      }
      if (method === 'Page.captureScreenshot') return { data: fakePng(50, viewHeight, scrollY / 10).toString('base64') }
      return undefined
    }
    const handle = registerBrowser(sessionKey, asContents(wc))
    const shot = await handle.screenshot({ fullPage: true, format: 'auto', tiles: { maxWidth: 1280, maxTileHeight: 150, maxTiles: 2 } })
    assert.equal(shot.tiles?.length, 2)
    assert.deepEqual(shot.tiles?.map((t) => [t.width, t.height]), [[50, 150], [50, 150]])
    assert.equal(shot.coveredCssHeight, 300)
    assert.equal(shot.totalCssHeight, contentHeight)
    assert.equal(shot.data, shot.tiles?.[0].data)
    // 300 rows need three 100-row strips; the other seven are never taken.
    assert.equal(wc.debugger.commands.filter((c) => c.method === 'Page.captureScreenshot').length, 3)
    unregisterBrowser(sessionKey)
  } finally {
    setImageCodecForTests(null)
  }
})

test('rekeying a browser moves the live guest, its marks and its state to the runtime id, without a new registration', async () => {
  const from = key()
  const to = key()
  const wc = fake()
  const handle = registerBrowser(from, asContents(wc))
  await settle()
  const mark = getMarkStore(from).add({ selector: 'h1', text: 'Hi', html: '<h1>Hi</h1>', rect: { x: 1, y: 2, width: 3, height: 4 }, url: 'https://example.com/' })
  const seen: string[] = []
  const off = onBrowserChange((changedKey, state) => seen.push(`${changedKey}:${state ? 'state' : 'null'}`))
  assert.equal(rekeyBrowser(from, to), true)
  off()
  assert.equal(getBrowser(from), null)
  assert.equal(isBrowserOpen(from), false)
  assert.equal(getBrowser(to), handle)
  assert.equal(handle.sessionKey, to)
  assert.deepEqual(getMarkStore(to).list().map((m) => m.id), [mark.id])
  assert.deepEqual(getMarkStore(from).list(), [])
  assert.deepEqual(seen, [`${to}:state`], 'the guest is not unregistered')
  // Later events of the guest carry the new key.
  wc.emit('did-navigate')
  assert.equal(getBrowser(to)?.sessionKey, to)
  unregisterBrowser(to)
})

test('rekeying does nothing when the source has no browser or the target already has one', async () => {
  const a = key()
  const b = key()
  assert.equal(rekeyBrowser(a, b), false)
  registerBrowser(a, asContents(fake()))
  const other = registerBrowser(b, asContents(fake()))
  await settle()
  assert.equal(rekeyBrowser(a, b), false)
  assert.equal(getBrowser(b), other)
  assert.equal(isBrowserOpen(a), true)
  assert.equal(rekeyBrowser(a, a), false)
  unregisterBrowser(a)
  unregisterBrowser(b)
})

test('the console buffer keeps the last 500 entries from console calls, log entries and exceptions', async () => {
  const sessionKey = key()
  const wc = fake()
  const handle = registerBrowser(sessionKey, asContents(wc))
  await settle()
  const dbg = wc.debugger
  dbg.emit('message', {}, 'Runtime.consoleAPICalled', {
    type: 'warning',
    args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 7 }, { type: 'object', description: 'Object' }],
    stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 11 }] },
  })
  dbg.emit('message', {}, 'Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource', url: 'https://example.com/x.png', lineNumber: 0 } })
  dbg.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' }, url: 'https://example.com/app.js', lineNumber: 4 } })
  dbg.emit('message', {}, 'Page.frameNavigated', {})

  const entries = handle.getConsole()
  assert.equal(entries.length, 3)
  assert.deepEqual(
    entries.map(({ level, text, url, line }) => ({ level, text, url, line })),
    [
      { level: 'warning', text: 'hello 7 Object', url: 'https://example.com/app.js', line: 12 },
      { level: 'error', text: 'Failed to load resource', url: 'https://example.com/x.png', line: 1 },
      { level: 'error', text: 'TypeError: x is undefined', url: 'https://example.com/app.js', line: 5 },
    ]
  )
  assert.equal(handle.getConsole(1).length, 1)
  assert.equal(handle.getConsole(1)[0].text, 'TypeError: x is undefined')

  for (let i = 0; i < CONSOLE_BUFFER_SIZE + 25; i++) {
    dbg.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'number', value: i }] })
  }
  const all = handle.getConsole()
  assert.equal(all.length, CONSOLE_BUFFER_SIZE)
  assert.equal(all.at(-1)?.text, String(CONSOLE_BUFFER_SIZE + 24))
  assert.equal(handle.getConsole(0).length, 0)
  unregisterBrowser(sessionKey)
})

test('marks are kept per session with increasing ids, and can be removed or cleared', () => {
  const a = key()
  const b = key()
  const ha = registerBrowser(a, asContents(fake()))
  const hb = registerBrowser(b, asContents(fake()))
  const base = { selector: 'h1', text: 'Title', html: '<h1>Title</h1>', rect: { x: 1, y: 2, width: 3, height: 4 }, url: 'https://example.com/' }

  const first = ha.addMark(base)
  const second = ha.addMark({ ...base, note: 'fix this' })
  assert.deepEqual([first.id, second.id], [1, 2])
  assert.equal(typeof first.createdAt, 'number')
  assert.equal(second.note, 'fix this')
  assert.equal(hb.addMark(base).id, 1, 'ids restart per session')
  assert.equal(ha.getMarks().length, 2)
  assert.equal(hb.getMarks().length, 1)

  ha.removeMark(first.id)
  assert.deepEqual(ha.getMarks().map((m) => m.id), [2])
  ha.clearMarks()
  assert.deepEqual(ha.getMarks(), [])
  assert.equal(hb.getMarks().length, 1)

  // A returned mark is a copy: editing it does not edit the store.
  const copy = hb.getMarks()[0]
  copy.text = 'changed'
  assert.equal(hb.getMarks()[0].text, 'Title')
  unregisterBrowser(a)
  unregisterBrowser(b)
})

const IPHONE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true }
const PIXEL = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true }
const LAPTOP = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, touch: false }

function userAgentOverrides(wc: FakeWebContents): Array<Record<string, unknown> | undefined> {
  return wc.debugger.commands.filter((c) => c.method === 'Emulation.setUserAgentOverride').map((c) => c.params)
}

test('a mobile preset sends its phone user agent and reloads the page; Reset brings the desktop agent back and reloads again', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.url = 'https://en.wikipedia.org/wiki/Brazil'
  const handle = registerBrowser(sessionKey, asContents(wc))
  await settle()

  await handle.setViewport(IPHONE)
  const phone = userAgentOverrides(wc).at(-1)
  assert.match(String(phone?.userAgent), /iPhone; CPU iPhone OS 18_0/)
  assert.equal(phone?.platform, 'iPhone')
  assert.deepEqual(wc.calls.filter((c) => c.startsWith('reload')), ['reloadIgnoringCache'])

  await handle.setViewport(PIXEL)
  const pixel = userAgentOverrides(wc).at(-1)
  assert.match(String(pixel?.userAgent), /Android 14; Pixel 8.*Mobile Safari/)
  assert.equal((pixel?.userAgentMetadata as { mobile: boolean }).mobile, true)
  assert.equal(wc.calls.filter((c) => c.startsWith('reload')).length, 2)

  await handle.setViewport(null)
  const desktop = userAgentOverrides(wc).at(-1)
  assert.match(String(desktop?.userAgent), /Macintosh|Windows NT|X11/)
  assert.doesNotMatch(String(desktop?.userAgent), /Mobile/)
  assert.equal(desktop?.platform, undefined)
  assert.equal(wc.calls.filter((c) => c.startsWith('reload')).length, 3)
  unregisterBrowser(sessionKey)
})

test('a viewport that keeps the same user agent does not reload the page', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.url = 'https://example.com/'
  const handle = registerBrowser(sessionKey, asContents(wc))
  await settle()
  await handle.setViewport(LAPTOP)
  await handle.setViewport({ ...LAPTOP, width: 1000 })
  await handle.setViewport(IPHONE)
  await handle.setViewport({ ...IPHONE, deviceScaleFactor: 2 })
  assert.equal(wc.calls.filter((c) => c.startsWith('reload')).length, 1, 'only desktop -> iPhone reloads')
  unregisterBrowser(sessionKey)
})

test('a blank page is not reloaded for a user agent change', async () => {
  const sessionKey = key()
  const wc = fake()
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.setViewport(IPHONE)
  assert.deepEqual(wc.calls.filter((c) => c.startsWith('reload')), [])
  assert.match(String(userAgentOverrides(wc).at(-1)?.userAgent), /iPhone/)
  unregisterBrowser(sessionKey)
})

test('the phone user agent is sent again after a replaced debugger client, without another reload', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.url = 'https://example.com/'
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.setViewport(IPHONE)
  wc.calls.length = 0
  wc.debugger.attached = false
  wc.debugger.emit('detach', {}, 'replaced_with_devtools')
  wc.debugger.commands = []
  wc.emit('devtools-closed')
  await settle()
  assert.match(String(userAgentOverrides(wc).at(-1)?.userAgent), /iPhone/)
  assert.deepEqual(wc.calls, [])
  unregisterBrowser(sessionKey)
})

test('a hidden panel reports 0x0: the last real pane size stays', () => {
  const sessionKey = key()
  const handle = registerBrowser(sessionKey, asContents(fake()))
  setBrowserPaneSize(sessionKey, 500, 700)
  setBrowserPaneSize(sessionKey, 0, 0)
  setBrowserPaneSize(sessionKey, 0, 300)
  assert.deepEqual(handle.getState().paneSize, { width: 500, height: 700 })
  unregisterBrowser(sessionKey)
})

test('a screenshot of a page with no visible area is taken at the last pane size, or fails clearly when there is none', async () => {
  const sessionKey = key()
  const wc = fake()
  let visible = { clientWidth: 0, clientHeight: 0 }
  wc.debugger.respond = (method) => {
    if (method === 'Page.getLayoutMetrics') {
      return { cssVisualViewport: { pageX: 0, pageY: 0, scale: 1, ...visible }, cssContentSize: { width: 400, height: 600 }, contentSize: { width: 1, height: 1 } }
    }
    if (method === 'Runtime.evaluate') return { result: { value: 1 } }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      visible = { clientWidth: Number(wc.debugger.commands.at(-1)?.params?.width), clientHeight: Number(wc.debugger.commands.at(-1)?.params?.height) }
      return {}
    }
    if (method === 'Page.captureScreenshot') return { data: fakePng(400, 600).toString('base64') }
    return undefined
  }
  const handle = registerBrowser(sessionKey, asContents(wc))
  await assert.rejects(handle.screenshot(), /no visible area/)

  visible = { clientWidth: 0, clientHeight: 0 }
  setBrowserPaneSize(sessionKey, 400, 600)
  const shot = await handle.screenshot()
  assert.deepEqual([shot.width, shot.height], [400, 600])
  const override = wc.debugger.commands.find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
  assert.deepEqual([override?.params?.width, override?.params?.height], [400, 600])
  unregisterBrowser(sessionKey)
})

test('format auto keeps a small light PNG and falls back to JPEG for a big image', async () => {
  const sessionKey = key()
  const wc = fake()
  let size = { width: 400, height: 800 }
  wc.debugger.respond = (method, params) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 400, clientHeight: 800, scale: 1 }, cssContentSize: { width: 400, height: 800 }, contentSize: { width: 1, height: 1 } }
    if (method === 'Runtime.evaluate') return { result: { value: 3 } }
    if (method === 'Page.captureScreenshot') return { data: fakePng(size.width, size.height).toString('base64'), format: params?.format }
    return undefined
  }
  const handle = registerBrowser(sessionKey, asContents(wc))
  const small = await handle.screenshot({ format: 'auto' })
  assert.equal(small.mimeType, 'image/png')
  wc.debugger.commands = []
  size = { width: 1200, height: 2400 }
  const big = await handle.screenshot({ format: 'auto' })
  assert.equal(big.mimeType, 'image/jpeg')
  assert.deepEqual(wc.debugger.commands.filter((c) => c.method === 'Page.captureScreenshot').map((c) => c.params?.format), ['png', 'jpeg'])
  unregisterBrowser(sessionKey)
})

test('sessions are isolated: a command on session B reaches only B guest, and closing A leaves B', async () => {
  const a = key()
  const b = key()
  const wcA = fake()
  const wcB = fake()
  const handleA = registerBrowser(a, asContents(wcA))
  const handleB = registerBrowser(b, asContents(wcB))
  await settle()
  wcA.debugger.commands = []
  wcB.debugger.commands = []
  assert.notEqual(handleA, handleB)
  assert.equal(getBrowser(b), handleB)

  await getBrowser(b)!.cdp('Page.enable')
  await getBrowser(b)!.setViewport(IPHONE)
  await getBrowser(b)!.navigate('https://example.com/')
  assert.deepEqual(wcA.debugger.commands, [])
  assert.deepEqual(wcA.loaded, [])
  assert.deepEqual(wcA.calls, [])
  assert.deepEqual(wcB.loaded, ['https://example.com/'])
  assert.equal(handleA.getState().viewport, null)

  unregisterBrowser(a)
  assert.equal(getBrowser(a), null)
  assert.equal(getBrowser(b), handleB)
  assert.equal(wcB.debugger.attached, true, 'the background session keeps its debugger')
  unregisterBrowser(b)
})

test('a viewport without touch turns touch emulation off without a maxTouchPoints, which CDP rejects below 1', async () => {
  const sessionKey = key()
  const wc = fake()
  wc.debugger.respond = (method, params) => {
    if (method === 'Emulation.setTouchEmulationEnabled' && params?.enabled === false && 'maxTouchPoints' in params) {
      throw new Error('Touch points must be between 1 and 16')
    }
    return undefined
  }
  const handle = registerBrowser(sessionKey, asContents(wc))
  await handle.setViewport(LAPTOP)
  const touch = wc.debugger.commands.filter((c) => c.method === 'Emulation.setTouchEmulationEnabled')
  assert.deepEqual(touch.at(-1)?.params, { enabled: false })
  unregisterBrowser(sessionKey)
})

test("a runtime created for workspace B takes only B's empty-chat browser, never A's", async () => {
  const keyA = noBrowserSessionKey('ws-a')
  const keyB = noBrowserSessionKey('ws-b')
  const handleA = registerBrowser(keyA, asContents(fake()))
  await settle()
  // The auto-started runtime of workspace B rekeys B's key: A has no claim on it.
  assert.equal(rekeyBrowser(keyB, 'runtime-b'), false)
  assert.equal(getBrowser(keyA), handleA)
  assert.equal(getBrowser('runtime-b'), null)
  // Workspace A's own runtime does take it.
  assert.equal(rekeyBrowser(keyA, 'runtime-a'), true)
  assert.equal(getBrowser('runtime-a'), handleA)
  unregisterBrowser('runtime-a')
})
