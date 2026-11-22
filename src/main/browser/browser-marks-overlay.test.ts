import assert from 'node:assert/strict'
import test from 'node:test'
import { getMarkStore, onMarkPick } from './browser-mark-store'
import { BrowserMarksOverlay } from './browser-marks-overlay'
import { MARKS_BINDING, MARKS_WORLD } from './browser-marks-script'

let counter = 0

function setup() {
  const store = getMarkStore(`overlay-${++counter}`)
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const answers: Record<string, unknown> = {}
  const overlay = new BrowserMarksOverlay(async (method, params) => {
    calls.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '')
      for (const [fragment, value] of Object.entries(answers)) if (expression.includes(fragment)) return { result: { value } }
    }
    return {}
  }, store)
  const called = (payload: unknown, executionContextId = 1): void =>
    overlay.onCdpMessage('Runtime.bindingCalled', { name: MARKS_BINDING, executionContextId, payload: JSON.stringify(payload) })
  return { store, calls, answers, overlay, called }
}

const mark = { selector: 'h1', text: 'Hi', html: '<h1>Hi</h1>', rect: { x: 1, y: 2, width: 3, height: 4 }, url: 'https://example.com/' }

test('install registers the binding and the script in the isolated world', async () => {
  const { overlay, calls } = setup()
  await overlay.install()
  assert.equal(calls[0].method, 'Page.enable')
  assert.deepEqual(calls[1], { method: 'Runtime.addBinding', params: { name: MARKS_BINDING, executionContextName: MARKS_WORLD } })
  assert.equal(calls[2].method, 'Page.addScriptToEvaluateOnNewDocument')
  assert.equal(calls[2].params?.worldName, MARKS_WORLD)
  assert.equal(calls[2].params?.runImmediately, true)
})

test('a frame that reports ready gets the mode and the badges', () => {
  const { overlay, store, calls, called } = setup()
  store.setMode(true)
  store.add(mark)
  called({ t: 'ready', top: true }, 7)
  const evaluate = calls.filter((call) => call.method === 'Runtime.evaluate').at(-1)
  assert.equal(evaluate?.params?.contextId, 7)
  const state = JSON.parse(String(evaluate?.params?.expression).slice('__piMarksApi.setState('.length, -1))
  assert.equal(state.mode, true)
  assert.deepEqual(state.badges.map((b: { n: number; selector: string }) => [b.n, b.selector]), [[1, 'h1']])
  assert.ok(overlay)
})

test('a click in mark mode is a pick that ends the mode and adds no mark by itself', () => {
  const { store, called } = setup()
  const picks: string[] = []
  const off = onMarkPick((sessionKey, pick) => {
    if (sessionKey === store.sessionKey) picks.push(pick.draft.selector)
  })
  store.setMode(true)
  called({ t: 'pick', shift: false, mark })
  off()
  assert.equal(store.markMode, false)
  assert.equal(store.list().length, 0)
  assert.deepEqual(picks, ['h1'])
})

test('Shift keeps the mode; a pick outside mark mode or a malformed one is ignored', () => {
  const { store, called } = setup()
  store.setMode(true)
  called({ t: 'pick', shift: true, mark })
  assert.equal(store.markMode, true)
  called({ t: 'pick', shift: false, mark: { selector: 5 } })
  assert.equal(store.markMode, true)
  called({ t: 'exit' })
  assert.equal(store.markMode, false)
  called({ t: 'pick', shift: false, mark })
  assert.equal(store.markMode, false)
})

test('measure asks the top frame only and returns its layout', async () => {
  const { overlay, answers, calls, called } = setup()
  called({ t: 'ready', top: false }, 2)
  called({ t: 'ready', top: true }, 3)
  answers['__piMarksApi.measure'] = { cssWidth: 400, cssHeight: 800, rects: [{ id: 1, x: 1, y: 2, width: 3, height: 4 }] }
  const layout = await overlay.measure([1], false)
  assert.equal(layout?.cssWidth, 400)
  const measure = calls.filter((call) => String(call.params?.expression).includes('measure'))
  assert.deepEqual(measure.map((call) => call.params?.contextId), [3])
})

test('a destroyed context stops getting commands; hiding reaches the live ones', async () => {
  const { overlay, calls, called } = setup()
  called({ t: 'ready', top: true }, 1)
  called({ t: 'ready', top: false }, 2)
  overlay.onCdpMessage('Runtime.executionContextDestroyed', { executionContextId: 2 })
  calls.length = 0
  await overlay.setHidden(true)
  assert.deepEqual(calls.map((call) => [call.params?.contextId, call.params?.expression]), [[1, '__piMarksApi.setHidden(true)']])
})
