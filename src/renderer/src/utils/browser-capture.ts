import type { BrowserCapture, BrowserMark } from '../../../shared/browser'
import { markOverlayBoxes, numberedMarks } from '../../../shared/browser-marks'
import type { BrowserMarksSendDeps } from './browser-marks-send'

const MARK_COLOR = '#f59e0b'
const MARK_FILL = 'rgba(245, 158, 11, 0.12)'
/** Browsers refuse canvases past this side; a bigger capture goes out without the drawing. */
const MAX_CANVAS_SIDE = 16000

export interface CapturedImage {
  mimeType: string
  data: string
}

function loadImage(mimeType: string, data: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode the screenshot'))
    image.src = `data:${mimeType};base64,${data}`
  })
}

/** Draw each mark's outline and numbered badge on the capture, at the pixel ratio the capture has. */
async function drawMarks(capture: BrowserCapture, marks: readonly BrowserMark[], all: readonly BrowserMark[]): Promise<CapturedImage> {
  const { screenshot, layout } = capture
  const plain = { mimeType: screenshot.mimeType, data: screenshot.data }
  const numbers = new Map(numberedMarks(all).map((entry) => [entry.mark.id, entry.number]))
  const wanted = new Set(marks.map((mark) => mark.id))
  const image = await loadImage(screenshot.mimeType, screenshot.data)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) return plain
  const boxes = markOverlayBoxes({ ...layout, rects: layout.rects.filter((rect) => wanted.has(rect.id)) }, { width, height }, numbers)
  if (boxes.length === 0) return plain

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return plain
  context.drawImage(image, 0, 0)
  // One CSS pixel is `ratio` image pixels.
  const ratio = layout.cssWidth > 0 ? width / layout.cssWidth : 1
  const radius = 10 * ratio
  context.lineWidth = Math.max(2, 2 * ratio)
  for (const box of boxes) {
    context.fillStyle = MARK_FILL
    context.strokeStyle = MARK_COLOR
    context.fillRect(box.x, box.y, box.width, box.height)
    context.strokeRect(box.x, box.y, box.width, box.height)
    const cx = Math.min(Math.max(box.x, radius), width - radius)
    const cy = Math.min(Math.max(box.y, radius), height - radius)
    context.beginPath()
    context.arc(cx, cy, radius, 0, Math.PI * 2)
    context.fillStyle = MARK_COLOR
    context.fill()
    context.lineWidth = Math.max(1.5, 1.5 * ratio)
    context.strokeStyle = '#ffffff'
    context.stroke()
    context.lineWidth = Math.max(2, 2 * ratio)
    context.fillStyle = '#ffffff'
    context.font = `700 ${Math.round(12 * ratio)}px system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(box.number), cx, cy + ratio * 0.5)
  }
  return { mimeType: 'image/png', data: canvas.toDataURL('image/png').slice('data:image/png;base64,'.length) }
}

/**
 * A capture of the session's browser. With `marks`, their outlines and numbers
 * are drawn on the image; `all` is the whole list, so a number matches its badge.
 */
export async function captureBrowserImage(
  sessionKey: string,
  options: { fullPage: boolean; marks: readonly BrowserMark[]; all: readonly BrowserMark[] },
): Promise<CapturedImage> {
  const capture = await window.piDesktop.browser.capture(sessionKey, {
    fullPage: options.fullPage,
    markIds: options.marks.map((mark) => mark.id),
  })
  if (options.marks.length === 0) return { mimeType: capture.screenshot.mimeType, data: capture.screenshot.data }
  return drawMarks(capture, options.marks, options.all)
}

/** What the send path needs to attach a session's pending marks to a prompt. */
export function browserMarksDeps(sessionKey: string): BrowserMarksSendDeps {
  return {
    getMarks: async () => (await window.piDesktop.browser.getMarks(sessionKey)).marks,
    captureWithMarks: async (marks, all) => {
      // Without an open panel there is no page to photograph.
      if (!(await window.piDesktop.browser.getState(sessionKey))) return null
      return captureBrowserImage(sessionKey, { fullPage: false, marks, all })
    },
  }
}
