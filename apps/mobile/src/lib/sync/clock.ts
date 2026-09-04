/**
 * Clock synchronization math (pure, unit-tested).
 *
 * Clients align to the host's clock using an NTP-style 4-timestamp exchange, then
 * decide how to correct playback drift. No React Native / IO here — keep it pure so
 * it can be tested in Node and reasoned about in isolation. See docs/architecture.md §5.
 *
 * IMPORTANT: callers must feed t1..t4 from a MONOTONIC clock (e.g.
 * elapsedRealtimeNanos on Android) — never Date.now(), which
 * jumps with NTP/user changes. This module is clock-source agnostic; the caller guarantees it.
 */

export interface ClockSample {
  /** t1: client send time (client clock, ms) */
  t1: number
  /** t2: host receive time (host clock, ms) */
  t2: number
  /** t3: host send time (host clock, ms) */
  t3: number
  /** t4: client receive time (client clock, ms) */
  t4: number
}

export interface ClockEstimate {
  /** Add to a client-clock value to get host-clock value (ms). */
  offsetMs: number
  /** Round-trip time of the sample used (ms). */
  rttMs: number
}

/** Offset + RTT from a single NTP-style exchange. */
export function estimateFromSample(s: ClockSample): ClockEstimate {
  const offsetMs = (s.t2 - s.t1 + (s.t3 - s.t4)) / 2
  const rttMs = s.t4 - s.t1 - (s.t3 - s.t2)
  return { offsetMs, rttMs }
}

/**
 * Best estimate across several samples: the lowest-RTT sample wins (least network
 * jitter => most trustworthy offset). Returns null for an empty set.
 */
export function bestEstimate(samples: ClockSample[]): ClockEstimate | null {
  let best: ClockEstimate | null = null
  for (const s of samples) {
    const e = estimateFromSample(s)
    if (best === null || e.rttMs < best.rttMs) best = e
  }
  return best
}

/** Convert a client-clock instant to the host's clock. */
export function toHostTime(clientNowMs: number, offsetMs: number): number {
  return clientNowMs + offsetMs
}

export interface DriftDecision {
  /** Seconds the local player is off from the host target (target - local). */
  driftSec: number
  action: 'hold' | 'nudge' | 'seek'
  /** For 'nudge': the temporary playbackRate multiplier to apply. */
  rate?: number
}

export interface DriftThresholds {
  /** Below this, do nothing (sec). */
  holdSec: number
  /** Between hold and seek, nudge playbackRate; at/above, hard seek (sec). */
  seekSec: number
  /** Magnitude of the temporary rate adjustment for nudges (e.g. 0.05 => ±5%). */
  nudgeRate: number
}

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  holdSec: 0.05, // ~50ms — within perceptual tolerance
  seekSec: 0.25, // ≥250ms — too far to nudge, snap instead
  nudgeRate: 0.05,
}

/**
 * Decide how a client should correct toward the host's target position.
 * Positive drift => local is BEHIND target => speed up; negative => ahead => slow down.
 */
export function decideDriftCorrection(
  targetSec: number,
  localSec: number,
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): DriftDecision {
  const driftSec = targetSec - localSec
  const abs = Math.abs(driftSec)

  if (abs < thresholds.holdSec) return { driftSec, action: 'hold' }
  if (abs >= thresholds.seekSec) return { driftSec, action: 'seek' }

  const rate = driftSec > 0 ? 1 + thresholds.nudgeRate : 1 - thresholds.nudgeRate
  return { driftSec, action: 'nudge', rate }
}
