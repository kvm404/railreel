/**
 * Reconnect backoff: how long to wait before the Nth reconnect attempt. Exponential from `baseMs`,
 * capped at `maxMs` so a long outage doesn't stretch the gap unboundedly. Pure + unit-tested.
 */
export function reconnectDelayMs(attempt: number, baseMs = 500, maxMs = 8000): number {
  const a = attempt < 0 ? 0 : attempt
  return Math.min(baseMs * 2 ** a, maxMs)
}
