import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserScreenshot, BrowserState, BrowserViewport } from '../../shared/browser'
import type { BrowserHandle } from './browser-controller'
import {
  EVAL_MAX_BYTES,
  buildSnapshot,
  currentRefs,
  parseKey,
  pointFromQuads,
  runBrowserAction,
  truncateUtf8,
  type ActionEnv,
  type ActionHandle,
  type AxNode,
} from './browser-actions'

interface Call {
  method: string
  params?: Record<string, unknown>
}

class FakeHandle implements ActionHandle {
  calls: Call[] = []
  url = 'https://example.test/'
  title = 'Example'
  loading = false
  viewport: BrowserViewport | null = null
  canGoBack = true
  responses: Record<string, unknown | ((params?: Record<string, unknown>) => unknown)> = {}
  consoleEntries = [
    { level: 'log', text: 'hello', ts: 1 },
    { level: 'error', text: 'boom', url: 'https://example.test/app.js', line: 7, ts: 2 },
    { level: 'warning', text: 'careful', ts: 3 },
  ]
  marks: Array<{ id: number; selector: string; text: string; html: string; rect: { x: number; y: number; width: number; height: number }; url: string; createdAt: number; note?: string }> = []
  navigated: string[] = []
  screenshotCalls: Array<Parameters<BrowserHandle['screenshot']>[0]> = []
  paneSize = { width: 900, height: 700 }
  focused = 0
  webContents = {
    focus: () => {
      this.focused += 1
    },
  }

  getState(): BrowserState {
    return {
      sessionKey: 's',
      url: this.url,
      title: this.title,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: false,
      viewport: this.viewport,
      paneSize: this.paneSize,
    }
  }
  async navigate(url: string): Promise<void> {
    this.navigated.push(url)
    this.url = url
  }
  goBack(): void {
    this.calls.push({ method: 'goBack' })
  }
  goForward(): void {
    this.calls.push({ method: 'goForward' })
  }
  reload(): void {
    this.calls.push({ method: 'reload' })
  }
  async setViewport(v: BrowserViewport | null): Promise<void> {
    this.viewport = v
  }
  async screenshot(opts?: Parameters<BrowserHandle['screenshot']>[0]): Promise<BrowserScreenshot> {
    this.screenshotCalls.push(opts)
    return { mimeType: opts?.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: 'QUJD', width: 100, height: 50 }
  }
  async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    const response = this.responses[method]
    const value = typeof response === 'function' ? (response as (p?: Record<string, unknown>) => unknown)(params) : response
    if (value instanceof Error) throw value
    return (value ?? {}) as T
  }
  getMarks() {
    return this.marks
  }
  getConsole(limit?: number) {
    return limit === undefined ? [...this.consoleEntries] : this.consoleEntries.slice(-limit)
  }
  named(method: string): Call[] {
    return this.calls.filter((c) => c.method === method)
  }
}

function fakeEnv(): ActionEnv & { clock: number } {
  const env = {
    clock: 0,
    async sleep(ms: number) {
      env.clock += ms
    },
    now: () => env.clock,
  }
  return env
}

const ax = (nodeId: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
})

const PAGE: AxNode[] = [
  ax('1', 'RootWebArea', 'Demo', { childIds: ['2', '3', '4', '5', '9'] }),
  ax('2', 'heading', 'Welcome', { parentId: '1', backendDOMNodeId: 12, properties: [{ name: 'level', value: { value: 1 } }] }),
  ax('3', 'textbox', 'Name', { parentId: '1', backendDOMNodeId: 20, value: { value: 'abc' }, properties: [{ name: 'focused', value: { value: true } }] }),
  ax('4', 'button', 'Save', { parentId: '1', backendDOMNodeId: 21, childIds: ['6'] }),
  ax('6', 'StaticText', 'Save', { parentId: '4', backendDOMNodeId: 22 }),
  ax('5', 'generic', '', { parentId: '1', childIds: ['7'] }),
  ax('7', 'link', 'Docs', { parentId: '5', backendDOMNodeId: 23, properties: [{ name: 'url', value: { value: 'https://example.test/docs' } }] }),
  ax('9', 'button', 'Hidden', { parentId: '1', ignored: true, backendDOMNodeId: 30 }),
]

test('snapshot lists interactive nodes with refs mapped to backend node ids', () => {
  const result = buildSnapshot(PAGE, { interactiveOnly: true, maxNodes: 400 })
  assert.deepEqual(result.lines, [
    '[e1] textbox "Name" [focused, value="abc"]',
    '[e2] button "Save"',
    '[e3] link "Docs" [href=https://example.test/docs]',
  ])
  assert.deepEqual([...result.refs], [['e1', 20], ['e2', 21], ['e3', 23]])
})

test('snapshot of the whole page indents, drops duplicated text and skips ignored nodes', () => {
  const result = buildSnapshot(PAGE, { interactiveOnly: false, maxNodes: 400 })
  assert.deepEqual(result.lines, [
    'page "Demo"',
    '  [e1] heading "Welcome" [level=1]',
    '  [e2] textbox "Name" [focused, value="abc"]',
    '  [e3] button "Save"',
    '  [e4] link "Docs" [href=https://example.test/docs]',
  ])
})

test('snapshot stops at maxNodes and says how many it left out', () => {
  const result = buildSnapshot(PAGE, { interactiveOnly: true, maxNodes: 2 })
  assert.equal(result.lines.length, 2)
  assert.equal(result.total, 3)
  assert.equal(result.omitted, 1)
  assert.equal(result.refs.size, 2)
})

test('the snapshot action stores refs for the page, and a navigation drops them', async () => {
  const handle = new FakeHandle()
  handle.responses['Accessibility.getFullAXTree'] = { nodes: PAGE }
  const result = await runBrowserAction(handle, 'snapshot', {}, fakeEnv())
  assert.equal(result.ok, true)
  assert.match(result.text, /\[e2\] button "Save"/)
  assert.match(result.text, /Page: Example — https:\/\/example\.test\/$/)
  assert.equal(currentRefs(handle)?.get('e2'), 21)

  await runBrowserAction(handle, 'navigate', { url: 'https://example.test/other' }, fakeEnv())
  assert.equal(currentRefs(handle), null)
})

test('a ref from before a navigation is refused with a hint to snapshot again', async () => {
  const handle = new FakeHandle()
  handle.responses['Accessibility.getFullAXTree'] = { nodes: PAGE }
  await runBrowserAction(handle, 'snapshot', {}, fakeEnv())
  handle.url = 'https://example.test/next'
  const result = await runBrowserAction(handle, 'click', { ref: 'e1' }, fakeEnv())
  assert.equal(result.ok, false)
  assert.match(result.text, /browser_snapshot again/)
  assert.equal(handle.named('Input.dispatchMouseEvent').length, 0)
})

test('pointFromQuads centres the first visible quad and clips it to the viewport', () => {
  assert.deepEqual(pointFromQuads([[10, 10, 110, 10, 110, 50, 10, 50]], { width: 800, height: 600 }), { x: 60, y: 30 })
  // Half of the element lies below the fold: the centre is that of the visible half.
  assert.deepEqual(pointFromQuads([[0, 500, 100, 500, 100, 700, 0, 700]], { width: 800, height: 600 }), { x: 50, y: 550 })
  // A zero-area quad is skipped for the next one.
  assert.deepEqual(
    pointFromQuads([[5, 5, 5, 5, 5, 5, 5, 5], [0, 0, 20, 0, 20, 20, 0, 20]], { width: 100, height: 100 }),
    { x: 10, y: 10 },
  )
  assert.equal(pointFromQuads([[900, 900, 950, 900, 950, 950, 900, 950]], { width: 800, height: 600 }), null)
})

test('click on a ref scrolls it in, reads the layout viewport and sends moved, pressed, released at the centre', async () => {
  const handle = new FakeHandle()
  handle.responses['Accessibility.getFullAXTree'] = { nodes: PAGE }
  handle.responses['DOM.resolveNode'] = (params?: Record<string, unknown>) => ({ object: { objectId: `obj-${String(params?.backendNodeId)}` } })
  // A 393x852 emulated phone: the quad is in CSS px of that viewport.
  handle.responses['Page.getLayoutMetrics'] = { cssLayoutViewport: { clientWidth: 393, clientHeight: 852 } }
  handle.responses['DOM.getContentQuads'] = { quads: [[100, 200, 300, 200, 300, 240, 100, 240]] }
  await runBrowserAction(handle, 'snapshot', {}, fakeEnv())
  const result = await runBrowserAction(handle, 'click', { ref: 'e2' }, fakeEnv())
  assert.equal(result.ok, true, result.text)
  assert.deepEqual(handle.named('DOM.resolveNode')[0].params, { backendNodeId: 21 })
  assert.deepEqual(handle.named('DOM.scrollIntoViewIfNeeded')[0].params, { objectId: 'obj-21' })
  const mouse = handle.named('Input.dispatchMouseEvent').map((c) => c.params)
  assert.deepEqual(mouse.map((p) => p?.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  for (const p of mouse) assert.deepEqual([p?.x, p?.y], [200, 220])
  assert.equal(mouse[1]?.button, 'left')
  assert.equal(mouse[1]?.clickCount, 1)
  assert.equal(mouse[2]?.buttons, 0)
})

test('click by selector reports an unknown selector and a bad one', async () => {
  const handle = new FakeHandle()
  handle.responses['Runtime.evaluate'] = { result: { type: 'object', subtype: 'null', value: null } }
  const missing = await runBrowserAction(handle, 'click', { selector: '#nope' }, fakeEnv())
  assert.equal(missing.ok, false)
  assert.match(missing.text, /No element matches selector "#nope"/)

  handle.responses['Runtime.evaluate'] = { result: {}, exceptionDetails: { text: 'SyntaxError', exception: { description: "SyntaxError: '##' is not a valid selector" } } }
  const bad = await runBrowserAction(handle, 'click', { selector: '##' }, fakeEnv())
  assert.match(bad.text, /Invalid selector "##"/)
})

test('click at x,y needs both coordinates and sends them as given', async () => {
  const handle = new FakeHandle()
  assert.equal((await runBrowserAction(handle, 'click', { x: 5 }, fakeEnv())).ok, false)
  const result = await runBrowserAction(handle, 'click', { x: 12, y: 34, button: 'right', clickCount: 2 }, fakeEnv())
  assert.equal(result.ok, true)
  const pressed = handle.named('Input.dispatchMouseEvent')[1].params
  assert.deepEqual([pressed?.x, pressed?.y, pressed?.button, pressed?.buttons, pressed?.clickCount], [12, 34, 'right', 2, 2])
})

test('actions that may navigate wait for the load, but never past 3 s', async () => {
  const handle = new FakeHandle()
  handle.loading = true
  const env = fakeEnv()
  await runBrowserAction(handle, 'click', { x: 1, y: 1 }, env)
  assert.ok(env.clock >= 3000 && env.clock < 3300, `waited ${env.clock} ms`)

  const quick = new FakeHandle()
  const quickEnv = fakeEnv()
  await runBrowserAction(quick, 'click', { x: 1, y: 1 }, quickEnv)
  assert.ok(quickEnv.clock < 500)
})

test('type focuses the target, clears it, inserts the text and submits with Enter', async () => {
  const handle = new FakeHandle()
  handle.responses['Runtime.evaluate'] = { result: { objectId: 'field' } }
  handle.responses['Page.getLayoutMetrics'] = { cssLayoutViewport: { clientWidth: 400, clientHeight: 800 } }
  handle.responses['DOM.getContentQuads'] = { quads: [[10, 10, 110, 10, 110, 50, 10, 50]] }
  const result = await runBrowserAction(handle, 'type', { selector: '#q', text: 'gabriel', clear: true, submit: true }, fakeEnv())
  assert.equal(result.ok, true, result.text)
  // Click the field (the guest takes the keyboard focus), put the caret at the end, clear, then type.
  const order = handle.calls.map((c) => c.method === 'Input.dispatchMouseEvent' ? `mouse:${String(c.params?.type)}` : c.method)
    .filter((m) => m.startsWith('mouse:') || m === 'Runtime.callFunctionOn')
  assert.deepEqual(order, ['mouse:mouseMoved', 'mouse:mousePressed', 'mouse:mouseReleased', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn'])
  assert.equal(handle.named('DOM.focus').length, 0)
  const typed = handle.named('Input.dispatchKeyEvent').map((c) => c.params).filter((p) => p?.type === 'char')
  assert.equal(typed.map((p) => p?.text).join(''), 'gabriel')
  assert.equal(handle.named('Input.insertText').length, 0)
  const keys = handle.named('Input.dispatchKeyEvent').map((c) => c.params).filter((p) => p?.type !== 'char')
  assert.deepEqual(keys.map((k) => [k?.type, k?.key, k?.windowsVirtualKeyCode]), [['keyDown', 'Enter', 13], ['keyUp', 'Enter', 13]])
  assert.equal(keys[0]?.text, '\r')
  assert.ok(handle.focused >= 1)
})

test('type with no target refuses when no text field has the focus', async () => {
  const handle = new FakeHandle()
  handle.responses['Runtime.evaluate'] = { result: { type: 'boolean', value: false } }
  const result = await runBrowserAction(handle, 'type', { text: 'x' }, fakeEnv())
  assert.equal(result.ok, false)
  assert.match(result.text, /No text field is focused/)
  assert.equal(handle.named('Input.insertText').length, 0)
  handle.responses['Runtime.evaluate'] = { result: { type: 'boolean', value: true } }
  assert.equal((await runBrowserAction(handle, 'type', { text: 'x' }, fakeEnv())).ok, true)
})

test('type without text is an error', async () => {
  const result = await runBrowserAction(new FakeHandle(), 'type', { selector: '#q' }, fakeEnv())
  assert.equal(result.ok, false)
})

test('parseKey maps names, aliases, letters, digits and punctuation', () => {
  assert.deepEqual(parseKey('Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' })
  assert.deepEqual(parseKey('esc'), { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0 })
  assert.deepEqual(parseKey('tab'), { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 })
  assert.equal(parseKey('ArrowDown').windowsVirtualKeyCode, 40)
  assert.equal(parseKey('left').code, 'ArrowLeft')
  assert.equal(parseKey('Backspace').windowsVirtualKeyCode, 8)
  assert.equal(parseKey('F5').windowsVirtualKeyCode, 116)
  assert.deepEqual(parseKey('a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a' })
  assert.deepEqual(parseKey('7'), { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: 0, text: '7' })
  assert.deepEqual(parseKey('/'), { key: '/', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 0, text: '/' })
  assert.deepEqual(parseKey('Space'), { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0, text: ' ' })
})

test('parseKey folds modifiers into the bit field and drops the typed text under a command key', () => {
  assert.deepEqual(parseKey('Control+a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  assert.equal(parseKey('Meta+Shift+ArrowLeft').modifiers, 4 | 8)
  assert.equal(parseKey('Shift+Tab').modifiers, 8)
  assert.equal(parseKey('Alt+Control+Delete').modifiers, 1 | 2)
  assert.equal(parseKey('Shift+a').key, 'A')
  assert.equal(parseKey('Shift+a').text, 'A')
  assert.equal(parseKey('Control++').code, 'Equal')
})

test('parseKey rejects what it cannot map', () => {
  assert.throws(() => parseKey(''), /empty/)
  assert.throws(() => parseKey('Hyper+a'), /Unknown modifier/)
  assert.throws(() => parseKey('Banana'), /Unknown key/)
})

test('press sends keyDown then keyUp with the code and virtual key code', async () => {
  const handle = new FakeHandle()
  const result = await runBrowserAction(handle, 'press', { key: 'Shift+Tab' }, fakeEnv())
  assert.equal(result.ok, true)
  const events = handle.named('Input.dispatchKeyEvent').map((c) => c.params)
  assert.deepEqual(events.map((e) => e?.type), ['rawKeyDown', 'keyUp'])
  assert.deepEqual([events[0]?.code, events[0]?.windowsVirtualKeyCode, events[0]?.modifiers], ['Tab', 9, 8])
  assert.equal((await runBrowserAction(handle, 'press', { key: 'Nope' }, fakeEnv())).ok, false)
})

test('truncateUtf8 cuts at the byte limit without splitting a character', () => {
  assert.equal(truncateUtf8('short', 100), 'short')
  const long = 'é'.repeat(100)
  const cut = truncateUtf8(long, 51)
  assert.ok(!cut.includes('�'))
  assert.match(cut, /^é{25}\n… \[truncated: \d+ more bytes\]$/)
})

test('eval returns the value, serialized, and cuts it at 8 KB', async () => {
  const handle = new FakeHandle()
  handle.responses['Runtime.evaluate'] = { result: { type: 'object', value: { a: 1 } } }
  assert.match((await runBrowserAction(handle, 'eval', { expression: '({a:1})' }, fakeEnv())).text, /^\{\n {2}"a": 1\n\}/)
  const evalCall = handle.named('Runtime.evaluate')[0].params
  assert.equal(evalCall?.returnByValue, true)
  assert.equal(evalCall?.awaitPromise, true)

  handle.responses['Runtime.evaluate'] = { result: { type: 'string', value: 'x'.repeat(20_000) } }
  const big = await runBrowserAction(handle, 'eval', { expression: 'big' }, fakeEnv())
  assert.ok(Buffer.byteLength(big.text) < EVAL_MAX_BYTES + 300)
  assert.match(big.text, /truncated/)

  handle.responses['Runtime.evaluate'] = { result: { type: 'undefined' } }
  assert.match((await runBrowserAction(handle, 'eval', { expression: 'void 0' }, fakeEnv())).text, /^undefined/)

  handle.responses['Runtime.evaluate'] = { result: {}, exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } } }
  const failed = await runBrowserAction(handle, 'eval', { expression: 'nope' }, fakeEnv())
  assert.equal(failed.ok, false)
  assert.match(failed.text, /ReferenceError/)
})

test('console filters by level and keeps the newest entries', async () => {
  const handle = new FakeHandle()
  const all = await runBrowserAction(handle, 'console', {}, fakeEnv())
  assert.match(all.text, /\[log\] hello\n\[error\] boom \(https:\/\/example\.test\/app\.js:7\)\n\[warning\] careful/)
  const errors = await runBrowserAction(handle, 'console', { level: 'error' }, fakeEnv())
  assert.match(errors.text, /^\[error\] boom/)
  assert.doesNotMatch(errors.text, /hello/)
  assert.match((await runBrowserAction(handle, 'console', { level: 'warn' }, fakeEnv())).text, /careful/)
  assert.match((await runBrowserAction(handle, 'console', { limit: 1 }, fakeEnv())).text, /^\[warning\] careful/)
})

test('set_viewport takes the presets of the panel, a custom size, and reset', async () => {
  const handle = new FakeHandle()
  const phone = await runBrowserAction(handle, 'set_viewport', { preset: 'iphone-15' }, fakeEnv())
  assert.equal(phone.ok, true)
  assert.deepEqual(handle.viewport, { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true })
  assert.match(phone.text, /393x852@3 mobile/)

  await runBrowserAction(handle, 'set_viewport', { width: 5000, height: 100, deviceScaleFactor: 9, mobile: true }, fakeEnv())
  assert.deepEqual(handle.viewport, { width: 4000, height: 200, deviceScaleFactor: 4, mobile: true, touch: true })

  assert.equal((await runBrowserAction(handle, 'set_viewport', { preset: 'fridge' }, fakeEnv())).ok, false)
  assert.equal((await runBrowserAction(handle, 'set_viewport', {}, fakeEnv())).ok, false)

  await runBrowserAction(handle, 'set_viewport', { reset: true }, fakeEnv())
  assert.equal(handle.viewport, null)
})

test('screenshot leaves PNG or JPEG to the size of the image that comes back, and caps it at 1600 px', async () => {
  const handle = new FakeHandle()
  for (const viewport of [
    { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, touch: false },
    { width: 320, height: 480, deviceScaleFactor: 1, mobile: false, touch: false },
    { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
  ]) {
    handle.viewport = viewport
    await runBrowserAction(handle, 'screenshot', {}, fakeEnv())
  }
  await runBrowserAction(handle, 'screenshot', { fullPage: true }, fakeEnv())
  // The device pixel ratio does not change the request: the controller measures what it captured.
  for (const call of handle.screenshotCalls) {
    assert.deepEqual({ ...call, fullPage: undefined, tiles: undefined }, { fullPage: undefined, tiles: undefined, format: 'auto', quality: 80, maxDimension: 1600 })
  }
  assert.deepEqual(handle.screenshotCalls.map((call) => call?.fullPage), [false, false, false, true])
  assert.deepEqual(handle.screenshotCalls.map((call) => call?.tiles), [undefined, undefined, undefined, { maxWidth: 1280, maxTileHeight: 1600, maxTiles: 4 }])
})

test('a full-page screenshot returns the tiles as images and says how far down the page they reach', async () => {
  const handle = new FakeHandle()
  const tile = (data: string) => ({ mimeType: 'image/jpeg', data, width: 1280, height: 1600 })
  handle.screenshot = async () => ({ ...tile('A'), tiles: [tile('A'), tile('B'), tile('C'), tile('D')], coveredCssHeight: 5200, totalCssHeight: 16000 })
  const result = await runBrowserAction(handle, 'screenshot', { fullPage: true }, fakeEnv())
  assert.equal(result.ok, true)
  assert.deepEqual([result.image?.data, ...(result.images ?? []).map((i) => i.data)], ['A', 'B', 'C', 'D'])
  assert.match(result.text, /4 tiles/)
  assert.match(result.text, /y=0 to y=5200/)
  assert.match(result.text, /16000 px tall.*browser_scroll/)
  handle.screenshot = async () => ({ ...tile('A'), tiles: [tile('A')], coveredCssHeight: 900, totalCssHeight: 900 })
  const whole = await runBrowserAction(handle, 'screenshot', { fullPage: true }, fakeEnv())
  assert.equal(whole.images, undefined)
  assert.match(whole.text, /1 tile /)
  assert.match(whole.text, /whole page is covered/)
})

test('screenshot withMarks draws the overlay, lists the marks, and removes the overlay', async () => {
  const handle = new FakeHandle()
  handle.marks = [{ id: 1, selector: '#go', text: 'Go', html: '<button>', rect: { x: 1, y: 2, width: 30, height: 10 }, url: handle.url, createdAt: 0, note: 'too small' }]
  const result = await runBrowserAction(handle, 'screenshot', { withMarks: true }, fakeEnv())
  assert.match(result.text, /#1 #go text="Go" note="too small"/)
  const scripts = handle.named('Runtime.evaluate').map((c) => String(c.params?.expression))
  assert.equal(scripts.length, 2)
  assert.match(scripts[0], /__pi_desktop_marks__/)
  assert.match(scripts[1], /remove\(\)/)
})

test('wait polls for text until it shows, and times out with a failure', async () => {
  const handle = new FakeHandle()
  let polls = 0
  handle.responses['Runtime.evaluate'] = () => ({ result: { type: 'boolean', value: ++polls >= 3 } })
  const env = fakeEnv()
  const found = await runBrowserAction(handle, 'wait', { text: 'OK', timeoutMs: 5000 }, env)
  assert.equal(found.ok, true)
  assert.equal(polls, 3)

  handle.responses['Runtime.evaluate'] = { result: { type: 'boolean', value: false } }
  const timedOut = await runBrowserAction(handle, 'wait', { selector: '#never', timeoutMs: 500 }, fakeEnv())
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.text, /Timed out after 500 ms waiting for selector #never/)

  const sleepEnv = fakeEnv()
  await runBrowserAction(handle, 'wait', { ms: 250 }, sleepEnv)
  assert.equal(sleepEnv.clock, 250)
  assert.equal((await runBrowserAction(handle, 'wait', {}, fakeEnv())).ok, false)
})

test('scroll by delta sends a wheel event at the viewport centre; a ref scrolls into view', async () => {
  const handle = new FakeHandle()
  handle.responses['Page.getLayoutMetrics'] = { cssLayoutViewport: { clientWidth: 400, clientHeight: 800 } }
  handle.responses['Runtime.evaluate'] = { result: { type: 'object', value: { x: 0, y: 300, max: 1200 } } }
  const result = await runBrowserAction(handle, 'scroll', { dy: 300 }, fakeEnv())
  assert.match(result.text, /y=300 of 1200/)
  assert.deepEqual(handle.named('Input.dispatchMouseEvent')[0].params, { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: 300 })
  assert.equal((await runBrowserAction(handle, 'scroll', {}, fakeEnv())).ok, false)
})

test('navigation actions reset refs, wait for the load and end with the page title and URL', async () => {
  const handle = new FakeHandle()
  const nav = await runBrowserAction(handle, 'navigate', { url: 'localhost:3000' }, fakeEnv())
  assert.deepEqual(handle.navigated, ['localhost:3000'])
  assert.match(nav.text, /Page: Example — localhost:3000$/)

  assert.equal((await runBrowserAction(handle, 'back', {}, fakeEnv())).ok, true)
  assert.equal(handle.named('goBack').length, 1)
  handle.canGoBack = false
  assert.equal((await runBrowserAction(handle, 'back', {}, fakeEnv())).ok, false)
  await runBrowserAction(handle, 'reload', {}, fakeEnv())
  assert.equal(handle.named('reload').length, 1)
})

test('a failing navigation comes back as ok:false instead of throwing', async () => {
  const handle = new FakeHandle()
  handle.navigate = async () => {
    throw new Error('Cannot load nope')
  }
  const result = await runBrowserAction(handle, 'navigate', { url: 'nope' }, fakeEnv())
  assert.equal(result.ok, false)
  assert.match(result.text, /Cannot load nope/)
})

test('get_marks lists the marks, or says there are none; an unknown action is refused', async () => {
  const handle = new FakeHandle()
  assert.match((await runBrowserAction(handle, 'get_marks', {}, fakeEnv())).text, /has not marked anything/)
  handle.marks = [{ id: 3, selector: 'main > a', text: 'Docs', html: '<a>', rect: { x: 1.4, y: 2, width: 3, height: 4 }, url: 'https://example.test/' , createdAt: 0 }]
  assert.match((await runBrowserAction(handle, 'get_marks', {}, fakeEnv())).text, /#3 main > a text="Docs" rect=1,2 3x4/)
  const unknown = await runBrowserAction(handle, 'selfdestruct', {}, fakeEnv())
  assert.equal(unknown.ok, false)
})
