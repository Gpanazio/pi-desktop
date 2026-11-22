// Drives the marks script inside a guest over CDP: installs it for every new
// document, tells each frame the mode and the badges, and turns what the page
// reports (a picked element, an exit) into store changes. The script lives in an
// isolated world, so the page's own scripts neither see nor break it.

import type { BrowserCaptureLayout, BrowserMarkDraft } from '../../shared/browser'
import { MARKS_BINDING, MARKS_WORLD, PAGE_SCRIPT } from './browser-marks-script'
import type { MarkStore } from './browser-mark-store'
import { t } from '../../shared/i18n'

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

interface PageMessage {
  t?: string
  top?: boolean
  shift?: boolean
  mark?: Partial<BrowserMarkDraft>
}

function isDraft(value: Partial<BrowserMarkDraft> | undefined): value is BrowserMarkDraft {
  return (
    !!value &&
    typeof value.selector === 'string' &&
    typeof value.text === 'string' &&
    typeof value.html === 'string' &&
    typeof value.url === 'string' &&
    !!value.rect &&
    [value.rect.x, value.rect.y, value.rect.width, value.rect.height].every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

export class BrowserMarksOverlay {
  /** Execution contexts of the script: id -> is it the top frame. */
  private readonly contexts = new Map<number, boolean>()
  private hidden = false

  constructor(
    private readonly send: Send,
    private readonly store: MarkStore,
  ) {}

  /** Expose the binding and run the script in every new document (and the ones already loaded). */
  async install(): Promise<void> {
    // The Page agent only injects into later documents once it is enabled.
    await this.send('Page.enable')
    await this.send('Runtime.addBinding', { name: MARKS_BINDING, executionContextName: MARKS_WORLD })
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: PAGE_SCRIPT,
      worldName: MARKS_WORLD,
      runImmediately: true,
    })
  }

  /** Give every frame the current mode and badges. */
  sync(): void {
    for (const id of [...this.contexts.keys()]) void this.evaluate(id, `__piMarksApi.setState(${this.stateJson()})`)
  }

  /** Hide or show the overlay (a capture must not contain it). */
  async setHidden(hidden: boolean): Promise<void> {
    this.hidden = hidden
    await Promise.all([...this.contexts.keys()].map((id) => this.evaluate(id, `__piMarksApi.setHidden(${hidden})`)))
  }

  /** Where these marks sit now, in CSS px of the viewport or of the whole page. Null: no page script answered. */
  async measure(ids: readonly number[], fullPage: boolean): Promise<BrowserCaptureLayout | null> {
    for (const [id, top] of this.contexts) {
      if (!top) continue
      const value = await this.evaluate(id, `__piMarksApi.measure(${JSON.stringify({ ids, fullPage })})`)
      if (value && typeof value === 'object') return value as BrowserCaptureLayout
    }
    return null
  }

  onCdpMessage(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'Runtime.executionContextDestroyed') {
      this.contexts.delete(p.executionContextId as number)
    } else if (method === 'Runtime.executionContextsCleared') {
      this.contexts.clear()
    } else if (method === 'Runtime.bindingCalled' && p.name === MARKS_BINDING) {
      this.onPageMessage(p.executionContextId as number, String(p.payload ?? ''))
    }
  }

  private onPageMessage(contextId: number, payload: string): void {
    let message: PageMessage
    try {
      message = JSON.parse(payload) as PageMessage
    } catch {
      return
    }
    if (message.t === 'ready') {
      this.contexts.set(contextId, message.top === true)
      void this.evaluate(contextId, `__piMarksApi.setState(${this.stateJson()})`)
      if (this.hidden) void this.evaluate(contextId, '__piMarksApi.setHidden(true)')
    } else if (message.t === 'pick') {
      if (this.store.markMode && isDraft(message.mark)) this.store.pick(message.mark, message.shift === true)
    } else if (message.t === 'exit') {
      this.store.setMode(false)
    }
  }

  private stateJson(): string {
    const badges = this.store.list().map((mark, index) => ({
      id: mark.id,
      n: index + 1,
      selector: mark.selector,
      rect: mark.rect,
      url: mark.url,
      sent: mark.sent === true,
    }))
    return JSON.stringify({ mode: this.store.markMode, badges, notice: t('browser.marks.iframe_denied') })
  }

  private async evaluate(contextId: number, expression: string): Promise<unknown> {
    try {
      const result = (await this.send('Runtime.evaluate', { expression, contextId, returnByValue: true })) as {
        result?: { value?: unknown }
        exceptionDetails?: unknown
      }
      if (result?.exceptionDetails) this.contexts.delete(contextId)
      return result?.result?.value
    } catch {
      this.contexts.delete(contextId)
      return undefined
    }
  }
}
