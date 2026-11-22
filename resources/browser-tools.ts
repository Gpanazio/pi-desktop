/**
 * The browser tools the agent gets while Pi Desktop's browser panel is open:
 * names, schemas, descriptions, and the pure rules the extension applies
 * (which tools are active, the context line, how a result becomes content).
 * It has no imports, so the extension, the tests, and main can load it.
 */

export const BROWSER_EXTENSION_FILE = 'pi-desktop-browser.ts'
export const BROWSER_CONTEXT_TYPE = 'pi-desktop-browser'

/** Plain JSON Schema, like the other bundled extensions: Pi and OMP both validate it. */
type Schema = Record<string, unknown>

const refOrSelector: Record<string, Schema> = {
  ref: { type: 'string', description: 'Element ref from the last browser_snapshot, such as "e12".' },
  selector: { type: 'string', description: 'CSS selector, used when there is no ref.' },
}

export interface BrowserToolSpec {
  name: string
  label: string
  /** The bridge action this tool runs. */
  action: string
  description: string
  parameters: Schema
}

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
})

export const BROWSER_TOOLS: readonly BrowserToolSpec[] = [
  {
    name: 'browser_navigate',
    label: 'Browser: open URL',
    action: 'navigate',
    description: 'Open a URL in the browser panel and wait for it to load. Takes a full URL or a host such as localhost:3000.',
    parameters: object({ url: { type: 'string', description: 'The address to open.' } }, ['url']),
  },
  { name: 'browser_back', label: 'Browser: back', action: 'back', description: 'Go back one page in the browser panel.', parameters: object({}) },
  { name: 'browser_forward', label: 'Browser: forward', action: 'forward', description: 'Go forward one page in the browser panel.', parameters: object({}) },
  { name: 'browser_reload', label: 'Browser: reload', action: 'reload', description: 'Reload the page in the browser panel.', parameters: object({}) },
  {
    name: 'browser_snapshot',
    label: 'Browser: snapshot',
    action: 'snapshot',
    description:
      'Read the page as a compact accessibility outline. Interactive elements carry refs like [e3]: pass them as `ref` to browser_click, browser_type and browser_scroll. Cheaper and more exact than a screenshot for finding things. Refs last until the page changes; take a new snapshot after navigating.',
    parameters: object({
      interactiveOnly: { type: 'boolean', description: 'List only buttons, links and fields (default true). Pass false to also read headings and page text.' },
      maxNodes: { type: 'integer', description: 'Most nodes to list (default 400).' },
    }),
  },
  {
    name: 'browser_screenshot',
    label: 'Browser: screenshot',
    action: 'screenshot',
    description: 'See the page: returns an image of the browser panel. Use it to judge layout, colors and visual bugs. withMarks draws the elements the user marked.',
    parameters: object({
      fullPage: { type: 'boolean', description: 'Capture the top of the scrollable page as up to 4 tiles, 1280 px wide, instead of the visible part. For a longer page, scroll and take more screenshots.' },
      withMarks: { type: 'boolean', description: 'Outline and number the elements the user marked in the panel.' },
    }),
  },
  {
    name: 'browser_click',
    label: 'Browser: click',
    action: 'click',
    description: 'Click an element by ref or selector, or a point by x and y (CSS pixels in the viewport). Waits for a resulting page load.',
    parameters: object({
      ...refOrSelector,
      x: { type: 'number', description: 'Viewport x, when clicking a point.' },
      y: { type: 'number', description: 'Viewport y, when clicking a point.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      clickCount: { type: 'integer', description: '2 for a double click (default 1).' },
    }),
  },
  {
    name: 'browser_type',
    label: 'Browser: type',
    action: 'type',
    description: 'Type text into a field. Give a ref or selector to focus it first; without one it types into the focused element. clear empties the field first; submit presses Enter after.',
    parameters: object(
      {
        ...refOrSelector,
        text: { type: 'string', description: 'The text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        clear: { type: 'boolean', description: 'Empty the field before typing.' },
      },
      ['text'],
    ),
  },
  {
    name: 'browser_press',
    label: 'Browser: press key',
    action: 'press',
    description: 'Press a key or combination: Enter, Tab, Escape, ArrowDown, Backspace, F5, a letter, or something like Control+a or Shift+Tab.',
    parameters: object({ key: { type: 'string', description: 'The key, with optional modifiers joined by +.' } }, ['key']),
  },
  {
    name: 'browser_scroll',
    label: 'Browser: scroll',
    action: 'scroll',
    description: 'Scroll the page by dx/dy pixels (positive dy scrolls down), or bring the element with this ref or selector into view.',
    parameters: object({
      dx: { type: 'number', description: 'Pixels to scroll right.' },
      dy: { type: 'number', description: 'Pixels to scroll down.' },
      ...refOrSelector,
    }),
  },
  {
    name: 'browser_wait',
    label: 'Browser: wait',
    action: 'wait',
    description: 'Wait for a time (ms), for a selector to exist, or for text to appear on the page. Fails after timeoutMs (default 10000).',
    parameters: object({
      ms: { type: 'integer', description: 'Milliseconds to wait.' },
      selector: { type: 'string', description: 'CSS selector to wait for.' },
      text: { type: 'string', description: 'Text to wait for.' },
      timeoutMs: { type: 'integer', description: 'Give up after this long (default 10000).' },
    }),
  },
  {
    name: 'browser_set_viewport',
    label: 'Browser: viewport',
    action: 'set_viewport',
    description: 'Emulate a device or size to check responsive layouts. Presets: iphone-15, pixel-8, ipad, laptop, desktop. Or give width and height. reset returns to the panel size.',
    parameters: object({
      preset: { type: 'string', description: 'A preset id.' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      deviceScaleFactor: { type: 'number', description: 'Pixel ratio, 1 to 4 (default 1).' },
      mobile: { type: 'boolean', description: 'Emulate a mobile device (touch, mobile layout).' },
      reset: { type: 'boolean', description: 'Drop the emulation.' },
    }),
  },
  {
    name: 'browser_eval',
    label: 'Browser: run JavaScript',
    action: 'eval',
    description: 'Run a JavaScript expression in the page and return its value (promises are awaited, output is cut at 8 KB). Use it to read state the outline does not show.',
    parameters: object({ expression: { type: 'string', description: 'The expression to evaluate.' } }, ['expression']),
  },
  {
    name: 'browser_console',
    label: 'Browser: console',
    action: 'console',
    description: 'Read the page console: logs, warnings, errors and uncaught exceptions, newest last.',
    parameters: object({
      limit: { type: 'integer', description: 'How many entries (default 50).' },
      level: { type: 'string', description: 'Only this level: log, info, warning, error, debug.' },
    }),
  },
  {
    name: 'browser_get_marks',
    label: 'Browser: user marks',
    action: 'get_marks',
    description: 'List the elements the user marked in the browser panel to point at them, with selector, text and note.',
    parameters: object({}),
  },
]

export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOLS.map((tool) => tool.name)

const BROWSER_TOOL_SET = new Set(BROWSER_TOOL_NAMES)

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_SET.has(name)
}

/**
 * The active tool list for the turn that starts now. Open: what is active
 * plus the browser tools. Closed: what is active minus them. Every other tool
 * keeps its place, and a tool someone turned off is never turned on.
 */
export function nextActiveTools(active: readonly string[], browserOpen: boolean): string[] {
  const rest = active.filter((name) => !BROWSER_TOOL_SET.has(name))
  return browserOpen ? [...rest, ...BROWSER_TOOL_NAMES] : rest
}

export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === new Set([...a, ...b]).size
}

export interface BrowserStateReply {
  open: boolean
  state?: {
    url: string
    title: string
    viewport: { width: number; height: number; deviceScaleFactor: number } | null
    paneSize: { width: number; height: number }
  }
  marks?: number
}

/** The line that tells the model the panel is open. */
export function browserContextText(reply: BrowserStateReply): string {
  const state = reply.state
  const where = state?.viewport
    ? `viewport ${state.viewport.width}x${state.viewport.height}@${state.viewport.deviceScaleFactor}`
    : `painel ${state?.paneSize.width ?? 0}x${state?.paneSize.height ?? 0}`
  const marks = reply.marks && reply.marks > 0 ? ` O usuário marcou ${reply.marks} elemento(s) no painel (browser_get_marks).` : ''
  return `Browser interno do Pi Desktop aberto: ${state?.title || '(sem título)'} — ${state?.url || 'about:blank'} (${where}). Use as tools browser_* para ver e interagir; prefira browser_snapshot para achar elementos e browser_screenshot para ver o visual.${marks}`
}

/** Pi's hook for a model without image input falls back to the text outline. */
export function modelSeesImages(model: { input?: readonly string[] } | undefined): boolean {
  return model?.input === undefined ? true : model.input.includes('image')
}

export interface BridgeActionResult {
  ok: boolean
  text: string
  image?: { mimeType: string; data: string }
  images?: Array<{ mimeType: string; data: string }>
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** A bridge reply as the content of a tool result; an image only when the model can take one. */
export function toolContent(result: BridgeActionResult, withImage: boolean): ToolContent[] {
  const content: ToolContent[] = [{ type: 'text', text: result.text }]
  if (withImage) for (const image of [result.image, ...(result.images ?? [])]) if (image) content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  return content
}
