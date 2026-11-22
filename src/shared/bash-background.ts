import type { AgentEngineKind } from './ipc-contracts'

/** A bash call the agent moved to a managed background process (by the user or by the deadline). */
export interface BashBackground {
  processId: string
  pid?: number
  name?: string
  manual: boolean
}

interface BashCallLike {
  name: string
  isExecuting: boolean
}

function isBash(name: string): boolean {
  return name.toLowerCase() === 'bash'
}

/** The Background button shows on a running bash call, on the Pi engine only (the /bg command lives in a Pi extension). */
export function canMoveToBackground(call: BashCallLike, engine: AgentEngineKind | null | undefined): boolean {
  return engine === 'pi' && call.isExecuting && isBash(call.name)
}

/** The toolCallId a keyboard shortcut would target: the only bash call running, else null. */
export function soleRunningBashId(calls: Iterable<[string, BashCallLike]>): string | null {
  let found: string | null = null
  for (const [id, call] of calls) {
    if (!call.isExecuting || !isBash(call.name)) continue
    if (found !== null) return null
    found = id
  }
  return found
}

/** Reads `details.background` of a tool_execution_end result; null when the call was not moved. */
export function parseBashBackground(details: unknown): BashBackground | null {
  if (!details || typeof details !== 'object') return null
  const raw = (details as Record<string, unknown>).background
  if (!raw || typeof raw !== 'object') return null
  const bg = raw as Record<string, unknown>
  if (typeof bg.processId !== 'string' && typeof bg.processId !== 'number') return null
  const result: BashBackground = { processId: String(bg.processId), manual: bg.manual === true }
  if (typeof bg.pid === 'number') result.pid = bg.pid
  if (typeof bg.name === 'string') result.name = bg.name
  return result
}

const BACKGROUND_TEXT = /moved to background.*?process (\S+)(?: "[^"]*")? \(pid (\d+)\)/i

/** History reloads only keep the result text; recover the process from its wording. */
export function parseBashBackgroundText(text: string | undefined): BashBackground | null {
  const m = text ? BACKGROUND_TEXT.exec(text) : null
  if (!m) return null
  return { processId: m[1], pid: Number(m[2]), manual: /by the user/i.test(text!) }
}

/** "process 3 · pid 123" for the card; just the id when the pid is unknown. */
export function backgroundSummary(bg: BashBackground): string {
  return bg.pid !== undefined ? `#${bg.processId} · pid ${bg.pid}` : `#${bg.processId}`
}
