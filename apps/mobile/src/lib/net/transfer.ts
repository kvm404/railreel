/**
 * Guest movie-transfer recovery rules (pure). A hotspot blip kills the HTTP transfer and the WS
 * together; the WS reconnects on its own, and these decide how the transfer follows it back.
 *
 * Resume beats restart: the host's data plane answers `Range: bytes=N-` with 206, and appending
 * to the SAME file keeps the playback proxy's open fd valid (a restart unlinks the file, leaving
 * the proxy reading a dead inode) and doesn't re-pull gigabytes over a shared hotspot.
 */

import { reconnectDelayMs } from './backoff'

/** Automatic transfer retries per failure streak (a success, or a manual retry, resets it). */
export const MAX_TRANSFER_RETRIES = 6

/** Backoff before automatic transfer retry #attempt: 1s, 2s, 4s, 8s, then 15s. */
export function transferRetryDelayMs(attempt: number): number {
  return reconnectDelayMs(attempt, 1000, 15_000)
}

/**
 * Byte offset to resume from, or 0 for a fresh transfer. Resume only a partial copy THIS session
 * wrote (the caller vouches for that) that is non-empty and strictly short of the final size —
 * an empty, complete, or oversized file (unknown size, foreign bytes) restarts clean.
 */
export function resumeOffset(localBytes: number | null | undefined, expectedBytes: number): number {
  if (!(expectedBytes > 0)) return 0 // no size, no Range proof → restart
  if (typeof localBytes !== 'number' || !Number.isFinite(localBytes) || localBytes <= 0) return 0
  if (localBytes >= expectedBytes) return 0
  return Math.floor(localBytes)
}

/**
 * Did the transfer leave a trustworthy file? The legacy downloader writes ANY response body to
 * disk (appending on a resume) — so a resumed transfer must have been a 206 (a 200 would have
 * appended the whole movie again; a 4xx appended an error page), and the final size must be
 * exactly the movie's size when we know it.
 */
export function transferResultOk(
  resumedFrom: number,
  status: number | undefined,
  finalBytes: number | null | undefined,
  expectedBytes: number,
): boolean {
  if (typeof status !== 'number') return false
  if (resumedFrom > 0 ? status !== 206 : status < 200 || status >= 300) return false
  if (expectedBytes > 0 && finalBytes !== expectedBytes) return false
  return true
}

export interface AutoResumeInput {
  /** The host approved us (grant live on the data plane). */
  approved: boolean
  /** Current client phase. */
  phase: string
  /** The movie is fully cached. */
  complete: boolean
  /** A transfer attempt is running right now. */
  transferring: boolean
  /** The WS is down and re-handshaking (a retry now would fail the same way). */
  reconnecting: boolean
  /** Automatic retries already spent in this failure streak. */
  retries: number
}

/** Should the guest automatically restart its (failed) transfer now? */
export function shouldAutoResume(i: AutoResumeInput): boolean {
  return (
    i.approved &&
    i.phase === 'approved' && // the failure path parks us here; 'downloading'/'ready' need nothing
    !i.complete &&
    !i.transferring &&
    !i.reconnecting &&
    i.retries < MAX_TRANSFER_RETRIES
  )
}

/** A running transfer that has made no progress for this long through a WS drop is presumed dead. */
export const TRANSFER_STALL_MS = 5000

/**
 * After the WS comes back: is the transfer still "running" but silently dead (OkHttp's 60s read
 * timeout hasn't fired yet)? Then abort and resume it now rather than wait out the timeout —
 * the playback proxy gives up on a silent edge after 30s.
 */
export function isTransferStalled(transferring: boolean, lastProgressAtMs: number, nowMs: number): boolean {
  return transferring && lastProgressAtMs > 0 && nowMs - lastProgressAtMs >= TRANSFER_STALL_MS
}
