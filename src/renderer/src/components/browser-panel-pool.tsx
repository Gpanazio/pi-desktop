import { useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { browserPanelId, nextLiveBrowserSessions, stableRenderOrder } from '../utils/browser-panel-state'
import { BrowserPanel } from './browser-panel'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

const FALLBACK_RECT: Rect = { left: 0, top: 0, width: 480, height: 640 }

/**
 * Every session with an open browser keeps its <webview> mounted (the three
 * most recently shown), so switching session never reloads the page. The panels
 * live here, in one stable parent, and are placed over `slotEl`, the empty box
 * the side panel reserves for the browser. A panel that is not on screen keeps
 * its last size, fully transparent and inert: its page keeps rendering, so the
 * agent of that session can still take a screenshot.
 */
export function BrowserPanelPool({
  rootRef,
  slotEl,
  activeKey,
  showing,
  onClose,
}: {
  rootRef: React.RefObject<HTMLElement | null>
  slotEl: HTMLElement | null
  activeKey: string
  /** The browser is the side panel on screen. */
  showing: boolean
  onClose: () => void
}): React.JSX.Element {
  const openSignature = useAppStore((state) =>
    JSON.stringify(Object.keys(state.browserSessions).filter((key) => state.browserSessions[key].open).sort()),
  )
  // Each open session's panel id: it outlives a change of session key, so the page does not reload.
  const panelIdSignature = useAppStore((state) =>
    JSON.stringify(Object.keys(state.browserSessions).filter((key) => state.browserSessions[key].open).sort().map((key) => [key, browserPanelId(state.browserSessions, key)])),
  )
  const panelIds = new Map(JSON.parse(panelIdSignature) as Array<[string, string]>)
  const liveRef = useRef<string[]>([])
  liveRef.current = nextLiveBrowserSessions(liveRef.current, activeKey, new Set(JSON.parse(openSignature) as string[]))
  // Rendered in the order each panel first mounted, not in LRU order: React moves a reordered child
  // in the DOM, and a <webview> that moves reloads its page.
  const renderOrderRef = useRef<string[]>([])
  const keyOfPanel = new Map(liveRef.current.map((key) => [panelIds.get(key) ?? key, key]))
  renderOrderRef.current = stableRenderOrder(renderOrderRef.current, [...keyOfPanel.keys()])
  const live = renderOrderRef.current

  // Where the slot is, relative to the root; a slot that measures 0 (the chat view is hidden) keeps the last real place.
  const [rect, setRect] = useState<Rect | null>(null)
  const measure = useMemo(
    () => (): void => {
      const root = rootRef.current
      if (!root || !slotEl) return
      const slot = slotEl.getBoundingClientRect()
      if (slot.width <= 0 || slot.height <= 0) return
      const base = root.getBoundingClientRect()
      const next = { left: slot.left - base.left, top: slot.top - base.top, width: slot.width, height: slot.height }
      setRect((previous) =>
        previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height
          ? previous
          : next,
      )
    },
    [rootRef, slotEl],
  )
  // Cheap and equality-guarded, so it also catches a slot that moved without resizing.
  useLayoutEffect(measure)
  useEffect(() => {
    const root = rootRef.current
    if (!root || !slotEl) return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(slotEl)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [rootRef, slotEl, measure])

  const place = rect ?? FALLBACK_RECT
  return (
    <>
      {live.map((panelId) => {
        const key = keyOfPanel.get(panelId) ?? panelId
        const onScreen = showing && key === activeKey && slotEl !== null && rect !== null
        return (
          <div
            key={panelId}
            className={onScreen ? 'absolute z-10 flex flex-col overflow-hidden bg-app' : 'pointer-events-none absolute z-10 flex flex-col overflow-hidden bg-app'}
            style={{ left: place.left, top: place.top, width: place.width, height: place.height, opacity: onScreen ? 1 : 0 }}
            aria-hidden={!onScreen}
            inert={!onScreen}
          >
            <BrowserPanel sessionKey={key} onClose={onClose} />
          </div>
        )
      })}
    </>
  )
}
