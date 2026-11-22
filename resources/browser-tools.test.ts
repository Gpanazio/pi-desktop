import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_TOOLS,
  BROWSER_TOOL_NAMES,
  browserContextText,
  isBrowserTool,
  modelSeesImages,
  nextActiveTools,
  sameTools,
  toolContent,
} from './browser-tools'

test('the extension offers the fifteen browser tools, all with a schema and a short description', () => {
  assert.deepEqual([...BROWSER_TOOL_NAMES].sort(), [
    'browser_back', 'browser_click', 'browser_console', 'browser_eval', 'browser_forward', 'browser_get_marks',
    'browser_navigate', 'browser_press', 'browser_reload', 'browser_screenshot', 'browser_scroll',
    'browser_set_viewport', 'browser_snapshot', 'browser_type', 'browser_wait',
  ])
  for (const tool of BROWSER_TOOLS) {
    assert.equal((tool.parameters as { type: string }).type, 'object', tool.name)
    assert.ok(tool.description.length > 20 && tool.description.length < 400, tool.name)
  }
  assert.match(BROWSER_TOOLS.find((t) => t.name === 'browser_snapshot')!.description, /ref/)
})

test('an open panel adds the browser tools after the tools already active', () => {
  assert.deepEqual(nextActiveTools(['read', 'bash'], true), ['read', 'bash', ...BROWSER_TOOL_NAMES])
})

test('opening twice does not duplicate them', () => {
  const once = nextActiveTools(['read'], true)
  assert.deepEqual(nextActiveTools(once, true), once)
})

test('a closed panel takes the browser tools out and keeps everything else, in order', () => {
  assert.deepEqual(nextActiveTools(['read', 'browser_click', 'bash', 'browser_snapshot', 'my_tool'], false), ['read', 'bash', 'my_tool'])
})

test('tools the user or another extension turned off stay off', () => {
  // `edit` is not active: it is neither added nor needed by the union.
  const next = nextActiveTools(['read'], true)
  assert.ok(!next.includes('edit'))
  assert.ok(!nextActiveTools(next, false).includes('edit'))
})

test('sameTools ignores order and is exact on membership', () => {
  assert.equal(sameTools(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameTools(['a', 'b'], ['a']), false)
  assert.equal(sameTools(['a', 'b'], ['a', 'c']), false)
  assert.equal(sameTools([], []), true)
})

test('isBrowserTool recognises only the browser tools', () => {
  assert.equal(isBrowserTool('browser_click'), true)
  assert.equal(isBrowserTool('bash'), false)
  assert.equal(isBrowserTool('browser'), false)
})

test('the context line names the page and the viewport', () => {
  const panel = browserContextText({
    open: true,
    state: { url: 'http://localhost:3000/', title: 'App', viewport: null, paneSize: { width: 900, height: 700 } },
  })
  assert.match(panel, /^Browser interno do Pi Desktop aberto: App — http:\/\/localhost:3000\/ \(painel 900x700\)\. Use as tools browser_\*/)
  const phone = browserContextText({
    open: true,
    state: { url: 'about:blank', title: '', viewport: { width: 393, height: 852, deviceScaleFactor: 3 }, paneSize: { width: 900, height: 700 } },
    marks: 2,
  })
  assert.match(phone, /\(sem título\) — about:blank \(viewport 393x852@3\)/)
  assert.match(phone, /marcou 2 elemento/)
})

test('a model without image input is detected; an unknown model is given the benefit of the doubt', () => {
  assert.equal(modelSeesImages({ input: ['text', 'image'] }), true)
  assert.equal(modelSeesImages({ input: ['text'] }), false)
  assert.equal(modelSeesImages(undefined), true)
  assert.equal(modelSeesImages({}), true)
})

test('an image result becomes image content only for a model that can see it', () => {
  const result = { ok: true, text: 'Screenshot', image: { mimeType: 'image/jpeg', data: 'QUJD' } }
  assert.deepEqual(toolContent(result, true), [
    { type: 'text', text: 'Screenshot' },
    { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
  ])
  assert.deepEqual(toolContent(result, false), [{ type: 'text', text: 'Screenshot' }])
  assert.deepEqual(toolContent({ ok: true, text: 'x' }, true), [{ type: 'text', text: 'x' }])
  const tiles = toolContent({ ok: true, text: 'x', image: { mimeType: 'image/png', data: 'a' }, images: [{ mimeType: 'image/jpeg', data: 'b' }] }, true)
  assert.deepEqual(tiles.map((c) => c.type), ['text', 'image', 'image'])
  assert.deepEqual(toolContent({ ok: true, text: 'x', image: { mimeType: 'image/png', data: 'a' }, images: [{ mimeType: 'image/jpeg', data: 'b' }] }, false), [{ type: 'text', text: 'x' }])
})
