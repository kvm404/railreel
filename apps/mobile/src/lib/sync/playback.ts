/**
 * Drift correction: keep a client's local playback aligned with the host's authoritative state.
 *
 * The host broadcasts a PlaybackState stamped with its MONOTONIC clock. A client converts its own
 * clock to host time (via the measured offset, see lib/sync/clock) and asks two pure questions:
 *   1. where SHOULD the playhead be right now?            → targetPositionSec()
 *   2. given where it ACTUALLY is, what should we do?      → decideCorrection()
 *
 * Strategy (architecture §5): a big gap is a hard seek; a small gap is nudged out by trimming the
 * playback rate (imperceptible) so we don't jump; inside a deadband we leave it alone. Pure +
 * unit-tested so the thresholds can be tuned against real-device fixtures.
 */

import type { PlaybackState } from '@/lib/protocol'

/** Where the playhead should be now, given the host's last state and the current host-monotonic ms. */
export function targetPositionSec(state: PlaybackState, hostNowMs: number): number {
  if (!state.isPlaying) return state.positionSec
  const elapsedSec = (hostNowMs - state.hostMonotonicMs) / 1000
  return state.positionSec + elapsedSec * state.rate
}

export type Correction =
  | { action: 'pause'; seekToSec?: number }
  | { action: 'play'; rate: number; seekToSec?: number }

export interface CorrectionParams {
  /** Where the playhead should be (from targetPositionSec). */
  targetSec: number
  /** Where the local player actually is. */
  actualSec: number
  /** Whether the host says we should be playing. */
  isPlaying: boolean
  /** Drift beyond this (s) → hard seek. */
  seekThresholdSec?: number
  /** Drift within this (s) → no correction (rate 1). */
  deadbandSec?: number
  /** Rate-nudge gain applied to the drift (s). */
  rateGain?: number
  /** Max rate deviation from the base rate (e.g. 0.1 → base ± 0.1). */
  maxRateNudge?: number
  /** The host's playback rate; nudges are centered on this (default 1). */
  baseRate?: number
}

// Tuned for SMOOTHNESS over frame-perfect sync: a movie that's <0.3s off is imperceptible, so leave
// it alone (deadband) and only ever close a gap with a gentle, near-inaudible rate trim. A hard seek
// is jarring (it re-buffers, drops audio) so it's reserved for a real desync (>1.5s).
const DEFAULTS = {
  seekThresholdSec: 1.5,
  deadbandSec: 0.3,
  rateGain: 0.4,
  maxRateNudge: 0.06,
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)

/**
 * Room gate: the host holds the show while any follower is stalled (still loading) and resumes
 * once everyone is ready. Pure so the tricky bits are pinned down: it must NOT fight a manual pause
 * (only auto-resume what it auto-paused) and must be idempotent (no action if already in the right
 * state) so it can't flap.
 *
 * `autoPaused` — did the gate itself pause the room? `playing` — is the room currently playing?
 * `blocked` — is at least one follower stalled?
 */
export type RoomGateAction = 'pause' | 'resume' | 'none'
export function roomGate(
  { autoPaused, playing }: { autoPaused: boolean; playing: boolean },
  blocked: boolean,
): RoomGateAction {
  if (blocked && playing) return 'pause' // a straggler appeared — hold the room
  if (!blocked && autoPaused && !playing) return 'resume' // everyone caught up — resume our hold
  return 'none'
}

/** Default grace before a flaky "not ready" counts as a real stall (see stallReport). */
export const STALL_GRACE_MS = 1200

/**
 * Debounce a follower's flaky readiness signal into a stable stall report. `player.status` blips to
 * "not ready" on every drift-seek and brief decode hiccup; reporting those instantly makes the host
 * hold the room and (on a slow client) never cleanly resume — a freeze. So we only call it a stall
 * once the player has been CONTINUOUSLY not-ready for `graceMs`, and clear it the instant it's ready.
 *
 * Pure: caller persists `notReadySince` (the ms timestamp readiness was first lost, or null) and
 * feeds it back each tick.
 */
export function stallReport(
  notReady: boolean,
  notReadySince: number | null,
  nowMs: number,
  graceMs = STALL_GRACE_MS,
): { notReadySince: number | null; stalled: boolean } {
  if (!notReady) return { notReadySince: null, stalled: false }
  const since = notReadySince ?? nowMs
  return { notReadySince: since, stalled: nowMs - since >= graceMs }
}

/**
 * Decide how to bring the local player back in line. `drift > 0` means we are BEHIND the host
 * (need to move forward / speed up); `drift < 0` means we are AHEAD.
 */
export function decideCorrection(p: CorrectionParams): Correction {
  const seekThreshold = p.seekThresholdSec ?? DEFAULTS.seekThresholdSec
  const deadband = p.deadbandSec ?? DEFAULTS.deadbandSec
  const gain = p.rateGain ?? DEFAULTS.rateGain
  const maxNudge = p.maxRateNudge ?? DEFAULTS.maxRateNudge
  const baseRate = p.baseRate ?? 1
  const drift = p.targetSec - p.actualSec

  if (!p.isPlaying) {
    // Paused: hold at the host's position; only seek if we're meaningfully off.
    return { action: 'pause', seekToSec: Math.abs(drift) > deadband ? p.targetSec : undefined }
  }
  if (Math.abs(drift) > seekThreshold) {
    // Too far to nudge — jump there and resume at the host's rate.
    return { action: 'play', rate: baseRate, seekToSec: p.targetSec }
  }
  if (Math.abs(drift) <= deadband) {
    return { action: 'play', rate: baseRate }
  }
  // Small drift: trim the rate (around the host's rate) to close the gap smoothly.
  const rate = baseRate + clamp(drift * gain, -maxNudge, maxNudge)
  return { action: 'play', rate }
}
