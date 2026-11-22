import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import type { ActionHandle } from './browser-actions'
import { startBrowserBridge, type BrowserBridge } from './browser-bridge'

const SECRET = 'test-secret'

function createHmacToken(sessionKey: string, secret = SECRET): string {
  return `${Buffer.from(sessionKey).toString('base64url')}.${createHmac('sha256', secret).update(sessionKey).digest('hex')}`
}

function fakeBrowser(log: string[]): ActionHandle {
  const state = {
    sessionKey: 's1',
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: null,
    paneSize: { width: 800, height: 600 },
  }
  return {
    getState: () => state,
    navigate: async (url: string) => {
      log.push(`navigate ${url}`)
    },
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    setViewport: async () => {},
    screenshot: async () => ({ mimeType: 'image/png', data: '', width: 1, height: 1 }),
    cdp: async <T>() => ({}) as T,
    getMarks: () => [
      { id: 1, selector: 'a', text: '', html: '', rect: { x: 0, y: 0, width: 1, height: 1 }, url: '', createdAt: 0 },
    ],
    getConsole: () => [],
  }
}

async function withBridge(run: (bridge: BrowserBridge, log: string[]) => Promise<void>): Promise<void> {
  const log: string[] = []
  const browser = fakeBrowser(log)
  const bridge = await startBrowserBridge({ secret: SECRET, getBrowser: (key) => (key === 's1' ? browser : null) })
  try {
    await run(bridge, log)
  } finally {
    await bridge.close()
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })
const auth = bearer(createHmacToken('s1'))

/** fetch cannot send a chosen Host header, so the Host and Origin cases use node:http. */
function rawRequest(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('the bridge listens on loopback only and hands a session its three variables', async () => {
  await withBridge(async (bridge) => {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual(bridge.envFor('rt-9'), {
      PI_DESKTOP_BROWSER_URL: bridge.url,
      PI_DESKTOP_BROWSER_TOKEN: createHmacToken('rt-9'),
      PI_DESKTOP_SESSION_KEY: 'rt-9',
    })
  })
})

test('a request without the token is 401, and one with the wrong token too', async () => {
  await withBridge(async (bridge) => {
    assert.equal((await fetch(`${bridge.url}/state?session=s1`)).status, 401)
    assert.equal((await fetch(`${bridge.url}/state?session=s1`, { headers: { Authorization: 'Bearer nope' } })).status, 401)
    assert.equal((await fetch(`${bridge.url}/state?session=s1`, { headers: { Authorization: createHmacToken('s1') } })).status, 401)
    assert.equal((await fetch(`${bridge.url}/action`, { method: 'POST', body: '{}' })).status, 401)
  })
})

test('a forged token is 401: another secret, a swapped session, a tampered mac', async () => {
  await withBridge(async (bridge) => {
    const get = async (token: string): Promise<number> => (await fetch(`${bridge.url}/state`, { headers: bearer(token) })).status
    assert.equal(await get(createHmacToken('s1', 'other-secret')), 401)
    const [, mac] = createHmacToken('s1').split('.')
    assert.equal(await get(`${Buffer.from('s2').toString('base64url')}.${mac}`), 401)
    assert.equal(await get(`${Buffer.from('s1').toString('base64url')}.${'0'.repeat(64)}`), 401)
    assert.equal(await get(bridge.tokenFor('s1')), 200)
  })
})

test('a session token cannot act on another session, by query or by body', async () => {
  await withBridge(async (bridge, log) => {
    assert.equal((await fetch(`${bridge.url}/state?session=s2`, { headers: auth })).status, 403)
    const response = await fetch(`${bridge.url}/action`, { method: 'POST', headers: auth, body: JSON.stringify({ session: 's2', action: 'navigate', params: { url: 'https://example.test/x' } }) })
    assert.equal(response.status, 403)
    assert.deepEqual(log, [])
    // Omitting the session is fine: the token names it.
    const own = await fetch(`${bridge.url}/action`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'reload' }) })
    assert.equal(own.status, 200)
  })
})

test('the transient no-session keys are unreachable even with a valid token', async () => {
  await withBridge(async (bridge) => {
    for (const key of ['no-session', 'no-session:ws-1']) {
      const headers = bearer(bridge.tokenFor(key))
      assert.equal((await fetch(`${bridge.url}/state?session=${key}`, { headers })).status, 403)
      assert.equal((await fetch(`${bridge.url}/state`, { headers })).status, 403)
      assert.equal((await fetch(`${bridge.url}/action`, { method: 'POST', headers, body: JSON.stringify({ session: key, action: 'reload' }) })).status, 403)
    }
  })
})

test('a foreign Host or any Origin is 403, even with the right token', async () => {
  await withBridge(async (bridge) => {
    const base = { ...auth }
    assert.equal((await rawRequest(bridge.port, '/state?session=s1', { ...base, Host: 'evil.example' })).status, 403)
    assert.equal((await rawRequest(bridge.port, '/state?session=s1', { ...base, Host: `evil.example:${bridge.port}` })).status, 403)
    assert.equal((await rawRequest(bridge.port, '/state?session=s1', { ...base, Host: `127.0.0.1:${bridge.port}`, Origin: 'https://evil.example' })).status, 403)
    // The check precedes the token: a rebound page learns nothing about it.
    assert.equal((await rawRequest(bridge.port, '/state?session=s1', { Host: 'evil.example' })).status, 403)
    assert.equal((await rawRequest(bridge.port, '/state?session=s1', { ...base, Host: `localhost:${bridge.port}` })).status, 200)
  })
})

test('GET /state says whether the panel is open for the session', async () => {
  await withBridge(async (bridge) => {
    const open = (await (await fetch(`${bridge.url}/state?session=s1`, { headers: auth })).json()) as { open: boolean; state: { title: string }; marks: number }
    assert.equal(open.open, true)
    assert.equal(open.state.title, 'Example')
    assert.equal(open.marks, 1)
    const closed = await (await fetch(`${bridge.url}/state`, { headers: bearer(bridge.tokenFor('other')) })).json()
    assert.deepEqual(closed, { open: false, marks: 0 })
  })
})

test('POST /action runs the action on that session and answers { ok, text }', async () => {
  await withBridge(async (bridge, log) => {
    const response = await fetch(`${bridge.url}/action`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: 's1', action: 'navigate', params: { url: 'https://example.test/x' } }),
    })
    assert.equal(response.status, 200)
    const result = (await response.json()) as { ok: boolean; text: string }
    assert.equal(result.ok, true)
    assert.match(result.text, /Navigated to https:\/\/example\.test\/x\.\nPage: Example — /)
    assert.deepEqual(log, ['navigate https://example.test/x'])
  })
})

test('an action on a session with no panel answers ok:false instead of failing', async () => {
  await withBridge(async (bridge) => {
    const response = await fetch(`${bridge.url}/action`, {
      method: 'POST',
      headers: bearer(bridge.tokenFor('other')),
      body: JSON.stringify({ session: 'other', action: 'reload' }),
    })
    const result = (await response.json()) as { ok: boolean; text: string }
    assert.equal(result.ok, false)
    assert.match(result.text, /panel is closed/)
  })
})

test('bad bodies and unknown routes are refused', async () => {
  await withBridge(async (bridge) => {
    assert.equal((await fetch(`${bridge.url}/action`, { method: 'POST', headers: auth, body: 'not json' })).status, 400)
    assert.equal((await fetch(`${bridge.url}/action`, { method: 'POST', headers: auth, body: '{"session":"s1"}' })).status, 400)
    assert.equal((await fetch(`${bridge.url}/action`, { method: 'POST', headers: auth, body: '{}' })).status, 400)
    assert.equal((await fetch(`${bridge.url}/action`, { headers: auth })).status, 405)
    assert.equal((await fetch(`${bridge.url}/nope`, { headers: auth })).status, 404)
  })
})
