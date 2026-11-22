// What the agent can do in the browser panel. Every action takes the session's
// BrowserHandle (CDP, state, marks) and returns text already shaped for the
// model. The pieces that need no browser (the accessibility snapshot, click
// coordinates, the key map, truncation) are pure functions so tests drive them
// without Electron. The bridge (browser-bridge.ts) is the only caller.

import {
  BROWSER_VIEWPORT_PRESETS,
  clampViewport,
  type BrowserMark,
  type BrowserViewport,
} from '../../shared/browser'
import { numberedMarks, type NumberedMark } from '../../shared/browser-marks'
import type { BrowserHandle } from './browser-controller'

export interface ActionResult {
  ok: boolean
  text: string
  image?: { mimeType: string; data: string }
  /** More images of the same result, after `image` (full-page tiles). */
  images?: Array<{ mimeType: string; data: string }>
}

export type ActionParams = Record<string, unknown>

/** The part of a BrowserHandle the actions use; tests pass a fake. */
export type ActionHandle = Pick<
  BrowserHandle,
  'getState' | 'navigate' | 'goBack' | 'goForward' | 'reload' | 'setViewport' | 'screenshot' | 'cdp' | 'getMarks' | 'getConsole'
> & {
  /** The guest, when there is one to give keyboard focus to; its embedder gets the focus back when the panel is hidden. */
  webContents?: { focus(): void; hostWebContents?: { focus(): void } | null }
  /** False while the panel is hidden in the pool; a missing method counts as visible. */
  isVisible?(): boolean
}

export interface ActionEnv {
  sleep(ms: number): Promise<void>
  now(): number
  /** Tests shorten the limits; the defaults are ACTION_TIMEOUT_MS and EVAL_TIMEOUT_MS. */
  actionTimeoutMs?: number
  evalTimeoutMs?: number
}

const realEnv: ActionEnv = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

export const ACTION_NAMES = [
  'navigate',
  'back',
  'forward',
  'reload',
  'snapshot',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
  'wait',
  'set_viewport',
  'eval',
  'console',
  'get_marks',
] as const
export type ActionName = (typeof ACTION_NAMES)[number]

export const SETTLE_MAX_MS = 3000
export const WAIT_DEFAULT_TIMEOUT_MS = 10_000
export const WAIT_MAX_TIMEOUT_MS = 60_000
export const EVAL_MAX_BYTES = 8 * 1024
/** One action's limit: past it the action answers with an error and the session's queue moves on. */
export const ACTION_TIMEOUT_MS = 30_000
/** `wait` runs for its own timeout; the limit is that plus this. */
export const WAIT_TIMEOUT_GRACE_MS = 5_000
export const EVAL_TIMEOUT_MS = 20_000
export const SCREENSHOT_MAX_DIMENSION = 1600
export const SCREENSHOT_JPEG_QUALITY = 80
/** A full-page capture for the agent: this wide at most, cut into tiles this tall at most, this many at most. */
export const FULL_PAGE_MAX_WIDTH = 1280
export const FULL_PAGE_TILE_HEIGHT = 1600
export const FULL_PAGE_MAX_TILES = 4
/** A capture whose longest side (device pixels) is at most this stays PNG: JPEG would only blur it. */
export const SNAPSHOT_DEFAULT_MAX_NODES = 400
export const SNAPSHOT_HARD_MAX_NODES = 2000
const SNAPSHOT_NAME_MAX = 120
const SNAPSHOT_VALUE_MAX = 80
const CONSOLE_DEFAULT_LIMIT = 50
const CONSOLE_MAX_LIMIT = 500

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Cut text to `maxBytes` of UTF-8 without splitting a character, and say so. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let cut = buffer.subarray(0, maxBytes).toString('utf8')
  if (cut.endsWith('�')) cut = cut.slice(0, -1)
  return `${cut}\n… [truncated: ${buffer.length - Buffer.byteLength(cut, 'utf8')} more bytes]`
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export interface AxValue {
  value?: unknown
}

export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  value?: AxValue
  properties?: Array<{ name: string; value?: AxValue }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'listbox',
  'treeitem',
  'textarea',
  'DisclosureTriangle',
  'PopUpButton',
  'ComboBoxSelect',
  'ColorWell',
])
const TRANSPARENT_ROLES = new Set(['LabelText', 'none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'IframePresentational'])
const NO_REF_ROLES = new Set(['StaticText', 'RootWebArea', 'WebArea', 'text'])
const SHOWN_FLAGS = ['checked', 'pressed', 'expanded', 'selected', 'disabled', 'required', 'focused', 'readonly', 'invalid', 'level'] as const

function axString(value: AxValue | undefined): string {
  const v = value?.value
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

export interface SnapshotResult {
  lines: string[]
  /** ref -> backendDOMNodeId */
  refs: Map<string, number>
  /** nodes that passed the filter, shown or not */
  total: number
  omitted: number
}

interface Included {
  node: AxNode
  role: string
  depth: number
}

function axFlags(node: AxNode, role: string): string {
  const out: string[] = []
  const byName = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]))
  for (const flag of SHOWN_FLAGS) {
    const v = byName.get(flag)
    if (v === undefined || v === false || v === 'false') {
      // expanded=false carries information; the other flags are shown only when set.
      if (flag === 'expanded' && (v === false || v === 'false')) out.push('expanded=false')
      continue
    }
    out.push(v === true || v === 'true' ? flag : `${flag}=${String(v)}`)
  }
  const value = clip(axString(node.value), SNAPSHOT_VALUE_MAX)
  if (value !== '' && role !== 'StaticText') out.push(`value="${value}"`)
  const url = byName.get('url')
  if (role === 'link' && typeof url === 'string' && url !== '') out.push(`href=${clip(url, 160)}`)
  return out.length > 0 ? ` [${out.join(', ')}]` : ''
}

/**
 * A compact, indented outline of the page's accessibility tree. Interactive
 * nodes get refs (e1, e2, ...) that map to the DOM node behind them, so the
 * model can name an element without a selector.
 */
export function buildSnapshot(nodes: AxNode[], options: { interactiveOnly: boolean; maxNodes: number }): SnapshotResult {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes.find((node) => node.parentId === undefined || !byId.has(node.parentId)) ?? nodes[0]
  const included: Included[] = []

  const visit = (node: AxNode, depth: number, parentName: string): void => {
    const role = axString(node.role)
    const name = axString(node.name)
    let shown = false
    if (!node.ignored && role !== '' && !TRANSPARENT_ROLES.has(role)) {
      if (options.interactiveOnly) {
        shown = INTERACTIVE_ROLES.has(role)
      } else if (role === 'StaticText') {
        shown = name.trim() !== '' && clip(name, SNAPSHOT_NAME_MAX) !== clip(parentName, SNAPSHOT_NAME_MAX)
      } else {
        shown = true
      }
    }
    if (shown) included.push({ node, role, depth })
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) visit(child, shown ? depth + 1 : depth, name !== '' ? name : parentName)
    }
  }
  if (root) visit(root, 0, '')

  const shownNodes = included.slice(0, Math.max(1, options.maxNodes))
  const refs = new Map<string, number>()
  const lines: string[] = []
  for (const { node, role, depth } of shownNodes) {
    const name = clip(axString(node.name), SNAPSHOT_NAME_MAX)
    let ref = ''
    if (node.backendDOMNodeId !== undefined && !NO_REF_ROLES.has(role)) {
      const id = `e${refs.size + 1}`
      refs.set(id, node.backendDOMNodeId)
      ref = `[${id}] `
    }
    const label = role === 'RootWebArea' || role === 'WebArea' ? 'page' : role === 'StaticText' ? 'text' : role
    lines.push(`${'  '.repeat(depth)}${ref}${label}${name !== '' ? ` "${name}"` : ''}${axFlags(node, role)}`)
  }
  return { lines, refs, total: included.length, omitted: included.length - shownNodes.length }
}

export interface Point {
  x: number
  y: number
}

function polygonArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

/**
 * Where to click an element from its content quads (CSS px, relative to the
 * layout viewport, which is what Input.dispatchMouseEvent takes, also under
 * device-metrics emulation). The first quad with a visible area wins, clipped
 * to the viewport; the point is the centre of that clipped quad.
 */
export function pointFromQuads(quads: number[][], viewport: { width: number; height: number }): Point | null {
  for (const quad of quads) {
    if (quad.length < 8) continue
    const points: Point[] = []
    for (let i = 0; i < 8; i += 2) {
      points.push({
        x: Math.min(Math.max(quad[i], 0), viewport.width),
        y: Math.min(Math.max(quad[i + 1], 0), viewport.height),
      })
    }
    if (polygonArea(points) < 1) continue
    return {
      x: Math.round((points.reduce((sum, p) => sum + p.x, 0) / 4) * 100) / 100,
      y: Math.round((points.reduce((sum, p) => sum + p.y, 0) / 4) * 100) / 100,
    }
  }
  return null
}

export const MODIFIER_FLAGS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const

export interface KeySpec {
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  /** The character the key types, when it types one. */
  text?: string
  /** Editing commands macOS runs for a shortcut such as Meta+a; a synthetic key event does not trigger them by itself. */
  commands?: string[]
}

interface NamedKey {
  key: string
  code: string
  vk: number
  text?: string
}

const NAMED_KEYS: Record<string, NamedKey> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}
for (let n = 1; n <= 12; n++) NAMED_KEYS[`F${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n }
const NAMED_KEYS_BY_LOWER = new Map(Object.entries(NAMED_KEYS).map(([name, spec]) => [name.toLowerCase(), spec]))

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  ins: 'Insert',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pageup: 'PageUp',
  pgdn: 'PageDown',
  pagedown: 'PageDown',
  spacebar: 'Space',
  ' ': 'Space',
}

const MODIFIER_ALIASES: Record<string, keyof typeof MODIFIER_FLAGS> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
}

// Punctuation on a US layout: [code, windowsVirtualKeyCode, shifted character].
const PUNCTUATION: Record<string, [string, number, string]> = {
  '-': ['Minus', 189, '_'],
  '=': ['Equal', 187, '+'],
  ',': ['Comma', 188, '<'],
  '.': ['Period', 190, '>'],
  '/': ['Slash', 191, '?'],
  ';': ['Semicolon', 186, ':'],
  "'": ['Quote', 222, '"'],
  '[': ['BracketLeft', 219, '{'],
  ']': ['BracketRight', 221, '}'],
  '\\': ['Backslash', 220, '|'],
  '`': ['Backquote', 192, '~'],
}
const SHIFTED_PUNCTUATION = new Map(Object.entries(PUNCTUATION).map(([char, [code, vk, shifted]]) => [shifted, { char, code, vk }]))

// Shifted digits on a US layout: character -> digit.
const SHIFTED_DIGITS = new Map(Object.entries({ ')': 0, '!': 1, '@': 2, '#': 3, $: 4, '%': 5, '^': 6, '&': 7, '*': 8, '(': 9 }))

const MAC_EDIT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }

/**
 * "Enter", "Control+a", "Shift+Tab", "Meta+Shift+ArrowLeft", "A", "!" -> the fields Input.dispatchKeyEvent needs.
 * A capital letter or a shifted symbol carries Shift by itself. On macOS, Meta+a/c/v/x/z (and Control+) add the
 * editing `commands`, because the page only sees them from the native menu path.
 */
export function parseKey(input: string, platform: string = process.platform): KeySpec {
  const combo = input.trim()
  if (combo === '') throw new Error('key is empty')
  let head: string
  let last: string
  if (combo === '+') {
    head = ''
    last = '+'
  } else if (combo.endsWith('++')) {
    head = combo.slice(0, -2)
    last = '+'
  } else if (combo.includes('+')) {
    const cut = combo.lastIndexOf('+')
    head = combo.slice(0, cut)
    last = combo.slice(cut + 1)
  } else {
    head = ''
    last = combo
  }

  let modifiers = 0
  for (const part of head.split('+').filter((p) => p !== '')) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (!modifier) throw new Error(`Unknown modifier "${part}" in key "${input}"`)
    modifiers |= MODIFIER_FLAGS[modifier]
  }
  let shift = (modifiers & MODIFIER_FLAGS.Shift) !== 0
  const commandHeld = (modifiers & (MODIFIER_FLAGS.Control | MODIFIER_FLAGS.Alt | MODIFIER_FLAGS.Meta)) !== 0

  const lower = last.toLowerCase()
  const named = last.length > 1 ? NAMED_KEYS_BY_LOWER.get(KEY_ALIASES[lower]?.toLowerCase() ?? lower) : undefined
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      modifiers,
      ...(named.text !== undefined && !commandHeld ? { text: named.text } : {}),
    }
  }
  if (last === ' ') {
    const space = NAMED_KEYS.Space
    return { key: space.key, code: space.code, windowsVirtualKeyCode: space.vk, modifiers, ...(commandHeld ? {} : { text: ' ' }) }
  }
  if (last.length === 1) {
    if (/[a-z]/i.test(last)) {
      const upper = last.toUpperCase()
      if (last === upper && !commandHeld) {
        shift = true
        modifiers |= MODIFIER_FLAGS.Shift
      }
      const character = shift ? upper : last.toLowerCase()
      const command =
        platform === 'darwin' && (modifiers === MODIFIER_FLAGS.Meta || modifiers === MODIFIER_FLAGS.Control) ? MAC_EDIT_COMMANDS[last.toLowerCase()] : undefined
      return {
        key: character,
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        modifiers,
        ...(commandHeld ? {} : { text: character }),
        ...(command ? { commands: [command] } : {}),
      }
    }
    const shiftedDigit = SHIFTED_DIGITS.get(last)
    if (shiftedDigit !== undefined) {
      return { key: last, code: `Digit${shiftedDigit}`, windowsVirtualKeyCode: 48 + shiftedDigit, modifiers: modifiers | MODIFIER_FLAGS.Shift, ...(commandHeld ? {} : { text: last }) }
    }
    if (/[0-9]/.test(last)) {
      return { key: last, code: `Digit${last}`, windowsVirtualKeyCode: 48 + Number(last), modifiers, ...(commandHeld ? {} : { text: last }) }
    }
    const direct = PUNCTUATION[last]
    if (direct) {
      const character = shift ? direct[2] : last
      return { key: character, code: direct[0], windowsVirtualKeyCode: direct[1], modifiers, ...(commandHeld ? {} : { text: character }) }
    }
    const shifted = SHIFTED_PUNCTUATION.get(last)
    if (shifted) {
      return { key: last, code: shifted.code, windowsVirtualKeyCode: shifted.vk, modifiers: modifiers | MODIFIER_FLAGS.Shift, ...(commandHeld ? {} : { text: last }) }
    }
  }
  throw new Error(`Unknown key "${last}". Use a name like Enter, Tab, Escape, ArrowDown, Backspace, F1 to F12, a single character, or a combination like Control+a.`)
}

// ─── Per-handle state ────────────────────────────────────────────────────────

interface RefState {
  url: string
  refs: Map<string, number>
}

/** Keyed by handle: a closed and reopened panel is a new handle, so its refs start empty. */
const refStates = new WeakMap<object, RefState>()

/** A #hash change keeps the document, so the refs of the snapshot stay valid. */
function withoutFragment(url: string): string {
  const cut = url.indexOf('#')
  return cut === -1 ? url : url.slice(0, cut)
}

/** The refs of the last snapshot, or null when the page changed since (or there was none). */
export function currentRefs(handle: Pick<ActionHandle, 'getState'>): Map<string, number> | null {
  const state = refStates.get(handle)
  if (!state || withoutFragment(state.url) !== withoutFragment(handle.getState().url)) return null
  return state.refs
}

// ─── CDP helpers ─────────────────────────────────────────────────────────────

interface RemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
}

interface EvaluateResult {
  result: RemoteObject
  exceptionDetails?: { text?: string; exception?: RemoteObject }
}

function exceptionText(details: NonNullable<EvaluateResult['exceptionDetails']>): string {
  return details.exception?.description ?? details.exception?.value?.toString() ?? details.text ?? 'Script error'
}

async function evaluateValue<T>(handle: ActionHandle, expression: string): Promise<T> {
  const response = await handle.cdp<EvaluateResult>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 10_000 })
  if (response.exceptionDetails) throw new Error(exceptionText(response.exceptionDetails))
  return response.result.value as T
}

function staleRef(ref: string): Error {
  return new Error(`Ref ${ref} is no longer valid: the page changed since the last browser_snapshot. Call browser_snapshot again.`)
}

/** The DOM object an action targets: a ref of the last snapshot, or a CSS selector. */
async function resolveTarget(handle: ActionHandle, params: ActionParams): Promise<string | null> {
  if (typeof params.ref === 'string' && params.ref !== '') {
    const ref = params.ref
    const refs = currentRefs(handle)
    if (!refs) throw staleRef(ref)
    const backendNodeId = refs.get(ref)
    if (backendNodeId === undefined) throw new Error(`Unknown ref ${ref}. Refs come from the last browser_snapshot.`)
    try {
      const { object } = await handle.cdp<{ object: RemoteObject }>('DOM.resolveNode', { backendNodeId })
      if (object.objectId) return object.objectId
    } catch {
      // The node left the page.
    }
    throw staleRef(ref)
  }
  if (typeof params.selector === 'string' && params.selector !== '') {
    const response = await handle.cdp<EvaluateResult>('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(params.selector)})`,
    })
    if (response.exceptionDetails) throw new Error(`Invalid selector "${params.selector}": ${exceptionText(response.exceptionDetails)}`)
    if (!response.result.objectId) throw new Error(`No element matches selector "${params.selector}".`)
    return response.result.objectId
  }
  return null
}

async function layoutViewport(handle: ActionHandle): Promise<{ width: number; height: number }> {
  const metrics = await handle.cdp<{
    cssLayoutViewport?: { clientWidth: number; clientHeight: number }
    layoutViewport?: { clientWidth: number; clientHeight: number }
  }>('Page.getLayoutMetrics')
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport
  return { width: viewport?.clientWidth ?? 0, height: viewport?.clientHeight ?? 0 }
}

async function centerOf(handle: ActionHandle, objectId: string): Promise<Point> {
  await handle.cdp('DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {})
  const [{ quads }, viewport] = await Promise.all([
    handle.cdp<{ quads: number[][] }>('DOM.getContentQuads', { objectId }),
    layoutViewport(handle),
  ])
  const point = pointFromQuads(quads, viewport)
  if (!point) throw new Error('The element has no visible area (hidden, zero size, or outside the page).')
  return point
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 } as const
type MouseButton = keyof typeof BUTTON_MASK

async function mouseClick(handle: ActionHandle, point: Point, button: MouseButton, clickCount: number): Promise<void> {
  await handle.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  await handle.cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button,
    buttons: BUTTON_MASK[button],
    clickCount,
  })
  await handle.cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
  })
}

/**
 * Text and keys reach the guest only while it holds the window's keyboard
 * focus: with the focus in the app's own composer, Input.insertText lands
 * there instead of in the page.
 */
async function withGuestFocus<T>(handle: ActionHandle, job: () => Promise<T>): Promise<T> {
  // A panel that is hidden in the pool must not keep the keyboard: focus, act, and give the focus back to the app.
  const hidden = handle.isVisible?.() === false
  try {
    handle.webContents?.focus()
  } catch {
    // A guest that is gone fails the CDP call that follows.
  }
  try {
    return await job()
  } finally {
    if (hidden) {
      try {
        handle.webContents?.hostWebContents?.focus()
      } catch {
        // The embedder is gone with the window.
      }
    }
  }
}

async function pressKey(handle: ActionHandle, spec: KeySpec): Promise<void> {
  const base = {
    modifiers: spec.modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
  }
  await handle.cdp('Input.dispatchKeyEvent', {
    type: spec.text !== undefined ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(spec.text !== undefined ? { text: spec.text, unmodifiedText: spec.text } : {}),
    ...(spec.commands ? { commands: spec.commands } : {}),
  })
  await handle.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * Types text as character events sent to the guest's own widget. Input.insertText
 * goes through the window's focused input method, which in a <webview> is the
 * app's composer, so the text would land there instead of in the page.
 */
async function typeText(handle: ActionHandle, text: string): Promise<void> {
  for (const character of text.replace(/\r\n?/g, '\n')) {
    if (character === '\n') {
      await pressKey(handle, parseKey('Enter'))
      continue
    }
    await handle.cdp('Input.dispatchKeyEvent', { type: 'char', text: character, unmodifiedText: character, key: character })
  }
}

/** After an action that can start a navigation: let it begin, then wait for the load, at most 3 s. */
async function settle(handle: ActionHandle, env: ActionEnv): Promise<void> {
  await env.sleep(120)
  const startedAt = env.now()
  while (handle.getState().loading && env.now() - startedAt < SETTLE_MAX_MS) await env.sleep(50)
}

function pageLine(handle: ActionHandle): string {
  const { title, url } = handle.getState()
  return `Page: ${title !== '' ? `${title} — ` : ''}${url}`
}

function done(handle: ActionHandle, text: string, extra: Partial<ActionResult> = {}): ActionResult {
  return { ok: true, text: `${text}\n${pageLine(handle)}`, ...extra }
}

function fail(handle: ActionHandle, message: string): ActionResult {
  return { ok: false, text: `${message}\n${pageLine(handle)}` }
}

function str(params: ActionParams, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function num(params: ActionParams, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bool(params: ActionParams, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}

function describeViewport(viewport: BrowserViewport | null, pane: { width: number; height: number }): string {
  if (!viewport) return `panel ${pane.width}x${pane.height}`
  return `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}${viewport.mobile ? ' mobile' : ''}`
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action = (handle: ActionHandle, params: ActionParams, env: ActionEnv) => Promise<ActionResult>

async function navigateWithin(handle: ActionHandle, url: string, env: ActionEnv): Promise<void> {
  refStates.delete(handle)
  let failure: unknown = null
  const loaded = handle.navigate(url).catch((error: unknown) => {
    failure = error
  })
  // A slow page keeps loading in the panel; the agent hears back after 3 s.
  await Promise.race([loaded, env.sleep(SETTLE_MAX_MS)])
  if (failure) throw failure
}

const actions: Record<ActionName, Action> = {
  async navigate(handle, params, env) {
    const url = str(params, 'url')
    if (!url) return fail(handle, 'navigate needs a url.')
    await navigateWithin(handle, url, env)
    await settle(handle, env)
    return done(handle, `Navigated to ${url}.`)
  },

  async back(handle, _params, env) {
    if (!handle.getState().canGoBack) return fail(handle, 'There is no page to go back to.')
    refStates.delete(handle)
    handle.goBack()
    await settle(handle, env)
    return done(handle, 'Went back.')
  },

  async forward(handle, _params, env) {
    if (!handle.getState().canGoForward) return fail(handle, 'There is no page to go forward to.')
    refStates.delete(handle)
    handle.goForward()
    await settle(handle, env)
    return done(handle, 'Went forward.')
  },

  async reload(handle, _params, env) {
    refStates.delete(handle)
    handle.reload()
    await settle(handle, env)
    return done(handle, 'Reloaded.')
  },

  async snapshot(handle, params) {
    const interactiveOnly = bool(params, 'interactiveOnly') ?? true
    const maxNodes = Math.min(Math.max(Math.round(num(params, 'maxNodes') ?? SNAPSHOT_DEFAULT_MAX_NODES), 1), SNAPSHOT_HARD_MAX_NODES)
    const { nodes } = await handle.cdp<{ nodes: AxNode[] }>('Accessibility.getFullAXTree')
    const snapshot = buildSnapshot(nodes ?? [], { interactiveOnly, maxNodes })
    refStates.set(handle, { url: handle.getState().url, refs: snapshot.refs })
    const body = snapshot.lines.length > 0 ? snapshot.lines.join('\n') : '(nothing to show)'
    const note = snapshot.omitted > 0 ? `\n… ${snapshot.omitted} more nodes omitted (raise maxNodes, or keep interactiveOnly on).` : ''
    const hint = `\nUse the [eN] refs with browser_click, browser_type, browser_scroll. A new snapshot replaces them.${
      interactiveOnly ? ' Only interactive elements are listed; pass interactiveOnly=false to read page text.' : ''
    }`
    return done(handle, `${body}${note}${hint}`)
  },

  async screenshot(handle, params) {
    const fullPage = bool(params, 'fullPage') ?? false
    const withMarks = bool(params, 'withMarks') ?? false
    const marks = withMarks ? handle.getMarks() : []
    if (marks.length > 0) await drawMarks(handle, marks)
    try {
      const shot = await handle.screenshot({
        fullPage,
        // PNG or JPEG is decided on the image that comes back, not on the viewport asked for.
        format: 'auto',
        quality: SCREENSHOT_JPEG_QUALITY,
        maxDimension: SCREENSHOT_MAX_DIMENSION,
        ...(fullPage ? { tiles: { maxWidth: FULL_PAGE_MAX_WIDTH, maxTileHeight: FULL_PAGE_TILE_HEIGHT, maxTiles: FULL_PAGE_MAX_TILES } } : {}),
      })
      const markNote = marks.length > 0 ? `\nMarked elements:\n${numberedMarks(marks).map(markLine).join('\n')}` : ''
      const css = await layoutViewport(handle).catch(() => null)
      if (fullPage && shot.tiles && shot.tiles.length > 0) {
        const [first, ...rest] = shot.tiles
        const covered = shot.coveredCssHeight ?? 0
        const total = shot.totalCssHeight ?? covered
        const rest2 = covered < total ? ` The page is ${total} px tall and was covered down to y=${covered}; use browser_scroll and browser_screenshot for the rest.` : ' The whole page is covered.'
        const text = `Full-page screenshot in ${shot.tiles.length} tile${shot.tiles.length === 1 ? '' : 's'} (${first.width}px wide, top to bottom, up to ${FULL_PAGE_TILE_HEIGHT}px tall each), covering y=0 to y=${covered} CSS px.${rest2}${coordinateNote(first.width, css ? Math.min(css.width, FULL_PAGE_MAX_WIDTH) : null, css)}${markNote}`
        return done(handle, text, {
          image: { mimeType: first.mimeType, data: first.data },
          ...(rest.length > 0 ? { images: rest.map((t) => ({ mimeType: t.mimeType, data: t.data })) } : {}),
        })
      }
      return done(handle, `Screenshot ${shot.width}x${shot.height} image px${fullPage ? ' (full page)' : ''}.${coordinateNote(shot.width, css?.width ?? null, css)}${markNote}`, {
        image: { mimeType: shot.mimeType, data: shot.data },
      })
    } finally {
      if (marks.length > 0) await handle.cdp('Runtime.evaluate', { expression: REMOVE_MARKS_SCRIPT }).catch(() => {})
    }
  },

  async click(handle, params, env) {
    const button = (['left', 'right', 'middle'] as const).find((b) => b === params.button) ?? 'left'
    const clickCount = Math.min(Math.max(Math.round(num(params, 'clickCount') ?? 1), 1), 3)
    const objectId = await resolveTarget(handle, params)
    let point: Point
    let what: string
    if (objectId) {
      point = await centerOf(handle, objectId)
      what = str(params, 'ref') ?? str(params, 'selector') ?? 'element'
    } else {
      const x = num(params, 'x')
      const y = num(params, 'y')
      if (x === undefined || y === undefined) return fail(handle, 'click needs a ref, a selector, or x and y.')
      point = { x, y }
      what = 'point'
    }
    await mouseClick(handle, point, button, clickCount)
    await settle(handle, env)
    return done(handle, `Clicked ${what} at (${point.x}, ${point.y})${clickCount > 1 ? ` x${clickCount}` : ''}${button !== 'left' ? ` with the ${button} button` : ''}.`)
  },

  async type(handle, params, env) {
    const text = str(params, 'text')
    if (text === undefined) return fail(handle, 'type needs text.')
    const objectId = await resolveTarget(handle, params)
    if (objectId) {
      // A real click is what gives the guest's widget the keyboard focus; DOM.focus alone leaves
      // the characters going nowhere. The caret then moves to the end so the text is appended.
      try {
        await mouseClick(handle, await centerOf(handle, objectId), 'left', 1)
      } catch {
        await handle.cdp('DOM.focus', { objectId })
      }
      await handle.cdp('Runtime.callFunctionOn', { objectId, functionDeclaration: CARET_TO_END_SCRIPT }).catch(() => {})
      if (bool(params, 'clear')) {
        await handle.cdp('Runtime.callFunctionOn', { objectId, functionDeclaration: CLEAR_SCRIPT })
      }
    } else {
      // Without a target the text goes to the focused element; typing into nothing would only look like it worked.
      const editable = await evaluateValue<boolean>(handle, EDITABLE_FOCUS_SCRIPT).catch(() => false)
      if (!editable) return fail(handle, 'No text field is focused. Pass a ref or selector to type into, or click the field first.')
      if (bool(params, 'clear')) {
        await handle.cdp('Runtime.evaluate', { expression: `(${CLEAR_SCRIPT}).call(document.activeElement)` })
      }
    }
    await withGuestFocus(handle, async () => {
      await typeText(handle, text)
      if (bool(params, 'submit')) await pressKey(handle, parseKey('Enter'))
    })
    await settle(handle, env)
    return done(handle, `Typed ${JSON.stringify(clip(text, 80))}${bool(params, 'submit') ? ' and pressed Enter' : ''}.`)
  },

  async press(handle, params, env) {
    const key = str(params, 'key')
    if (!key) return fail(handle, 'press needs a key.')
    const spec = parseKey(key)
    await withGuestFocus(handle, () => pressKey(handle, spec))
    await settle(handle, env)
    return done(handle, `Pressed ${key}.`)
  },

  async scroll(handle, params, env) {
    const objectId = await resolveTarget(handle, params)
    if (objectId) {
      await handle.cdp('DOM.scrollIntoViewIfNeeded', { objectId })
    } else {
      const dx = num(params, 'dx') ?? 0
      const dy = num(params, 'dy') ?? 0
      if (dx === 0 && dy === 0) return fail(handle, 'scroll needs dx/dy or a ref.')
      const viewport = await layoutViewport(handle)
      await handle.cdp('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(viewport.width / 2),
        y: Math.round(viewport.height / 2),
        deltaX: dx,
        deltaY: dy,
      })
    }
    await env.sleep(200)
    const position = await evaluateValue<{ x: number; y: number; max: number }>(
      handle,
      '({ x: Math.round(scrollX), y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) })',
    ).catch(() => null)
    return done(handle, position ? `Scrolled. Position y=${position.y} of ${Math.max(position.max, 0)}, x=${position.x}.` : 'Scrolled.')
  },

  async wait(handle, params, env) {
    const timeoutMs = Math.min(Math.max(num(params, 'timeoutMs') ?? WAIT_DEFAULT_TIMEOUT_MS, 100), WAIT_MAX_TIMEOUT_MS)
    const selector = str(params, 'selector')
    const text = str(params, 'text')
    const ms = num(params, 'ms')
    if (selector === undefined && text === undefined) {
      if (ms === undefined) return fail(handle, 'wait needs ms, selector, or text.')
      const waited = Math.min(Math.max(ms, 0), timeoutMs)
      await env.sleep(waited)
      return done(handle, `Waited ${waited} ms.`)
    }
    const condition =
      selector !== undefined
        ? `!!document.querySelector(${JSON.stringify(selector)})`
        : `!!document.body && document.body.innerText.includes(${JSON.stringify(text)})`
    const startedAt = env.now()
    for (;;) {
      if (await evaluateValue<boolean>(handle, condition).catch(() => false)) {
        return done(handle, `Found ${selector !== undefined ? `selector ${selector}` : `text ${JSON.stringify(clip(text ?? '', 60))}`} after ${env.now() - startedAt} ms.`)
      }
      if (env.now() - startedAt >= timeoutMs) {
        return fail(handle, `Timed out after ${timeoutMs} ms waiting for ${selector !== undefined ? `selector ${selector}` : `text ${JSON.stringify(clip(text ?? '', 60))}`}.`)
      }
      await env.sleep(100)
    }
  },

  async set_viewport(handle, params) {
    if (params.reset === true) {
      await handle.setViewport(null)
      const state = handle.getState()
      return done(handle, `Viewport reset to the panel size (${state.paneSize.width}x${state.paneSize.height}).`)
    }
    const presetName = str(params, 'preset')
    let viewport: BrowserViewport
    if (presetName !== undefined) {
      const wanted = presetName.toLowerCase()
      const preset = BROWSER_VIEWPORT_PRESETS.find((p) => p.id === wanted || p.label.toLowerCase() === wanted)
      if (!preset) {
        return fail(handle, `Unknown preset "${presetName}". Presets: ${BROWSER_VIEWPORT_PRESETS.map((p) => p.id).join(', ')}.`)
      }
      viewport = { width: preset.width, height: preset.height, deviceScaleFactor: preset.deviceScaleFactor, mobile: preset.mobile, touch: preset.touch }
    } else {
      const width = num(params, 'width')
      const height = num(params, 'height')
      if (width === undefined || height === undefined) return fail(handle, 'set_viewport needs a preset, width and height, or reset.')
      const mobile = bool(params, 'mobile') ?? false
      viewport = clampViewport({ width, height, deviceScaleFactor: num(params, 'deviceScaleFactor') ?? 1, mobile, touch: mobile })
    }
    await handle.setViewport(viewport)
    return done(handle, `Viewport set to ${describeViewport(handle.getState().viewport, handle.getState().paneSize)}.`)
  },

  async eval(handle, params, env) {
    const expression = str(params, 'expression')
    if (!expression) return fail(handle, 'eval needs an expression.')
    const limit = env.evalTimeoutMs ?? EVAL_TIMEOUT_MS
    const response = await withTimeout(
      handle.cdp<EvaluateResult>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        timeout: limit,
      }),
      limit,
      `eval did not finish within ${Math.round(limit / 1000)} s (a Promise that never settles, or a loop that never ends). The page may need a reload.`,
    )
    if (response.exceptionDetails) return fail(handle, truncateUtf8(`Error: ${exceptionText(response.exceptionDetails)}`, EVAL_MAX_BYTES))
    return done(handle, truncateUtf8(serializeRemote(response.result), EVAL_MAX_BYTES))
  },

  async console(handle, params) {
    const limit = Math.min(Math.max(Math.round(num(params, 'limit') ?? CONSOLE_DEFAULT_LIMIT), 1), CONSOLE_MAX_LIMIT)
    const level = str(params, 'level')?.toLowerCase()
    const wanted = level === 'warn' ? 'warning' : level
    const all = handle.getConsole()
    const matching = wanted ? all.filter((entry) => (entry.level === 'warn' ? 'warning' : entry.level) === wanted) : all
    const shown = matching.slice(-limit)
    const lines = shown.map((entry) => `[${entry.level}] ${clip(entry.text, 500)}${entry.url ? ` (${entry.url}${entry.line ? `:${entry.line}` : ''})` : ''}`)
    return done(handle, lines.length > 0 ? lines.join('\n') : `No console messages${wanted ? ` at level ${wanted}` : ''}.`)
  },

  async get_marks(handle) {
    const marks = handle.getMarks()
    if (marks.length === 0) return done(handle, 'The user has not marked anything in the browser panel.')
    return done(handle, `Elements the user marked in the browser panel:\n${numberedMarks(marks).map(markLine).join('\n')}`)
  },
}

/** The image is in image px; browser_click x/y are CSS px. Say both and the ratio between them. */
function coordinateNote(imageWidth: number, cssWidth: number | null, viewport: { width: number; height: number } | null): string {
  const ratio = cssWidth && cssWidth > 0 ? Math.round((imageWidth / cssWidth) * 100) / 100 : null
  const size = viewport ? `Viewport ${viewport.width}x${viewport.height} CSS px` : 'Viewport size unknown'
  return `\n${size}${ratio !== null ? `; image px per CSS px = ${ratio}` : ''}. browser_click x and y are CSS px, not image px: divide image coordinates by the ratio.`
}

function markLine({ number, mark }: NumberedMark): string {
  const rect = mark.rect
  return [
    `#${number} ${mark.selector}`,
    mark.text ? ` text=${JSON.stringify(clip(mark.text, 120))}` : '',
    mark.note ? ` note=${JSON.stringify(clip(mark.note, 200))}` : '',
    ` rect=${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
    ` page=${mark.url}`,
  ].join('')
}

const CLEAR_SCRIPT = `function () {
  if ('value' in this) {
    this.value = ''
    this.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (this && this.isContentEditable) {
    this.textContent = ''
  }
}`

const CARET_TO_END_SCRIPT = `function () {
  if (typeof this.value === 'string' && typeof this.setSelectionRange === 'function') {
    try { this.setSelectionRange(this.value.length, this.value.length) } catch {}
  } else if (this.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(this)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }
}`

const EDITABLE_FOCUS_SCRIPT = `(() => {
  const el = document.activeElement
  return !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'reset', 'image', 'file'].includes(el.type)))
})()`

const MARK_OVERLAY_ID = '__pi_desktop_marks__'
const REMOVE_MARKS_SCRIPT = `document.getElementById(${JSON.stringify(MARK_OVERLAY_ID)})?.remove()`

/** Draw each mark as a numbered box over the page for one capture. The element is found again by its selector. */
async function drawMarks(handle: ActionHandle, marks: BrowserMark[]): Promise<void> {
  const payload = JSON.stringify(numberedMarks(marks).map(({ number, mark }) => ({ id: number, selector: mark.selector, rect: mark.rect })))
  const expression = `(() => {
    const old = document.getElementById(${JSON.stringify(MARK_OVERLAY_ID)}); if (old) old.remove()
    const layer = document.createElement('div')
    layer.id = ${JSON.stringify(MARK_OVERLAY_ID)}
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    for (const mark of ${payload}) {
      let rect = mark.rect
      try {
        const el = document.querySelector(mark.selector)
        if (el) { const r = el.getBoundingClientRect(); rect = { x: r.x, y: r.y, width: r.width, height: r.height } }
      } catch {}
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #e11d48;background:rgba(225,29,72,.12);left:' + rect.x + 'px;top:' + rect.y + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px'
      const badge = document.createElement('span')
      badge.textContent = String(mark.id)
      badge.style.cssText = 'position:absolute;left:-2px;top:-18px;background:#e11d48;color:#fff;font:700 12px/16px sans-serif;padding:0 5px;border-radius:3px'
      box.appendChild(badge)
      layer.appendChild(box)
    }
    document.documentElement.appendChild(layer)
  })()`
  await handle.cdp('Runtime.evaluate', { expression }).catch(() => {})
}

function serializeRemote(object: RemoteObject): string {
  if (object.subtype === 'null') return 'null'
  if (object.type === 'undefined') return 'undefined'
  if (object.value !== undefined) {
    if (typeof object.value === 'string') return object.value
    try {
      return JSON.stringify(object.value, null, 2) ?? String(object.value)
    } catch {
      return String(object.value)
    }
  }
  return object.unserializableValue ?? object.description ?? object.type ?? 'undefined'
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

function actionLimitMs(action: string, params: ActionParams, env: ActionEnv): number {
  if (env.actionTimeoutMs !== undefined) return env.actionTimeoutMs
  if (action !== 'wait') return ACTION_TIMEOUT_MS
  const timeoutMs = Math.min(Math.max(num(params, 'timeoutMs') ?? WAIT_DEFAULT_TIMEOUT_MS, 100), WAIT_MAX_TIMEOUT_MS)
  return timeoutMs + WAIT_TIMEOUT_GRACE_MS
}

/** Run one action. It never throws: a failure comes back as { ok: false, text }. */
export async function runBrowserAction(
  handle: ActionHandle,
  action: string,
  params: ActionParams = {},
  env: ActionEnv = realEnv,
): Promise<ActionResult> {
  const run = (ACTION_NAMES as readonly string[]).includes(action) ? actions[action as ActionName] : undefined
  if (!run) return fail(handle, `Unknown browser action "${action}".`)
  try {
    const limit = actionLimitMs(action, params, env)
    return await withTimeout(run(handle, params, env), limit, `browser_${action} did not finish within ${Math.round(limit / 1000)} s; the page is not answering.`)
  } catch (error) {
    return fail(handle, error instanceof Error ? error.message : String(error))
  }
}
