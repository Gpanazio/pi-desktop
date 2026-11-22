import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_PARTITION,
  BROWSER_VIEWPORT_PRESETS,
  SEARCH_URL_PREFIX,
  clampViewport,
  isBrowsableUrl,
  normalizeAddress,
  scaleToFit,
} from './browser'

const viewport = { width: 800, height: 600, deviceScaleFactor: 1, mobile: false, touch: false }

test('a full http(s) URL loads as typed', () => {
  assert.deepEqual(normalizeAddress('https://example.com/a?b=1#c'), { kind: 'url', url: 'https://example.com/a?b=1#c' })
  assert.deepEqual(normalizeAddress('  http://example.com  '), { kind: 'url', url: 'http://example.com/' })
})

test('a host without a scheme gets https', () => {
  assert.equal(normalizeAddress('example.com').url, 'https://example.com/')
  assert.equal(normalizeAddress('www.example.co.uk/path?q=1').url, 'https://www.example.co.uk/path?q=1')
  assert.equal(normalizeAddress('example.com:8443/x').url, 'https://example.com:8443/x')
  assert.equal(normalizeAddress('example.com').kind, 'url')
})

test('localhost and local addresses get http, a public IP gets https', () => {
  assert.equal(normalizeAddress('localhost:3000').url, 'http://localhost:3000/')
  assert.equal(normalizeAddress('127.0.0.1:8080/app').url, 'http://127.0.0.1:8080/app')
  assert.equal(normalizeAddress('192.168.0.10').url, 'http://192.168.0.10/')
  assert.equal(normalizeAddress('8.8.8.8').url, 'https://8.8.8.8/')
})

test('text that is not an address becomes a Google search', () => {
  assert.deepEqual(normalizeAddress('cats and dogs'), { kind: 'search', url: `${SEARCH_URL_PREFIX}cats%20and%20dogs` })
  assert.equal(normalizeAddress('hello').kind, 'search')
  assert.equal(normalizeAddress('what is 1.5 + 2?').kind, 'search')
  assert.equal(normalizeAddress('ftp://example.com').kind, 'search')
})

test('schemes the panel must not load never become a URL', () => {
  for (const text of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'chrome://settings', 'view-source:https://example.com']) {
    const result = normalizeAddress(text)
    assert.equal(result.kind, 'search', text)
    assert.ok(result.url.startsWith(SEARCH_URL_PREFIX), text)
  }
})

test('an empty address is a blank page', () => {
  assert.deepEqual(normalizeAddress('   '), { kind: 'url', url: 'about:blank' })
  assert.deepEqual(normalizeAddress('about:blank'), { kind: 'url', url: 'about:blank' })
})

test('isBrowsableUrl accepts http(s) and about:blank only', () => {
  assert.equal(isBrowsableUrl('https://example.com'), true)
  assert.equal(isBrowsableUrl('http://localhost:3000'), true)
  assert.equal(isBrowsableUrl('about:blank'), true)
  assert.equal(isBrowsableUrl('file:///tmp/x.html'), false)
  assert.equal(isBrowsableUrl('javascript:alert(1)'), false)
  assert.equal(isBrowsableUrl(''), false)
})

test('clampViewport keeps size in 200..4000 and the pixel ratio in 1..4', () => {
  assert.deepEqual(clampViewport({ ...viewport, width: 50, height: 99999, deviceScaleFactor: 0.2 }), {
    ...viewport,
    width: 200,
    height: 4000,
    deviceScaleFactor: 1,
  })
  assert.equal(clampViewport({ ...viewport, width: 200 }).width, 200)
  assert.equal(clampViewport({ ...viewport, width: 4000 }).width, 4000)
  assert.equal(clampViewport({ ...viewport, deviceScaleFactor: 9 }).deviceScaleFactor, 4)
  assert.equal(clampViewport({ ...viewport, deviceScaleFactor: 2.625 }).deviceScaleFactor, 2.625)
  assert.equal(clampViewport({ ...viewport, width: 393.6 }).width, 394)
  assert.equal(clampViewport({ ...viewport, width: Number.NaN }).width, 200)
})

test('every preset is already inside the clamp', () => {
  for (const preset of BROWSER_VIEWPORT_PRESETS) {
    const { id: _id, label: _label, ...own } = preset
    assert.deepEqual(clampViewport(own), own, preset.id)
  }
})

test('the presets match the menu the product asks for', () => {
  const byId = Object.fromEntries(BROWSER_VIEWPORT_PRESETS.map((p) => [p.id, p]))
  assert.deepEqual([byId['iphone-15'].width, byId['iphone-15'].height, byId['iphone-15'].deviceScaleFactor, byId['iphone-15'].mobile, byId['iphone-15'].touch], [393, 852, 3, true, true])
  assert.deepEqual([byId['pixel-8'].width, byId['pixel-8'].height, byId['pixel-8'].deviceScaleFactor], [412, 915, 2.625])
  assert.deepEqual([byId.ipad.width, byId.ipad.height, byId.ipad.deviceScaleFactor], [820, 1180, 2])
  assert.deepEqual([byId.laptop.width, byId.laptop.height, byId.laptop.deviceScaleFactor], [1440, 900, 2])
  assert.deepEqual([byId.desktop.width, byId.desktop.height, byId.desktop.deviceScaleFactor], [1920, 1080, 1])
})

test('scaleToFit shrinks to the pane and never enlarges', () => {
  assert.equal(scaleToFit({ width: 1000, height: 500 }, { width: 500, height: 500 }), 0.5)
  assert.equal(scaleToFit({ width: 1000, height: 1000 }, { width: 500, height: 250 }), 0.25)
  assert.equal(scaleToFit({ width: 400, height: 300 }, { width: 800, height: 600 }), 1)
  assert.equal(scaleToFit({ width: 400, height: 300 }, { width: 0, height: 0 }), 1)
})

test('the browser partition is persistent and distinct from the preview ones', () => {
  assert.equal(BROWSER_PARTITION, 'persist:pi-browser')
})
