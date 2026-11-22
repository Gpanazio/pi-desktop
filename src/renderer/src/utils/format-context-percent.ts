/** Context usage label; null/non-finite percent (pi after a compact, until the next response) is unknown, not 0. */
export function formatContextPercent(percent: number | null | undefined): string | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  const clamped = Math.min(100, Math.max(0, percent))
  // Large windows (1M) sit below 10% for a long time; one decimal keeps the figure moving.
  return clamped < 10 ? `${clamped.toFixed(1)}%` : `${Math.round(clamped)}%`
}
