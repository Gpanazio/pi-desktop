/**
 * Session generation speed = sum of output tokens of the assistant turns / sum
 * of their generation time, measured from the first stream delta to the
 * message_end (excludes the wait before the first token and tool execution
 * time). Output tokens are `message.usage.output` (pi 1.6.0 reports reasoning
 * inside it). Turns under MIN_TURN_MS or without tokens are ignored.
 */
export interface GenerationSpeed {
  tokens: number
  ms: number
}

export const MIN_TURN_MS = 200

export function addGenerationTurn(
  acc: GenerationSpeed | null,
  outputTokens: unknown,
  firstDeltaAt: number | null,
  endedAt: number
): GenerationSpeed | null {
  if (firstDeltaAt === null || typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return acc
  const ms = endedAt - firstDeltaAt
  if (outputTokens <= 0 || !(ms >= MIN_TURN_MS)) return acc
  return { tokens: (acc?.tokens ?? 0) + outputTokens, ms: (acc?.ms ?? 0) + ms }
}

/** Whole tokens per second, or null when no turn has been measured yet. */
export function formatTokensPerSecond(speed: GenerationSpeed | null | undefined): string | null {
  if (!speed || speed.ms <= 0 || speed.tokens <= 0) return null
  const rate = (speed.tokens * 1000) / speed.ms
  return rate < 10 ? rate.toFixed(1) : String(Math.round(rate))
}
