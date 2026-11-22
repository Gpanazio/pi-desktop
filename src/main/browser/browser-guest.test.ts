import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_PARTITION } from '../../shared/browser'
import { HTML_PREVIEW_PARTITION, PDF_PREVIEW_PARTITION } from '../../shared/preview-partitions'
import {
  applyBrowserGuestPreferences,
  decideWindowOpen,
  isBrowserGuestSrcAllowed,
  isBrowserPermissionAllowed,
  shouldBlockGuestNavigation,
  uniqueDownloadName,
  webviewGuestKind,
  type BrowserGuestWebPreferences,
} from './browser-guest'

test('will-attach-webview routing: browser partition, preview partitions, unknown partitions', () => {
  assert.equal(webviewGuestKind(BROWSER_PARTITION), 'browser')
  assert.equal(webviewGuestKind(HTML_PREVIEW_PARTITION), 'preview')
  assert.equal(webviewGuestKind(PDF_PREVIEW_PARTITION), 'preview')
  // Unknown or missing partitions keep falling under the preview rules.
  assert.equal(webviewGuestKind('persist:something-else'), 'preview')
  assert.equal(webviewGuestKind('pi-browser'), 'preview')
  assert.equal(webviewGuestKind(''), 'preview')
  assert.equal(webviewGuestKind(undefined), 'preview')
})

test('a browser guest gets the sandbox on, no Node, no preload, scripts on and no plugins', () => {
  const preferences: BrowserGuestWebPreferences = {
    preload: '/evil.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    plugins: true,
    javascript: false,
  }
  applyBrowserGuestPreferences(preferences)
  assert.deepEqual(preferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    plugins: false,
    javascript: true,
  })
})

test('a browser guest loads web pages and never local files', () => {
  assert.equal(isBrowserGuestSrcAllowed('https://example.com'), true)
  assert.equal(isBrowserGuestSrcAllowed('http://localhost:3000/x'), true)
  assert.equal(isBrowserGuestSrcAllowed('about:blank'), true)
  assert.equal(isBrowserGuestSrcAllowed(''), true)
  assert.equal(isBrowserGuestSrcAllowed('file:///etc/passwd'), false)
  assert.equal(isBrowserGuestSrcAllowed('javascript:alert(1)'), false)
})

test('a popup with window features opens as a real window, a plain open loads in the panel', () => {
  assert.equal(decideWindowOpen({ url: 'https://accounts.example.com/oauth', disposition: 'new-window' }), 'popup')
  assert.equal(decideWindowOpen({ url: 'about:blank', disposition: 'new-window' }), 'popup')
  assert.equal(decideWindowOpen({ url: 'https://example.com', disposition: 'foreground-tab' }), 'same-panel')
  assert.equal(decideWindowOpen({ url: 'https://example.com', disposition: 'background-tab' }), 'same-panel')
  assert.equal(decideWindowOpen({ url: 'about:blank', disposition: 'foreground-tab' }), 'deny')
  assert.equal(decideWindowOpen({ url: 'file:///etc/passwd', disposition: 'new-window' }), 'deny')
  assert.equal(decideWindowOpen({ url: 'javascript:alert(1)', disposition: 'foreground-tab' }), 'deny')
})

test('camera, microphone, notifications, location, clipboard and fullscreen are granted; the rest is not', () => {
  for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']) {
    assert.equal(isBrowserPermissionAllowed(permission), true, permission)
  }
  for (const permission of ['openExternal', 'usb', 'hid', 'serial', 'midiSysex', 'unknown']) {
    assert.equal(isBrowserPermissionAllowed(permission), false, permission)
  }
})

test('a download never overwrites a file in Downloads', () => {
  const taken = new Set(['report.pdf', 'report (1).pdf', 'notes'])
  const exists = (name: string): boolean => taken.has(name)
  assert.equal(uniqueDownloadName('fresh.zip', exists), 'fresh.zip')
  assert.equal(uniqueDownloadName('report.pdf', exists), 'report (2).pdf')
  assert.equal(uniqueDownloadName('notes', exists), 'notes (1)')
  assert.equal(uniqueDownloadName('../../etc/passwd', exists), '_.._etc_passwd')
  assert.equal(uniqueDownloadName('', exists), 'download')
})

test('the global will-navigate guard stops previews only, never the browser panel', () => {
  const web = 'https://example.com/learn-more'
  // Untrusted or no workspace: a preview stays on its file, the browser panel goes anywhere.
  assert.equal(shouldBlockGuestNavigation({ isBrowserGuest: false, url: web, workspaceTrusted: false }), true)
  assert.equal(shouldBlockGuestNavigation({ isBrowserGuest: false, url: 'file:///tmp/a.html', workspaceTrusted: false }), false)
  assert.equal(shouldBlockGuestNavigation({ isBrowserGuest: true, url: web, workspaceTrusted: false }), false)
  // Trusted workspace: previews may navigate freely, as before.
  assert.equal(shouldBlockGuestNavigation({ isBrowserGuest: false, url: web, workspaceTrusted: true }), false)
})
