// The marks of one session and whether it is in mark mode. They belong to the
// session, not to the open panel: closing the panel or switching to another
// session keeps them, and the panel puts them back when it opens again. The
// panel's toolbar, the page overlay and the agent tools all read this store.

import type { BrowserMark, BrowserMarkDraft, BrowserMarkPick, BrowserMarksSnapshot } from '../../shared/browser'
import { clipText, MARK_HTML_MAX, MARK_NOTE_MAX, MARK_TEXT_MAX } from '../../shared/browser-marks'

type StoreListener = () => void
type ChangeListener = (sessionKey: string, snapshot: BrowserMarksSnapshot) => void
type PickListener = (sessionKey: string, pick: BrowserMarkPick) => void

const stores = new Map<string, MarkStore>()
const changeListeners = new Set<ChangeListener>()
const pickListeners = new Set<PickListener>()

function guard(call: () => void): void {
  try {
    call()
  } catch {
    // A broken subscriber must not break the others.
  }
}

export class MarkStore {
  private marks: BrowserMark[] = []
  private nextId = 1
  private mode = false
  private readonly subscribers = new Set<StoreListener>()

  constructor(public sessionKey: string) {}

  list(): BrowserMark[] {
    return this.marks.map((mark) => ({ ...mark, rect: { ...mark.rect } }))
  }

  get markMode(): boolean {
    return this.mode
  }

  snapshot(): BrowserMarksSnapshot {
    return { marks: this.list(), markMode: this.mode }
  }

  add(mark: Omit<BrowserMark, 'id' | 'createdAt'>): BrowserMark {
    const note = mark.note === undefined ? '' : clipText(mark.note, MARK_NOTE_MAX)
    const created: BrowserMark = {
      ...mark,
      text: clipText(mark.text, MARK_TEXT_MAX),
      html: clipText(mark.html, MARK_HTML_MAX),
      rect: { ...mark.rect },
      id: this.nextId++,
      createdAt: Date.now(),
    }
    if (note !== '') created.note = note
    else delete created.note
    this.marks.push(created)
    this.changed()
    return { ...created, rect: { ...created.rect } }
  }

  /** Set a note (an empty one removes it). False when the mark is gone. */
  updateNote(id: number, note: string | null): boolean {
    const mark = this.marks.find((candidate) => candidate.id === id)
    if (!mark) return false
    const clean = note === null ? '' : clipText(note, MARK_NOTE_MAX)
    if (clean !== '') mark.note = clean
    else delete mark.note
    this.changed()
    return true
  }

  remove(id: number): void {
    const before = this.marks.length
    this.marks = this.marks.filter((mark) => mark.id !== id)
    if (this.marks.length !== before) this.changed()
  }

  clear(): void {
    if (this.marks.length === 0) return
    this.marks = []
    this.changed()
  }

  /** Mark these as sent with a prompt. Marks already sent stay as they are. */
  markSent(ids: readonly number[]): void {
    let touched = false
    for (const mark of this.marks) {
      if (ids.includes(mark.id) && mark.sent !== true) {
        mark.sent = true
        touched = true
      }
    }
    if (touched) this.changed()
  }

  setMode(on: boolean): void {
    if (this.mode === on) return
    this.mode = on
    this.changed()
  }

  /** The person clicked an element in mark mode. A plain click ends the mode; Shift keeps it. */
  pick(draft: BrowserMarkDraft, keepMode: boolean): void {
    if (!keepMode) this.setMode(false)
    for (const listener of [...pickListeners]) guard(() => listener(this.sessionKey, { draft, keepMode }))
  }

  subscribe(listener: StoreListener): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private changed(): void {
    for (const listener of [...this.subscribers]) guard(listener)
    const snapshot = this.snapshot()
    for (const listener of [...changeListeners]) guard(() => listener(this.sessionKey, snapshot))
  }
}

export function getMarkStore(sessionKey: string): MarkStore {
  let store = stores.get(sessionKey)
  if (!store) {
    store = new MarkStore(sessionKey)
    stores.set(sessionKey, store)
  }
  return store
}

/**
 * Moves the marks of one session key to another (a chat with no runtime yet gets its runtime id).
 * Refuses when the target already holds marks of its own.
 */
export function renameMarkStore(from: string, to: string): boolean {
  const store = stores.get(from)
  if (!store || from === to) return false
  const existing = stores.get(to)
  if (existing && existing.list().length > 0) return false
  stores.delete(from)
  store.sessionKey = to
  stores.set(to, store)
  return true
}

export function onMarksChange(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function onMarkPick(listener: PickListener): () => void {
  pickListeners.add(listener)
  return () => {
    pickListeners.delete(listener)
  }
}
