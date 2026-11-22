import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBashBackgroundText, backgroundSummary, canMoveToBackground, parseBashBackground, soleRunningBashId } from './bash-background'

test('button shows only for a running bash on the pi engine', () => {
  assert.equal(canMoveToBackground({ name: 'bash', isExecuting: true }, 'pi'), true)
  assert.equal(canMoveToBackground({ name: 'bash', isExecuting: false }, 'pi'), false)
  assert.equal(canMoveToBackground({ name: 'bash', isExecuting: true }, 'omp'), false)
  assert.equal(canMoveToBackground({ name: 'bash', isExecuting: true }, null), false)
  assert.equal(canMoveToBackground({ name: 'read', isExecuting: true }, 'pi'), false)
})

test('sole running bash is found only when exactly one runs', () => {
  const calls: Array<[string, { name: string; isExecuting: boolean }]> = [
    ['a', { name: 'read', isExecuting: true }],
    ['b', { name: 'bash', isExecuting: true }],
    ['c', { name: 'bash', isExecuting: false }],
  ]
  assert.equal(soleRunningBashId(calls), 'b')
  assert.equal(soleRunningBashId([...calls, ['d', { name: 'bash', isExecuting: true }]]), null)
  assert.equal(soleRunningBashId([]), null)
})

test('parses details.background and rejects anything else', () => {
  const bg = parseBashBackground({ background: { processId: 'p3', name: 'loop', pid: 42, elapsedSeconds: 5, manual: true } })
  assert.deepEqual(bg, { processId: 'p3', pid: 42, name: 'loop', manual: true })
  assert.equal(parseBashBackground({ background: { processId: 7 } })?.processId, '7')
  assert.equal(parseBashBackground({ background: { processId: 'p', manual: false } })?.manual, false)
  assert.equal(parseBashBackground({}), null)
  assert.equal(parseBashBackground(undefined), null)
  assert.equal(parseBashBackground({ background: { pid: 1 } }), null)
})

test('summary names id and pid', () => {
  assert.equal(backgroundSummary({ processId: 'p3', pid: 42, manual: true }), '#p3 · pid 42')
  assert.equal(backgroundSummary({ processId: 'p3', manual: false }), '#p3')
})

test('recovers the process from the result text of a reloaded session', () => {
  const text = 'Moved to background by the user after 12s: process p3 "for i" (pid 4242). It keeps running; nothing was restarted.'
  assert.deepEqual(parseBashBackgroundText(text), { processId: 'p3', pid: 4242, manual: true })
  assert.equal(parseBashBackgroundText('Command still running after 30s; moved to background as process p9 "x" (pid 7). It keeps')?.manual, false)
  assert.equal(parseBashBackgroundText('t1\nt2'), null)
  assert.equal(parseBashBackgroundText(undefined), null)
})
