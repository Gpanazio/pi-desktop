import assert from 'node:assert/strict'
import test from 'node:test'
import { getMarkStore, onMarkPick, onMarksChange, renameMarkStore } from './browser-mark-store'

let counter = 0
const key = (): string => `marks-${++counter}`
const draft = { selector: 'h1', text: 'Hi', html: '<h1>Hi</h1>', rect: { x: 1, y: 2, width: 3, height: 4 }, url: 'https://example.com/' }

test('marks get ids and a clipped text, html and note', () => {
  const store = getMarkStore(key())
  const added = store.add({ ...draft, text: 'a'.repeat(500), html: 'b'.repeat(900), note: '  fix   this ' })
  assert.equal(added.id, 1)
  assert.equal(added.text.length, 200)
  assert.equal(added.html.length, 600)
  assert.equal(added.note, 'fix this')
  assert.equal(store.add(draft).id, 2)
})

test('marks outlive the panel: the same session key gives the same store', () => {
  const sessionKey = key()
  getMarkStore(sessionKey).add(draft)
  assert.equal(getMarkStore(sessionKey).list().length, 1)
})

test('a sent mark stays in the list, flagged, and is not flagged twice', () => {
  const store = getMarkStore(key())
  const a = store.add(draft)
  const b = store.add(draft)
  let changes = 0
  store.subscribe(() => changes++)
  store.markSent([a.id])
  store.markSent([a.id])
  assert.equal(changes, 1)
  assert.deepEqual(store.list().map((mark) => mark.sent === true), [true, false])
  store.remove(b.id)
  store.clear()
  assert.deepEqual(store.list(), [])
})

test('a note can be edited and cleared', () => {
  const store = getMarkStore(key())
  const added = store.add(draft)
  assert.equal(store.updateNote(added.id, 'trocar texto'), true)
  assert.equal(store.list()[0].note, 'trocar texto')
  store.updateNote(added.id, '  ')
  assert.equal('note' in store.list()[0], false)
  assert.equal(store.updateNote(999, 'x'), false)
})

test('a plain pick ends mark mode, a Shift pick keeps it', () => {
  const sessionKey = key()
  const store = getMarkStore(sessionKey)
  const picks: boolean[] = []
  const off = onMarkPick((k, pick) => {
    if (k === sessionKey) picks.push(pick.keepMode)
  })
  store.setMode(true)
  store.pick(draft, true)
  assert.equal(store.markMode, true)
  store.pick(draft, false)
  assert.equal(store.markMode, false)
  assert.deepEqual(picks, [true, false])
  off()
})

test('changes reach the global listener with the session key and a snapshot', () => {
  const sessionKey = key()
  const seen: Array<{ marks: number; mode: boolean }> = []
  const off = onMarksChange((k, snapshot) => {
    if (k === sessionKey) seen.push({ marks: snapshot.marks.length, mode: snapshot.markMode })
  })
  const store = getMarkStore(sessionKey)
  store.setMode(true)
  store.add(draft)
  off()
  assert.deepEqual(seen, [{ marks: 0, mode: true }, { marks: 1, mode: true }])
})

test('renaming a store moves its marks and later changes report the new key; a target with marks of its own refuses', () => {
  const from = key()
  const to = key()
  const store = getMarkStore(from)
  store.add(draft)
  const seen: string[] = []
  const off = onMarksChange((sessionKey) => seen.push(sessionKey))
  assert.equal(renameMarkStore(from, to), true)
  store.add(draft)
  off()
  assert.deepEqual(seen, [to])
  assert.equal(getMarkStore(to), store)
  assert.equal(getMarkStore(to).list().length, 2)
  assert.equal(getMarkStore(from).list().length, 0)
  const busy = key()
  getMarkStore(busy).add(draft)
  const spare = key()
  getMarkStore(spare).add(draft)
  assert.equal(renameMarkStore(spare, busy), false)
  assert.equal(renameMarkStore('never-existed', key()), false)
})
