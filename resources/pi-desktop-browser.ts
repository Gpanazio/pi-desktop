import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  BROWSER_CONTEXT_TYPE,
  BROWSER_TOOLS,
  browserContextText,
  modelSeesImages,
  nextActiveTools,
  sameTools,
  toolContent,
  type BridgeActionResult,
  type BrowserStateReply,
} from './browser-tools'

// Set by Pi Desktop when it starts this agent (Pi only). Without them the
// extension registers nothing the model can use, so a stray copy is harmless.
const bridgeUrl = process.env.PI_DESKTOP_BROWSER_URL
const bridgeToken = process.env.PI_DESKTOP_BROWSER_TOKEN
const sessionKey = process.env.PI_DESKTOP_SESSION_KEY
// Plan / Read-only mode names the tools the agent may use; the browser can act, so it stays out.
const readOnly = process.env.PI_DESKTOP_PERMISSION_MODE === 'plan-readonly'

const STATE_TIMEOUT_MS = 1500
const ACTION_TIMEOUT_MS = 120_000

async function bridge(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(`${bridgeUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`Pi Desktop browser bridge answered ${response.status}`)
  return response.json()
}

async function fetchState(): Promise<BrowserStateReply> {
  if (!bridgeUrl || !bridgeToken || !sessionKey) return { open: false }
  try {
    return (await bridge(`/state?session=${encodeURIComponent(sessionKey)}`, { method: 'GET' }, STATE_TIMEOUT_MS)) as BrowserStateReply
  } catch {
    // An app that does not answer in time counts as a closed panel.
    return { open: false }
  }
}

async function runAction(action: string, params: unknown, signal?: AbortSignal): Promise<BridgeActionResult> {
  try {
    return (await bridge('/action', { method: 'POST', body: JSON.stringify({ session: sessionKey, action, params }) }, ACTION_TIMEOUT_MS, signal)) as BridgeActionResult
  } catch (error) {
    return { ok: false, text: `The browser is not reachable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Gives the agent Pi Desktop's built-in browser. The tools are registered
 * inactive and switched on at the start of a turn only while the panel is open
 * for this session, and switched off again when it closes, so a closed panel
 * costs the model no tool declarations. Tools other extensions or the user
 * turned on or off are left as they are.
 */
export default function piDesktopBrowser(pi: ExtensionAPI): void {
  for (const tool of BROWSER_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      defaultActive: false,
      async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { model?: { input?: readonly string[] } }) {
        const seesImages = modelSeesImages(ctx?.model)
        // A model without vision gets the page as text instead of an image.
        const result =
          tool.action === 'screenshot' && !seesImages
            ? await runAction('snapshot', { interactiveOnly: false, maxNodes: 300 }, signal)
            : await runAction(tool.action, params, signal)
        const note = tool.action === 'screenshot' && !seesImages && result.ok ? 'The active model has no image input, so this is the page as text.\n' : ''
        return {
          content: toolContent({ ...result, text: `${note}${result.text}` }, seesImages),
          details: {},
          ...(result.ok ? {} : { isError: true }),
        }
      },
    })
  }

  let lastContext = ''
  pi.on('before_agent_start', async () => {
    const reply = readOnly ? { open: false } : await fetchState()
    const active = pi.getActiveTools()
    const next = nextActiveTools(active, reply.open)
    if (!sameTools(active, next)) pi.setActiveTools(next)
    if (!reply.open) {
      lastContext = ''
      return
    }
    // The line stays in the conversation, so it is sent again only when it changes.
    const content = browserContextText(reply)
    if (content === lastContext) return
    lastContext = content
    return { message: { customType: BROWSER_CONTEXT_TYPE, content, display: false } }
  })
}
