/**
 * How often fast-moving transfer telemetry reaches React state (pure).
 *
 * The session store is one context: every state change re-renders every screen using it, the
 * Player included, while the phone is downloading, decoding and drawing captions. Download
 * callbacks arrive ~10×/s and each guest heartbeats 2–3×/s, so the exact numbers live in refs
 * (heartbeats, gate math) and the UI gets a throttled view: structural changes at once,
 * telemetry at a few Hz, sub-visible jitter never.
 */

/** Minimum gap between published download-progress values (≤ 4 updates/s). */
export const PROGRESS_PUBLISH_MS = 250
/** Minimum gap between telemetry-only roster publishes (≤ 2 updates/s). */
export const ROSTER_TELEMETRY_PUBLISH_MS = 500

/**
 * Publish this progress value now? Always for the boundaries — 0 (a reset/restart) and 1
 * (validated complete) — and otherwise at most once per `gapMs`. A value held back should be
 * flushed by a trailing timer so the last one before a pause is never lost.
 */
export function shouldPublishProgress(next: number, published: number, publishedAt: number, now: number, gapMs = PROGRESS_PUBLISH_MS): boolean {
  if (next === published) return false
  if (next <= 0 || next >= 1) return true
  return now - publishedAt >= gapMs
}

/** The roster fields the UI renders (lastBeatAt is bookkeeping, never drawn). */
export type RosterRow = {
  id: string
  name: string
  status: string
  progress: number
  downloadMbps: number
  bufferedAheadSec: number
  stalled: boolean
  inShow: boolean
  decodeOk: boolean
}

/**
 * What changed between the roster the UI last saw and the current one:
 *  - 'structural' — membership, order, a name/status, or a flag that holds the room (stalled,
 *    inShow, decodeOk): publish immediately;
 *  - 'telemetry'  — a visible number moved (whole-percent progress, 0.1 Mbps, whole seconds of
 *    buffer): publish, but coalesced;
 *  - 'none'       — only invisible jitter (heartbeat stamps, sub-percent progress).
 */
export function rosterChange(prev: readonly RosterRow[], next: readonly RosterRow[]): 'none' | 'telemetry' | 'structural' {
  if (prev === next) return 'none'
  if (prev.length !== next.length) return 'structural'
  let telemetry = false
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]!
    const b = next[i]!
    if (a === b) continue
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.status !== b.status ||
      a.stalled !== b.stalled ||
      a.inShow !== b.inShow ||
      a.decodeOk !== b.decodeOk
    ) {
      return 'structural'
    }
    if (
      !telemetry &&
      (Math.round(a.progress * 100) !== Math.round(b.progress * 100) ||
        Math.round(a.downloadMbps * 10) !== Math.round(b.downloadMbps * 10) ||
        Math.floor(a.bufferedAheadSec) !== Math.floor(b.bufferedAheadSec))
    ) {
      telemetry = true
    }
  }
  return telemetry ? 'telemetry' : 'none'
}
