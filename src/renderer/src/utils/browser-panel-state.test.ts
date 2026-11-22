import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_LIVE_BROWSER_SESSIONS, NO_BROWSER_SESSION_KEY, browserPanelId, migrateBrowserSession, noBrowserSessionKey, nextLiveBrowserSessions, patchBrowserSession, stableRenderOrder } from './browser-panel-state'

const open = (...keys: string[]): ReadonlySet<string> => new Set(keys)

test('the session on screen joins the live ones, most recent last', () => {
  assert.deepEqual(nextLiveBrowserSessions([], 'a', open('a')), ['a'])
  assert.deepEqual(nextLiveBrowserSessions(['a'], 'b', open('a', 'b')), ['a', 'b'])
  assert.deepEqual(nextLiveBrowserSessions(['a', 'b'], 'a', open('a', 'b')), ['b', 'a'])
})

test('switching to a session without a browser keeps the others alive', () => {
  assert.deepEqual(nextLiveBrowserSessions(['a', 'b'], 'c', open('a', 'b')), ['a', 'b'])
})

test('a session whose panel was closed is dropped', () => {
  assert.deepEqual(nextLiveBrowserSessions(['a', 'b'], 'b', open('b')), ['b'])
})

test('past three the least recently shown is unmounted', () => {
  assert.equal(MAX_LIVE_BROWSER_SESSIONS, 3)
  let live: string[] = []
  const all = open('a', 'b', 'c', 'd')
  for (const key of ['a', 'b', 'c']) live = nextLiveBrowserSessions(live, key, all)
  assert.deepEqual(live, ['a', 'b', 'c'])
  live = nextLiveBrowserSessions(live, 'd', all)
  assert.deepEqual(live, ['b', 'c', 'd'], 'a is the oldest')
  // Going back to b makes c the oldest.
  live = nextLiveBrowserSessions(live, 'b', all)
  live = nextLiveBrowserSessions(live, 'a', all)
  assert.deepEqual(live, ['d', 'b', 'a'])
})

test('the session on screen is never the one dropped, and the call is stable when repeated', () => {
  const live = nextLiveBrowserSessions(['a', 'b', 'c'], 'a', open('a', 'b', 'c'), 1)
  assert.deepEqual(live, ['a'])
  assert.deepEqual(nextLiveBrowserSessions(live, 'a', open('a')), live)
})

test('passing through the no-session key never pushes a real session out', () => {
  const none = NO_BROWSER_SESSION_KEY
  const all = open('a', 'b', 'c', none)
  let live = nextLiveBrowserSessions([], 'a', all)
  live = nextLiveBrowserSessions(live, 'b', all)
  live = nextLiveBrowserSessions(live, 'c', all)
  assert.deepEqual(live, ['a', 'b', 'c'])
  // A session load reads the active key as no-session for a moment.
  const transient = nextLiveBrowserSessions(live, none, all)
  assert.deepEqual(transient, [none, 'a', 'b', 'c'])
  // And back: the real session returns, the order of the others is kept.
  assert.deepEqual(nextLiveBrowserSessions(transient, 'a', all), [none, 'b', 'c', 'a'])
  // A no-session whose browser is closed is not kept.
  assert.deepEqual(nextLiveBrowserSessions(live, none, open('a', 'b', 'c')), ['a', 'b', 'c'])
})

test('the render order ignores the LRU order, so showing a session never moves another panel', () => {
  assert.deepEqual(stableRenderOrder([], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(stableRenderOrder(['a', 'b'], ['b', 'a']), ['a', 'b'])
  assert.deepEqual(stableRenderOrder(['a', 'b', 'c'], ['c', 'b', 'd']), ['b', 'c', 'd'])
})

test('a panel opened before the first prompt moves to the runtime id and keeps its panel id, so the page is not reloaded', () => {
  let sessions = patchBrowserSession({}, NO_BROWSER_SESSION_KEY, { open: true, url: 'http://localhost:8000/', width: 600 })
  const panelId = browserPanelId(sessions, NO_BROWSER_SESSION_KEY)
  sessions = patchBrowserSession(sessions, 'other', { open: true })
  const moved = migrateBrowserSession(sessions, 'runtime-1')
  assert.equal(moved[NO_BROWSER_SESSION_KEY], undefined)
  assert.equal(moved['runtime-1'].open, true)
  assert.equal(moved['runtime-1'].url, 'http://localhost:8000/')
  assert.equal(moved['runtime-1'].width, 600)
  assert.equal(browserPanelId(moved, 'runtime-1'), panelId)
  assert.equal(moved.other, sessions.other)
  // Moving again, or with nothing to move, changes nothing.
  assert.equal(migrateBrowserSession(moved, 'runtime-1'), moved)
  const empty = {}
  assert.equal(migrateBrowserSession(empty, 'runtime-1'), empty)
})

test('the next empty chat that opens a panel gets a panel id of its own, apart from the migrated one', () => {
  const first = patchBrowserSession({}, NO_BROWSER_SESSION_KEY, { open: true })
  const moved = migrateBrowserSession(first, 'runtime-1')
  const second = patchBrowserSession(moved, NO_BROWSER_SESSION_KEY, { open: true })
  assert.notEqual(browserPanelId(second, NO_BROWSER_SESSION_KEY), browserPanelId(second, 'runtime-1'))
})

test('a runtime that already has an open panel keeps it', () => {
  const sessions = patchBrowserSession(patchBrowserSession({}, NO_BROWSER_SESSION_KEY, { open: true }), 'runtime-1', { open: true, url: 'http://own/' })
  assert.equal(migrateBrowserSession(sessions, 'runtime-1'), sessions)
})

test('each workspace has its own empty-chat key, and a runtime adopts only its own workspace panel', () => {
  const a = noBrowserSessionKey('ws-a')
  const b = noBrowserSessionKey('ws-b')
  assert.notEqual(a, b)
  const sessions = patchBrowserSession({}, a, { open: true, url: 'http://a/' })
  // The runtime auto-created for workspace B must not take workspace A's browser.
  assert.equal(migrateBrowserSession(sessions, 'runtime-b', 'ws-b'), sessions)
  const moved = migrateBrowserSession(sessions, 'runtime-a', 'ws-a')
  assert.equal(moved[a], undefined)
  assert.equal(moved['runtime-a'].url, 'http://a/')
})

test('workspace no-session keys never count in the LRU, and stay first', () => {
  const a = noBrowserSessionKey('ws-a')
  const all = open('x', 'y', a)
  const live = nextLiveBrowserSessions(nextLiveBrowserSessions([], 'x', all), 'y', all)
  assert.deepEqual(live, ['x', 'y'])
  assert.deepEqual(nextLiveBrowserSessions(live, a, all), [a, 'x', 'y'])
  assert.deepEqual(nextLiveBrowserSessions(live, a, open('x', 'y')), ['x', 'y'])
})
