import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserMark } from '../../../shared/browser'
import { attachBrowserMarks, confirmBrowserMarksSent, type BrowserMarksSendDeps } from './browser-marks-send'

function mark(id: number, patch: Partial<BrowserMark> = {}): BrowserMark {
  return {
    id,
    selector: `s${id}`,
    text: `t${id}`,
    html: `<p>${id}</p>`,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    url: 'https://example.com/',
    createdAt: 1,
    ...patch,
  }
}

function deps(marks: BrowserMark[], extra: Partial<BrowserMarksSendDeps> = {}) {
  const sent: number[][] = []
  const captured: number[][] = []
  const value: BrowserMarksSendDeps = {
    getMarks: async () => marks,
    captureWithMarks: async (pending) => {
      captured.push(pending.map((m) => m.id))
      return { mimeType: 'image/png', data: 'AAAA' }
    },
    ...extra,
  }
  return { value, sent, captured }
}

test('pending marks go at the end of the message with a picture, and are not flagged sent by attaching alone', async () => {
  const { value, sent, captured } = deps([mark(1), mark(2)])
  const result = await attachBrowserMarks('fix these', undefined, value)
  assert.ok(result.message.startsWith('fix these\n\n<browser_marks url="https://example.com/" content="untrusted">\nNote: '))
  assert.ok(result.message.endsWith('</browser_marks>'))
  assert.equal(result.options?.images?.length, 1)
  assert.equal(result.options?.attachments?.[0].name, 'browser-marks.png')
  assert.deepEqual(result.sentIds, [1, 2])
  assert.deepEqual(sent, [], 'nothing is flagged before the send is confirmed')
  assert.deepEqual(captured, [[1, 2]])
})

test('marks already sent are not sent again, but pending ones keep their badge number', async () => {
  const { value, sent } = deps([mark(1, { sent: true }), mark(2)])
  const result = await attachBrowserMarks('go', undefined, value)
  assert.ok(!result.message.includes('s1'))
  assert.ok(result.message.includes('2. s2'))
  assert.deepEqual(result.sentIds, [2])
  assert.deepEqual(sent, [])
})

test('with nothing pending the prompt is untouched and nothing is captured', async () => {
  const { value, sent, captured } = deps([mark(1, { sent: true })])
  const options = { images: [] }
  const result = await attachBrowserMarks('hello', options, value)
  assert.equal(result.message, 'hello')
  assert.equal(result.options, options)
  assert.deepEqual([sent, captured], [[], []])
})

test('images already on the prompt stay; the picture is added after them', async () => {
  const { value } = deps([mark(1)])
  const result = await attachBrowserMarks('x', { images: [{ type: 'image', mimeType: 'image/png', data: 'old' }], attachments: [{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'old' }] }, value)
  assert.deepEqual(result.options?.images?.map((i) => i.data), ['old', 'AAAA'])
  assert.deepEqual(result.options?.attachments?.map((i) => i.name), ['a.png', 'browser-marks.png'])
})

test('a failed capture still sends the marks as text; a failed read leaves the prompt alone', async () => {
  const failing = deps([mark(1)], { captureWithMarks: async () => { throw new Error('closed') } })
  const result = await attachBrowserMarks('x', undefined, failing.value)
  assert.ok(result.message.includes('<browser_marks'))
  assert.equal(result.options, undefined)
  assert.deepEqual(result.sentIds, [1])
  const unreadable = deps([], { getMarks: async () => { throw new Error('boom') } })
  assert.deepEqual(await attachBrowserMarks('x', undefined, unreadable.value), { message: 'x', options: undefined, sentIds: [] })
})

test('a prompt with no text becomes the block alone', async () => {
  const { value } = deps([mark(1)])
  assert.ok((await attachBrowserMarks('  ', undefined, value)).message.startsWith('<browser_marks'))
})

test('the marks are flagged sent once the send is delivered', () => {
  const flagged: number[][] = []
  confirmBrowserMarksSent(true, [1, 2], async (ids) => {
    flagged.push(ids)
  })
  assert.deepEqual(flagged, [[1, 2]])
})

test('a failed or refused send leaves the marks pending, so the next prompt carries them again', async () => {
  const flagged: number[][] = []
  const markSent = async (ids: number[]): Promise<void> => {
    flagged.push(ids)
  }
  confirmBrowserMarksSent(false, [1, 2], markSent)
  confirmBrowserMarksSent(true, [], markSent)
  assert.deepEqual(flagged, [])

  // End to end over the pure pieces: the marks are still pending for the next attach.
  const marks = [mark(1), mark(2)]
  const first = await attachBrowserMarks('go', undefined, deps(marks).value)
  confirmBrowserMarksSent(false, first.sentIds, markSent)
  const retry = await attachBrowserMarks('go again', undefined, deps(marks).value)
  assert.deepEqual(retry.sentIds, [1, 2])
  assert.ok(retry.message.includes('1. s1') && retry.message.includes('2. s2'))
})

test('a rejected markSent does not surface', async () => {
  confirmBrowserMarksSent(true, [1], async () => {
    throw new Error('closed')
  })
  await new Promise((resolve) => setImmediate(resolve))
})

test('a capture that never answers sends the marks as text only and warns', async () => {
  const warnings: string[] = []
  const { value } = deps([mark(1)], { captureWithMarks: () => new Promise(() => {}), timeoutMs: 20, warn: (text) => warnings.push(text) })
  const result = await attachBrowserMarks('fix', undefined, value)
  assert.ok(result.message.includes('<browser_marks'))
  assert.equal(result.options, undefined)
  assert.deepEqual(result.sentIds, [1])
  assert.equal(warnings.length, 1)
})

test('marks that never load leave the prompt as written and warn', async () => {
  const warnings: string[] = []
  const { value } = deps([], { getMarks: () => new Promise(() => {}), timeoutMs: 20, warn: (text) => warnings.push(text) })
  const result = await attachBrowserMarks('fix', undefined, value)
  assert.deepEqual(result, { message: 'fix', options: undefined, sentIds: [] })
  assert.equal(warnings.length, 1)
})
