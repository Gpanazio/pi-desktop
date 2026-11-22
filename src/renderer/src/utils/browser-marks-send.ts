import type { BrowserMark } from '../../../shared/browser'
import { formatBrowserMarks, numberedMarks, pendingMarks } from '../../../shared/browser-marks'
import type { PromptImage } from '../../../shared/ipc-contracts'
import type { DisplayAttachment } from '../message-parsing'

export interface SendOptions {
  images?: PromptImage[]
  attachments?: DisplayAttachment[]
}

export interface BrowserMarksSendDeps {
  /** Every mark of the session, sent ones included (their numbers stay). */
  getMarks: () => Promise<BrowserMark[]>
  /** A PNG of the visible area with these marks drawn on it; null when the panel is not open. */
  captureWithMarks: (marks: BrowserMark[], all: BrowserMark[]) => Promise<{ mimeType: string; data: string } | null>
  /** Longest wait for the marks or the picture (default BROWSER_MARKS_TIMEOUT_MS). */
  timeoutMs?: number
  /** Where a timeout is reported (default console.warn). */
  warn?: (message: string) => void
}

export const BROWSER_MARKS_TIMEOUT_MS = 4000

class MarksTimeout extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MarksTimeout()), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

export const BROWSER_MARKS_IMAGE_NAME = 'browser-marks.png'

/**
 * The prompt with the session's pending marks added: the `<browser_marks>`
 * block at the end of the text and a picture of the visible area with the
 * marks drawn on it. `sentIds` are the marks it used: they are flagged as sent
 * (`confirmBrowserMarksSent`) only once the send succeeded, so a failed send
 * leaves them pending. Anything that goes wrong here leaves the prompt as the
 * person wrote it.
 */
export async function attachBrowserMarks(
  message: string,
  options: SendOptions | undefined,
  deps: BrowserMarksSendDeps,
): Promise<{ message: string; options: SendOptions | undefined; sentIds: number[] }> {
  const limit = deps.timeoutMs ?? BROWSER_MARKS_TIMEOUT_MS
  const warn = deps.warn ?? ((text: string) => console.warn(text))
  let all: BrowserMark[]
  try {
    all = await within(deps.getMarks(), limit)
  } catch (error) {
    if (error instanceof MarksTimeout) warn(`[browser] reading the marks took over ${limit} ms; the prompt goes without them`)
    return { message, options, sentIds: [] }
  }
  const pending = pendingMarks(all)
  if (pending.length === 0) return { message, options, sentIds: [] }

  const block = formatBrowserMarks(numberedMarks(all).filter((entry) => entry.mark.sent !== true))
  const composed = message.trim() === '' ? block : `${message}\n\n${block}`

  let image: { mimeType: string; data: string } | null = null
  try {
    image = await within(deps.captureWithMarks(pending, all), limit)
  } catch (error) {
    // The picture is a help; the marks themselves still go.
    if (error instanceof MarksTimeout) warn(`[browser] the capture took over ${limit} ms; the prompt goes with the marks as text only`)
  }
  const sentIds = pending.map((mark) => mark.id)
  if (!image) return { message: composed, options, sentIds }
  return {
    message: composed,
    options: {
      images: [...(options?.images ?? []), { type: 'image', mimeType: image.mimeType, data: image.data }],
      attachments: [
        ...(options?.attachments ?? []),
        { kind: 'image', name: BROWSER_MARKS_IMAGE_NAME, mimeType: image.mimeType, data: image.data },
      ],
    },
    sentIds,
  }
}

/** Flag the marks a prompt carried as sent, once that prompt was delivered. A failed send keeps them pending. */
export function confirmBrowserMarksSent(delivered: boolean, sentIds: readonly number[], markSent: (ids: number[]) => Promise<void>): void {
  if (!delivered || sentIds.length === 0) return
  void markSent([...sentIds]).catch(() => {})
}
