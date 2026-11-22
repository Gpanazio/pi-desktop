import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_VIEWPORT_PRESETS } from '../../shared/browser'
import { buildChromeUserAgent, buildUserAgentOverride, deviceForViewport } from './browser-user-agent'

test('the macOS user agent is a stable Chrome one without Electron or app tokens', () => {
  const ua = buildChromeUserAgent('150.0.7871.4', 'darwin')
  assert.equal(ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36')
  assert.doesNotMatch(ua, /Electron|pi-desktop|Pi Desktop/i)
})

test('Windows and Linux agents carry their own platform token', () => {
  assert.match(buildChromeUserAgent('150.0.1.2', 'win32'), /\(Windows NT 10\.0; Win64; x64\).*Chrome\/150\.0\.0\.0/)
  assert.match(buildChromeUserAgent('150.0.1.2', 'linux'), /\(X11; Linux x86_64\)/)
})

test('each mobile preset picks its own device and anything non-mobile keeps the desktop agent', () => {
  const byId = (id: string) => BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === id)!
  assert.equal(deviceForViewport(byId('iphone-15')), 'iphone')
  assert.equal(deviceForViewport(byId('pixel-8')), 'android')
  assert.equal(deviceForViewport(byId('ipad')), 'ipad')
  assert.equal(deviceForViewport(byId('laptop')), 'desktop')
  assert.equal(deviceForViewport(byId('desktop')), 'desktop')
  assert.equal(deviceForViewport(null), 'desktop')
  // A typed viewport that is not mobile stays desktop; a typed mobile one is a phone or a tablet by its short side.
  assert.equal(deviceForViewport({ width: 800, height: 600, mobile: false }), 'desktop')
  assert.equal(deviceForViewport({ width: 360, height: 800, mobile: true }), 'iphone')
  assert.equal(deviceForViewport({ width: 900, height: 1200, mobile: true }), 'ipad')
})

test('the iPhone and iPad agents are Safari on iOS 18 with their own platform', () => {
  const phone = buildUserAgentOverride('iphone', '150.0.1.2', 'darwin')
  assert.match(phone.userAgent, /\(iPhone; CPU iPhone OS 18_0 like Mac OS X\).*Version\/18\.0 Mobile\/15E148 Safari/)
  assert.equal(phone.platform, 'iPhone')
  const tablet = buildUserAgentOverride('ipad', '150.0.1.2', 'darwin')
  assert.match(tablet.userAgent, /\(iPad; CPU OS 18_0 like Mac OS X\)/)
  assert.equal(tablet.platform, 'iPad')
  for (const override of [phone, tablet]) assert.doesNotMatch(override.userAgent, /Electron|Chrome\//)
})

test('the Pixel agent is mobile Chrome on Android with matching client-hint metadata', () => {
  const pixel = buildUserAgentOverride('android', '150.0.1.2', 'darwin')
  assert.match(pixel.userAgent, /\(Linux; Android 14; Pixel 8\).*Chrome\/150\.0\.0\.0 Mobile Safari/)
  assert.equal(pixel.userAgentMetadata?.mobile, true)
  assert.equal(pixel.userAgentMetadata?.platform, 'Android')
  assert.equal(pixel.userAgentMetadata?.model, 'Pixel 8')
  assert.ok(pixel.userAgentMetadata?.brands.some((entry) => entry.brand === 'Google Chrome' && entry.version === '150'))
})

test('the desktop override is the panel Chrome agent and carries no device fields', () => {
  assert.deepEqual(buildUserAgentOverride('desktop', '150.0.1.2', 'darwin'), { userAgent: buildChromeUserAgent('150.0.1.2', 'darwin') })
})
