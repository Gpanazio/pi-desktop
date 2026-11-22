import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ArrowLeft, ArrowRight, Bug, Camera, Check, Crosshair, ExternalLink, Loader2, MonitorSmartphone, Pencil, RotateCw, Trash2, X } from 'lucide-react'
import { useAppStore } from '../store'
import {
  BROWSER_PARTITION,
  BROWSER_VIEWPORT_PRESETS,
  clampViewport,
  isBrowsableUrl,
  normalizeAddress,
  scaleToFit,
  type BrowserMark,
  type BrowserMarkPick,
  type BrowserMarksSnapshot,
  type BrowserState,
  type BrowserViewport,
} from '../../../shared/browser'
import { numberedMarks } from '../../../shared/browser-marks'
import { DEFAULT_BROWSER_PANEL_SESSION } from '../utils/browser-panel-state'
import { captureBrowserImage } from '../utils/browser-capture'

// The <webview> element's own API; the tag is not a typed JSX intrinsic (see file-tree.tsx).
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  closeDevTools(): void
  isDevToolsOpened(): boolean
}

const Webview = 'webview' as unknown as React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLElement> & React.RefAttributes<WebviewElement> & { src?: string; partition?: string; allowpopups?: string }
>

const CUSTOM_PRESET_ID = 'custom'
const PANE_REPORT_DELAY_MS = 120
const POPOVER_WIDTH = 248
const POPOVER_HEIGHT = 104
const NO_MARKS: BrowserMarksSnapshot = { marks: [], markMode: false }

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Width, height and pixel ratio of the viewport the person typed, as numbers. */
function parseCustomViewport(width: string, height: string, ratio: string): BrowserViewport | null {
  const w = Number(width)
  const h = Number(height)
  const dpr = Number(ratio)
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(dpr)) return null
  return clampViewport({ width: w, height: h, deviceScaleFactor: dpr, mobile: false, touch: false })
}

export function BrowserPanel({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const saved = useAppStore((state) => state.browserSessions[sessionKey] ?? DEFAULT_BROWSER_PANEL_SESSION)
  const patchSession = useAppStore((state) => state.patchBrowserSession)

  const webviewRef = useRef<WebviewElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const readyRef = useRef(false)
  const registeredRef = useRef(false)
  // The webview's src is set once: later navigation goes through loadURL, never through a prop change.
  const [initialUrl] = useState(() => (saved.url !== '' && isBrowsableUrl(saved.url) ? saved.url : 'about:blank'))
  const [state, setState] = useState<BrowserState | null>(null)
  const [address, setAddress] = useState(initialUrl === 'about:blank' ? '' : initialUrl)
  const [addressFocused, setAddressFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customWidth, setCustomWidth] = useState(String(saved.viewport?.width ?? 800))
  const [customHeight, setCustomHeight] = useState(String(saved.viewport?.height ?? 600))
  const [customRatio, setCustomRatio] = useState(String(saved.viewport?.deviceScaleFactor ?? 1))
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [marksSnap, setMarksSnap] = useState<BrowserMarksSnapshot>(NO_MARKS)
  const [pick, setPick] = useState<BrowserMarkPick | null>(null)
  const [pickNote, setPickNote] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [shotMenuOpen, setShotMenuOpen] = useState(false)
  const [shotWithMarks, setShotWithMarks] = useState(true)
  const [shotBusy, setShotBusy] = useState(false)
  const [shotFailed, setShotFailed] = useState(false)
  const pickRef = useRef<{ pick: BrowserMarkPick | null; note: string }>({ pick: null, note: '' })
  pickRef.current = { pick, note: pickNote }

  // Latest saved viewport, read when the guest registers (a stale closure would apply an old one).
  const savedViewportRef = useRef(saved.viewport)
  savedViewportRef.current = saved.viewport

  // The session key can change while the page stays loaded (the first prompt of a chat gives it a runtime id):
  // the guest's own lifecycle reads the current key instead of restarting with it.
  const keyRef = useRef(sessionKey)
  keyRef.current = sessionKey

  const registerGuest = useCallback(() => {
    const webview = webviewRef.current
    if (!webview || registeredRef.current) return
    registeredRef.current = true
    const key = keyRef.current
    void window.piDesktop.browser
      .register(key, webview.getWebContentsId())
      .then(async () => {
        if (savedViewportRef.current) await window.piDesktop.browser.setViewport(keyRef.current, savedViewportRef.current)
      })
      .catch(() => {
        registeredRef.current = false
      })
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    const onDomReady = (): void => {
      readyRef.current = true
      registerGuest()
    }
    webview.addEventListener('dom-ready', onDomReady)
    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      readyRef.current = false
      registeredRef.current = false
      void window.piDesktop.browser.unregister(keyRef.current).catch(() => {})
    }
  }, [registerGuest])

  useEffect(() => {
    return window.piDesktop.browser.onState((event) => {
      if (event.sessionKey !== sessionKey) return
      setState(event.state)
      if (event.state && event.state.url !== '' && event.state.url !== 'about:blank') {
        useAppStore.getState().patchBrowserSession(sessionKey, { url: event.state.url })
      }
    })
  }, [sessionKey])

  // The marks live in the main process (they outlive this panel); this view follows them.
  useEffect(() => {
    let cancelled = false
    void window.piDesktop.browser
      .getMarks(sessionKey)
      .then((snapshot) => {
        if (!cancelled) setMarksSnap(snapshot)
      })
      .catch(() => {})
    const offMarks = window.piDesktop.browser.onMarks((event) => {
      if (event.sessionKey !== sessionKey) return
      if (event.kind === 'marks') {
        setMarksSnap({ marks: event.marks, markMode: event.markMode })
        return
      }
      // A new pick while an earlier one waits for its note keeps the earlier one as typed.
      const earlier = pickRef.current
      if (earlier.pick) void window.piDesktop.browser.addMark(sessionKey, earlier.pick.draft, earlier.note.trim() || undefined).catch(() => {})
      setPick(event.pick)
      setPickNote('')
    })
    return () => {
      cancelled = true
      offMarks()
    }
  }, [sessionKey])

  // Follow the page's address unless the person is typing.
  useEffect(() => {
    if (addressFocused || !state || state.url === '' || state.url === 'about:blank') return
    setAddress(state.url)
  }, [state, addressFocused])

  // The stage's size is the panel size the agent sees; it is also what "scale to fit" fits into.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = (): void => {
      const width = stage.clientWidth
      const height = stage.clientHeight
      setStageSize({ width, height })
      clearTimeout(timer)
      timer = setTimeout(() => {
        void window.piDesktop.browser.setPaneSize(sessionKey, width, height).catch(() => {})
      }, PANE_REPORT_DELAY_MS)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [sessionKey])

  const navigate = (text: string): void => {
    const { url } = normalizeAddress(text)
    setAddress(url === 'about:blank' ? '' : url)
    const webview = webviewRef.current
    if (!webview) return
    if (readyRef.current) void webview.loadURL(url).catch(() => {})
    else webview.setAttribute('src', url)
  }

  const applyViewport = (viewport: BrowserViewport | null, presetId: string | null): void => {
    patchSession(sessionKey, { viewport, presetId })
    if (registeredRef.current) void window.piDesktop.browser.setViewport(sessionKey, viewport).catch(() => {})
  }

  const toggleDevTools = (): void => {
    const webview = webviewRef.current
    if (!webview || !readyRef.current) return
    if (webview.isDevToolsOpened()) webview.closeDevTools()
    else webview.openDevTools()
  }

  const openExternal = (): void => {
    const url = state?.url ?? ''
    if (/^https?:\/\//i.test(url)) void window.piDesktop.system.openExternal(url).catch(() => {})
  }

  const markMode = marksSnap.markMode
  const numbered = useMemo(() => numberedMarks(marksSnap.marks), [marksSnap.marks])

  const setMarkMode = (on: boolean): void => {
    void window.piDesktop.browser.setMarkMode(sessionKey, on).catch(() => {})
  }

  const confirmPick = (): void => {
    if (!pick) return
    void window.piDesktop.browser.addMark(sessionKey, pick.draft, pickNote.trim() || undefined).catch(() => {})
    setPick(null)
    setPickNote('')
  }

  const cancelPick = (): void => {
    setPick(null)
    setPickNote('')
  }

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !pick && markMode) {
      event.preventDefault()
      setMarkMode(false)
      return
    }
    if (event.key.toLowerCase() === 'm' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target)) {
      event.preventDefault()
      setMarkMode(!markMode)
    }
  }

  const takeShot = async (fullPage: boolean): Promise<void> => {
    setShotMenuOpen(false)
    setShotBusy(true)
    setShotFailed(false)
    try {
      const image = await captureBrowserImage(sessionKey, { fullPage, marks: shotWithMarks ? marksSnap.marks : [], all: marksSnap.marks })
      const stamp = Date.now()
      const name = `browser-${fullPage ? 'page' : 'view'}-${stamp}.png`
      useAppStore.getState().stageComposerAttachment({
        kind: 'image',
        name,
        path: `browser://${sessionKey}/${stamp}`,
        image: { type: 'image', mimeType: image.mimeType, data: image.data },
      })
    } catch {
      setShotFailed(true)
    } finally {
      setShotBusy(false)
    }
  }

  const viewport = saved.viewport
  const fit = useMemo(
    () => (viewport && saved.scaleToFit ? scaleToFit(viewport, stageSize) : 1),
    [viewport, saved.scaleToFit, stageSize]
  )
  const loading = state?.loading ?? false

  const navButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-highlight hover:text-secondary disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden outline-none" tabIndex={-1} onKeyDown={onPanelKeyDown}>
      <div className="relative flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <button type="button" className={navButton} disabled={!state?.canGoBack} onClick={() => webviewRef.current?.goBack()} title={t('browser.toolbar.back')} aria-label={t('browser.toolbar.back')}>
          <ArrowLeft size={14} />
        </button>
        <button type="button" className={navButton} disabled={!state?.canGoForward} onClick={() => webviewRef.current?.goForward()} title={t('browser.toolbar.forward')} aria-label={t('browser.toolbar.forward')}>
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className={navButton}
          onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())}
          title={loading ? t('browser.toolbar.stop') : t('browser.toolbar.reload')}
          aria-label={loading ? t('browser.toolbar.stop') : t('browser.toolbar.reload')}
        >
          {loading ? <X size={14} /> : <RotateCw size={14} />}
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            setAddressFocused(true)
            event.currentTarget.select()
          }}
          onBlur={() => setAddressFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              navigate(address)
              event.currentTarget.blur()
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={t('browser.toolbar.addressPlaceholder')}
          aria-label={t('browser.toolbar.address')}
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-primary placeholder:text-faint focus:border-accent focus:outline-none"
        />
        {loading && <Loader2 size={13} className="shrink-0 animate-spin text-dim" aria-label={t('browser.toolbar.loading')} />}
        <div className="relative">
          <button
            type="button"
            className={clsx(navButton, (viewport || menuOpen) && 'text-accent')}
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t('browser.viewport.menu')}
            aria-label={t('browser.viewport.menu')}
          >
            <MonitorSmartphone size={14} />
          </button>
          {menuOpen && (
            <ViewportMenu
              presetId={saved.presetId}
              scaleToFitOn={saved.scaleToFit}
              customOpen={customOpen}
              customWidth={customWidth}
              customHeight={customHeight}
              customRatio={customRatio}
              onCustomWidth={setCustomWidth}
              onCustomHeight={setCustomHeight}
              onCustomRatio={setCustomRatio}
              onPreset={(preset) => {
                applyViewport(
                  clampViewport({ width: preset.width, height: preset.height, deviceScaleFactor: preset.deviceScaleFactor, mobile: preset.mobile, touch: preset.touch }),
                  preset.id
                )
                setMenuOpen(false)
              }}
              onToggleCustom={() => setCustomOpen((open) => !open)}
              onApplyCustom={() => {
                const custom = parseCustomViewport(customWidth, customHeight, customRatio)
                if (!custom) return
                setCustomWidth(String(custom.width))
                setCustomHeight(String(custom.height))
                setCustomRatio(String(custom.deviceScaleFactor))
                applyViewport(custom, CUSTOM_PRESET_ID)
                setMenuOpen(false)
              }}
              onToggleScale={() => patchSession(sessionKey, { scaleToFit: !saved.scaleToFit })}
              onReset={() => {
                applyViewport(null, null)
                setMenuOpen(false)
              }}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
        <button
          type="button"
          className={clsx(navButton, markMode && 'bg-highlight text-accent')}
          onClick={() => setMarkMode(!markMode)}
          aria-pressed={markMode}
          title={t('browser.marks.toggle')}
          aria-label={t('browser.marks.toggle')}
        >
          <Crosshair size={14} />
        </button>
        <div className="relative">
          <button
            type="button"
            className={clsx(navButton, (shotMenuOpen || shotBusy) && 'text-accent')}
            disabled={shotBusy}
            onClick={() => setShotMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={shotMenuOpen}
            title={t('browser.shot.menu')}
            aria-label={t('browser.shot.menu')}
          >
            {shotBusy ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
          </button>
          {shotMenuOpen && (
            <ShotMenu
              withMarks={shotWithMarks}
              hasMarks={marksSnap.marks.length > 0}
              onToggleMarks={() => setShotWithMarks((on) => !on)}
              onShot={(fullPage) => void takeShot(fullPage)}
              onClose={() => setShotMenuOpen(false)}
            />
          )}
        </div>
        <button type="button" className={navButton} onClick={toggleDevTools} title={t('browser.toolbar.devtools')} aria-label={t('browser.toolbar.devtools')}>
          <Bug size={14} />
        </button>
        <button type="button" className={navButton} disabled={!/^https?:\/\//i.test(state?.url ?? '')} onClick={openExternal} title={t('browser.toolbar.openExternal')} aria-label={t('browser.toolbar.openExternal')}>
          <ExternalLink size={14} />
        </button>
        <button type="button" className={navButton} onClick={onClose} title={t('browser.toolbar.close')} aria-label={t('browser.toolbar.close')}>
          <X size={14} />
        </button>
        {loading && <div className="absolute inset-x-0 bottom-0 h-px animate-pulse bg-accent" role="progressbar" aria-label={t('browser.toolbar.loading')} />}
      </div>

      <div ref={stageRef} className={clsx('relative min-h-0 flex-1 bg-app', viewport ? 'overflow-auto' : 'overflow-hidden')}>
        {/* One element tree for every viewport, so changing the viewport never remounts (and reloads) the page. */}
        <div className="relative mx-auto" style={viewport ? { width: viewport.width * fit, height: viewport.height * fit } : { width: '100%', height: '100%' }}>
          <Webview
            ref={webviewRef}
            src={initialUrl}
            partition={BROWSER_PARTITION}
            allowpopups="true"
            style={
              viewport
                ? { display: 'flex', width: viewport.width, height: viewport.height, transform: `scale(${fit})`, transformOrigin: 'top left' }
                : { display: 'flex', width: '100%', height: '100%' }
            }
          />
          {pick && (
            <MarkPopover
              pick={pick}
              note={pickNote}
              fit={fit}
              area={viewport ? { width: viewport.width * fit, height: viewport.height * fit } : stageSize}
              onNote={setPickNote}
              onConfirm={confirmPick}
              onCancel={cancelPick}
            />
          )}
        </div>
        {markMode && !pick && (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <span className="rounded-full border border-border-strong bg-surface px-3 py-1 text-[11px] text-secondary shadow-lg shadow-black/30">{t('browser.marks.hint')}</span>
          </div>
        )}
      </div>

      {shotFailed && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-error">
          <span className="flex-1">{t('browser.shot.failed')}</span>
          <button type="button" className="text-dim hover:text-secondary" onClick={() => setShotFailed(false)} aria-label={t('browser.shot.dismiss')}>
            <X size={12} />
          </button>
        </div>
      )}

      {(numbered.length > 0 || markMode) && (
        <MarksList
          entries={numbered}
          editingId={editingId}
          attach={saved.attachMarks}
          onAttach={() => patchSession(sessionKey, { attachMarks: !saved.attachMarks })}
          onEdit={setEditingId}
          onNote={(id, note) => {
            setEditingId(null)
            void window.piDesktop.browser.updateMarkNote(sessionKey, id, note.trim() === '' ? null : note).catch(() => {})
          }}
          onRemove={(id) => void window.piDesktop.browser.removeMark(sessionKey, id).catch(() => {})}
          onClear={() => void window.piDesktop.browser.clearMarks(sessionKey).catch(() => {})}
        />
      )}
    </div>
  )
}

function MarkPopover({
  pick,
  note,
  fit,
  area,
  onNote,
  onConfirm,
  onCancel,
}: {
  pick: BrowserMarkPick
  note: string
  fit: number
  area: { width: number; height: number }
  onNote: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [pick])

  const rect = pick.draft.rect
  const left = Math.min(Math.max(0, rect.x * fit), Math.max(0, area.width - POPOVER_WIDTH))
  const below = (rect.y + rect.height) * fit + 8
  const top = below + POPOVER_HEIGHT > area.height ? Math.max(0, rect.y * fit - POPOVER_HEIGHT - 8) : below

  return (
    <div
      role="dialog"
      aria-label={t('browser.marks.noteTitle')}
      className="absolute z-20 flex flex-col gap-1.5 rounded-lg border border-border-strong bg-surface p-2.5 shadow-xl shadow-black/40"
      style={{ left, top, width: POPOVER_WIDTH }}
    >
      <div className="truncate font-mono text-[10px] text-dim" title={pick.draft.selector}>
        {pick.draft.selector}
      </div>
      <input
        ref={inputRef}
        value={note}
        onChange={(event) => onNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            onConfirm()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        spellCheck={false}
        placeholder={t('browser.marks.notePlaceholder')}
        aria-label={t('browser.marks.noteTitle')}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-primary placeholder:text-faint focus:border-accent focus:outline-none"
      />
      <div className="text-[10px] text-faint">{t('browser.marks.noteHint')}</div>
    </div>
  )
}

function MarksList({
  entries,
  editingId,
  attach,
  onAttach,
  onEdit,
  onNote,
  onRemove,
  onClear,
}: {
  entries: Array<{ number: number; mark: BrowserMark }>
  editingId: number | null
  attach: boolean
  onAttach: () => void
  onEdit: (id: number | null) => void
  onNote: (id: number, note: string) => void
  onRemove: (id: number) => void
  onClear: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const small = 'flex h-5 w-5 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-highlight hover:text-secondary'
  return (
    <div className="flex max-h-44 shrink-0 flex-col border-t border-border">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs text-secondary">
        <span className="font-medium">{t('browser.marks.title', { count: entries.length })}</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
          <input type="checkbox" checked={attach} onChange={onAttach} className="accent-accent" />
          {t('browser.marks.attach')}
        </label>
        {entries.length > 0 && (
          <button type="button" className="text-[11px] text-dim transition-colors hover:text-secondary" onClick={onClear}>
            {t('browser.marks.clear')}
          </button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto pb-1">
        {entries.map(({ number, mark }) => (
          <li key={mark.id} className={clsx('flex items-start gap-2 px-3 py-1 text-xs', mark.sent && 'opacity-50')} title={mark.sent ? t('browser.marks.sent') : undefined}>
            <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">{number}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-[11px] text-secondary" title={mark.selector}>
                  {mark.selector}
                </span>
                {mark.sent && <span className="shrink-0 text-[10px] text-faint">{t('browser.marks.sent')}</span>}
              </div>
              {editingId === mark.id ? (
                <input
                  autoFocus
                  defaultValue={mark.note ?? ''}
                  placeholder={t('browser.marks.notePlaceholder')}
                  aria-label={t('browser.marks.editNote')}
                  onBlur={(event) => onNote(mark.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Enter') event.currentTarget.blur()
                    else if (event.key === 'Escape') {
                      event.stopPropagation()
                      onEdit(null)
                    }
                  }}
                  className="mt-0.5 w-full rounded border border-border bg-card px-1.5 py-0.5 text-xs text-primary placeholder:text-faint focus:border-accent focus:outline-none"
                />
              ) : (
                mark.note && <div className="truncate text-dim">{mark.note}</div>
              )}
            </div>
            <button type="button" className={small} onClick={() => onEdit(mark.id)} title={t('browser.marks.editNote')} aria-label={t('browser.marks.editNote')}>
              <Pencil size={11} />
            </button>
            <button type="button" className={small} onClick={() => onRemove(mark.id)} title={t('browser.marks.remove')} aria-label={t('browser.marks.remove')}>
              <Trash2 size={11} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ShotMenu({
  withMarks,
  hasMarks,
  onToggleMarks,
  onShot,
  onClose,
}: {
  withMarks: boolean
  hasMarks: boolean
  onToggleMarks: () => void
  onShot: (fullPage: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.parentElement?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary transition-colors hover:bg-highlight disabled:opacity-40 disabled:hover:bg-transparent'
  return (
    <div ref={menuRef} role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-[200px] rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40">
      <button type="button" role="menuitem" className={item} onClick={() => onShot(false)}>
        {t('browser.shot.visible')}
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => onShot(true)}>
        {t('browser.shot.fullPage')}
      </button>
      <div className="my-1 border-t border-border" />
      <button type="button" role="menuitemcheckbox" aria-checked={withMarks} disabled={!hasMarks} className={item} onClick={onToggleMarks}>
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">{withMarks && hasMarks && <Check size={12} />}</span>
        <span className="flex-1">{t('browser.shot.withMarks')}</span>
      </button>
    </div>
  )
}

function ViewportMenu({
  presetId,
  scaleToFitOn,
  customOpen,
  customWidth,
  customHeight,
  customRatio,
  onCustomWidth,
  onCustomHeight,
  onCustomRatio,
  onPreset,
  onToggleCustom,
  onApplyCustom,
  onToggleScale,
  onReset,
  onClose,
}: {
  presetId: string | null
  scaleToFitOn: boolean
  customOpen: boolean
  customWidth: string
  customHeight: string
  customRatio: string
  onCustomWidth: (value: string) => void
  onCustomHeight: (value: string) => void
  onCustomRatio: (value: string) => void
  onPreset: (preset: (typeof BROWSER_VIEWPORT_PRESETS)[number]) => void
  onToggleCustom: () => void
  onApplyCustom: () => void
  onToggleScale: () => void
  onReset: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.parentElement?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary transition-colors hover:bg-highlight'
  const field = 'w-16 rounded border border-border bg-card px-1.5 py-1 text-xs text-primary focus:border-accent focus:outline-none'
  return (
    <div ref={menuRef} role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-[230px] rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40">
      {BROWSER_VIEWPORT_PRESETS.map((preset) => (
        <button key={preset.id} type="button" role="menuitemradio" aria-checked={presetId === preset.id} className={item} onClick={() => onPreset(preset)}>
          <span className="flex h-3 w-3 shrink-0 items-center justify-center">{presetId === preset.id && <Check size={12} />}</span>
          <span className="flex-1">{preset.label}</span>
          <span className="text-faint tabular-nums">
            {preset.width}×{preset.height} @{preset.deviceScaleFactor}
          </span>
        </button>
      ))}
      <button type="button" role="menuitemradio" aria-checked={presetId === CUSTOM_PRESET_ID} aria-expanded={customOpen} className={item} onClick={onToggleCustom}>
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">{presetId === CUSTOM_PRESET_ID && <Check size={12} />}</span>
        <span className="flex-1">{t('browser.viewport.custom')}</span>
      </button>
      {customOpen && (
        <div className="flex flex-wrap items-end gap-2 px-3 pb-2 pt-1">
          <label className="flex flex-col gap-0.5 text-[10px] text-dim">
            {t('browser.viewport.width')}
            <input className={field} inputMode="numeric" value={customWidth} onChange={(event) => onCustomWidth(event.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5 text-[10px] text-dim">
            {t('browser.viewport.height')}
            <input className={field} inputMode="numeric" value={customHeight} onChange={(event) => onCustomHeight(event.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5 text-[10px] text-dim">
            {t('browser.viewport.pixelRatio')}
            <input className={field} inputMode="decimal" value={customRatio} onChange={(event) => onCustomRatio(event.target.value)} />
          </label>
          <button type="button" onClick={onApplyCustom} className="rounded bg-accent px-2 py-1 text-xs text-white hover:opacity-90">
            {t('browser.viewport.apply')}
          </button>
        </div>
      )}
      <div className="my-1 border-t border-border" />
      <button type="button" role="menuitemcheckbox" aria-checked={scaleToFitOn} className={item} onClick={onToggleScale}>
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">{scaleToFitOn && <Check size={12} />}</span>
        <span className="flex-1">{t('browser.viewport.scaleToFit')}</span>
      </button>
      <button type="button" role="menuitem" className={item} onClick={onReset}>
        <span className="h-3 w-3 shrink-0" />
        <span className="flex-1">{t('browser.viewport.reset')}</span>
      </button>
    </div>
  )
}
