/**
 * Countdown math for time-boxed prompts (the host's moderation banner). The deadline is derived
 * from when the request ARRIVED, never from when the UI last rendered — so a re-render, a remount
 * or a late subscription can't reset the clock, and the number on screen always agrees with the
 * store's own auto-dismiss timer.
 */

/** Whole seconds left before `receivedAtMs + totalMs` (ceil, so "1s" shows until the very end; never negative). */
export function secondsLeft(receivedAtMs: number, nowMs: number, totalMs: number): number {
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(totalMs)) return 0
  const leftMs = receivedAtMs + totalMs - nowMs
  return leftMs > 0 ? Math.ceil(leftMs / 1000) : 0
}

/** Fraction of the window still remaining, 0..1 (drives the draining fuse under the banner). */
export function fractionLeft(receivedAtMs: number, nowMs: number, totalMs: number): number {
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(nowMs) || !(totalMs > 0)) return 0
  const f = (receivedAtMs + totalMs - nowMs) / totalMs
  return f <= 0 ? 0 : f >= 1 ? 1 : f
}
