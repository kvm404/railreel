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
  if (!state.isPlaying) return Math.max(0, state.positionSec)
  const elapsedSec = (hostNowMs - state.hostMonotonicMs) / 1000
  return Math.max(0, state.positionSec + elapsedSec * state.rate)
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
  /** Max rate deviation inside the near band (inaudible trim). */
  maxRateNudge?: number
  /** |drift| beyond this (s) escalates to the assertive catch-up cap. */
  nearBandSec?: number
  /** Max rate deviation beyond the near band (brief, assertive catch-up). */
  maxRateNudgeFar?: number
  /** The host's playback rate; nudges are centered on this (default 1). */
  baseRate?: number
  /**
   * Measured seek-landing latency (s) for THIS device: how far the target moves while a seek is
   * being executed. A hard seek while playing aims at `target + lead` so it lands ON the target
   * instead of behind it — the reason slow devices used to settle ~1s behind the host.
   */
  seekLeadSec?: number
}

// Tuned for tight-but-smooth sync (PRD target: sub-100ms perceived). Inside a small deadband we
// leave the player alone; small drift gets an inaudible ≤5% rate trim; larger drift (a slow device
// falling behind) gets a brief assertive ≤15% catch-up — still smoother than a seek, and it closes
// 1s of drift in ~7s instead of parking just outside a wide deadband. Hard seeks (re-buffer,
// audio drop) stay reserved for a real desync.
const DEFAULTS = {
  seekThresholdSec: 1.2,
  deadbandSec: 0.12,
  rateGain: 0.5,
  maxRateNudge: 0.05,
  nearBandSec: 0.5,
  maxRateNudgeFar: 0.15,
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

/** Bounds for a believable seek-latency sample (s): below = timer noise, above = a rebuffer, not a seek. */
const SEEK_LEAD_MIN = 0.05
const SEEK_LEAD_MAX = 2.5

/**
 * Fold a measured seek-landing latency sample into the device's running estimate (EMA). The
 * estimate feeds decideCorrection's `seekLeadSec`. Samples outside believable bounds are dropped
 * (a stall mid-seek would otherwise poison the lead and every future seek would overshoot).
 */
export function nextSeekLead(prevLeadSec: number, sampleSec: number, alpha = 0.3): number {
  if (!Number.isFinite(sampleSec) || sampleSec < SEEK_LEAD_MIN || sampleSec > SEEK_LEAD_MAX) return prevLeadSec
  return prevLeadSec > 0 ? prevLeadSec + alpha * (sampleSec - prevLeadSec) : sampleSec
}

/**
 * Decide how to bring the local player back in line. `drift > 0` means we are BEHIND the host
 * (need to move forward / speed up); `drift < 0` means we are AHEAD.
 */
export function decideCorrection(p: CorrectionParams): Correction {
  const seekThreshold = p.seekThresholdSec ?? DEFAULTS.seekThresholdSec
  const deadband = p.deadbandSec ?? DEFAULTS.deadbandSec
  const gain = p.rateGain ?? DEFAULTS.rateGain
  const nearBand = p.nearBandSec ?? DEFAULTS.nearBandSec
  const maxNudgeNear = p.maxRateNudge ?? DEFAULTS.maxRateNudge
  const maxNudgeFar = p.maxRateNudgeFar ?? DEFAULTS.maxRateNudgeFar
  const baseRate = p.baseRate ?? 1
  const seekLead = p.seekLeadSec ?? 0
  const drift = p.targetSec - p.actualSec

  if (!p.isPlaying) {
    // Paused: hold at the host's position; only seek if we're meaningfully off. No lead — a
    // paused target doesn't move while the seek lands.
    return { action: 'pause', seekToSec: Math.abs(drift) > deadband ? Math.max(0, p.targetSec) : undefined }
  }
  if (Math.abs(drift) > seekThreshold) {
    // Too far to nudge — jump there, leading by the device's measured seek latency so the seek
    // lands ON the moving target rather than behind it. Never lead a backwards seek past the
    // target itself (an ahead-of-host device is already fast; overshooting would flip the error).
    const lead = drift > 0 ? seekLead : 0
    return { action: 'play', rate: baseRate, seekToSec: Math.max(0, p.targetSec + lead) }
  }
  if (Math.abs(drift) <= deadband) {
    return { action: 'play', rate: baseRate }
  }
  // Rate-trim toward the target: inaudible inside the near band, assertive beyond it.
  const maxNudge = Math.abs(drift) <= nearBand ? maxNudgeNear : maxNudgeFar
  const rate = baseRate + clamp(drift * gain, -maxNudge, maxNudge)
  return { action: 'play', rate }
}
